-- The migration does not require a deterministic order. Avoid sorting large
-- toasted Base64 values so each batch can return immediately.

begin;

create or replace function public.list_wish_item_inline_images(p_limit integer default 10)
returns table(id uuid, event_id text, image_url text, version bigint)
language sql
security definer
set search_path = public, pg_temp
as $$
  select w.id, w.event_id, w.image_url, w.version
  from public.wish_items w
  where w.image_url like 'data:image/%;base64,%'
  limit least(greatest(coalesce(p_limit, 10), 1), 25);
$$;

revoke all on function public.list_wish_item_inline_images(integer) from public, anon, authenticated;
grant execute on function public.list_wish_item_inline_images(integer) to service_role;

commit;
