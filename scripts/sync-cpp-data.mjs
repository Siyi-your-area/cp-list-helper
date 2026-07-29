#!/usr/bin/env node

/**
 * 可恢复、并发、增量、可校验的 CPP 数据同步流水线。
 *
 * 示例：
 * node scripts/sync-cpp-data.mjs --event=cpg --days=7073 --concurrency=6
 * node scripts/sync-cpp-data.mjs --event=cpg --days=7073 --resume
 * node scripts/sync-cpp-data.mjs --event=cpg --days=7073 --verify-only
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const TYPE_MAP = [
  { id: 36, name: "漫画" },
  { id: 37, name: "小说" },
  { id: 38, name: "图集" },
  { id: 39, name: "音乐" },
  { id: 40, name: "GAME" },
  { id: 50, name: "图文志" },
  { id: 51, name: "海报集" },
  { id: 52, name: "其他作品集" },
  { id: 33, name: "卡片" },
  { id: 34, name: "纸胶带" },
  { id: 41, name: "COS" },
  { id: 42, name: "手办" },
  { id: 43, name: "亚克力" },
  { id: 44, name: "徽章" },
  { id: 45, name: "色纸" },
  { id: 46, name: "其他" },
];

const { values } = parseArgs({
  options: {
    event: { type: "string" },
    days: { type: "string" },
    types: { type: "string" },
    concurrency: { type: "string", default: "6" },
    pageSize: { type: "string", default: "30" },
    retries: { type: "string", default: "4" },
    timeout: { type: "string", default: "12000" },
    maxPages: { type: "string" },
    mode: { type: "string", default: "incremental" },
    resume: { type: "boolean", default: true },
    reset: { type: "boolean", default: false },
    dryRun: { type: "boolean", default: false },
    verifyOnly: { type: "boolean", default: false },
    fixture: { type: "string" },
    stateDir: { type: "string", default: ".cpp-sync" },
  },
});

if (!values.event || !values.days) {
  console.error("必须提供 --event=<内部展会ID> 和 --days=<CPP活动日ID,...>");
  process.exit(2);
}
if (!["incremental", "full"].includes(values.mode)) {
  console.error("--mode 仅支持 incremental 或 full");
  process.exit(2);
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

loadEnvFile(path.join(process.cwd(), ".env.local"));
loadEnvFile(path.join(process.cwd(), ".dev.vars"));

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("正式同步必须提供 SUPABASE_URL（或 NEXT_PUBLIC_SUPABASE_URL）和 SUPABASE_SERVICE_ROLE_KEY；不再允许 anon key 写入");
  process.exit(2);
}

function getCookie() {
  if (process.env.CPP_COOKIE) return process.env.CPP_COOKIE;
  const cookiePath = path.join(process.cwd(), "cpp-cookies.json");
  if (!existsSync(cookiePath)) return "";
  const cookies = JSON.parse(readFileSync(cookiePath, "utf-8"));
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

const cookie = getCookie();
const fixtureData = values.fixture
  ? JSON.parse(readFileSync(path.resolve(values.fixture), "utf-8"))
  : null;
if (!cookie && !values.verifyOnly && !fixtureData) {
  console.error("缺少 CPP_COOKIE 或 cpp-cookies.json");
  process.exit(2);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const eventId = values.event;
const dayIds = values.days.split(",").map((value) => value.trim()).filter(Boolean);
const requestedTypeIds = values.types
  ? new Set(values.types.split(",").map((value) => Number(value.trim())))
  : null;
const selectedTypes = requestedTypeIds
  ? TYPE_MAP.filter((type) => requestedTypeIds.has(type.id))
  : TYPE_MAP;
const concurrency = Math.max(1, Number(values.concurrency));
const pageSize = Math.min(100, Math.max(1, Number(values.pageSize)));
const retries = Math.max(0, Number(values.retries));
const timeoutMs = Math.max(1000, Number(values.timeout));
const maxPages = values.maxPages ? Math.max(1, Number(values.maxPages)) : null;
const runId = `${eventId}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const stateDir = path.resolve(values.stateDir);
const stateFile = path.join(stateDir, `${eventId}.checkpoint.json`);
const reportFile = path.join(stateDir, `${runId}.report.json`);

mkdirSync(stateDir, { recursive: true });
if (values.reset && existsSync(stateFile)) rmSync(stateFile);

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\u00a0]+/g, "")
    .replace(/[·•・—–－_\-~～,，。.!！?？:：;；'"“”‘’()[\]（）【】{}《》「」『』]/g, "")
    .toLowerCase();
}

function splitBooths(value) {
  return String(value || "").match(/[一-鿿]+[A-Z]?\d+/g) || [String(value || "")];
}

function aliases(value) {
  const output = new Set([normalize(value)]);
  for (const match of String(value || "").matchAll(/[【\[《「『(（]([^】\]》」』)）]+)[】\]》」』)）]/g)) {
    output.add(normalize(match[1]));
  }
  return Array.from(output).filter((item) => item.length >= 2);
}

function stableHash(row) {
  const source = {
    event_id: row.event_id,
    day_id: row.day_id,
    type_id: row.type_id,
    doujinshi_id: row.doujinshi_id,
    product_name: row.product_name,
    author: row.author,
    booth_number: row.booth_number,
    booth_name: row.booth_name,
    image_url: row.image_url,
    tags: row.tags,
    source_url: row.source_url,
    hot_count: row.hot_count,
    original_work: row.original_work,
  };
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function taskKey(dayId, typeId) {
  return `${dayId}:${typeId}`;
}

function emptyState() {
  const tasks = {};
  for (const dayId of dayIds) {
    for (const type of selectedTypes) {
      tasks[taskKey(dayId, type.id)] = {
        dayId,
        typeId: type.id,
        typeName: type.name,
        nextPage: 1,
        status: "pending",
        pages: 0,
        apiRows: 0,
        sourceRows: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        expectedTotal: null,
        failures: [],
        pageChecksums: {},
      };
    }
  }
  return {
    version: 1,
    eventId,
    dayIds,
    typeIds: selectedTypes.map((type) => type.id),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks,
  };
}

function loadState() {
  if (!values.resume || !existsSync(stateFile)) return emptyState();
  const state = JSON.parse(readFileSync(stateFile, "utf-8"));
  if (state.eventId !== eventId) throw new Error("checkpoint eventId 与本次参数不一致");
  const previousTasks = Object.values(state.tasks || {});
  if (
    previousTasks.length > 0 &&
    previousTasks.every((task) => task.status === "done" || task.status === "limited")
  ) {
    return emptyState();
  }
  const fresh = emptyState();
  return {
    ...fresh,
    ...state,
    tasks: Object.fromEntries(
      Object.entries(fresh.tasks).map(([key, task]) => [key, { ...task, ...(state.tasks?.[key] || {}) }])
    ),
  };
}

const state = loadState();

function saveJsonAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2));
  renameSync(temp, file);
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  saveJsonAtomic(stateFile, state);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(label, operation) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      const delay = Math.min(8000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250);
      console.warn(`  RETRY ${label} (${attempt + 1}/${retries}) in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function fetchPage(dayId, type, pageIndex) {
  if (fixtureData) {
    return fixtureData[`${dayId}:${type.id}:${pageIndex}`] || { list: [], total: 0 };
  }
  const params = new URLSearchParams({
    eventId: dayId,
    keyword: "",
    orderBy: "1",
    typeIds: String(type.id),
    pageIndex: String(pageIndex),
    pageSize: String(pageSize),
    sellStatus: "",
    ideaType: "",
    tag: "",
    ideaStatus: "",
  });
  const response = await fetch(`https://www.allcpp.cn/api/doujinshi/search.do?${params}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
      Cookie: cookie,
    },
  });
  if (!response.ok) throw new Error(`CPP HTTP ${response.status}`);
  const json = await response.json();
  if (!json.isSuccess) throw new Error(`CPP API: ${json.message || "unknown error"}`);
  return json.result || { list: [], total: 0 };
}

function normalizePage(dayId, type, list) {
  const rows = [];
  for (const item of list) {
    for (const event of (item.eventList || []).filter(
      (entry) => String(entry.eventID) === String(dayId)
    )) {
      const row = {
        event_id: eventId,
        day_id: String(dayId),
        type_id: type.id,
        type_name: type.name,
        doujinshi_id: item.doujinshiId,
        product_name: item.doujinshiName || "",
        author: (item.authorList || [])
          .map((author) => author.authorName || String(author.authorId))
          .join(", "),
        booth_number: event.position || "",
        booth_name: event.circleName || "",
        image_url: item.coverPicUrl
          ? `https://imagecdn3.allcpp.cn/upload${item.coverPicUrl}`
          : "",
        tags: item.tag ? item.tag.split("|") : [],
        source_url: `https://www.allcpp.cn/d/${item.doujinshiId}.do`,
        hot_count: item.hotCount || 0,
        original_work: item.themeAlias || "",
        normalized_booth: normalize(event.position || ""),
        normalized_product: normalize(item.doujinshiName || ""),
        normalized_author: normalize(
          (item.authorList || []).map((author) => author.authorName || "").join(", ")
        ),
        booth_aliases: Array.from(new Set(splitBooths(event.position || "").map(normalize).filter(Boolean))),
        product_aliases: aliases(item.doujinshiName || ""),
        source_updated_at: new Date().toISOString(),
        crawl_run_id: runId,
      };
      row.source_hash = stableHash(row);
      rows.push(row);
    }
  }

  const unique = new Map();
  for (const row of rows) {
    unique.set(`${row.event_id}|${row.day_id}|${row.doujinshi_id}`, row);
  }
  return Array.from(unique.values());
}

async function existingHashes(dayId, rows) {
  if (rows.length === 0) return new Map();
  const ids = rows.map((row) => row.doujinshi_id);
  const { data, error } = await supabase
    .from("cpp_items")
    .select("doujinshi_id,source_hash")
    .eq("event_id", eventId)
    .eq("day_id", String(dayId))
    .in("doujinshi_id", ids);
  if (error) throw error;
  return new Map((data || []).map((row) => [Number(row.doujinshi_id), row.source_hash || ""]));
}

async function persistPage(dayId, rows, task) {
  if (rows.length === 0) return;
  if (values.dryRun) {
    task.inserted += rows.length;
    return;
  }
  const hashes = await existingHashes(dayId, rows);
  const changed = values.mode === "full"
    ? rows
    : rows.filter((row) => hashes.get(Number(row.doujinshi_id)) !== row.source_hash);

  const inserted = changed.filter((row) => !hashes.has(Number(row.doujinshi_id))).length;
  const updated = changed.length - inserted;
  const unchanged = rows.length - changed.length;
  if (changed.length === 0) {
    task.unchanged += unchanged;
    return;
  }

  const { error } = await supabase
    .from("cpp_items")
    .upsert(changed, {
      onConflict: "event_id,day_id,doujinshi_id",
      ignoreDuplicates: false,
    });
  if (error) throw error;
  task.inserted += inserted;
  task.updated += updated;
  task.unchanged += unchanged;
}

async function syncTask(task) {
  if (task.status === "done") return;
  const type = TYPE_MAP.find((entry) => entry.id === task.typeId);
  task.status = "running";
  saveState();

  while (true) {
    const pageIndex = task.nextPage;
    if (maxPages && pageIndex > maxPages) {
      task.status = "limited";
      break;
    }

    try {
      const page = await withRetry(
        `${task.dayId}/${type.name}/page-${pageIndex}`,
        () => fetchPage(task.dayId, type, pageIndex)
      );
      const list = page.list || [];
      const rows = normalizePage(task.dayId, type, list);
      await withRetry(
        `${task.dayId}/${type.name}/persist-${pageIndex}`,
        () => persistPage(task.dayId, rows, task)
      );

      task.expectedTotal = Number(page.total || 0);
      task.pages += 1;
      task.apiRows += list.length;
      task.sourceRows += rows.length;
      task.pageChecksums[pageIndex] = createHash("sha256")
        .update(rows.map((row) => `${row.doujinshi_id}:${row.source_hash}`).sort().join("|"))
        .digest("hex");
      task.failures = task.failures.filter((failure) => failure.page !== pageIndex);
      task.nextPage += 1;
      saveState();

      console.log(
        `OK day=${task.dayId} type=${type.name} page=${pageIndex} api=${list.length} rows=${rows.length}`
      );

      if (list.length === 0 || task.apiRows >= task.expectedTotal || list.length < pageSize) {
        task.status = "done";
        break;
      }
    } catch (error) {
      task.status = "failed";
      task.failures.push({
        page: pageIndex,
        at: new Date().toISOString(),
        message: error.message,
      });
      saveState();
      console.error(`FAILED day=${task.dayId} type=${type.name} page=${pageIndex}: ${error.message}`);
      return;
    }
  }
  saveState();
}

async function databaseCount(dayId, typeId) {
  const { count, error } = await supabase
    .from("cpp_items")
    .select("*", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("day_id", String(dayId))
    .eq("type_id", typeId);
  if (error) throw error;
  return count || 0;
}

async function buildReport(startedAt) {
  const taskReports = [];
  for (const task of Object.values(state.tasks)) {
    const databaseRows = values.dryRun
      ? null
      : await databaseCount(task.dayId, task.typeId);
    const sourceComplete =
      task.status === "done" &&
      task.expectedTotal != null &&
      task.apiRows >= task.expectedTotal;
    const databaseCovered =
      values.dryRun ||
      databaseRows >= Math.min(task.sourceRows, task.expectedTotal || task.sourceRows);
    taskReports.push({
      dayId: task.dayId,
      typeId: task.typeId,
      typeName: task.typeName,
      status: task.status,
      pages: task.pages,
      expectedTotal: task.expectedTotal,
      apiRows: task.apiRows,
      normalizedRows: task.sourceRows,
      databaseRows,
      sourceComplete,
      databaseCovered,
      valid:
        task.failures.length === 0 &&
        (task.status === "limited" || (sourceComplete && databaseCovered)),
      inserted: task.inserted,
      updated: task.updated,
      unchanged: task.unchanged,
      failures: task.failures,
      checksum: createHash("sha256")
        .update(Object.values(task.pageChecksums).sort().join("|"))
        .digest("hex"),
    });
  }

  const failedTasks = taskReports.filter((task) => task.status === "failed");
  const limitedTasks = taskReports.filter((task) => task.status === "limited");
  const invalidTasks = taskReports.filter((task) => !task.valid && task.status !== "limited");
  const report = {
    runId,
    eventId,
    mode: values.mode,
    dryRun: values.dryRun,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    status:
      failedTasks.length > 0
        ? "partial"
        : invalidTasks.length > 0
          ? "invalid"
          : limitedTasks.length > 0
            ? "limited"
            : "ok",
    totals: {
      tasks: taskReports.length,
      failedTasks: failedTasks.length,
      limitedTasks: limitedTasks.length,
      invalidTasks: invalidTasks.length,
      apiRows: taskReports.reduce((sum, task) => sum + task.apiRows, 0),
      normalizedRows: taskReports.reduce((sum, task) => sum + task.normalizedRows, 0),
      inserted: taskReports.reduce((sum, task) => sum + task.inserted, 0),
      updated: taskReports.reduce((sum, task) => sum + task.updated, 0),
      unchanged: taskReports.reduce((sum, task) => sum + task.unchanged, 0),
    },
    tasks: taskReports,
  };
  saveJsonAtomic(reportFile, report);
  return report;
}

async function main() {
  const startedAt = Date.now();
  console.log(`CPP sync run=${runId}`);
  console.log(
    `event=${eventId} days=${dayIds.join(",")} tasks=${Object.keys(state.tasks).length} concurrency=${concurrency} mode=${values.mode}`
  );

  if (!values.verifyOnly) {
    const queue = Object.values(state.tasks).filter((task) => task.status !== "done");
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (task) await syncTask(task);
      }
    });
    await Promise.all(workers);
  }

  const report = await buildReport(startedAt);
  console.log(JSON.stringify(report.totals, null, 2));
  console.log(`report=${reportFile}`);
  if (report.status === "partial" || report.status === "invalid") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
