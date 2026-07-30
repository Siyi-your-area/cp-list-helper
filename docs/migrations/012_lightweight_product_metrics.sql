-- Add privacy-minimized product metrics. This migration is forward-only,
-- requires 006 (list_members), and is safe to apply after 007-011.

begin;

create extension if not exists pgcrypto;

create table if not exists public.product_metric_events (
  id uuid primary key,
  event_name text not null
    check (event_name in ('page_view', 'list_created')),
  metric_date date not null
    default ((now() at time zone 'Asia/Shanghai')::date),
  occurred_at timestamptz not null default now(),
  visitor_key text,
  constraint product_metric_events_visitor_key_check check (
    (
      event_name = 'page_view'
      and visitor_key is not null
      and length(visitor_key) = 64
    )
    or (
      event_name = 'list_created'
      and visitor_key is null
    )
  )
);

create index if not exists idx_product_metric_events_day_event
  on public.product_metric_events(metric_date, event_name);
create index if not exists idx_product_metric_events_visitor_time
  on public.product_metric_events(visitor_key, occurred_at desc)
  where visitor_key is not null;

alter table public.product_metric_events enable row level security;
revoke all privileges on table public.product_metric_events
  from public, anon, authenticated, service_role;

create or replace function public.record_page_view(
  p_user_id uuid,
  p_view_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_visitor_key text;
  v_recent_count integer;
begin
  if p_user_id is null or p_view_id is null then
    return false;
  end if;

  v_visitor_key := encode(digest(p_user_id::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(
    hashtextextended('product_metric:' || v_visitor_key, 0)
  );

  if exists (
    select 1
    from public.product_metric_events metric
    where metric.id = p_view_id
      and metric.event_name = 'page_view'
      and metric.visitor_key = v_visitor_key
  ) then
    return true;
  end if;

  select count(*)::integer
  into v_recent_count
  from public.product_metric_events metric
  where metric.event_name = 'page_view'
    and metric.visitor_key = v_visitor_key
    and metric.occurred_at >= now() - interval '1 minute';

  if v_recent_count >= 30 then
    return false;
  end if;

  insert into public.product_metric_events(id, event_name, visitor_key)
  values (p_view_id, 'page_view', v_visitor_key)
  on conflict (id) do nothing;

  return found;
end;
$$;

revoke all privileges on function public.record_page_view(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_page_view(uuid,uuid) to service_role;

create or replace function public.record_list_created_metric()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_digest text;
  v_metric_id uuid;
begin
  if new.role is distinct from 'owner' then
    return new;
  end if;

  v_digest := encode(
    digest('list_created:' || new.event_id, 'sha256'),
    'hex'
  );
  v_metric_id := (
    substring(v_digest from 1 for 8) || '-' ||
    substring(v_digest from 9 for 4) || '-' ||
    substring(v_digest from 13 for 4) || '-' ||
    substring(v_digest from 17 for 4) || '-' ||
    substring(v_digest from 21 for 12)
  )::uuid;

  insert into public.product_metric_events(id, event_name, visitor_key)
  values (v_metric_id, 'list_created', null)
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

drop trigger if exists list_members_record_list_created_metric
  on public.list_members;
create trigger list_members_record_list_created_metric
after insert on public.list_members
for each row execute function public.record_list_created_metric();

commit;
