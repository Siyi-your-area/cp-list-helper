import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const prepareMigration = read("docs/migrations/006_auth_rls_realtime.sql");
const cutoverMigration = read("docs/migrations/007_auth_rls_cutover.sql");
const serviceRoleFixMigration = read("docs/migrations/008_redeem_share_service_role_grants.sql");
const casConflictFixMigration = read("docs/migrations/009_cas_conflict_sqlstate.sql");
const leastPrivilegeMigration = read("docs/migrations/010_service_role_least_privilege.sql");
const serviceRpcAclFixMigration = read("docs/migrations/011_service_rpc_execute_acl.sql");
const analyticsMigration = read("docs/migrations/012_lightweight_product_metrics.sql");
const analyticsPgcryptoFixMigration = read("docs/migrations/013_fix_product_metric_pgcrypto_search_path.sql");
const migration = `${prepareMigration}\n${serviceRoleFixMigration}\n${casConflictFixMigration}\n${leastPrivilegeMigration}\n${serviceRpcAclFixMigration}\n${cutoverMigration}`;
const productionPreflight = read("docs/sql/production-cutover-preflight.sql");
const productionPostflight = read("docs/sql/production-cutover-postflight.sql");
const rolloutGuide = read("docs/11-security-realtime-rollout.md");

test("migration establishes JWT membership RLS for protected tables", () => {
  for (const table of ["events", "wish_items", "event_access", "cpp_items", "list_members", "legacy_device_claims", "share_redemption_attempts"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.match(migration, /wish_items_member_(select|insert|update|delete)/i);
  assert.match(migration, /list_members_self_select/i);
  assert.match(migration, /cpp_items_public_select[\s\S]*for select to anon, authenticated/i);
  assert.doesNotMatch(migration, /cpp_items_public_(insert|update|delete)/i);
});

test("legacy device claim is one-time, locked and service-role-only", () => {
  assert.match(migration, /create table if not exists public\.legacy_device_claims[\s\S]*client_id_hash text primary key[\s\S]*user_id uuid not null/i);
  assert.match(migration, /claim_legacy_access\([\s\S]*p_user_id uuid[\s\S]*p_client_id_hash text/i);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('legacy:' \|\| p_client_id_hash/i);
  assert.match(migration, /if v_bound_user = p_user_id then return 0;[\s\S]*LEGACY_DEVICE_ALREADY_CLAIMED/i);
  assert.match(migration, /grant execute on function public\.claim_legacy_access\(uuid,text,text\) to service_role/i);
  assert.doesNotMatch(migration, /grant execute on function public\.claim_legacy_access[^;]+to authenticated/i);
  const claimRoute = read("app/api/auth/claim/route.ts");
  assert.match(claimRoute, /authenticateRequest\(request\)/);
  assert.match(claimRoute, /getServerEnv\("LEGACY_CLAIM_ENABLED"\) !== "true"/);
  assert.match(claimRoute, /createServiceRoleClient\(\)/);
  assert.match(claimRoute, /hashLegacyClientId\(clientId\)/);
});

test("security definer RPCs pin search_path and privileged share RPCs are service-only", () => {
  const definerFunctions = migration.match(/security definer/g) || [];
  const pinnedPaths = migration.match(/set search_path = public, pg_temp/g) || [];
  assert.ok(definerFunctions.length >= 9);
  assert.ok(pinnedPaths.length >= definerFunctions.length);
  assert.match(migration, /grant execute on function public\.redeem_share_code\(uuid,text,text\) to service_role/i);
  assert.doesNotMatch(migration, /grant execute on function public\.redeem_share_code[^;]+to authenticated/i);
});

test("share redemption stores hashes, rotates legacy plaintext and rate limits", () => {
  assert.doesNotMatch(prepareMigration, /update public\.events set share_code = null/i);
  assert.match(cutoverMigration, /update public\.events set share_code = null/i);
  assert.match(migration, /share_code_hash text/i);
  assert.match(migration, /ip_hash text/i);
  assert.match(migration, /v_attempts >= 12/i);
  assert.doesNotMatch(migration, /create table[^;]+share_code\s+text/is);
});

test("008 removes redeem output-column ambiguity without changing its API contract", () => {
  assert.match(serviceRoleFixMigration, /create or replace function public\.redeem_share_code\([\s\S]*returns table\(event_id text, event_name text\)/i);
  assert.match(serviceRoleFixMigration, /on conflict on constraint share_redemption_attempts_pkey do update/i);
  assert.match(serviceRoleFixMigration, /on conflict on constraint list_members_pkey do update/i);
  assert.doesNotMatch(serviceRoleFixMigration, /on conflict\s*\(\s*event_id\s*,\s*user_id\s*\)/i);
  assert.match(serviceRoleFixMigration, /return query[\s\S]*select event_row\.id, event_row\.name/i);
  assert.match(serviceRoleFixMigration, /revoke all on function public\.redeem_share_code\(uuid,text,text\) from public, anon, authenticated/i);
  assert.match(serviceRoleFixMigration, /grant execute on function public\.redeem_share_code\(uuid,text,text\) to service_role/i);
});

test("008 grants only the direct service-role objects required by CPP sync", () => {
  assert.match(serviceRoleFixMigration, /grant usage on schema public to service_role/i);
  assert.match(serviceRoleFixMigration, /revoke all on table public\.cpp_items from service_role/i);
  assert.match(serviceRoleFixMigration, /grant select, insert, update on table public\.cpp_items to service_role/i);
  assert.match(serviceRoleFixMigration, /pg_get_serial_sequence\('public\.cpp_items', 'id'\)/i);
  assert.match(serviceRoleFixMigration, /grant usage on sequence %s to service_role/i);
  assert.doesNotMatch(serviceRoleFixMigration, /grant[^;]*delete[^;]*to service_role/i);
  assert.doesNotMatch(serviceRoleFixMigration, /grant[^;]*on table public\.(events|wish_items|event_access|list_members|legacy_device_claims|share_redemption_attempts)[^;]*to service_role/i);
});

test("010 closes direct service-role table access and future default grants", () => {
  assert.match(leastPrivilegeMigration, /revoke all privileges on schema public from public, service_role/i);
  assert.match(leastPrivilegeMigration, /grant usage on schema public to anon, authenticated, service_role/i);
  for (const table of [
    "events",
    "wish_items",
    "event_access",
    "list_members",
    "legacy_device_claims",
    "share_redemption_attempts",
  ]) {
    assert.match(
      leastPrivilegeMigration,
      new RegExp(`revoke all privileges on table[\\s\\S]*public\\.${table}[\\s\\S]*from public, service_role`, "i"),
    );
  }
  assert.match(leastPrivilegeMigration, /revoke all privileges on table public\.cpp_items from public, service_role/i);
  assert.match(leastPrivilegeMigration, /grant select, insert, update on table public\.cpp_items to service_role/i);
  assert.match(leastPrivilegeMigration, /revoke all privileges on sequence %s from public, service_role/i);
  assert.match(leastPrivilegeMigration, /grant usage on sequence %s to service_role/i);
  assert.match(leastPrivilegeMigration, /alter default privileges in schema public[\s\S]*revoke all privileges on tables from public, service_role/i);
  assert.match(leastPrivilegeMigration, /alter default privileges in schema public[\s\S]*revoke all privileges on sequences from public, service_role/i);

  for (const signature of [
    String.raw`claim_legacy_access\(uuid,text,text\)`,
    String.raw`get_event_share_material\(uuid,text\)`,
    String.raw`set_event_share_material\(uuid,text,uuid,text,uuid,text\)`,
    String.raw`redeem_share_code\(uuid,text,text\)`,
  ]) {
    assert.match(
      leastPrivilegeMigration,
      new RegExp(`grant execute on function public\\.${signature} to service_role`, "i"),
    );
  }
});

test("011 makes all four exact service RPC signatures service-role-only", () => {
  for (const signature of [
    String.raw`claim_legacy_access\(uuid,text,text\)`,
    String.raw`get_event_share_material\(uuid,text\)`,
    String.raw`set_event_share_material\(uuid,text,uuid,text,uuid,text\)`,
    String.raw`redeem_share_code\(uuid,text,text\)`,
  ]) {
    assert.match(
      serviceRpcAclFixMigration,
      new RegExp(`revoke execute on function public\\.${signature}\\s+from public, anon, authenticated`, "i"),
    );
    assert.match(
      serviceRpcAclFixMigration,
      new RegExp(`grant execute on function public\\.${signature} to service_role`, "i"),
    );
    assert.doesNotMatch(
      serviceRpcAclFixMigration,
      new RegExp(`grant execute on function public\\.${signature} to (?:public|anon|authenticated)`, "i"),
    );
  }
});

test("012 keeps metric storage closed and page-view recording service-only", () => {
  assert.match(
    analyticsMigration,
    /alter table public\.product_metric_events enable row level security/i,
  );
  assert.match(
    analyticsMigration,
    /revoke all privileges on table public\.product_metric_events\s+from public, anon, authenticated, service_role/i,
  );
  assert.doesNotMatch(analyticsMigration, /create policy[\s\S]*product_metric_events/i);
  assert.match(
    analyticsMigration,
    /create or replace function public\.record_page_view\([\s\S]*security definer[\s\S]*set search_path = public, pg_temp/i,
  );
  assert.match(
    analyticsMigration,
    /revoke all privileges on function public\.record_page_view\(uuid,uuid\)\s+from public, anon, authenticated, service_role/i,
  );
  assert.match(
    analyticsMigration,
    /grant execute on function public\.record_page_view\(uuid,uuid\) to service_role/i,
  );
  assert.match(
    analyticsMigration,
    /revoke all privileges on function public\.record_list_created_metric\(\)\s+from public, anon, authenticated, service_role/i,
  );
});

test("013 exposes trusted pgcrypto without changing metric function logic or ACLs", () => {
  assert.match(
    analyticsPgcryptoFixMigration,
    /alter function public\.record_page_view\(uuid,uuid\)\s+set search_path = public, extensions, pg_temp/i,
  );
  assert.match(
    analyticsPgcryptoFixMigration,
    /alter function public\.record_list_created_metric\(\)\s+set search_path = public, extensions, pg_temp/i,
  );
  assert.doesNotMatch(
    analyticsPgcryptoFixMigration,
    /create or replace function|security invoker|grant|revoke/i,
  );
});

test("006 is compatibility prepare and 007 performs enforcement", () => {
  for (const table of ["events", "wish_items", "event_access", "cpp_items"]) {
    assert.doesNotMatch(prepareMigration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(cutoverMigration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.doesNotMatch(prepareMigration, /revoke all on public\.events/i);
  assert.match(cutoverMigration, /revoke all on public\.events/i);
});

test("006-013 never mutate CPP rows or remove existing tables and columns", () => {
  for (const sql of [
    prepareMigration,
    cutoverMigration,
    serviceRoleFixMigration,
    casConflictFixMigration,
    leastPrivilegeMigration,
    serviceRpcAclFixMigration,
    analyticsMigration,
    analyticsPgcryptoFixMigration,
  ]) {
    assert.doesNotMatch(sql, /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?cpp_items\b/i);
    assert.doesNotMatch(sql, /\btruncate\b/i);
    assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
    assert.doesNotMatch(sql, /\balter\s+table\s+(?:public\.)?\w+\s+drop\s+(?:column|constraint)\b/i);
  }
  assert.match(cutoverMigration, /update public\.events set share_code = null where share_code is not null/i);
});

test("production cutover snapshots are read-only and protect CP32 data", () => {
  for (const sql of [productionPreflight, productionPostflight]) {
    assert.match(sql, /begin transaction read only\s*;/i);
    assert.match(sql, /rollback\s*;\s*$/i);
    assert.doesNotMatch(
      sql,
      /^\s*(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|comment|copy|call|do)\b/im,
    );
    assert.match(sql, /information_schema\.columns/i);
    assert.match(sql, /pg_constraint/i);
    assert.match(sql, /pg_indexes/i);
    assert.match(sql, /pg_policies/i);
    assert.match(sql, /content_fingerprint/i);
    assert.match(sql, /event_id\s*=\s*'cp32'/i);
    assert.match(sql, /group by event_id,\s*day_id,\s*type_id/i);
  }
  assert.match(productionPreflight, /case when item_count > 0 then 'PASS' else 'BLOCK'/i);
  assert.match(productionPostflight, /catalog_events_have_no_members/i);
  assert.match(productionPostflight, /legacy_identity_claims_disabled/i);
  assert.match(
    productionPostflight,
    /public_schema_service_usage_only[\s\S]*has_schema_privilege\('service_role', 'public', 'USAGE'\)[\s\S]*not has_schema_privilege\('service_role', 'public', 'CREATE'\)/i,
  );
  const exactRpcGate = productionPostflight.match(
    /'service_rpcs_exact_execute'[\s\S]*?'four exact service RPC signatures execute as service_role but not anon\/authenticated or PUBLIC'/i,
  )?.[0] || "";
  for (const signature of [
    "public.claim_legacy_access(uuid,text,text)",
    "public.get_event_share_material(uuid,text)",
    "public.set_event_share_material(uuid,text,uuid,text,uuid,text)",
    "public.redeem_share_code(uuid,text,text)",
  ]) {
    assert.match(exactRpcGate, new RegExp(signature.replace(/[().]/g, "\\$&"), "i"));
  }
  assert.match(exactRpcGate, /to_regprocedure\(required\.signature\)/i);
  assert.match(exactRpcGate, /has_function_privilege\('service_role', resolved\.function_oid, 'EXECUTE'\)/i);
  assert.match(exactRpcGate, /not has_function_privilege\('anon', resolved\.function_oid, 'EXECUTE'\)/i);
  assert.match(exactRpcGate, /not has_function_privilege\('authenticated', resolved\.function_oid, 'EXECUTE'\)/i);

  const defaultAclGate = productionPostflight.match(
    /'public_default_acl_least_privilege'[\s\S]*?'migration owner default ACL grants no future public tables\/sequences to PUBLIC or service_role'/i,
  )?.[0] || "";
  assert.match(defaultAclGate, /from pg_default_acl/i);
  assert.match(defaultAclGate, /aclexplode\(default_acl\.defaclacl\)/i);
  assert.match(defaultAclGate, /default_acl\.defaclrole[\s\S]*owner_role\.rolname = current_user/i);
  assert.match(defaultAclGate, /default_acl\.defaclnamespace in \(0, 'public'::regnamespace::oid\)/i);
  assert.match(defaultAclGate, /default_acl\.defaclobjtype in \('r', 'S'\)/i);
  assert.match(defaultAclGate, /privilege\.grantee = 0/i);
  assert.match(defaultAclGate, /service_role\.rolname = 'service_role'/i);

  assert.match(productionPostflight, /protected_tables_no_service_role_direct_access/i);
  const serviceRoleTableGate = productionPostflight.match(
    /'protected_tables_no_service_role_direct_access'[\s\S]*?'service_role has no effective direct privilege on protected application tables'/i,
  )?.[0] || "";
  for (const table of [
    "events",
    "wish_items",
    "event_access",
    "list_members",
    "legacy_device_claims",
    "share_redemption_attempts",
  ]) {
    assert.match(serviceRoleTableGate, new RegExp(`public\\.${table}`, "i"));
  }
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
    assert.match(
      serviceRoleTableGate,
      new RegExp(`has_table_privilege\\('service_role', protected\\.table_name, '${privilege}'\\)`, "i"),
    );
  }
  assert.match(productionPostflight, /has_sequence_privilege\([\s\S]*pg_get_serial_sequence\('public\.cpp_items', 'id'\)[\s\S]*'USAGE'/i);
});

test("007 production cutover is documented as one SQL Editor run", () => {
  assert.match(rolloutGuide, /006[\s\S]*008[\s\S]*009[\s\S]*010[\s\S]*011[\s\S]*部署新应用[\s\S]*007/i);
  assert.match(rolloutGuide, /重跑 006[\s\S]*重跑 008、009、010、011/i);
  assert.match(rolloutGuide, /begin;[\s\S]*007_auth_rls_cutover\.sql[\s\S]*commit;/i);
  assert.match(rolloutGuide, /同一个查询[\s\S]*只点击一次 \*\*Run\*\*/i);
  assert.match(rolloutGuide, /不能分三次运行/i);
  assert.match(rolloutGuide, /事务标记为 aborted/i);
  assert.match(rolloutGuide, /不要再单独运行 `commit;`/i);
});

test("realtime and optimistic concurrency contract is permanent", () => {
  assert.match(migration, /add column if not exists version bigint not null default 1/i);
  assert.match(migration, /WISH_ITEM_CONFLICT/i);
  assert.match(migration, /replica identity full/i);
  assert.match(migration, /alter publication supabase_realtime add table public\.wish_items/i);
});

test("draft saves use one atomic batch CAS RPC", () => {
  assert.match(migration, /function public\.save_wish_items_batch_cas\([\s\S]*returns setof public\.wish_items/i);
  assert.match(migration, /jsonb_array_elements\(p_items\)[\s\S]*save_wish_item_cas/i);
  assert.match(migration, /grant execute on function public\.save_wish_items_batch_cas\(text,jsonb\) to authenticated/i);
  assert.match(prepareMigration, /function public\.save_wish_item_cas[\s\S]*security definer[\s\S]*is_event_member\(p_event_id\)/i);
  assert.match(prepareMigration, /function public\.save_wish_items_batch_cas[\s\S]*security definer[\s\S]*is_event_member\(p_event_id\)/i);
  assert.match(prepareMigration, /revoke update on public\.wish_items from authenticated/i);
  assert.doesNotMatch(cutoverMigration, /grant select, insert, update, delete on public\.wish_items/i);
  const service = read("lib/db-service.ts");
  const implementation = service.match(/export async function saveWishItemDrafts[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(implementation, /supabase\.rpc\("save_wish_items_batch_cas"/);
  assert.doesNotMatch(implementation, /for\s*\(/);
});

test("009 reports single and batch CAS conflicts without a retryable SQLSTATE", () => {
  assert.match(casConflictFixMigration, /create or replace function public\.save_wish_item_cas\([\s\S]*returns public\.wish_items/i);
  assert.match(casConflictFixMigration, /raise exception using errcode = 'P0001', message = 'WISH_ITEM_CONFLICT'/i);
  assert.doesNotMatch(casConflictFixMigration, /errcode\s*=\s*'40001'/i);
  assert.match(casConflictFixMigration, /revoke all on function public\.save_wish_item_cas\(text,uuid,bigint,jsonb\) from public, anon, authenticated/i);
  assert.match(casConflictFixMigration, /grant execute on function public\.save_wish_item_cas\(text,uuid,bigint,jsonb\) to authenticated/i);

  const batchFunction = prepareMigration.match(/create or replace function public\.save_wish_items_batch_cas[\s\S]*?\n\$\$;/i)?.[0] || "";
  assert.match(batchFunction, /returns setof public\.wish_items/i);
  assert.match(batchFunction, /jsonb_array_elements\(p_items\)[\s\S]*public\.save_wish_item_cas\(/i);

  const service = read("lib/db-service.ts");
  const singleCall = service.match(/export async function updateWishItem[\s\S]*?\n}/)?.[0] || "";
  const batchCall = service.match(/export async function saveWishItemDrafts[\s\S]*?\n}/)?.[0] || "";
  assert.match(singleCall, /supabase\.rpc\("save_wish_item_cas"/);
  assert.match(batchCall, /supabase\.rpc\("save_wish_items_batch_cas"/);
  assert.doesNotMatch(batchCall, /for\s*\(/);

  const hook = read("hooks/useExhibitData.ts");
  assert.match(hook, /message\?\.includes\("WISH_ITEM_CONFLICT"\)/);
});

test("first realtime subscription refreshes the query/subscription gap", () => {
  const hook = read("hooks/useExhibitData.ts");
  assert.match(hook, /status === "SUBSCRIBED"[\s\S]*setSyncStatus\("live"\);[\s\S]*void refresh\(\)/);
});

test("anonymous sessions explicitly authenticate Realtime before subscribing", () => {
  const authClient = read("lib/auth-client.ts");
  const realtimeSetup = authClient.match(/async function setRealtimeSession[\s\S]*?\n}/)?.[0] || "";
  assert.match(realtimeSetup, /await supabase\.realtime\.setAuth\(session\.access_token\)/);
  assert.doesNotMatch(realtimeSetup, /console\.|access_token\s*[,}]/);
  assert.match(authClient, /existing\.session\) return setRealtimeSession\(existing\.session\)/);
  assert.match(authClient, /return setRealtimeSession\(data\.session\)/);

  const hook = read("hooks/useExhibitData.ts");
  assert.match(hook, /await ensureAnonymousSession\(\)[\s\S]*setReady\(true\)/);
  assert.match(hook, /if \(!ready\) return;[\s\S]*\.channel\(`/);
});

test("share material writes use expected-value CAS and retry on a lost race", () => {
  assert.match(prepareMigration, /set_event_share_material\([\s\S]*p_expected_seed uuid[\s\S]*p_expected_code_hash text/i);
  assert.match(prepareMigration, /share_seed is not distinct from p_expected_seed[\s\S]*share_code_hash is not distinct from p_expected_code_hash/i);
  const route = read("app/api/share/route.ts");
  assert.match(route, /p_expected_seed: currentSeed/);
  assert.match(route, /p_expected_code_hash: currentHash/);
  assert.match(route, /if \(!saved\) \{[\s\S]*continue;/);
  assert.doesNotMatch(route, /if \(!saved\) return/);
});

test("remote delete conflicts cannot recreate a wish item", () => {
  const hook = read("hooks/useExhibitData.ts");
  const resolver = hook.match(/const keepMyConflict[\s\S]*?\n  }, \[conflicts, eventId\]\);/)?.[0] || "";
  assert.match(resolver, /if \(!conflict\?\.remote\) return/);
  assert.doesNotMatch(resolver, /createWishItemAsync/);
  const page = read("app/exhibit/[id]/page.tsx");
  assert.match(page, /conflicts\[0\]\.kind === "deleted" \? "确认删除"/);
  assert.match(page, /conflicts\[0\]\.kind === "updated" &&/);
});

test("server APIs authenticate JWTs and sync cannot fall back to anon writes", () => {
  for (const route of [
    "app/api/exhibits/route.ts",
    "app/api/exhibits/[id]/route.ts",
    "app/api/share/route.ts",
    "app/api/cpp/match/route.ts",
    "app/api/auth/claim/route.ts",
    "app/api/analytics/page-view/route.ts",
  ]) {
    assert.match(read(route), /authenticateRequest\(request\)/, route);
  }
  const sync = read("scripts/sync-cpp-data.mjs");
  assert.match(sync, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(sync, /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(sync, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
});

test("server secrets prefer Cloudflare bindings with a process environment fallback", () => {
  const serverEnv = read("lib/server-env.ts");
  const supabaseServer = read("lib/supabase-server.ts");
  const shareSecurity = read("lib/share-security.ts");
  const wrangler = read("wrangler.jsonc");

  assert.match(serverEnv, /getCloudflareContext\(\)\.env/);
  assert.match(serverEnv, /selectServerEnvValue\(cloudflareValue, process\.env\[name\]\)/);
  assert.match(serverEnv, /typeof cloudflareValue === "string"[\s\S]*return cloudflareValue[\s\S]*return processValue/);
  assert.match(supabaseServer, /requireServerEnv\("NEXT_PUBLIC_SUPABASE_URL"\)/);
  assert.match(supabaseServer, /requireServerEnv\("NEXT_PUBLIC_SUPABASE_ANON_KEY"\)/);
  assert.match(supabaseServer, /requireServerEnv\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  assert.doesNotMatch(supabaseServer, /process\.env/);
  assert.match(shareSecurity, /getServerEnv\("SHARE_CODE_SECRET"\)/);
  assert.match(wrangler, /"staging"\s*:\s*\{/);
});

test("JWT validation diagnostics never include bearer material", () => {
  const supabaseServer = read("lib/supabase-server.ts");
  const diagnostic = supabaseServer.match(/console\.warn\("\[Server Auth\][\s\S]*?\n\s*}\);/)?.[0] || "";

  assert.match(diagnostic, /code:/);
  assert.match(diagnostic, /status:/);
  assert.doesNotMatch(diagnostic, /accessToken|authorization|Bearer/);
});
