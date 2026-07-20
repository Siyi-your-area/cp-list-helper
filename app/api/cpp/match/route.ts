import { NextRequest, NextResponse } from "next/server";
import {
  createMatchIndex,
  MatchIndex,
} from "@/lib/cpp-matcher";
import {
  enrichCPPItemWithDetail,
  extractCoreProductName,
  fetchCPPExternalDetail,
  getCPPCookieHeader,
  isCPPExternalFallbackEligible,
  matchCPPExternalCandidates,
  searchCPPExternal,
} from "@/lib/cpp-external";
import {
  getCPPItems,
  getCPPItemsByBooths,
  resolveCPPMatchScope,
  searchCPPItems,
} from "@/lib/db-service";
import type {
  MatchInput,
  MatchResult,
} from "@/lib/types";

const MAX_ITEMS = 1000;
const DB_SEARCH_CONCURRENCY = 8;
const EXTERNAL_CONCURRENCY = 6;
const MAX_EXTERNAL_TASKS = 40;
const SERVER_BUDGET_MS = 28_000;
const EXTERNAL_TIMEOUT_MS = 5_000;

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

function extractSearchKeyword(productName: string): string {
  const cleaned = extractCoreProductName(productName);
  if (cleaned.length >= 2) return cleaned.slice(0, 24);
  return cleaned.slice(0, 24);
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
    const externalTasks = new Map<string, { keyword: string; indices: number[] }>();
    results.forEach((result, indexValue) => {
      if (!shouldRetry(result)) return;
      const input = items[indexValue];
      if (!isCPPExternalFallbackEligible(input)) return;
      const keyword = extractSearchKeyword(input.productName);
      if (!keyword) return;
      const key = keyword.toLowerCase();
      const task = externalTasks.get(key) || { keyword, indices: [] };
      task.indices.push(indexValue);
      externalTasks.set(key, task);
    });

    const cppCookie =
      externalTasks.size > 0 && externalDayIds.length > 0
        ? getCPPCookieHeader()
        : "";
    const externalEnabled = Boolean(cppCookie && externalDayIds.length > 0);
    const selectedExternalTasks = externalEnabled
      ? Array.from(externalTasks.values()).slice(0, MAX_EXTERNAL_TASKS)
      : [];
    let externalResponses = 0;
    let externalDetails = 0;
    await mapWithConcurrency(
      selectedExternalTasks,
      EXTERNAL_CONCURRENCY,
      async (task) => {
        if (performance.now() >= deadline) return;
        const freshItems = await searchCPPExternal(
          task.keyword,
          externalDayIds,
          cppCookie,
          deadline,
          EXTERNAL_TIMEOUT_MS
        );
        if (freshItems.length === 0) return;
        externalResponses += 1;
        for (const indexValue of task.indices) {
          let incoming = matchCPPExternalCandidates(
            items[indexValue],
            freshItems,
            externalDayIds
          );
          if (
            incoming.decision === "accepted" &&
            incoming.cppItem &&
            performance.now() < deadline
          ) {
            const detail = await fetchCPPExternalDetail(
              incoming.cppItem.doujinshiId,
              cppCookie,
              deadline
            );
            if (detail) {
              externalDetails += 1;
              incoming = {
                ...incoming,
                cppItem: enrichCPPItemWithDetail(incoming.cppItem, detail),
              };
            }
          }
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
      externalDetails,
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
