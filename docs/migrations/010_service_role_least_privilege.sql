-- Close direct service-role table access while preserving the SECURITY DEFINER
-- RPC contract and the minimum privileges required by CPP synchronization.
-- Requires 006, 008 and 009. Safe to apply before or after 007.

begin;

revoke all privileges on schema public from public, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- PUBLIC grants are also removed so service_role cannot regain effective table
-- access through PUBLIC membership.
revoke all privileges on table
  public.events,
  public.wish_items,
  public.event_access,
  public.list_members,
  public.legacy_device_claims,
  public.share_redemption_attempts
from public, service_role;

revoke all privileges on table public.cpp_items from public, service_role;
grant select, insert, update on table public.cpp_items to service_role;

do $$
declare
  v_cpp_items_sequence regclass;
begin
  v_cpp_items_sequence := pg_get_serial_sequence('public.cpp_items', 'id')::regclass;
  if v_cpp_items_sequence is not null then
    execute format('revoke all privileges on sequence %s from public, service_role', v_cpp_items_sequence);
    execute format('grant usage on sequence %s to service_role', v_cpp_items_sequence);
  end if;
end;
$$;

-- Future tables and sequences created by the migration role must also start
-- closed. Application access must always be granted explicitly.
alter default privileges in schema public
  revoke all privileges on tables from public, service_role;
alter default privileges in schema public
  revoke all privileges on sequences from public, service_role;

grant execute on function public.claim_legacy_access(uuid,text,text) to service_role;
grant execute on function public.get_event_share_material(uuid,text) to service_role;
grant execute on function public.set_event_share_material(uuid,text,uuid,text,uuid,text) to service_role;
grant execute on function public.redeem_share_code(uuid,text,text) to service_role;

commit;
