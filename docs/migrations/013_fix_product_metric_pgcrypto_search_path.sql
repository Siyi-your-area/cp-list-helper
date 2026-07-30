-- Forward-fix 012 on Supabase projects where pgcrypto is installed in the
-- trusted extensions schema. Function bodies, SECURITY DEFINER and ACLs stay
-- unchanged.

begin;

alter function public.record_page_view(uuid,uuid)
  set search_path = public, extensions, pg_temp;
alter function public.record_list_created_metric()
  set search_path = public, extensions, pg_temp;

commit;
