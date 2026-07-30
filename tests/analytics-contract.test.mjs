import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("docs/migrations/012_lightweight_product_metrics.sql");
const pgcryptoFixMigration = read("docs/migrations/013_fix_product_metric_pgcrypto_search_path.sql");
const route = read("app/api/analytics/page-view/route.ts");
const tracker = read("components/PageViewTracker.tsx");
const layout = read("app/layout.tsx");
const about = read("app/about/page.tsx");
const report = read("docs/sql/analytics-report.sql");
const deployment = read("docs/06-deployment.md");

test("metric table stores only the approved minimal fields", () => {
  const table = migration.match(
    /create table if not exists public\.product_metric_events \(([\s\S]*?)\n\);\n\ncreate index/i,
  )?.[1] || "";
  const columns = [...table.matchAll(
    /^\s{2}([a-z_][a-z0-9_]*)\s+(?:uuid|text|date|timestamptz)\b/gm,
  )].map((match) => match[1]);

  assert.deepEqual(columns, [
    "id",
    "event_name",
    "metric_date",
    "occurred_at",
    "visitor_key",
  ]);
  for (const forbidden of [
    "path",
    "query",
    "ip",
    "user_agent",
    "ua",
    "referrer",
    "list_id",
    "file",
    "payload",
    "raw_user_id",
    "user_id",
  ]) {
    assert.ok(!columns.includes(forbidden), forbidden);
  }
  assert.match(table, /id uuid primary key/i);
  assert.match(table, /event_name text not null[\s\S]*check \(event_name in \('page_view', 'list_created'\)\)/i);
  assert.match(table, /metric_date date not null[\s\S]*now\(\) at time zone 'Asia\/Shanghai'/i);
  assert.match(table, /occurred_at timestamptz not null default now\(\)/i);
  assert.match(table, /event_name = 'page_view'[\s\S]*visitor_key is not null[\s\S]*length\(visitor_key\) = 64/i);
  assert.match(table, /event_name = 'list_created'[\s\S]*visitor_key is null/i);
});

test("metric table is closed and indexed without an RLS policy", () => {
  assert.match(migration, /idx_product_metric_events_day_event[\s\S]*\(metric_date, event_name\)/i);
  assert.match(migration, /idx_product_metric_events_visitor_time[\s\S]*\(visitor_key, occurred_at desc\)/i);
  assert.match(migration, /alter table public\.product_metric_events enable row level security/i);
  assert.match(
    migration,
    /revoke all privileges on table public\.product_metric_events\s+from public, anon, authenticated, service_role/i,
  );
  assert.doesNotMatch(migration, /create policy[\s\S]*product_metric_events/i);
});

test("page-view RPC hashes the verified UID, is idempotent and rate limited", () => {
  const rpc = migration.match(
    /create or replace function public\.record_page_view\([\s\S]*?\n\$\$;/i,
  )?.[0] || "";

  assert.match(rpc, /security definer[\s\S]*set search_path = public, pg_temp/i);
  assert.match(rpc, /encode\(digest\(p_user_id::text, 'sha256'\), 'hex'\)/i);
  assert.match(rpc, /pg_advisory_xact_lock\([\s\S]*v_visitor_key/i);
  assert.match(rpc, /metric\.id = p_view_id[\s\S]*return true/i);
  assert.match(rpc, /metric\.occurred_at >= now\(\) - interval '1 minute'/i);
  assert.match(rpc, /if v_recent_count >= 30 then[\s\S]*return false/i);
  assert.match(rpc, /insert into public\.product_metric_events\(id, event_name, visitor_key\)/i);
  assert.match(rpc, /values \(p_view_id, 'page_view', v_visitor_key\)/i);
  assert.match(rpc, /on conflict \(id\) do nothing/i);
  assert.doesNotMatch(rpc, /insert into public\.product_metric_events\([^)]*user_id/i);
  assert.match(
    migration,
    /revoke all privileges on function public\.record_page_view\(uuid,uuid\)\s+from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.record_page_view\(uuid,uuid\) to service_role/i,
  );
});

test("013 forward-fixes both exact metric function search paths", () => {
  assert.match(
    pgcryptoFixMigration,
    /alter function public\.record_page_view\(uuid,uuid\)\s+set search_path = public, extensions, pg_temp/i,
  );
  assert.match(
    pgcryptoFixMigration,
    /alter function public\.record_list_created_metric\(\)\s+set search_path = public, extensions, pg_temp/i,
  );
  assert.doesNotMatch(pgcryptoFixMigration, /create or replace function|security invoker|grant|revoke/i);
  assert.doesNotMatch(
    pgcryptoFixMigration,
    /\b(?:insert|update|delete|truncate|drop\s+table|alter\s+table)\b/i,
  );
  assert.match(pgcryptoFixMigration, /begin\s*;[\s\S]*commit\s*;/i);
});

test("list-created metric is owner-only, idempotent and fail-open", () => {
  const triggerFunction = migration.match(
    /create or replace function public\.record_list_created_metric\(\)[\s\S]*?\n\$\$;/i,
  )?.[0] || "";

  assert.match(triggerFunction, /returns trigger[\s\S]*security definer[\s\S]*set search_path = public, pg_temp/i);
  assert.match(triggerFunction, /if new\.role is distinct from 'owner' then[\s\S]*return new/i);
  assert.match(triggerFunction, /digest\('list_created:' \|\| new\.event_id, 'sha256'\)/i);
  assert.match(triggerFunction, /substring\(v_digest from 1 for 8\)[\s\S]*::uuid/i);
  assert.match(triggerFunction, /values \(v_metric_id, 'list_created', null\)/i);
  assert.match(triggerFunction, /on conflict \(id\) do nothing/i);
  assert.match(
    triggerFunction,
    /exception\s+when others then\s+raise warning 'PRODUCT_METRIC_LIST_CREATED_FAILED';\s+return new/i,
  );
  assert.doesNotMatch(triggerFunction, /sqlerrm|sqlstate|raise warning[^;]*(?:new\.|event_id)/i);
  assert.match(
    migration,
    /create trigger list_members_record_list_created_metric\s+after insert on public\.list_members/i,
  );
  assert.doesNotMatch(migration, /create trigger[\s\S]*after insert on public\.events/i);
  assert.match(
    migration,
    /revoke all privileges on function public\.record_list_created_metric\(\)\s+from public, anon, authenticated, service_role/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.record_list_created_metric\(\)/i,
  );
});

test("page-view API accepts only a small viewId payload and fails open on metric writes", () => {
  assert.match(route, /const MAX_BODY_BYTES = 256/);
  assert.match(route, /authenticateRequest\(request\)/);
  assert.match(route, /contentType !== "application\/json"[\s\S]*400/);
  assert.match(route, /keys\.length === 1[\s\S]*keys\[0\] === "viewId"/);
  assert.match(route, /UUID_PATTERN\.test/);
  assert.match(route, /declaredLength > MAX_BODY_BYTES[\s\S]*413/);
  assert.match(route, /TextEncoder\(\)\.encode\(rawBody\)\.byteLength > MAX_BODY_BYTES[\s\S]*413/);
  assert.match(route, /JSON\.parse\(rawBody\)/);
  assert.match(route, /service\.rpc\("record_page_view", \{[\s\S]*p_user_id: userId,[\s\S]*p_view_id: payload\.viewId/);
  assert.match(route, /const NO_STORE_HEADERS = \{ "Cache-Control": "no-store" \}/i);
  assert.match(route, /new NextResponse\(null, \{ status: 204, headers: NO_STORE_HEADERS \}\)/i);
  assert.match(route, /return jsonError\("登录状态无效", 401\)/);
  assert.match(route, /return jsonError\("请求参数无效", 400\)/);
  assert.match(route, /catch \(error\) \{[\s\S]*code: "ANALYTICS_RPC_FAILED"[\s\S]*sqlstate: sqlStateOf\(error\)[\s\S]*return noContent\(\)/);
  assert.doesNotMatch(route, /nextUrl|searchParams|cf-connecting-ip|user-agent|referer|referrer/i);

  const diagnostic = route.match(
    /console\.warn\("\[Analytics API\] metric write failed"[\s\S]*?\n\s*}\);/i,
  )?.[0] || "";
  assert.match(diagnostic, /code: "ANALYTICS_RPC_FAILED"/);
  assert.match(diagnostic, /sqlstate:/);
  assert.doesNotMatch(diagnostic, /rawBody|payload|userId|request|token|authorization|\bip\b/i);
});

test("global tracker records real pathname commits without sending the pathname", () => {
  assert.match(tracker, /usePathname\(\)/);
  assert.match(tracker, /useRef<string \| null>\(null\)/);
  assert.match(tracker, /previousPath\.current === pathname/);
  assert.match(tracker, /previousPath\.current = pathname/);
  assert.match(tracker, /const viewId = createCompatibleUUID\(\)/);
  assert.match(tracker, /authFetch\("\/api\/analytics\/page-view"/);
  assert.match(tracker, /body: JSON\.stringify\(\{ viewId \}\)/);
  assert.match(tracker, /\.catch\(\(\) => undefined\)/);
  assert.doesNotMatch(tracker, /JSON\.stringify\([^)]*pathname|body:[^\n]*pathname/i);
  assert.match(layout, /import \{ PageViewTracker \}[\s\S]*<PageViewTracker \/>/);
});

test("about page discloses metric scope, retention and exclusions", () => {
  assert.match(about, /访问统计与隐私/);
  assert.match(about, /页面访问量（PV）/);
  assert.match(about, /匿名身份访问量（UV）/);
  assert.match(about, /成功创建list/);
  assert.match(about, /保留90天/);
  assert.match(about, /不保存IP、list识别码或内容、上传文件名、搜索和编辑输入/);
  assert.match(about, /不等同于自然人数，也不表示完全匿名/);
});

test("analytics report is read-only and uses the approved 30-day metrics", () => {
  assert.match(report, /begin transaction read only\s*;/i);
  assert.match(report, /set local time zone 'Asia\/Shanghai'/i);
  assert.match(report, /current_date - 29/i);
  assert.match(report, /count\(\*\) filter \(where metric\.event_name = 'page_view'\)/i);
  assert.match(report, /count\(distinct metric\.visitor_key\)[\s\S]*event_name = 'page_view'/i);
  assert.match(report, /count\(\*\) filter \(where metric\.event_name = 'list_created'\)/i);
  assert.match(report, /不回填 012 上线前的历史数据/);
  assert.match(report, /不等同于自然人数/);
  assert.match(report, /rollback\s*;\s*$/i);
  assert.doesNotMatch(
    report,
    /^\s*(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|comment|copy|call|do)\b/im,
  );
  assert.match(
    deployment,
    /012_lightweight_product_metrics\.sql[\s\S]*013_fix_product_metric_pgcrypto_search_path\.sql[\s\S]*才部署/i,
  );
  assert.match(deployment, /occurred_at < now\(\) - interval '90 days'/i);
});
