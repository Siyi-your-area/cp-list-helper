-- CP list帮手：轻量产品指标最近 30 天只读报告
-- 口径：Asia/Shanghai 自然日；不回填 012 上线前的历史数据。
-- 匿名 UV 是 visitor_key 去重数，不等同于自然人数。
-- 创建者去重按 creator_key 统计匿名身份；历史已删除 list 无法回填，
-- list_creations_without_creator > 0 时，该日/区间的创建者人数仅为已知下限。

begin transaction read only;
set local time zone 'Asia/Shanghai';

-- 01. 最近 30 个自然日的 PV、匿名身份 UV、创建 list 数及去重创建者。
with calendar as (
  select generate_series(
    current_date - 29,
    current_date,
    interval '1 day'
  )::date as metric_date
),
daily as (
  select
    metric.metric_date,
    count(*) filter (where metric.event_name = 'page_view') as page_views,
    count(distinct metric.visitor_key)
      filter (where metric.event_name = 'page_view') as anonymous_visitors,
    count(*) filter (where metric.event_name = 'list_created') as lists_created,
    count(distinct metric.creator_key)
      filter (where metric.event_name = 'list_created') as unique_list_creators,
    count(*) filter (
      where metric.event_name = 'list_created' and metric.creator_key is null
    ) as list_creations_without_creator
  from public.product_metric_events metric
  where metric.metric_date between current_date - 29 and current_date
  group by metric.metric_date
)
select
  calendar.metric_date,
  coalesce(daily.page_views, 0) as page_views,
  coalesce(daily.anonymous_visitors, 0) as anonymous_visitors,
  coalesce(daily.lists_created, 0) as lists_created,
  coalesce(daily.unique_list_creators, 0) as unique_list_creators,
  coalesce(daily.list_creations_without_creator, 0) as list_creations_without_creator
from calendar
left join daily using (metric_date)
order by calendar.metric_date;

-- 02. 同一 30 天区间总计；UV 在整个区间去重，不能累加日报 UV。
select
  current_date - 29 as period_start,
  current_date as period_end,
  count(*) filter (where metric.event_name = 'page_view') as cumulative_pv,
  count(distinct metric.visitor_key)
    filter (where metric.event_name = 'page_view') as cumulative_uv,
  count(*) filter (where metric.event_name = 'list_created') as cumulative_list_created,
  count(distinct metric.creator_key)
    filter (where metric.event_name = 'list_created') as cumulative_list_creator_uv,
  count(*) filter (
    where metric.event_name = 'list_created' and metric.creator_key is null
  ) as cumulative_list_created_without_creator
from public.product_metric_events metric
where metric.metric_date between current_date - 29 and current_date;

rollback;
