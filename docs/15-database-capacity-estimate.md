# 数据库容量估算（2026-08-04）

> 2026-08-04 一次只读生产快照，不是实时值。按 Supabase Free plan 500 MiB 估算；官方说明超出计划容量后可能进入只读模式，见 [Database Size](https://supabase.com/docs/guides/platform/database-size)。

## 只读快照

| 指标 | bytes | rows |
|---|---:|---:|
| database | 97,176,723 | — |
| `cpp_items` | 84,459,520 | 104,329 |
| `wish_items` | 507,904 | 467 |
| `events` | 65,536 | 8 |
| `list_members` | 65,536 | 4 |
| `event_access` | 65,536 | 6 |
| `product_metric_events` | 114,688 | 105 |
| `auth.users` | 212,992 | 26 |

平均 payload：event 180.38 B、wish item 469.6 B、member 79.25 B、metric 124.09 B。payload 不含索引、TOAST、页面空闲空间和关系固定页，不能直接替代关系容量。

## 预算与区间

```text
500 MiB = 524,288,000 bytes
30% reserve = 157,286,400 bytes
remaining = 524,288,000 - 157,286,400 - 97,176,723
          = 269,824,877 bytes
```

保守地按当前小表关系大小均摊：wish item `507,904/467=1,087.59 B`、event `8,192 B`、member `16,384 B`、每条 metric `1,092.27 B`。假设每张 list 有 50 条 wish、1 event、1 member、1 metric，总计约 `80,048 B/list`，可容纳约 3,370 张。

关系固定页被增长摊薄后，中性/理想估计约 `55 KB/list`，可容纳约 4,906 张。因此保留 30% 安全余量时规划区间为 **3,300–4,900 张 list**，建议 **3,000 张**作为运营警戒点。不留 30% 时约 **5,300–7,700 张**，不建议作为安全目标。

`product_metric_events` 随访问独立增长，`auth.users` 随身份独立增长，均不能简单视为每-list 常量。`cpp_items` 当前占库主体；CPG 新增、表/索引膨胀、VACUUM、JSON/数组和未来索引都会压缩预算。

## 只读复跑 SQL

```sql
select pg_database_size(current_database()) as database_bytes;

select 'public.cpp_items' relation, pg_total_relation_size('public.cpp_items') relation_bytes, count(*) rows from public.cpp_items
union all select 'public.wish_items', pg_total_relation_size('public.wish_items'), count(*) from public.wish_items
union all select 'public.events', pg_total_relation_size('public.events'), count(*) from public.events
union all select 'public.list_members', pg_total_relation_size('public.list_members'), count(*) from public.list_members
union all select 'public.event_access', pg_total_relation_size('public.event_access'), count(*) from public.event_access
union all select 'public.product_metric_events', pg_total_relation_size('public.product_metric_events'), count(*) from public.product_metric_events
union all select 'auth.users', pg_total_relation_size('auth.users'), count(*) from auth.users;

select
  (select avg(pg_column_size(t)) from public.events t) avg_event_payload_bytes,
  (select avg(pg_column_size(t)) from public.wish_items t) avg_wish_item_payload_bytes,
  (select avg(pg_column_size(t)) from public.list_members t) avg_member_payload_bytes,
  (select avg(pg_column_size(t)) from public.product_metric_events t) avg_metric_payload_bytes;
```

以上只执行 SELECT/只读容量函数，仍需相应 schema/关系的读取权限。
