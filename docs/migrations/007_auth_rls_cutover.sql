-- CP List Helper auth/RLS ENFORCE migration.
-- Prerequisites: 006 applied, Anonymous Auth and server secrets enabled, new app
-- deployed and validated. Apply in a short maintenance window.

-- Rotate away all legacy plaintext codes only at the security cutover.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'events' and column_name = 'share_code'
  ) then
    update public.events set share_code = null where share_code is not null;
  end if;
end $$;

-- Remove every pre-existing permissive policy before establishing the contract.
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and tablename in
             ('events','wish_items','event_access','cpp_items','list_members','legacy_device_claims','share_redemption_attempts')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.events enable row level security;
alter table public.wish_items enable row level security;
alter table public.event_access enable row level security;
alter table public.cpp_items enable row level security;
alter table public.list_members enable row level security;
alter table public.legacy_device_claims enable row level security;
alter table public.share_redemption_attempts enable row level security;

create policy events_member_select on public.events for select to authenticated
  using (public.is_event_member(id));
create policy wish_items_member_select on public.wish_items for select to authenticated
  using (public.is_event_member(event_id));
create policy wish_items_member_insert on public.wish_items for insert to authenticated
  with check (public.is_event_member(event_id));
create policy wish_items_member_update on public.wish_items for update to authenticated
  using (public.is_event_member(event_id)) with check (public.is_event_member(event_id));
create policy wish_items_member_delete on public.wish_items for delete to authenticated
  using (public.is_event_member(event_id));
create policy list_members_self_select on public.list_members for select to authenticated
  using (user_id = auth.uid());
create policy cpp_items_public_select on public.cpp_items for select to anon, authenticated
  using (true);

revoke all on public.events, public.wish_items, public.event_access, public.cpp_items,
  public.list_members, public.legacy_device_claims, public.share_redemption_attempts from anon, authenticated;
grant select on public.cpp_items to anon, authenticated;
grant select on public.events, public.list_members to authenticated;
grant select, insert, delete on public.wish_items to authenticated;
