-- Refresh one accessible list from the latest CPP/CPG item rows.
-- Only booth_number and hot_count are copied into wish_items.

create or replace function public.sync_wish_items_from_cpp(p_event_id text)
returns table(updated_count bigint, matched_count bigint, synced_through timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cpp_event_id text;
  v_days jsonb;
  v_updated_count bigint := 0;
  v_matched_count bigint := 0;
  v_synced_through timestamptz;
begin
  if not public.is_event_member(p_event_id) then
    raise exception 'EVENT_ACCESS_DENIED' using errcode = '42501';
  end if;

  select e.cpp_event_id, e.days
    into v_cpp_event_id, v_days
  from public.events e
  where e.id = p_event_id;

  if v_cpp_event_id is null then
    return query select 0::bigint, 0::bigint, null::timestamptz;
    return;
  end if;

  with latest_cpp as (
    select distinct on (c.doujinshi_id)
      c.doujinshi_id,
      c.booth_number,
      c.hot_count,
      c.source_updated_at
    from public.cpp_items c
    where c.event_id = v_cpp_event_id
      and (
        jsonb_array_length(coalesce(v_days, '[]'::jsonb)) = 0
        or exists (
          select 1
          from jsonb_array_elements(coalesce(v_days, '[]'::jsonb)) day
          where day->>'id' = c.day_id
        )
      )
    order by
      c.doujinshi_id,
      (nullif(btrim(c.booth_number), '') is not null) desc,
      c.source_updated_at desc nulls last,
      c.day_id
  )
  select count(w.id)
  into v_matched_count
  from public.wish_items w
  join latest_cpp c on c.doujinshi_id = w.cpp_item_id
  where w.event_id = p_event_id;

  select max(c.source_updated_at)
  into v_synced_through
  from public.cpp_items c
  where c.event_id = v_cpp_event_id
    and (
      jsonb_array_length(coalesce(v_days, '[]'::jsonb)) = 0
      or exists (
        select 1
        from jsonb_array_elements(coalesce(v_days, '[]'::jsonb)) day
        where day->>'id' = c.day_id
      )
    );

  with latest_cpp as (
    select distinct on (c.doujinshi_id)
      c.doujinshi_id,
      c.booth_number,
      c.hot_count
    from public.cpp_items c
    where c.event_id = v_cpp_event_id
      and (
        jsonb_array_length(coalesce(v_days, '[]'::jsonb)) = 0
        or exists (
          select 1
          from jsonb_array_elements(coalesce(v_days, '[]'::jsonb)) day
          where day->>'id' = c.day_id
        )
      )
    order by
      c.doujinshi_id,
      (nullif(btrim(c.booth_number), '') is not null) desc,
      c.source_updated_at desc nulls last,
      c.day_id
  )
  update public.wish_items w
  set
    booth_number = case
      when nullif(btrim(c.booth_number), '') is not null then c.booth_number
      else w.booth_number
    end,
    hot_count = coalesce(c.hot_count, w.hot_count),
    updated_at = now()
  from latest_cpp c
  where w.event_id = p_event_id
    and w.cpp_item_id = c.doujinshi_id
    and (
      (nullif(btrim(c.booth_number), '') is not null and w.booth_number is distinct from c.booth_number)
      or (c.hot_count is not null and w.hot_count is distinct from c.hot_count)
    );

  get diagnostics v_updated_count = row_count;

  return query select v_updated_count, v_matched_count, v_synced_through;
end;
$$;

revoke all on function public.sync_wish_items_from_cpp(text) from public, anon;
grant execute on function public.sync_wish_items_from_cpp(text) to authenticated;

comment on function public.sync_wish_items_from_cpp(text) is
  'Copies the latest non-empty CPP booth number and valid hot count into one accessible list.';
