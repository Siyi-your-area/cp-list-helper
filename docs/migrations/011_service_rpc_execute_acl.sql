-- Close inherited and explicit browser-role EXECUTE grants on service-only
-- SECURITY DEFINER RPCs. Requires 006 and is safe before or after 007.

begin;

revoke execute on function public.claim_legacy_access(uuid,text,text)
  from public, anon, authenticated;
revoke execute on function public.get_event_share_material(uuid,text)
  from public, anon, authenticated;
revoke execute on function public.set_event_share_material(uuid,text,uuid,text,uuid,text)
  from public, anon, authenticated;
revoke execute on function public.redeem_share_code(uuid,text,text)
  from public, anon, authenticated;

grant execute on function public.claim_legacy_access(uuid,text,text) to service_role;
grant execute on function public.get_event_share_material(uuid,text) to service_role;
grant execute on function public.set_event_share_material(uuid,text,uuid,text,uuid,text) to service_role;
grant execute on function public.redeem_share_code(uuid,text,text) to service_role;

commit;
