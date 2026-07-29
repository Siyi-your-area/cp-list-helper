-- CP list帮手：生产安全切换前只读快照
-- 运行位置：Supabase Dashboard -> SQL Editor
-- 运行时机：暂停应用写入和 CPP 同步之后、执行 006 之前
--
-- 本脚本不会创建、修改或删除任何数据库对象和数据。
-- SQL Editor 会显示多个结果集；请逐个导出并保存，供 postflight 严格比对。
-- 任何标记为 BLOCK 的结果都表示不得继续生产切换。

begin transaction read only;
set local time zone 'UTC';

-- 00. 快照上下文。保存该结果用于标记快照时间和数据库。
select
  'preflight_context' as section,
  current_database() as database_name,
  current_user as executed_by,
  transaction_timestamp() as captured_at,
  current_setting('transaction_read_only') as transaction_read_only,
  current_setting('server_version') as postgres_version;

-- 01. public 中全部普通表及 RLS 状态。
select
  n.nspname as table_schema,
  c.relname as table_name,
  c.relrowsecurity as row_security,
  c.relforcerowsecurity as force_row_security,
  obj_description(c.oid, 'pg_class') as table_comment
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
order by c.relname;

-- 02. public 中全部普通表的完整列定义。
select
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_schema,
  c.udt_name,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale,
  c.datetime_precision,
  c.is_nullable,
  c.column_default,
  c.is_identity,
  c.identity_generation,
  c.is_generated,
  c.generation_expression,
  col_description(
    format('%I.%I', c.table_schema, c.table_name)::regclass::oid,
    c.ordinal_position
  ) as column_comment
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema
 and t.table_name = c.table_name
 and t.table_type = 'BASE TABLE'
where c.table_schema = 'public'
order by c.table_name, c.ordinal_position;

-- 03. 完整约束定义。
select
  rel.relname as table_name,
  con.conname as constraint_name,
  con.contype as constraint_type,
  con.convalidated as is_validated,
  con.condeferrable as is_deferrable,
  con.condeferred as is_initially_deferred,
  pg_get_constraintdef(con.oid, true) as constraint_definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
order by rel.relname, con.conname;

-- 04. 完整索引定义。
select
  tablename as table_name,
  indexname as index_name,
  indexdef as index_definition
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;

-- 05. 完整 RLS policy 基线。
select
  schemaname,
  tablename as table_name,
  policyname as policy_name,
  permissive,
  roles::text as roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 06. 表级权限基线。
select
  table_name,
  grantee,
  privilege_type,
  is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
order by table_name, grantee, privilege_type;

-- 07. 非内部触发器基线。
select
  rel.relname as table_name,
  trg.tgname as trigger_name,
  pg_get_triggerdef(trg.oid, true) as trigger_definition
from pg_trigger trg
join pg_class rel on rel.oid = trg.tgrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
  and not trg.tgisinternal
order by rel.relname, trg.tgname;

-- 08. 每张表的结构指纹。postflight 中对应表必须逐项比对；
-- 安全迁移明确新增的列、约束、索引、policy 除外，不得少表、少旧字段。
with column_lines as (
  select
    c.table_name,
    c.ordinal_position,
    concat_ws(
      '|',
      c.column_name,
      c.data_type,
      c.udt_schema,
      c.udt_name,
      coalesce(c.character_maximum_length::text, ''),
      coalesce(c.numeric_precision::text, ''),
      coalesce(c.numeric_scale::text, ''),
      c.is_nullable,
      coalesce(c.column_default, ''),
      c.is_identity,
      c.identity_generation,
      c.is_generated,
      coalesce(c.generation_expression, '')
    ) as definition
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema
   and t.table_name = c.table_name
   and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public'
)
select
  table_name,
  count(*) as column_count,
  md5(string_agg(definition, E'\n' order by ordinal_position)) as columns_fingerprint
from column_lines
group by table_name
order by table_name;

-- 09. 旧业务数据精确数量。旧行无需迁移身份，但必须物理保留。
select
  (select count(*) from public.events) as events_count,
  (select count(*) from public.event_access) as event_access_count,
  (select count(*) from public.wish_items) as wish_items_count,
  (select count(*) from public.cpp_items) as cpp_items_count,
  (select count(*) from public.wish_items w
     where not exists (select 1 from public.events e where e.id = w.event_id)
  ) as orphan_wish_items_count,
  (select count(*) from public.event_access a
     where not exists (select 1 from public.events e where e.id = a.event_id)
  ) as orphan_event_access_count;

-- 10. 每个旧 list 的行数。postflight 必须逐行比对，不能只比总数。
select
  e.id as event_id,
  e.name as event_name,
  e.cpp_event_id,
  e.created_at,
  count(distinct a.client_id) as legacy_access_count,
  count(distinct w.id) as wish_item_count
from public.events e
left join public.event_access a on a.event_id = e.id
left join public.wish_items w on w.event_id = e.id
group by e.id, e.name, e.cpp_event_id, e.created_at
order by e.id;

-- 11. CPP/CPG 全量内容指纹。依赖 jsonb 的稳定键序和 id 的固定顺序，
-- 会覆盖 cpp_items 的全部现有字段；preflight/postflight 必须完全一致。
with cpp_row_hashes as (
  select
    c.id,
    c.event_id,
    md5(to_jsonb(c)::text) as row_hash
  from public.cpp_items c
)
select
  count(*) as item_count,
  count(distinct c.doujinshi_id) as distinct_doujinshi_count,
  min(c.id) as min_id,
  max(c.id) as max_id,
  min(c.doujinshi_id) as min_doujinshi_id,
  max(c.doujinshi_id) as max_doujinshi_id,
  md5(coalesce(string_agg(h.row_hash, '' order by h.id), '')) as content_fingerprint
from public.cpp_items c
join cpp_row_hashes h on h.id = c.id;

-- 12. CPP/CPG 按 event_id/day_id/type_id 的精确数量和稳定内容指纹。
with cpp_row_hashes as (
  select
    c.id,
    c.event_id,
    c.day_id,
    c.type_id,
    c.doujinshi_id,
    md5(to_jsonb(c)::text) as row_hash
  from public.cpp_items c
)
select
  event_id,
  day_id,
  type_id,
  count(*) as item_count,
  count(distinct doujinshi_id) as distinct_doujinshi_count,
  min(id) as min_id,
  max(id) as max_id,
  min(doujinshi_id) as min_doujinshi_id,
  max(doujinshi_id) as max_doujinshi_id,
  md5(string_agg(row_hash, '' order by id)) as content_fingerprint
from cpp_row_hashes
group by event_id, day_id, type_id
order by event_id, day_id, type_id;

-- 13. CP32 强制门禁。item_count 必须大于 0，且 gate 必须为 PASS。
-- 如果结果为 BLOCK，立即停止，不得执行任何迁移或部署。
with cp32 as (
  select
    count(*) as item_count,
    count(distinct c.doujinshi_id) as distinct_doujinshi_count,
    min(c.id) as min_id,
    max(c.id) as max_id,
    md5(coalesce(
      string_agg(md5(to_jsonb(c)::text), '' order by c.id),
      ''
    )) as content_fingerprint
  from public.cpp_items c
  where c.event_id = 'cp32'
)
select
  case when item_count > 0 then 'PASS' else 'BLOCK' end as gate,
  'CP32 cpp_items must be non-empty and unchanged after cutover' as requirement,
  item_count,
  distinct_doujinshi_count,
  min_id,
  max_id,
  content_fingerprint
from cp32;

-- 14. 保留目录事件基线。event id 与 cpp_items.event_id 相同的行属于目录事件，
-- 本次不为这些旧行创建 owner；保存此清单供 postflight 检查。
select
  e.id as catalog_event_id,
  e.name,
  count(c.id) as cpp_item_count
from public.events e
join public.cpp_items c on c.event_id = e.id
group by e.id, e.name
order by e.id;

rollback;
