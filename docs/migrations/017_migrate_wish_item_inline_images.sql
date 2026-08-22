-- Narrow service-role helpers for moving legacy inline images into Supabase Storage.
-- They expose only Base64 image rows and only allow replacing those rows with the
-- public URL of the dedicated wish-item image bucket.

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
  order by w.id
  limit least(greatest(coalesce(p_limit, 10), 1), 25);
$$;

create or replace function public.replace_wish_item_inline_image(
  p_item_id uuid,
  p_expected_version bigint,
  p_image_url text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if p_image_url not like '%/storage/v1/object/public/wish-item-images/%' then
    raise exception 'INVALID_WISH_ITEM_IMAGE_URL';
  end if;

  update public.wish_items
  set image_url = p_image_url,
      version = version + 1,
      updated_at = now()
  where id = p_item_id
    and version = p_expected_version
    and image_url like 'data:image/%;base64,%';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.list_wish_item_inline_images(integer) from public, anon, authenticated;
revoke all on function public.replace_wish_item_inline_image(uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.list_wish_item_inline_images(integer) to service_role;
grant execute on function public.replace_wish_item_inline_image(uuid,bigint,text) to service_role;

commit;
