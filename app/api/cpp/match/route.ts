import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  createMatchAliases,
  createMatchIndex,
  MatchIndex,
  normalizeMatchText,
  splitBoothNumber,
} from "@/lib/cpp-matcher";
import {
  getCPPItems,
  getCPPItemsByBooths,
  resolveCPPMatchScope,
  searchCPPItems,
} from "@/lib/db-service";
import type {
  MatchInput,
  MatchResult,
  NormalizedCPPItem,
} from "@/lib/types";

const MAX_ITEMS = 1000;
const DB_SEARCH_CONCURRENCY = 8;
const EXTERNAL_CONCURRENCY = 6;
const MAX_EXTERNAL_TASKS = 40;
const SERVER_BUDGET_MS = 28_000;
const EXTERNAL_TIMEOUT_MS = 5_000;
const KEYWORD_CACHE_TTL = 30 * 60 * 1000;

interface CachedFetch {
  items: NormalizedCPPItem[];
  time: number;
}

const keywordCache = new Map<string, CachedFetch>();

function elapsed(start: number) {
  return Math.round((performance.now() - start) * 10) / 10;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
) {
  const queue = [...values];
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length > 0) {
        const value = queue.shift();
        if (value !== undefined) await worker(value);
      }
    }
  );
  await Promise.all(workers);
}

function getCookies(): string {
  if (process.env.CPP_COOKIE) return process.env.CPP_COOKIE;
  try {
    const cookiePath = path.join(process.cwd(), "cpp-cookies.json");
    const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf-8"));
    return cookies.map((cookie: any) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    return "";
  }
}

function extractSearchKeyword(productName: string): string {
  if (!productName) return "";
  const cleaned = productName
    // 【图奈】、【新刊】通常是作品/宣发标签，不应作为搜索主体。
    .replace(/^(?:\s*[【\[][^\]】]+[\]】]\s*)+/, "")
    .replace(/^(?:cp|comicup)\s*\d+(?:pre)?/i, "")
    .replace(/(?:cp|comicup)\s*\d+(?:pre)?/gi, "")
    .replace(/新刊|首发|场贩|通贩|二刷/g, "")
    .replace(/^[\s·|｜:：\-—]+|[\s·|｜:：\-—]+$/g, "")
    .trim();
  if (cleaned.length >= 2) return cleaned.slice(0, 24);

  // 极端情况下退回标准化别名，避免标签剥离后没有可搜索内容。
  const alias = createMatchAliases(productName)
    .filter((value) => value.length >= 2)
    .sort((left, right) => right.length - left.length)[0];
  return (alias || cleaned).slice(0, 24);
}

function boothNumbersOverlap(left: string, right: string): boolean {
  if (!left.trim()) return true;
  const buildTokens = (value: string) =>
    new Set(
      [value, ...splitBoothNumber(value)]
        .map(normalizeMatchText)
        .filter(Boolean)
    );
  const leftTokens = buildTokens(left);
  const rightTokens = buildTokens(right);
  return Array.from(leftTokens).some((value) => rightTokens.has(value));
}

async function fetchByKeyword(
  keyword: string,
  boothNumber: string,
  dayIds: string[],
  deadline: number
): Promise<NormalizedCPPItem[]> {
  if (!keyword.trim() || performance.now() >= deadline) return [];
  const cacheKey = `${dayIds.join(",")}|${boothNumber}|${keyword}`;
  const cached = keywordCache.get(cacheKey);
  if (cached && Date.now() - cached.time < KEYWORD_CACHE_TTL) return cached.items;

  const cookie = getCookies();
  if (!cookie) return [];

  const pages = await Promise.all(dayIds.map(async (dayId) => {
    if (performance.now() >= deadline) return [] as NormalizedCPPItem[];
    const params = new URLSearchParams({
      eventId: dayId,
      keyword: keyword.trim(),
      orderBy: "1",
      typeIds: "",
      pageIndex: "1",
      pageSize: "30",
      sellStatus: "",
      ideaType: "",
      tag: "",
      ideaStatus: "",
    });

    try {
      const response = await fetch(
        `https://www.allcpp.cn/api/doujinshi/search.do?${params}`,
        {
          signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
          headers: {
            "User-Agent": "Mozilla/5.0",
            Accept: "application/json",
            "Content-Type": "application/json",
            Cookie: cookie,
          },
        }
      );
      if (!response.ok) return [];
      const json = await response.json();
      if (!json.isSuccess) return [];

      const output: NormalizedCPPItem[] = [];
      for (const item of json.result?.list || []) {
        for (const event of (item.eventList || []).filter(
          (entry: any) => String(entry.eventID) === String(dayId)
        )) {
          if (!boothNumbersOverlap(boothNumber, event.position || "")) continue;
          output.push({
            boothNumber: event.position || "",
            boothName: event.circleName || "",
            productName: item.doujinshiName || "",
            author: (item.authorList || [])
              .map((author: any) => author.authorName || String(author.authorId))
              .join(", "),
            imageUrl: item.coverPicUrl
              ? `https://imagecdn3.allcpp.cn/upload${item.coverPicUrl}`
              : "",
            tags: item.tag ? item.tag.split("|") : [],
            eventName: event.eventName || "",
            dayId,
            sourceUrl: `https://www.allcpp.cn/d/${item.doujinshiId}.do`,
            doujinshiId: item.doujinshiId || 0,
            hotCount: item.hotCount || 0,
            originalWork: item.themeAlias || "",
          });
        }
      }
      return output;
    } catch {
      return [];
    }
  }));

  const items = pages.flat();
  keywordCache.set(cacheKey, { items, time: Date.now() });
  return items;
}

function shouldRetry(result: MatchResult) {
  return result.decision !== "accepted";
}

function mergeCandidate(
  current: MatchResult,
  incoming: MatchResult
): MatchResult {
  if (incoming.decision === "accepted") return incoming;
  if (
    incoming.decision === "review" &&
    (current.decision === "unmatched" || (incoming.score || 0) > (current.score || 0))
  ) {
    return incoming;
  }
  return current;
}

export async function POST(request: NextRequest) {
  const requestStart = performance.now();
  try {
    const parseBodyStart = performance.now();
    const body = await request.json();
    const items: MatchInput[] = Array.isArray(body.items) ? body.items : [];
    const bodyMs = elapsed(parseBodyStart);

    if (items.length === 0) {
      return NextResponse.json({
        results: [],
        stats: { total: 0, matched: 0, review: 0, none: 0 },
        timings: { bodyMs, serverTotalMs: elapsed(requestStart) },
      });
    }
    if (items.length > MAX_ITEMS) {
      return NextResponse.json({ error: `单次最多匹配 ${MAX_ITEMS} 条` }, { status: 400 });
    }

    const scopeStart = performance.now();
    const scope = await resolveCPPMatchScope(body.eventId || "cp32");
    const eventId = scope.eventId;
    const dayIds = scope.dayIds || [];
    const externalDayIds = dayIds.length > 0
      ? dayIds
      : eventId === "cp32"
        ? ["7040", "7042"]
        : [];
    const scopeMs = elapsed(scopeStart);

    // 第一阶段 A：按摊位批量取候选，再用唯一标识、别名和组合特征评分。
    const candidateStart = performance.now();
    const candidates = await getCPPItemsByBooths(
      eventId,
      items.map((item) => item.boothNumber),
      dayIds,
      items.map((item) => item.doujinshiId).filter((value): value is number => Boolean(value))
    );
    const candidateQueryMs = elapsed(candidateStart);

    const databaseMatchStart = performance.now();
    const index = new MatchIndex(candidates);
    const results = index.matchBatch(items, "database-index");
    const databaseMatchMs = elapsed(databaseMatchStart);

    // 第一阶段 B：精确摊位候选不足时，按标准化名称查询数据库。
    const databaseSearchStart = performance.now();
    const dbTasks = new Map<string, { keyword: string; indices: number[] }>();
    results.forEach((result, indexValue) => {
      if (!shouldRetry(result)) return;
      const keyword = extractSearchKeyword(items[indexValue].productName);
      if (!keyword) return;
      const key = keyword.toLowerCase();
      const task = dbTasks.get(key) || { keyword, indices: [] };
      task.indices.push(indexValue);
      dbTasks.set(key, task);
    });

    await mapWithConcurrency(
      Array.from(dbTasks.values()),
      DB_SEARCH_CONCURRENCY,
      async (task) => {
        try {
          const freshItems = await searchCPPItems(eventId, task.keyword, 50, dayIds);
          if (freshItems.length === 0) return;
          const freshIndex = createMatchIndex(freshItems);
          for (const indexValue of task.indices) {
            const incoming = freshIndex.match(items[indexValue], "database-search");
            results[indexValue] = mergeCandidate(results[indexValue], incoming);
          }
        } catch (error) {
          console.warn("[CPP Match] database fallback search failed", {
            keyword: task.keyword,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );
    const databaseSearchMs = elapsed(databaseSearchStart);

    // 第二阶段：数据库未接受的条目才调用 CPP，且受全局 28 秒预算保护。
    const externalStart = performance.now();
    const deadline = requestStart + SERVER_BUDGET_MS;
    const externalTasks = new Map<
      string,
      { keyword: string; boothNumber: string; indices: number[] }
    >();
    results.forEach((result, indexValue) => {
      if (!shouldRetry(result)) return;
      const input = items[indexValue];
      const keyword = extractSearchKeyword(input.productName);
      if (!keyword) return;
      const key = `${input.boothNumber}|${keyword}`;
      const task = externalTasks.get(key) || {
        keyword,
        boothNumber: input.boothNumber,
        indices: [],
      };
      task.indices.push(indexValue);
      externalTasks.set(key, task);
    });

    const externalEnabled = Boolean(getCookies() && externalDayIds.length > 0);
    const selectedExternalTasks = externalEnabled
      ? Array.from(externalTasks.values()).slice(0, MAX_EXTERNAL_TASKS)
      : [];
    let externalResponses = 0;
    await mapWithConcurrency(
      selectedExternalTasks,
      EXTERNAL_CONCURRENCY,
      async (task) => {
        if (performance.now() >= deadline) return;
        const freshItems = await fetchByKeyword(
          task.keyword,
          task.boothNumber,
          externalDayIds,
          deadline
        );
        if (freshItems.length === 0) return;
        externalResponses += 1;
        const freshIndex = createMatchIndex(freshItems);
        for (const indexValue of task.indices) {
          const incoming = freshIndex.match(items[indexValue], "external-api");
          results[indexValue] = mergeCandidate(results[indexValue], incoming);
        }
      }
    );
    const externalMs = elapsed(externalStart);

    const accepted = results.filter((result) => result.decision === "accepted").length;
    const review = results.filter((result) => result.decision === "review").length;
    const unmatched = results.length - accepted - review;
    const fromExternal = results.filter(
      (result) => result.source === "external-api" && result.decision === "accepted"
    ).length;
    const serverTotalMs = elapsed(requestStart);

    const stats = {
      total: items.length,
      matched: accepted,
      accepted,
      review,
      unmatched,
      exact: results.filter((result) => result.confidence === "exact").length,
      high: results.filter((result) => result.confidence === "high").length,
      medium: results.filter((result) => result.confidence === "medium").length,
      low: results.filter((result) => result.confidence === "low").length,
      none: unmatched,
      databaseCandidates: candidates.length,
      databaseSearchTasks: dbTasks.size,
      externalEligible: externalTasks.size,
      externalEnabled,
      externalAttempted: selectedExternalTasks.length,
      externalResponses,
      fromAPI: fromExternal,
      fallbackRate: items.length > 0
        ? Math.round((selectedExternalTasks.length / items.length) * 10_000) / 100
        : 0,
      budgetExceeded: performance.now() >= deadline,
    };
    const timings = {
      clientParseMs: body.clientTimings?.parseMs,
      clientDedupeMs: body.clientTimings?.dedupeMs,
      bodyMs,
      scopeMs,
      candidateQueryMs,
      databaseMatchMs,
      databaseSearchMs,
      externalMs,
      serverTotalMs,
      targetMs: 30_000,
      withinTarget: serverTotalMs <= 30_000,
    };

    console.log("[CPP Match Metrics]", JSON.stringify({
      eventId,
      stats,
      timings,
    }));

    return NextResponse.json({ results, stats, timings });
  } catch (error: any) {
    console.error("[CPP Match] 匹配失败:", error);
    return NextResponse.json(
      {
        error: `匹配服务异常: ${error.message}`,
        timings: { serverTotalMs: elapsed(requestStart) },
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const booth = searchParams.get("booth");
    const scope = await resolveCPPMatchScope(searchParams.get("event") || "cp32");
    if (!booth) {
      return NextResponse.json({ error: "缺少 booth 参数" }, { status: 400 });
    }
    const items = await getCPPItems(scope.eventId, scope.dayIds);
    const boothItems = new MatchIndex(items).getByBooth(booth);
    return NextResponse.json({ booth, count: boothItems.length, items: boothItems });
  } catch (error: any) {
    return NextResponse.json(
      { error: `查询服务异常: ${error.message}` },
      { status: 500 }
    );
  }
}
