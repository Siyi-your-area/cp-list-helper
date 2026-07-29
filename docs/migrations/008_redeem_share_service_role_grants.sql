-- Fix the share redemption RPC and make the application's service-role object
-- grants explicit. Requires 006 and is safe to apply before or after 007.

begin;

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
  delete from public.share_redemption_attempts as attempt
  where attempt.window_started < now() - interval '1 day';
  select coalesce(sum(attempt.attempt_count), 0)::integer into v_attempts
  from public.share_redemption_attempts as attempt
  where attempt.window_started = v_window
    and (attempt.user_id = p_user_id or attempt.ip_hash = p_ip_hash);
  if v_attempts >= 12 then return; end if;

  insert into public.share_redemption_attempts as attempt
    (user_id, ip_hash, window_started)
  values (p_user_id, p_ip_hash, v_window)
  on conflict on constraint share_redemption_attempts_pkey do update
    set attempt_count = attempt.attempt_count + 1,
        last_attempt_at = now();

  select event_row.id into v_event_id
  from public.events as event_row
  where event_row.share_code_hash = p_code_hash;
  if v_event_id is null then return; end if;

  insert into public.list_members as member
    (event_id, user_id, role)
  values (v_event_id, p_user_id, 'editor')
  on conflict on constraint list_members_pkey do update
    set role = case when member.role = 'owner' then 'owner' else 'editor' end;

  return query
    select event_row.id, event_row.name
    from public.events as event_row
    where event_row.id = v_event_id;
end;
$$;

revoke all on function public.redeem_share_code(uuid,text,text) from public, anon, authenticated;
grant execute on function public.redeem_share_code(uuid,text,text) to service_role;

-- The server APIs use SECURITY DEFINER RPCs and therefore need EXECUTE only.
-- Direct service-role table access is limited to the CPP synchronization job:
-- it reads existing hashes and performs inserts/updates through UPSERT.
grant usage on schema public to service_role;
revoke all on table public.cpp_items from service_role;
grant select, insert, update on table public.cpp_items to service_role;

do $$
declare
  v_cpp_items_sequence regclass;
begin
  v_cpp_items_sequence := pg_get_serial_sequence('public.cpp_items', 'id')::regclass;
  if v_cpp_items_sequence is not null then
    execute format('revoke all on sequence %s from service_role', v_cpp_items_sequence);
    execute format('grant usage on sequence %s to service_role', v_cpp_items_sequence);
  end if;
end;
$$;

commit;
