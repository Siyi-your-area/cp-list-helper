-- CP list帮手：生产安全切换后只读验收
-- 运行位置：Supabase Dashboard -> SQL Editor
-- 运行时机：006 -> 008 -> 009 -> 010 -> 011 -> 新应用 -> 事务内 007 完成之后，恢复写入之前
--
-- 本脚本不会创建、修改或删除任何数据库对象和数据。
-- SQL Editor 会显示多个结果集；请逐个导出，与 preflight 结果严格比对。
-- 任一自动门禁为 BLOCK，或人工比对不一致，都不得恢复生产写入。

begin transaction read only;
set local time zone 'UTC';

-- 00. 验收上下文。
select
  'postflight_context' as section,
  current_database() as database_name,
  current_user as executed_by,
  transaction_timestamp() as captured_at,
  current_setting('transaction_read_only') as transaction_read_only,
  current_setting('server_version') as postgres_version;

-- 01. 自动安全门禁。每一行都必须是 PASS。
with gates as (
  select
    'protected_tables_rls'::text as gate_name,
    (
      select count(*) = 7
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'events', 'wish_items', 'event_access', 'cpp_items',
          'list_members', 'legacy_device_claims', 'share_redemption_attempts'
        )
        and c.relrowsecurity
    ) as passed,
    '7 protected tables exist and have RLS enabled'::text as expectation

  union all
  select
    'cpp_items_public_select_only',
    exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'cpp_items'
        and policyname = 'cpp_items_public_select'
        and cmd = 'SELECT'
        and roles @> array['anon', 'authenticated']::name[]
    )
    and not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'cpp_items'
        and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    'anon/authenticated have a SELECT policy and no CPP write policy'

  union all
  select
    'cpp_items_browser_grants',
    has_table_privilege('anon', 'public.cpp_items', 'SELECT')
      and not has_table_privilege('anon', 'public.cpp_items', 'INSERT')
      and not has_table_privilege('anon', 'public.cpp_items', 'UPDATE')
      and not has_table_privilege('anon', 'public.cpp_items', 'DELETE')
      and has_table_privilege('authenticated', 'public.cpp_items', 'SELECT')
      and not has_table_privilege('authenticated', 'public.cpp_items', 'INSERT')
      and not has_table_privilege('authenticated', 'public.cpp_items', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.cpp_items', 'DELETE'),
    'browser roles can read cpp_items but cannot write it directly'

  union all
  select
    'public_schema_service_usage_only',
    has_schema_privilege('service_role', 'public', 'USAGE')
      and not has_schema_privilege('service_role', 'public', 'CREATE'),
    'service_role can use public schema but cannot create objects in it'

  union all
  select
    'cpp_items_service_grants',
    has_table_privilege('service_role', 'public.cpp_items', 'SELECT')
      and has_table_privilege('service_role', 'public.cpp_items', 'INSERT')
      and has_table_privilege('service_role', 'public.cpp_items', 'UPDATE')
      and not has_table_privilege('service_role', 'public.cpp_items', 'DELETE')
      and not has_table_privilege('service_role', 'public.cpp_items', 'TRUNCATE')
      and not has_table_privilege('service_role', 'public.cpp_items', 'REFERENCES')
      and not has_table_privilege('service_role', 'public.cpp_items', 'TRIGGER')
      and has_sequence_privilege(
        'service_role',
        pg_get_serial_sequence('public.cpp_items', 'id'),
        'USAGE'
      )
      and not has_sequence_privilege(
        'service_role',
        pg_get_serial_sequence('public.cpp_items', 'id'),
        'SELECT'
      )
      and not has_sequence_privilege(
        'service_role',
        pg_get_serial_sequence('public.cpp_items', 'id'),
        'UPDATE'
      ),
    'service_role has only SELECT/INSERT/UPDATE on cpp_items and USAGE on its id sequence'

  union all
  select
    'protected_tables_no_service_role_direct_access',
    not exists (
      select 1
      from (
        values
          ('public.events'),
          ('public.wish_items'),
          ('public.event_access'),
          ('public.list_members'),
          ('public.legacy_device_claims'),
          ('public.share_redemption_attempts')
      ) as protected(table_name)
      where has_table_privilege('service_role', protected.table_name, 'SELECT')
         or has_table_privilege('service_role', protected.table_name, 'INSERT')
         or has_table_privilege('service_role', protected.table_name, 'UPDATE')
         or has_table_privilege('service_role', protected.table_name, 'DELETE')
         or has_table_privilege('service_role', protected.table_name, 'TRUNCATE')
         or has_table_privilege('service_role', protected.table_name, 'REFERENCES')
         or has_table_privilege('service_role', protected.table_name, 'TRIGGER')
    ),
    'service_role has no effective direct privilege on protected application tables'

  union all
  select
    'wish_items_cas_only_update',
    has_table_privilege('authenticated', 'public.wish_items', 'SELECT')
      and has_table_privilege('authenticated', 'public.wish_items', 'INSERT')
      and has_table_privilege('authenticated', 'public.wish_items', 'DELETE')
      and not has_table_privilege('authenticated', 'public.wish_items', 'UPDATE'),
    'authenticated UPDATE is RPC/CAS-only'

  union all
  select
    'service_rpcs_exact_execute',
    (
      select bool_and(
        resolved.function_oid is not null
        and has_function_privilege('service_role', resolved.function_oid, 'EXECUTE')
        and not has_function_privilege('anon', resolved.function_oid, 'EXECUTE')
        and not has_function_privilege('authenticated', resolved.function_oid, 'EXECUTE')
      )
      from (
        values
          ('public.claim_legacy_access(uuid,text,text)'),
          ('public.get_event_share_material(uuid,text)'),
          ('public.set_event_share_material(uuid,text,uuid,text,uuid,text)'),
          ('public.redeem_share_code(uuid,text,text)')
      ) as required(signature)
      cross join lateral (
        select to_regprocedure(required.signature) as function_oid
      ) as resolved
    ),
    'four exact service RPC signatures execute as service_role but not anon/authenticated or PUBLIC'

  union all
  select
    'public_default_acl_least_privilege',
    not exists (
      select 1
      from pg_default_acl default_acl
      cross join lateral aclexplode(default_acl.defaclacl) privilege
      where default_acl.defaclrole = (
          select owner_role.oid
          from pg_roles owner_role
          where owner_role.rolname = current_user
        )
        and default_acl.defaclnamespace in (0, 'public'::regnamespace::oid)
        and default_acl.defaclobjtype in ('r', 'S')
        and (
          privilege.grantee = 0
          or privilege.grantee = (
            select service_role.oid
            from pg_roles service_role
            where service_role.rolname = 'service_role'
          )
        )
    ),
    'migration owner default ACL grants no future public tables/sequences to PUBLIC or service_role'

  union all
  select
    'wish_items_realtime',
    exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'wish_items'
    ),
    'wish_items is in the supabase_realtime publication'

  union all
  select
    'legacy_plaintext_share_codes_cleared',
    not exists (select 1 from public.events where share_code is not null),
    '007 cleared old events.share_code plaintext values'

  union all
  select
    'legacy_identity_claims_disabled',
    not exists (select 1 from public.legacy_device_claims),
    'no old client_id was migrated into a JWT identity'

  union all
  select
    'catalog_events_have_no_members',
    not exists (
      select 1
      from public.list_members m
      where m.event_id in (select distinct c.event_id from public.cpp_items c)
    ),
    'retained catalog event rows were not assigned owner/editor members'

  union all
  select
    'cp32_data_present',
    exists (select 1 from public.cpp_items where event_id = 'cp32'),
    'CP32 cpp_items is non-empty'
)
select
  case when passed then 'PASS' else 'BLOCK' end as gate,
  gate_name,
  expectation
from gates
order by gate_name;

-- 02. public 中全部普通表及 RLS 状态。
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

-- 03. public 中全部普通表的完整列定义。
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

-- 04. 完整约束定义。
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

-- 05. 完整索引定义。
select
  tablename as table_name,
  indexname as index_name,
  indexdef as index_definition
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;

-- 06. 完整 RLS policy 验收结果。
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

-- 07. 表级权限验收结果。
select
  table_name,
  grantee,
  privilege_type,
  is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
order by table_name, grantee, privilege_type;

-- 08. 非内部触发器验收结果。
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

-- 09. 每张表的结构指纹。迁移允许新增结构，不允许任一旧表或旧字段消失；
-- 应结合 03 的完整列清单，而不是只看指纹是否相同。
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

-- 10. 旧业务数据精确数量。events/event_access/wish_items 必须与 preflight 相同；
-- list_members 和 legacy_device_claims 不得由旧数据自动回填。
select
  (select count(*) from public.events) as events_count,
  (select count(*) from public.event_access) as event_access_count,
  (select count(*) from public.wish_items) as wish_items_count,
  (select count(*) from public.cpp_items) as cpp_items_count,
  (select count(*) from public.list_members) as list_members_count,
  (select count(*) from public.legacy_device_claims) as legacy_device_claims_count,
  (select count(*) from public.wish_items w
     where not exists (select 1 from public.events e where e.id = w.event_id)
  ) as orphan_wish_items_count,
  (select count(*) from public.event_access a
     where not exists (select 1 from public.events e where e.id = a.event_id)
  ) as orphan_event_access_count;

-- 11. 每个旧 list 的行数。必须与 preflight 逐行一致。
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

-- 12. CPP/CPG 全量内容指纹。必须与 preflight 完全一致。
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

-- 13. CPP/CPG 分组内容指纹。每一行必须与 preflight 完全一致。
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

-- 14. CP32 强制门禁。除 gate=PASS 外，数量、ID 范围和内容指纹也必须与
-- preflight 完全相同，否则即使非空也不得恢复生产写入。
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
  'CP32 cpp_items must be non-empty and exactly match preflight' as requirement,
  item_count,
  distinct_doujinshi_count,
  min_id,
  max_id,
  content_fingerprint
from cp32;

-- 15. 保留目录事件成员检查。结果必须全部为 0；不为旧目录事件伪造 owner。
select
  e.id as catalog_event_id,
  e.name,
  count(c.id) as cpp_item_count,
  count(distinct m.user_id) as member_count,
  count(distinct m.user_id) filter (where m.role = 'owner') as owner_count,
  case when count(distinct m.user_id) = 0 then 'PASS' else 'BLOCK' end as gate
from public.events e
join public.cpp_items c on c.event_id = e.id
left join public.list_members m on m.event_id = e.id
group by e.id, e.name
order by e.id;

rollback;
