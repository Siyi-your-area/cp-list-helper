-- Record a non-linkable creator key for future list_created metrics.
-- Existing metrics are backfilled only while their list still exists.
-- Deleted lists cannot be attributed retrospectively; reports must show coverage.

begin;

alter table public.product_metric_events
  add column creator_key text;

alter table public.product_metric_events
  add constraint product_metric_events_creator_key_check
  check (
    creator_key is null
    or (
      event_name = 'list_created'
      and creator_key ~ '^[0-9a-f]{64}$'
    )
  );

create or replace function public.record_list_created_metric()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_digest text;
  v_metric_id uuid;
  v_creator_key text;
begin
  if new.role is distinct from 'owner' then
    return new;
  end if;

  v_digest := encode(
    extensions.digest('list_created:' || new.event_id, 'sha256'),
    'hex'
  );
  v_metric_id := (
    substring(v_digest from 1 for 8) || '-' ||
    substring(v_digest from 9 for 4) || '-' ||
    substring(v_digest from 13 for 4) || '-' ||
    substring(v_digest from 17 for 4) || '-' ||
    substring(v_digest from 21 for 12)
  )::uuid;
  v_creator_key := encode(
    extensions.digest('list_creator:' || new.user_id::text, 'sha256'),
    'hex'
  );

  insert into public.product_metric_events(id, event_name, visitor_key, creator_key)
  values (v_metric_id, 'list_created', null, v_creator_key)
  on conflict (id) do nothing;

  return new;
exception
  when others then
    raise warning 'PRODUCT_METRIC_LIST_CREATED_FAILED';
    return new;
end;
$$;

revoke all privileges on function public.record_list_created_metric()
  from public, anon, authenticated, service_role;

with surviving_lists as (
  select
    (
      substring(k.metric_digest from 1 for 8) || '-' ||
      substring(k.metric_digest from 9 for 4) || '-' ||
      substring(k.metric_digest from 13 for 4) || '-' ||
      substring(k.metric_digest from 17 for 4) || '-' ||
      substring(k.metric_digest from 21 for 12)
    )::uuid as metric_id,
    encode(
      extensions.digest('list_creator:' || e.created_by::text, 'sha256'),
      'hex'
    ) as creator_key
  from public.events e
  cross join lateral (
    select encode(
      extensions.digest('list_created:' || e.id, 'sha256'),
      'hex'
    ) as metric_digest
  ) k
  where e.created_by is not null
)
update public.product_metric_events metric
set creator_key = surviving_lists.creator_key
from surviving_lists
where metric.id = surviving_lists.metric_id
  and metric.event_name = 'list_created'
  and metric.creator_key is null;

commit;
