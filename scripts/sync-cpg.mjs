#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseCPGEventPage } from "./cpp-snapshot-core.mjs";

const CPP_ORIGIN = "https://www.allcpp.cn";
const SOURCE_EVENT_ID = "7073";
const DATABASE_EVENT_ID = "cpg08";
const PAGE_SIZE = 1000;
const SEARCH_WORKERS = 4;
const DETAIL_WORKERS = 8;
const UPSERT_BATCH_SIZE = 500;
const CPP_REQUEST_INTERVAL_MS = 600;
const DETAIL_REQUEST_INTERVAL_MS = 200;
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const WRITE_FIELDS = [
  "event_id", "day_id", "type_id", "type_name", "doujinshi_id", "product_name",
  "author", "booth_number", "booth_name", "image_url", "tags", "source_url",
  "hot_count", "original_work", "exchange_type", "description", "normalized_booth",
  "normalized_product", "normalized_author", "booth_aliases", "product_aliases",
  "source_updated_at",
];

let cppRequestQueue = Promise.resolve();
let detailRequestQueue = Promise.resolve();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForCppTurn() {
  const turn = cppRequestQueue.then(() => wait(CPP_REQUEST_INTERVAL_MS));
  cppRequestQueue = turn.catch(() => {});
  return turn;
}

function waitForDetailTurn() {
  const turn = detailRequestQueue.then(() => wait(DETAIL_REQUEST_INTERVAL_MS));
  detailRequestQueue = turn.catch(() => {});
  return turn;
}

function loadLocalEnv(filename) {
  if (!existsSync(filename)) return;
  for (const line of readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value.replace(/\\n/g, "\n");
  }
}

function cookieHeader() {
  if (process.env.CPP_COOKIE?.trim()) return process.env.CPP_COOKIE.trim();
  let raw = process.env.CPP_COOKIE_JSON;
  if (!raw && existsSync("cpp-cookies.json")) raw = readFileSync("cpp-cookies.json", "utf8");
  if (!raw) throw new Error("缺少 CPP_COOKIE 或 CPP_COOKIE_JSON");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("CPP_COOKIE_JSON 必须是 Cookie 数组");
  return parsed.filter((item) => item?.name && item?.value != null).map((item) => `${item.name}=${item.value}`).join("; ");
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").replace(/[\s\u00a0]+/g, "").replace(/[·•・—–－_\-~～,，。.!！?？:：;；'"“”‘’()[\]（）【】{}《》「」『』]/g, "").toLowerCase();
}

function aliases(value) {
  const values = new Set([normalize(value)]);
  for (const match of String(value ?? "").matchAll(/[【\[《「『(（]([^】\]》」』)）]+)[】\]》」』)）]/g)) values.add(normalize(match[1]));
  return [...values].filter((item) => item.length >= 2);
}

function boothAliases(value) {
  const matches = String(value ?? "").match(/[一-鿿]+[A-Z]?\d+/g) || [String(value ?? "")];
  return [...new Set(matches.map(normalize).filter(Boolean))];
}

function cacheDirectory(dayId) {
  return path.resolve(".tmp", "cpg-sync", dayId);
}

function cacheFile(dayId, typeId) {
  return path.join(cacheDirectory(dayId), `${typeId}.json`);
}

function detailCacheFile(dayId, doujinshiId) {
  return path.join(cacheDirectory(dayId), "details", `${doujinshiId}.json`);
}

function loadCachedType(dayId, type) {
  const filename = cacheFile(dayId, type.id);
  if (!existsSync(filename) || Date.now() - statSync(filename).mtimeMs > CACHE_MAX_AGE_MS) return null;
  const cached = JSON.parse(readFileSync(filename, "utf8"));
  if (cached?.dayId !== dayId || cached?.typeId !== type.id || cached?.typeName !== type.name || !Array.isArray(cached?.rows)) return null;
  return cached.rows;
}

function saveCachedType(dayId, type, rows) {
  const directory = cacheDirectory(dayId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(cacheFile(dayId, type.id), JSON.stringify({ dayId, typeId: type.id, typeName: type.name, rows }), "utf8");
}


function loadCachedDetail(dayId, doujinshiId) {
  const filename = detailCacheFile(dayId, doujinshiId);
  if (!existsSync(filename) || Date.now() - statSync(filename).mtimeMs > CACHE_MAX_AGE_MS) return null;
  const cached = JSON.parse(readFileSync(filename, "utf8"));
  return cached?.doujinshiId === doujinshiId && cached?.detail && typeof cached.detail === "object" ? cached.detail : null;
}

function saveCachedDetail(dayId, doujinshiId, detail) {
  const filename = detailCacheFile(dayId, doujinshiId);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify({ doujinshiId, detail }), "utf8");
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validExchangeType(value) {
  const text = String(value ?? "").trim();
  if (text.includes("无料")) return "无料交换";
  if (text.includes("有偿")) return "有偿交换";
  return "";
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function request(url, options, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20000) });
    if (response.ok) return response;
    if (![429, 502, 503, 504].includes(response.status) || attempt === 3) {
      const body = await response.text();
      throw new Error(`${label} HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    await wait(attempt * 1000);
  }
  throw new Error(`${label} 请求失败`);
}

async function cppRequest(url, options, label) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await waitForCppTurn();
    const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20000) });
    if (response.ok) return response;
    if (![429, 502, 503, 504].includes(response.status) || attempt === 8) throw new Error(`${label} HTTP ${response.status}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 2000);
  }
  throw new Error(`${label} 请求失败`);
}

async function detailRequest(url, options, label) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await waitForDetailTurn();
    const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20000) });
    if (response.ok) return response;
    if (![429, 502, 503, 504].includes(response.status) || attempt === 8) throw new Error(`${label} HTTP ${response.status}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 2000);
  }
  throw new Error(`${label} 请求失败`);
}

async function mapPool(items, workers, task) {
  let cursor = 0;
  const output = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await task(items[index], index);
    }
  }));
  return output;
}

async function discover(cookie) {
  const response = await cppRequest(`${CPP_ORIGIN}/allcpp/event/eventdoujinshi.do?event=${SOURCE_EVENT_ID}`, {
    headers: { Accept: "text/html", Cookie: cookie, "User-Agent": "CP-List-Helper-CPG-Sync/1.0" },
  }, "CPG 活动页");
  return parseCPGEventPage(await response.text());
}

function searchRow(item, dayId, type) {
  const event = Array.isArray(item.eventList)
    ? item.eventList.find((entry) => String(entry?.eventID ?? entry?.eventId) === dayId)
    : null;
  if (!Number.isSafeInteger(item?.doujinshiId) || !nonEmpty(item?.doujinshiName) || !event) return null;
  const author = Array.isArray(item.authorList)
    ? item.authorList.map((entry) => String(entry?.authorName ?? "").trim()).filter(Boolean).join(", ")
    : "";
  const hotCount = Number(item.hotCount);
  return {
    event_id: DATABASE_EVENT_ID,
    day_id: dayId,
    type_id: type.id,
    type_name: type.name,
    doujinshi_id: item.doujinshiId,
    product_name: item.doujinshiName.trim(),
    author,
    booth_number: String(event.position ?? "").trim(),
    booth_name: String(event.circleName ?? "").trim(),
    image_url: item.coverPicUrl ? `https://imagecdn3.allcpp.cn/upload${item.coverPicUrl}` : "",
    tags: item.tag ? String(item.tag).split("|").map((tag) => tag.trim()).filter(Boolean) : [],
    source_url: `${CPP_ORIGIN}/d/${item.doujinshiId}.do`,
    hot_count: Number.isSafeInteger(hotCount) && hotCount >= 0 ? hotCount : null,
    original_work: String(item.themeAlias ?? "").trim(),
  };
}

async function scanType(cookie, dayId, type) {
  const rows = new Map();
  let pageIndex = 1;
  let declaredTotal = null;
  while (true) {
    const url = new URL("/api/doujinshi/search.do", CPP_ORIGIN);
    url.search = new URLSearchParams({ eventId: dayId, keyword: "", orderBy: "0", typeIds: String(type.id), pageIndex: String(pageIndex), pageSize: String(PAGE_SIZE), sellStatus: "", ideaType: "", tag: "", ideaStatus: "" });
    const response = await cppRequest(url, { headers: { Accept: "application/json", Cookie: cookie, "User-Agent": "CP-List-Helper-CPG-Sync/1.0" } }, `${type.name} 第 ${pageIndex} 页`);
    const json = await response.json();
    if (json?.isSuccess !== true || !Array.isArray(json?.result?.list)) throw new Error(`${type.name} 第 ${pageIndex} 页响应无效`);
    const list = json.result.list;
    if (declaredTotal == null && Number.isSafeInteger(json.result.total)) declaredTotal = json.result.total;
    if (list.length === 0) break;
    for (const item of list) {
      const row = searchRow(item, dayId, type);
      if (row) rows.set(row.doujinshi_id, row);
    }
    pageIndex += 1;
    if (pageIndex > 2000) throw new Error(`${type.name} 分页超过合理上限`);
  }
  console.log(`  ${type.name}: ${rows.size}${declaredTotal == null ? "" : ` / 页面报告 ${declaredTotal}`}`);
  return [...rows.values()];
}

function parseDetail(html) {
  const result = { exchange_type: "", description: "" };
  const exchange = html.match(/交换[：:]\s*([^<"\n]+)/);
  if (exchange) result.exchange_type = validExchangeType(exchange[1]);
  const description = html.match(/class=["']djs-tab-box info textEllipsis["'][^>]*>([\s\S]*?)<\/div>/);
  if (description) result.description = description[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return result;
}

async function fetchDetail(cookie, doujinshiId) {
  const response = await detailRequest(`${CPP_ORIGIN}/d/${doujinshiId}.do`, {
    headers: { Accept: "text/html", Cookie: cookie, "User-Agent": "CP-List-Helper-CPG-Sync/1.0" },
  }, `制品 ${doujinshiId} 详情`);
  return parseDetail(await response.text());
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_CPP_SYNC_KEY || process.env.SUPABASE_CPP_PROMOTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("缺少 SUPABASE_URL");
  if (!key) throw new Error("缺少 SUPABASE_CPP_SYNC_KEY（或 SUPABASE_SERVICE_ROLE_KEY）");
  const headers = { apikey: key };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  return { origin: new URL(url).origin, headers };
}

async function selectExisting(config, dayId) {
  const rows = [];
  while (true) {
    const url = new URL("/rest/v1/cpp_items", config.origin);
    url.searchParams.set("select", "*");
    url.searchParams.set("event_id", `eq.${DATABASE_EVENT_ID}`);
    url.searchParams.set("day_id", `eq.${dayId}`);
    url.searchParams.set("order", "doujinshi_id.asc");
    url.searchParams.set("offset", String(rows.length));
    url.searchParams.set("limit", "1000");
    const response = await request(url, { headers: config.headers }, "读取 Supabase CPG 数据");
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("Supabase 返回格式无效");
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function mergeRow(source, current, detail, now) {
  const result = current ? { ...current } : {
    event_id: source.event_id,
    day_id: source.day_id,
    doujinshi_id: source.doujinshi_id,
    exchange_type: "",
    description: "",
  };
  for (const field of ["type_id", "type_name", "product_name", "tags", "source_url"]) result[field] = source[field];
  for (const field of ["author", "booth_number", "booth_name", "image_url", "original_work"]) {
    if (nonEmpty(source[field])) result[field] = source[field];
  }
  if (Number.isSafeInteger(source.hot_count) && source.hot_count >= 0) result.hot_count = source.hot_count;
  if (nonEmpty(detail?.description)) result.description = detail.description;
  const exchangeType = validExchangeType(detail?.exchange_type);
  if (exchangeType) result.exchange_type = exchangeType;
  result.normalized_booth = normalize(result.booth_number);
  result.normalized_product = normalize(result.product_name);
  result.normalized_author = normalize(result.author);
  result.booth_aliases = boothAliases(result.booth_number);
  result.product_aliases = aliases(result.product_name);
  result.source_updated_at = now;
  delete result.source_hash;
  delete result.crawl_run_id;
  delete result.created_at;
  delete result.id;
  return result;
}

function baseChanged(source, current) {
  if (!current) return true;
  for (const field of ["type_id", "type_name", "product_name", "tags", "source_url", "hot_count"]) {
    if (!sameValue(source[field], current[field])) return true;
  }
  for (const field of ["author", "booth_number", "booth_name", "image_url", "original_work"]) {
    if (nonEmpty(source[field]) && !sameValue(source[field], current[field])) return true;
  }
  return false;
}

async function upsert(config, rows) {
  for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH_SIZE) {
    const url = new URL("/rest/v1/cpp_items", config.origin);
    url.searchParams.set("on_conflict", "event_id,day_id,doujinshi_id");
    const batch = rows.slice(offset, offset + UPSERT_BATCH_SIZE).map((row) => Object.fromEntries(
      WRITE_FIELDS.map((field) => {
        if (row[field] != null) return [field, row[field]];
        if (["tags", "booth_aliases", "product_aliases"].includes(field)) return [field, []];
        if (field === "hot_count") return [field, 0];
        return [field, ""];
      }),
    ));
    const response = await request(url, {
      method: "POST",
      headers: { ...config.headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(batch),
    }, "写入 Supabase CPG 数据");
    await response.text();
  }
}

async function main() {
  loadLocalEnv(path.resolve(".dev.vars"));
  loadLocalEnv(path.resolve(".env.local"));
  const { values } = parseArgs({ options: {
    dryRun: { type: "boolean", default: false },
    fullDetails: { type: "boolean", default: false },
  } });
  const startedAt = Date.now();
  const cookie = cookieHeader();
  const database = supabaseConfig();
  const manifest = await discover(cookie);
  const dayId = manifest.dayIds[0];
  console.log(`CPG08 day=${dayId}，扫描 ${manifest.types.length} 个类目`);

  const scanned = (await mapPool(manifest.types, SEARCH_WORKERS, async (type) => {
    const cached = loadCachedType(dayId, type);
    if (cached) {
      console.log(`  ${type.name}: ${cached.length}（复用本轮断点）`);
      return cached;
    }
    const rows = await scanType(cookie, dayId, type);
    saveCachedType(dayId, type, rows);
    return rows;
  })).flat();
  const sourceById = new Map(scanned.map((row) => [row.doujinshi_id, row]));
  const existing = await selectExisting(database, dayId);
  const existingById = new Map(existing.map((row) => [Number(row.doujinshi_id), row]));

  const detailTargets = [...sourceById.values()].filter((source) => values.fullDetails || !existingById.has(source.doujinshi_id));
  console.log(`详情更新目标：${detailTargets.length}${values.fullDetails ? "（人工全量刷新）" : "（全部新增制品）"}`);
  const detailResults = await mapPool(detailTargets, DETAIL_WORKERS, async (row) => {
    const cached = loadCachedDetail(dayId, row.doujinshi_id);
    if (cached) return [row.doujinshi_id, cached];
    const detail = await fetchDetail(cookie, row.doujinshi_id);
    saveCachedDetail(dayId, row.doujinshi_id, detail);
    return [row.doujinshi_id, detail];
  });
  const details = new Map(detailResults);
  const now = new Date().toISOString();
  const changed = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const source of sourceById.values()) {
    const current = existingById.get(source.doujinshi_id);
    const detail = details.get(source.doujinshi_id);
    const merged = mergeRow(source, current, detail, now);
    const detailChanged = nonEmpty(detail?.description) && !sameValue(detail.description, current?.description);
    const exchangeChanged = Boolean(validExchangeType(detail?.exchange_type)) && !sameValue(validExchangeType(detail.exchange_type), current?.exchange_type);
    const meaningful = baseChanged(source, current) || detailChanged || exchangeChanged;
    if (!current) {
      inserted += 1;
      changed.push(merged);
    } else if (meaningful) {
      updated += 1;
      changed.push(merged);
    } else {
      unchanged += 1;
    }
  }

  if (!values.dryRun && changed.length > 0) await upsert(database, changed);
  const databaseCount = values.dryRun ? existing.length : (await selectExisting(database, dayId)).length;
  if (!values.dryRun) rmSync(cacheDirectory(dayId), { recursive: true, force: true });
  console.log(JSON.stringify({
    mode: values.dryRun ? "dry-run" : "write",
    sourceEventId: SOURCE_EVENT_ID,
    eventId: DATABASE_EVENT_ID,
    dayId,
    categories: manifest.types.length,
    scanned: sourceById.size,
    existingBefore: existing.length,
    inserted,
    updated,
    unchanged,
    written: values.dryRun ? 0 : changed.length,
    databaseAfter: databaseCount,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  }, null, 2));
}

main().catch((error) => {
  console.error(`CPG 同步失败：${error.message}`);
  process.exitCode = 1;
});
