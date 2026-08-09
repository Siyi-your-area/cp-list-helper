#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DATABASE_EVENT_ID,
  EVENT_DAYS,
  SOURCE_EVENT_ID,
  createCPPRequestController,
  createFixtureDatabaseTransport,
  createFixtureSourceTransport,
  parseExactContentRange,
  resolveCookieHeader,
  runEvent6377Audit,
} from "./event6377-scanner-core.mjs";

const CPP_ORIGIN = "https://www.allcpp.cn";
const EVENT_PAGE_URL =
  `${CPP_ORIGIN}/allcpp/event/eventdoujinshi.do?event=${SOURCE_EVENT_ID}`;
const SEARCH_URL = `${CPP_ORIGIN}/api/doujinshi/search.do`;
const DEFAULT_SOURCE_FIXTURE =
  "tests/fixtures/event6377-scanner-source.json";
const DEFAULT_DATABASE_FIXTURE =
  "tests/fixtures/event6377-scanner-db.json";

const { values } = parseArgs({
  options: {
    fixture: { type: "boolean", default: false },
    sourceFixture: { type: "string" },
    databaseFixture: { type: "string" },
    outputDir: { type: "string", default: ".cpp-audit" },
    timeout: { type: "string", default: "15000" },
    cppMinInterval: { type: "string", default: "900" },
  },
});

function loadDevVars() {
  const file = path.resolve(".dev.vars");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"));
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} 必须为正整数`);
  }
  return number;
}

function safeWriteReport(outputDir, report) {
  const directory = path.resolve(outputDir);
  mkdirSync(directory, { recursive: true });
  const stamp = report.finishedAt.replace(/[:.]/g, "-");
  const target = path.join(directory, `event6377-${stamp}.report.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, target);
  return target;
}

function fetchOptions(headers, timeoutMs) {
  return {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  };
}

function createLiveSourceTransport({ cookie, timeoutMs, cppRequester }) {
  const headers = {
    Accept: "application/json, text/html;q=0.9",
    Cookie: cookie,
    "User-Agent": "CP-List-Helper-event6377-read-only-audit/1.0",
  };
  return {
    async getEventPage() {
      const response = await cppRequester.request(
        EVENT_PAGE_URL,
        () => fetchOptions(headers, timeoutMs),
        "event-page"
      );
      if (!response.ok) {
        throw new Error(`CPP event6377 页面 HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        throw new Error(`CPP event6377 页面 Content-Type 非 HTML`);
      }
      return response.text();
    },
    async getSearchPage({
      dayId,
      typeId,
      orderBy,
      pageIndex,
      pageSize,
    }) {
      const query = new URLSearchParams({
        eventId: dayId,
        keyword: "",
        orderBy: String(orderBy),
        typeIds: String(typeId),
        pageIndex: String(pageIndex),
        pageSize: String(pageSize),
        sellStatus: "",
        ideaType: "",
        tag: "",
        ideaStatus: "",
      });
      const response = await cppRequester.request(
        `${SEARCH_URL}?${query}`,
        () => fetchOptions(headers, timeoutMs),
        `day=${dayId} type=${typeId} order=${orderBy} page=${pageIndex}`
      );
      if (!response.ok) {
        throw new Error(
          `CPP day=${dayId} type=${typeId} page=${pageIndex} HTTP ${response.status}`
        );
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error(
          `CPP day=${dayId} type=${typeId} page=${pageIndex} Content-Type 非 JSON`
        );
      }
      return response.json();
    },
  };
}

function createLiveDatabaseTransport({ supabaseUrl, apiKey, timeoutMs }) {
  const baseUrl = new URL("/rest/v1/cpp_items", supabaseUrl);
  return {
    async selectCppItemsPage({
      eventId,
      dayIds,
      offset,
      limit,
      columns,
    }) {
      if (
        eventId !== DATABASE_EVENT_ID ||
        JSON.stringify(dayIds) !== JSON.stringify(EVENT_DAYS)
      ) {
        throw new Error("数据库 SELECT 范围不是 event6377/cp32");
      }
      const url = new URL(baseUrl);
      url.searchParams.set("select", columns.join(","));
      url.searchParams.set("event_id", `eq.${DATABASE_EVENT_ID}`);
      url.searchParams.set(
        "day_id",
        `in.(${EVENT_DAYS.map((dayId) => `"${dayId}"`).join(",")})`
      );
      url.searchParams.set("order", "day_id.asc,doujinshi_id.asc,id.asc");
      const response = await fetch(
        url,
        fetchOptions(
          {
            Accept: "application/json",
            apikey: apiKey,
            Authorization: `Bearer ${apiKey}`,
            Prefer: "count=exact",
            "Range-Unit": "items",
            Range: `${offset}-${offset + limit - 1}`,
          },
          timeoutMs
        )
      );
      if (!response.ok) {
        throw new Error(`Supabase SELECT HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("Supabase SELECT Content-Type 非 JSON");
      }
      const rows = await response.json();
      if (!Array.isArray(rows)) {
        throw new Error("Supabase SELECT 响应不是数组");
      }
      const exactTotal = parseExactContentRange(
        response.headers.get("content-range"),
        { offset, rowCount: rows.length }
      );
      return { rows, exactTotal };
    },
  };
}

async function main() {
  const fixtureMode =
    values.fixture ||
    Boolean(values.sourceFixture) ||
    Boolean(values.databaseFixture);
  const timeoutMs = positiveInteger(values.timeout, "--timeout");
  const cppMinIntervalMs = positiveInteger(
    values.cppMinInterval,
    "--cppMinInterval"
  );
  if (cppMinIntervalMs < 800) {
    throw new Error("--cppMinInterval 安全下限为 800ms");
  }
  let sourceTransport;
  let databaseTransport;

  if (fixtureMode) {
    const sourceFixture =
      values.sourceFixture || DEFAULT_SOURCE_FIXTURE;
    const databaseFixture =
      values.databaseFixture || DEFAULT_DATABASE_FIXTURE;
    sourceTransport = createFixtureSourceTransport(readJson(sourceFixture));
    databaseTransport = createFixtureDatabaseTransport(
      readJson(databaseFixture)
    );
  } else {
    loadDevVars();
    const cookie = resolveCookieHeader({
      CPP_COOKIE: process.env.CPP_COOKIE,
      CPP_COOKIE_JSON: process.env.CPP_COOKIE_JSON,
    });
    const supabaseUrl =
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const apiKey =
      process.env.SUPABASE_READONLY_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!cookie) {
      throw new Error(
        "缺少 CPP_COOKIE/CPP_COOKIE_JSON（仅从环境变量或 .dev.vars 读取）"
      );
    }
    if (!supabaseUrl || !apiKey) {
      throw new Error(
        "缺少 SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_READONLY_KEY/NEXT_PUBLIC_SUPABASE_ANON_KEY"
      );
    }
    const cppRequester = createCPPRequestController({
      minIntervalMs: cppMinIntervalMs,
      maxAttempts: 6,
      maxBackoffMs: 30000,
      onRetry({
        label,
        status,
        nextAttempt,
        maxAttempts,
        delayMs,
      }) {
        console.warn(
          `[event6377] CPP retry ${label} status=${status} attempt=${nextAttempt}/${maxAttempts} waitMs=${delayMs}`
        );
      },
    });
    sourceTransport = createLiveSourceTransport({
      cookie,
      timeoutMs,
      cppRequester,
    });
    databaseTransport = createLiveDatabaseTransport({
      supabaseUrl,
      apiKey,
      timeoutMs,
    });
  }

  const report = await runEvent6377Audit({
    sourceTransport,
    databaseTransport,
    onTaskComplete({ dayId, typeId, total, valid, capRisk }) {
      console.log(
        `[event6377] task day=${dayId} type=${typeId} total=${total} valid=${valid} capRisk=${capRisk}`
      );
    },
  });
  const reportFile = safeWriteReport(values.outputDir, report);
  console.log(
    JSON.stringify({
      status: report.status,
      valid: report.valid,
      readOnly: report.readOnly,
      dbWritesAttempted: report.dbWritesAttempted,
      tasks: report.totals.tasks,
      sourceUnique: report.totals.sourceUnique,
      databaseUnique: report.totals.databaseUnique,
      reportFile,
    })
  );
  if (!report.valid) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`event6377 扫描失败：${error.message}`);
  process.exitCode = 1;
});
