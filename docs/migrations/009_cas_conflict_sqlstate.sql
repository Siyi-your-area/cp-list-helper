-- Make optimistic-concurrency conflicts fail fast through PostgREST.
-- Requires 006. Safe to apply before or after 007/008.

begin;

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
  if v_item.id is null then
    raise exception using errcode = 'P0001', message = 'WISH_ITEM_CONFLICT';
  end if;
  return v_item;
end;
$$;

revoke all on function public.save_wish_item_cas(text,uuid,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.save_wish_item_cas(text,uuid,bigint,jsonb) to authenticated;

commit;
