#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  CPG_SOURCE_EVENT_ID,
  CPG_SCAN_ORDER_BY,
  createCPPRequestController,
  createGeneratedFixtureTransport,
  runCPGProvisionalSnapshot,
  runCPGSnapshot,
} from "./cpp-snapshot-core.mjs";

const CPP_ORIGIN = "https://www.allcpp.cn";
const DEFAULT_FIXTURE = "tests/fixtures/cpg-snapshot-source.json";

function parseCliArgs() {
  return parseArgs({ options: {
    fixture: { type: "boolean", default: false },
    sourceFixture: { type: "string", default: DEFAULT_FIXTURE },
    outputDir: { type: "string", default: ".cpp-snapshots" },
    pageSize: { type: "string", default: "100" },
    timeout: { type: "string", default: "15000" },
    dispatchInterval: { type: "string", default: "250" },
    maxInFlight: { type: "string", default: "4" },
    categoryWorkers: { type: "string", default: "4" },
    provisionalSinglePass: { type: "boolean", default: false },
  } }).values;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} 必须为正整数`);
  return number;
}

function cookieHeader() {
  const raw = process.env.CPP_COOKIE;
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("live 扫描需要 CPP_COOKIE；不会从文件自动加载凭据");
  if (/\r|\n/.test(raw)) throw new Error("CPP_COOKIE 含非法换行");
  return raw.trim();
}

async function strictCountEnvelope(response, checkpoint) {
  if (response.status === 401 || response.status === 403) throw new Error(`${checkpoint} CPP 鉴权失败 HTTP ${response.status}`);
  if (response.status !== 200) throw new Error(`${checkpoint} CPP count HTTP ${response.status}`);
  const contentType = response.headers?.get?.("content-type") || "";
  if (!/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) throw new Error(`${checkpoint} CPP count 响应不是 JSON（可能登录跳转）`);
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${checkpoint} CPP count JSON 解析失败`);
  }
  if (!value || value.isSuccess !== true || !value.result || !Number.isSafeInteger(value.result.total) || value.result.total <= 0 || !Array.isArray(value.result.list)) {
    throw new Error(`${checkpoint} CPP count envelope 无效`);
  }
  return value;
}

export function createLiveTransport({ timeoutMs, minIntervalMs = 250, maxInFlight = 4, requester, cookie } = {}) {
  const controlledRequester = requester || createCPPRequestController({ minIntervalMs, maxInFlight });
  const headers = { Accept: "application/json", Cookie: cookie ?? cookieHeader(), "User-Agent": "CP-List-Helper-CPG-Snapshot/1.0" };
  return {
    async getEventPage() {
      const response = await controlledRequester.request(`${CPP_ORIGIN}/allcpp/event/eventdoujinshi.do?event=${CPG_SOURCE_EVENT_ID}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { ...headers, Accept: "text/html" } }, "CPG event page");
      if (!response.ok) throw new Error(`CPG event page HTTP ${response.status}`);
      return response.text();
    },
    async getDeclaredTotal({ dayId, checkpoint }) {
      const url = new URL("/api/doujinshi/search.do", CPP_ORIGIN);
      url.search = new URLSearchParams({ eventId: dayId, keyword: "", orderBy: CPG_SCAN_ORDER_BY, typeIds: "", pageIndex: "1", pageSize: "1", sellStatus: "", ideaType: "", tag: "", ideaStatus: "" });
      const response = await controlledRequester.request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers }, `${checkpoint} global count`);
      return strictCountEnvelope(response, checkpoint);
    },
    async getSearchPage({ dayId, typeId, orderBy, pageIndex, pageSize }) {
      const url = new URL("/api/doujinshi/search.do", CPP_ORIGIN);
      url.search = new URLSearchParams({ eventId: dayId, keyword: "", orderBy, typeIds: String(typeId), pageIndex: String(pageIndex), pageSize: String(pageSize), sellStatus: "", ideaType: "", tag: "", ideaStatus: "" });
      const response = await controlledRequester.request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers }, `type=${typeId} page=${pageIndex}`);
      if (!response.ok) throw new Error(`CPP search HTTP ${response.status}`);
      return response.json();
    },
    getRequestMetrics() {
      return controlledRequester.getMetrics?.() ?? { requestStarts: 0, retries: 0, status429: 0, maxInFlight: 0, effectiveMinInterval: minIntervalMs, elapsedMs: 0 };
    },
  };
}

export function writeSnapshot(outputDir, snapshot) {
  const directory = path.resolve(outputDir);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `cpg-${snapshot.snapshotHash}.snapshot.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  return target;
}

export async function runCPGScan({
  fixture = false,
  sourceFixture = DEFAULT_FIXTURE,
  outputDir = ".cpp-snapshots",
  pageSize = 100,
  timeoutMs = 15000,
  dispatchInterval = 250,
  maxInFlight = 4,
  categoryWorkers = 4,
  provisionalSinglePass = false,
  onTaskComplete = () => {},
} = {}) {
  const sourceTransport = fixture
    ? createGeneratedFixtureTransport(JSON.parse(readFileSync(path.resolve(sourceFixture), "utf8")))
    : createLiveTransport({ timeoutMs, minIntervalMs: dispatchInterval, maxInFlight });
  const runSnapshot = provisionalSinglePass ? runCPGProvisionalSnapshot : runCPGSnapshot;
  const snapshot = await runSnapshot({ sourceTransport, pageSize, categoryWorkers, onTaskComplete });
  const target = writeSnapshot(outputDir, snapshot);
  return { snapshot, target };
}

async function main() {
  const values = parseCliArgs();
  const pageSize = positiveInteger(values.pageSize, "pageSize");
  const categoryWorkers = positiveInteger(values.categoryWorkers, "categoryWorkers");
  const { snapshot, target } = await runCPGScan({
    fixture: values.fixture,
    sourceFixture: values.sourceFixture,
    outputDir: values.outputDir,
    pageSize,
    timeoutMs: positiveInteger(values.timeout, "timeout"),
    dispatchInterval: positiveInteger(values.dispatchInterval, "dispatchInterval"),
    maxInFlight: positiveInteger(values.maxInFlight, "maxInFlight"),
    categoryWorkers,
    provisionalSinglePass: values.provisionalSinglePass,
    onTaskComplete: (task) => console.log(`snapshot pass=${task.pass} type=${task.typeId} total=${task.total}`),
  });
  console.log(JSON.stringify({ state: snapshot.state, tasks: `${snapshot.tasksCompleted}/${snapshot.tasksExpected}`, declared: snapshot.totals.declared ?? snapshot.totals.observedGlobal, uniqueRows: snapshot.totals.uniqueRows, definitionHash: snapshot.definitionHash, snapshotHash: snapshot.snapshotHash, readOnly: snapshot.readOnly, dbWritesAttempted: snapshot.dbWritesAttempted, execution: snapshot.execution, requestMetrics: snapshot.requestMetrics, snapshot: target }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
