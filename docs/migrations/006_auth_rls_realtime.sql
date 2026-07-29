-- CP List Helper auth/realtime PREPARE migration.
-- Apply after 001..005. This phase is additive, safe to re-run, and keeps the
-- legacy application operational. Apply 007 only after the new app is deployed.

create extension if not exists pgcrypto;

alter table public.events
  add column if not exists created_by uuid,
  add column if not exists share_code_hash text,
  add column if not exists share_seed uuid default gen_random_uuid();

update public.events set share_seed = gen_random_uuid() where share_seed is null;
alter table public.events alter column share_seed set default gen_random_uuid();
alter table public.events alter column share_seed set not null;

alter table public.wish_items
  add column if not exists version bigint not null default 1;

create table if not exists public.list_members (
  event_id text not null references public.events(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table if not exists public.legacy_device_claims (
  client_id_hash text primary key check (length(client_id_hash) = 64),
  user_id uuid not null,
  claimed_at timestamptz not null default now()
);

create index if not exists idx_legacy_device_claims_user
  on public.legacy_device_claims(user_id, claimed_at desc);

create index if not exists idx_list_members_user
  on public.list_members(user_id, created_at desc);
create index if not exists idx_list_members_event_role
  on public.list_members(event_id, role);
create unique index if not exists idx_events_share_code_hash
  on public.events(share_code_hash) where share_code_hash is not null;

create table if not exists public.share_redemption_attempts (
  user_id uuid not null,
  ip_hash text not null,
  window_started timestamptz not null,
  attempt_count integer not null default 1 check (attempt_count > 0),
  last_attempt_at timestamptz not null default now(),
  primary key (user_id, ip_hash, window_started)
);

create or replace function public.bump_wish_item_version()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.version = old.version then new.version := old.version + 1; end if;
  return new;
end;
$$;

drop trigger if exists wish_items_version on public.wish_items;
create trigger wish_items_version before update on public.wish_items
for each row execute function public.bump_wish_item_version();

comment on table public.list_members is
  'JWT user membership for a list. event_access is retained only as a one-time legacy claim source.';
comment on table public.legacy_device_claims is
  'One-time server-HMAC binding from a legacy device identifier to one auth UID. Plaintext client IDs are never stored here.';
comment on column public.events.share_code_hash is
  'Server-HMAC of the four-character share code; the code itself is never stored.';
comment on column public.events.share_seed is
  'Random material used by the server to derive a stable share code; not exposed by member-facing RPCs.';
comment on table public.share_redemption_attempts is
  'Rate-limit counters keyed by auth UID and a server-HMAC of CF-Connecting-IP. No plaintext IP or code is stored.';

-- Existing deployments may contain orphan wish_items. NOT VALID preserves those
-- rows while enforcing the relation for new writes and enabling cascade cleanup.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'wish_items_event_id_fkey'
      and conrelid = 'public.wish_items'::regclass
  ) then
    alter table public.wish_items
      add constraint wish_items_event_id_fkey
      foreign key (event_id) references public.events(id) on delete cascade not valid;
  end if;
end $$;

create or replace function public.is_event_member(p_event_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.list_members m
    where m.event_id = p_event_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.get_event_role(p_event_id text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role from public.list_members m
  where m.event_id = p_event_id and m.user_id = auth.uid();
$$;

drop function if exists public.claim_legacy_access(text);
create or replace function public.claim_legacy_access(
  p_user_id uuid,
  p_client_id text,
  p_client_id_hash text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_bound_user uuid;
begin
  if p_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_client_id is null or length(p_client_id) < 20 or length(p_client_id) > 128 then
    raise exception 'INVALID_LEGACY_ID' using errcode = '22023';
  end if;
  if p_client_id_hash is null or length(p_client_id_hash) <> 64 then
    raise exception 'INVALID_LEGACY_HASH' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('legacy:' || p_client_id_hash, 0));
  select user_id into v_bound_user from public.legacy_device_claims
  where client_id_hash = p_client_id_hash for update;
  if v_bound_user is not null then
    if v_bound_user = p_user_id then return 0; end if;
    raise exception 'LEGACY_DEVICE_ALREADY_CLAIMED' using errcode = '42501';
  end if;

  if not exists (select 1 from public.event_access where client_id = p_client_id) then
    return 0;
  end if;
  insert into public.legacy_device_claims(client_id_hash, user_id)
  values (p_client_id_hash, p_user_id);

  insert into public.list_members(event_id, user_id, role)
  select ea.event_id, p_user_id, case when ea.role = 'owner' then 'owner' else 'editor' end
  from public.event_access ea
  where ea.client_id = p_client_id
  on conflict (event_id, user_id) do update
    set role = case
      when list_members.role = 'owner' or excluded.role = 'owner' then 'owner'
      else 'editor'
    end;
  get diagnostics v_count = row_count;

  update public.events e set created_by = p_user_id
  where e.created_by is null and exists (
    select 1 from public.event_access ea
    where ea.event_id = e.id and ea.client_id = p_client_id and ea.role = 'owner'
  );
  return v_count;
end;
$$;

create or replace function public.create_event_secure(
  p_id text,
  p_name text,
  p_days jsonb,
  p_cpp_event_id text default null
)
returns public.events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_event public.events;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_id is null or length(p_id) < 3 or length(p_id) > 120
     or p_name is null or length(btrim(p_name)) < 1 or length(p_name) > 50
     or jsonb_typeof(coalesce(p_days, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_EVENT_INPUT' using errcode = '22023';
  end if;

  insert into public.events(id, name, days, cpp_event_id, status, created_by, share_seed)
  values (p_id, btrim(p_name), coalesce(p_days, '[]'::jsonb), p_cpp_event_id, 'active', auth.uid(), gen_random_uuid())
  returning * into v_event;
  insert into public.list_members(event_id, user_id, role)
  values (p_id, auth.uid(), 'owner');
  return v_event;
end;
$$;

create or replace function public.delete_or_leave_event(p_event_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_role text;
begin
  select role into v_role from public.list_members
  where event_id = p_event_id and user_id = auth.uid() for update;
  if v_role is null then raise exception 'EVENT_ACCESS_DENIED' using errcode = '42501'; end if;
  if v_role = 'owner' then
    delete from public.wish_items where event_id = p_event_id;
    delete from public.events where id = p_event_id;
    return 'deleted';
  end if;
  delete from public.list_members where event_id = p_event_id and user_id = auth.uid();
  return 'left';
end;
$$;

create or replace function public.get_my_event_membership(p_event_id text)
returns table(role text, is_creator boolean, member_count bigint, collaborator_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select mine.role,
         (e.created_by = auth.uid() or mine.role = 'owner') as is_creator,
         count(all_members.user_id) as member_count,
         count(all_members.user_id) filter (where all_members.role = 'editor') as collaborator_count
  from public.list_members mine
  join public.events e on e.id = mine.event_id
  join public.list_members all_members on all_members.event_id = mine.event_id
  where mine.event_id = p_event_id and mine.user_id = auth.uid()
  group by mine.role, e.created_by;
$$;

create or replace function public.list_my_events()
returns table(
  id text, name text, days jsonb, cpp_event_id text, created_at timestamptz,
  access_role text, is_creator boolean, item_count bigint, collaborator_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id, e.name, e.days, e.cpp_event_id, e.created_at,
         mine.role, (e.created_by = auth.uid() or mine.role = 'owner'),
         (select count(*) from public.wish_items w where w.event_id = e.id),
         (select count(*) from public.list_members lm where lm.event_id = e.id and lm.role = 'editor')
  from public.list_members mine
  join public.events e on e.id = mine.event_id
  where mine.user_id = auth.uid()
  order by e.created_at desc;
$$;

create or replace function public.save_wish_item_cas(
  p_event_id text,
  p_item_id uuid,
  p_expected_version bigint,
  p_patch jsonb
)
returns public.wish_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_item public.wish_items;
begin
  if not public.is_event_member(p_event_id) then
    raise exception 'EVENT_ACCESS_DENIED' using errcode = '42501';
  end if;
  update public.wish_items w set
    booth_number = case when p_patch ? 'booth_number' then p_patch->>'booth_number' else w.booth_number end,
    product_name = case when p_patch ? 'product_name' then p_patch->>'product_name' else w.product_name end,
    author = case when p_patch ? 'author' then nullif(p_patch->>'author', '') else w.author end,
    image_url = case when p_patch ? 'image_url' then nullif(p_patch->>'image_url', '') else w.image_url end,
    item_type = case when p_patch ? 'item_type' then p_patch->>'item_type' else w.item_type end,
    status = case when p_patch ? 'status' then p_patch->>'status' else w.status end,
    priority = case when p_patch ? 'priority' then nullif(p_patch->>'priority', '') else w.priority end,
    note = case when p_patch ? 'note' then nullif(p_patch->>'note', '') else w.note end,
    price = case when p_patch ? 'price' then (p_patch->>'price')::numeric else w.price end,
    quantity = case when p_patch ? 'quantity' then coalesce((p_patch->>'quantity')::integer, 1) else w.quantity end,
    purchase_limit = case when p_patch ? 'purchase_limit' then (p_patch->>'purchase_limit')::integer else w.purchase_limit end,
    cpp_item_id = case when p_patch ? 'cpp_item_id' then (p_patch->>'cpp_item_id')::bigint else w.cpp_item_id end,
    hot_count = case when p_patch ? 'hot_count' then (p_patch->>'hot_count')::integer else w.hot_count end,
    description = case when p_patch ? 'description' then nullif(p_patch->>'description', '') else w.description end,
    version = w.version + 1,
    updated_at = now()
  where w.event_id = p_event_id and w.id = p_item_id and w.version = p_expected_version
  returning w.* into v_item;
  if v_item.id is null then raise exception 'WISH_ITEM_CONFLICT' using errcode = '40001'; end if;
  return v_item;
end;
$$;

create or replace function public.save_wish_items_batch_cas(
  p_event_id text,
  p_items jsonb
)
returns setof public.wish_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry jsonb;
  v_item public.wish_items;
begin
  if not public.is_event_member(p_event_id) then
    raise exception 'EVENT_ACCESS_DENIED' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'INVALID_BATCH' using errcode = '22023';
  end if;
  for v_entry in select value from jsonb_array_elements(p_items)
  loop
    select * into v_item from public.save_wish_item_cas(
      p_event_id,
      (v_entry->>'item_id')::uuid,
      (v_entry->>'expected_version')::bigint,
      coalesce(v_entry->'patch', '{}'::jsonb)
    );
    return next v_item;
  end loop;
  return;
end;
$$;

-- Service-only share helpers. The application server verifies the Bearer JWT,
-- derives HMACs/codes, then supplies the verified user id here.
create or replace function public.get_event_share_material(p_user_id uuid, p_event_id text)
returns table(seed uuid, code_hash text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.share_seed, e.share_code_hash from public.events e
  where e.id = p_event_id and exists (
    select 1 from public.list_members m where m.event_id = e.id and m.user_id = p_user_id
  );
$$;

drop function if exists public.set_event_share_material(uuid,text,uuid,text);
create or replace function public.set_event_share_material(
  p_user_id uuid,
  p_event_id text,
  p_expected_seed uuid,
  p_expected_code_hash text,
  p_seed uuid,
  p_code_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.list_members where event_id = p_event_id and user_id = p_user_id) then
    return false;
  end if;
  update public.events set share_seed = p_seed, share_code_hash = p_code_hash
  where id = p_event_id
    and share_seed is not distinct from p_expected_seed
    and share_code_hash is not distinct from p_expected_code_hash;
  return found;
end;
$$;

create or replace function public.redeem_share_code(
  p_user_id uuid, p_code_hash text, p_ip_hash text
)
returns table(event_id text, event_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window timestamptz := date_trunc('hour', now()) + floor(extract(minute from now()) / 10) * interval '10 minutes';
  v_attempts integer;
  v_event_id text;
begin
  if p_user_id is null or length(p_code_hash) <> 64 or length(p_ip_hash) <> 64 then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(least('u:' || p_user_id::text, 'i:' || p_ip_hash), 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest('u:' || p_user_id::text, 'i:' || p_ip_hash), 0));
  delete from public.share_redemption_attempts where window_started < now() - interval '1 day';
  select coalesce(sum(a.attempt_count), 0)::integer into v_attempts
  from public.share_redemption_attempts a
  where a.window_started = v_window and (a.user_id = p_user_id or a.ip_hash = p_ip_hash);
  if v_attempts >= 12 then return; end if;

  insert into public.share_redemption_attempts(user_id, ip_hash, window_started)
  values (p_user_id, p_ip_hash, v_window)
  on conflict (user_id, ip_hash, window_started) do update
    set attempt_count = public.share_redemption_attempts.attempt_count + 1,
        last_attempt_at = now();

  select e.id into v_event_id from public.events e where e.share_code_hash = p_code_hash;
  if v_event_id is null then return; end if;
  insert into public.list_members(event_id, user_id, role)
  values (v_event_id, p_user_id, 'editor')
  on conflict (event_id, user_id) do update
    set role = case when list_members.role = 'owner' then 'owner' else 'editor' end;
  return query select e.id, e.name from public.events e where e.id = v_event_id;
end;
$$;

-- New security tables are closed during the compatibility window. Existing
-- product tables are intentionally not changed until 007 cutover.
alter table public.list_members enable row level security;
alter table public.legacy_device_claims enable row level security;
alter table public.share_redemption_attempts enable row level security;
drop policy if exists list_members_self_select on public.list_members;
create policy list_members_self_select on public.list_members for select to authenticated
  using (user_id = auth.uid());
revoke all on public.list_members, public.legacy_device_claims, public.share_redemption_attempts from anon, authenticated;
grant select on public.list_members to authenticated;
-- Compatibility grants let the JWT-aware app run before 007 while leaving the
-- legacy anon grants/policies untouched. UPDATE is CAS-only from this point.
grant select on public.events, public.cpp_items to authenticated;
grant select, insert, delete on public.wish_items to authenticated;
revoke update on public.wish_items from authenticated;

revoke all on function public.is_event_member(text) from public;
revoke all on function public.bump_wish_item_version() from public;
revoke all on function public.get_event_role(text) from public;
revoke all on function public.claim_legacy_access(uuid,text,text) from public;
revoke all on function public.create_event_secure(text,text,jsonb,text) from public;
revoke all on function public.delete_or_leave_event(text) from public;
revoke all on function public.get_my_event_membership(text) from public;
revoke all on function public.list_my_events() from public;
revoke all on function public.save_wish_item_cas(text,uuid,bigint,jsonb) from public;
revoke all on function public.save_wish_items_batch_cas(text,jsonb) from public;
revoke all on function public.get_event_share_material(uuid,text) from public;
revoke all on function public.set_event_share_material(uuid,text,uuid,text,uuid,text) from public;
revoke all on function public.redeem_share_code(uuid,text,text) from public;

grant execute on function public.is_event_member(text) to authenticated;
grant execute on function public.get_event_role(text) to authenticated;
grant execute on function public.claim_legacy_access(uuid,text,text) to service_role;
grant execute on function public.create_event_secure(text,text,jsonb,text) to authenticated;
grant execute on function public.delete_or_leave_event(text) to authenticated;
grant execute on function public.get_my_event_membership(text) to authenticated;
grant execute on function public.list_my_events() to authenticated;
grant execute on function public.save_wish_item_cas(text,uuid,bigint,jsonb) to authenticated;
grant execute on function public.save_wish_items_batch_cas(text,jsonb) to authenticated;
grant execute on function public.get_event_share_material(uuid,text) to service_role;
grant execute on function public.set_event_share_material(uuid,text,uuid,text,uuid,text) to service_role;
grant execute on function public.redeem_share_code(uuid,text,text) to service_role;

alter table public.wish_items replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wish_items'
     ) then
    alter publication supabase_realtime add table public.wish_items;
  end if;
end $$;
