import { NextRequest, NextResponse } from "next/server";
import {
  createMatchIndex,
  matchEmptyBoothByExactProductAndCircle,
  MatchIndex,
  normalizeMatchText,
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
  getCPPItemsByNormalizedProducts,
  getEventMembership,
  resolveCPPMatchScope,
  searchCPPItems,
} from "@/lib/db-service";
import { authenticateRequest } from "@/lib/supabase-server";
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
const CPG_DETAIL_CONCURRENCY = 6;
const CPG_DETAIL_BUDGET_MS = 25_000;

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
    const { client } = await authenticateRequest(request);
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

    const requestedEventId = typeof body.eventId === "string" ? body.eventId : "";
    if (!requestedEventId || !(await getEventMembership(requestedEventId, client))) {
      return NextResponse.json({ error: "无权为这份list执行匹配" }, { status: 403 });
    }
    const scopeStart = performance.now();
    const scope = await resolveCPPMatchScope(requestedEventId, client, false);
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
      items.map((item) => item.doujinshiId).filter((value): value is number => Boolean(value)),
      client
    );
    const candidateQueryMs = elapsed(candidateStart);

    const databaseMatchStart = performance.now();
    const index = new MatchIndex(candidates);
    const results = index.matchBatch(items, "database-index");
    const databaseMatchMs = elapsed(databaseMatchStart);

    // CPG08 的真实导出可能没有摊位号。仅用完整标准化制品名批量取候选，
    // 再由严格的唯一性规则决定接受或转人工复核，避免空摊位触发逐条模糊查询。
    const emptyBoothBatchStart = performance.now();
    const emptyBoothHandledIndices = new Set<number>();
    let emptyBoothCandidates = 0;
    if (eventId === "cpg08") {
      const emptyBoothEntries = items
        .map((item, indexValue) => ({
          indexValue,
          normalizedProduct: normalizeMatchText(item.productName),
          hasBooth: Boolean(normalizeMatchText(item.boothNumber)),
          hasExplicitId: Boolean(item.doujinshiId),
        }))
        .filter(
          (entry) =>
            !entry.hasBooth &&
            !entry.hasExplicitId &&
            Boolean(entry.normalizedProduct)
        );

      for (const entry of emptyBoothEntries) {
        emptyBoothHandledIndices.add(entry.indexValue);
      }

      if (emptyBoothEntries.length > 0) {
        try {
          const emptyBoothItems = await getCPPItemsByNormalizedProducts(
            eventId,
            emptyBoothEntries.map((entry) => entry.normalizedProduct),
            dayIds,
            client
          );
          emptyBoothCandidates = emptyBoothItems.length;
          const candidatesByProduct = new Map<string, typeof emptyBoothItems>();
          for (const candidate of emptyBoothItems) {
            if (normalizeMatchText(candidate.boothNumber)) continue;
            const productKey = normalizeMatchText(candidate.productName);
            if (!productKey) continue;
            const productCandidates = candidatesByProduct.get(productKey) || [];
            productCandidates.push(candidate);
            candidatesByProduct.set(productKey, productCandidates);
          }

          for (const entry of emptyBoothEntries) {
            results[entry.indexValue] = matchEmptyBoothByExactProductAndCircle(
              items[entry.indexValue],
              candidatesByProduct.get(entry.normalizedProduct) || [],
              "database-search"
            );
          }
        } catch (error) {
          console.warn("[CPP Match] CPG empty-booth batch lookup failed", {
            itemCount: emptyBoothEntries.length,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const emptyBoothBatchMs = elapsed(emptyBoothBatchStart);

    // 第一阶段 B：精确摊位候选不足时，按标准化名称查询数据库。
    const databaseSearchStart = performance.now();
    const dbTasks = new Map<string, { keyword: string; indices: number[] }>();
    results.forEach((result, indexValue) => {
      if (emptyBoothHandledIndices.has(indexValue)) return;
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
          const freshItems = await searchCPPItems(eventId, task.keyword, 50, dayIds, client);
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
      if (emptyBoothHandledIndices.has(indexValue)) return;
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
    const externalBudgetExceeded = performance.now() >= deadline;

    // CPG 搜索/数据库快照可能缺少交换类型。匹配决策完成后，仅为已接受的
    // 数据库结果按制品 ID 去重尽力补详情；失败时保留匹配结果，由前端按有料处理。
    const cpgDetailStart = performance.now();
    const cpgDetailTargets = new Map<number, number[]>();
    if (eventId === "cpg08") {
      results.forEach((result, indexValue) => {
        const cppItem = result.cppItem;
        if (
          result.decision !== "accepted" ||
          result.source === "external-api" ||
          !cppItem?.doujinshiId ||
          cppItem.exchangeType?.trim()
        ) {
          return;
        }
        const targetIndices = cpgDetailTargets.get(cppItem.doujinshiId) || [];
        targetIndices.push(indexValue);
        cpgDetailTargets.set(cppItem.doujinshiId, targetIndices);
      });
    }

    const cpgDetailCookie = cpgDetailTargets.size > 0
      ? cppCookie || getCPPCookieHeader()
      : "";
    const cpgDetailEnabled = Boolean(cpgDetailCookie && cpgDetailTargets.size > 0);
    const cpgDetailDeadline = Math.min(
      performance.now() + CPG_DETAIL_BUDGET_MS,
      requestStart + SERVER_BUDGET_MS
    );
    let cpgDetailAttempted = 0;
    let cpgDetailResponses = 0;
    let cpgDetailExchangeTypes = 0;
    if (cpgDetailEnabled) {
      await mapWithConcurrency(
        Array.from(cpgDetailTargets.keys()),
        CPG_DETAIL_CONCURRENCY,
        async (doujinshiId) => {
          if (performance.now() >= cpgDetailDeadline) return;
          cpgDetailAttempted += 1;
          const detail = await fetchCPPExternalDetail(
            doujinshiId,
            cpgDetailCookie,
            cpgDetailDeadline
          );
          if (!detail) return;
          cpgDetailResponses += 1;
          if (detail.exchangeType) cpgDetailExchangeTypes += 1;
          for (const indexValue of cpgDetailTargets.get(doujinshiId) || []) {
            const current = results[indexValue];
            if (!current.cppItem) continue;
            results[indexValue] = {
              ...current,
              cppItem: enrichCPPItemWithDetail(current.cppItem, detail),
            };
          }
        }
      );
    }
    const cpgDetailMs = elapsed(cpgDetailStart);
    const cpgDetailBudgetExceeded =
      cpgDetailAttempted < cpgDetailTargets.size &&
      performance.now() >= cpgDetailDeadline;

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
      emptyBoothBatchItems: emptyBoothHandledIndices.size,
      emptyBoothCandidates,
      databaseSearchTasks: dbTasks.size,
      externalEligible: externalTasks.size,
      externalEnabled,
      externalAttempted: selectedExternalTasks.length,
      externalResponses,
      externalDetails,
      cpgDetailEligible: cpgDetailTargets.size,
      cpgDetailEnabled,
      cpgDetailAttempted,
      cpgDetailResponses,
      cpgDetailExchangeTypes,
      cpgDetailBudgetExceeded,
      fromAPI: fromExternal,
      fallbackRate: items.length > 0
        ? Math.round((selectedExternalTasks.length / items.length) * 10_000) / 100
        : 0,
      budgetExceeded: externalBudgetExceeded,
    };
    const timings = {
      clientParseMs: body.clientTimings?.parseMs,
      clientDedupeMs: body.clientTimings?.dedupeMs,
      bodyMs,
      scopeMs,
      candidateQueryMs,
      databaseMatchMs,
      emptyBoothBatchMs,
      databaseSearchMs,
      externalMs,
      cpgDetailMs,
      cpgDetailBudgetMs: CPG_DETAIL_BUDGET_MS,
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
    const unauthorized = error?.message === "AUTH_REQUIRED";
    return NextResponse.json(
      {
        error: unauthorized ? "登录状态无效，请刷新后重试" : `匹配服务异常: ${error.message}`,
        timings: { serverTotalMs: elapsed(requestStart) },
      },
      { status: unauthorized ? 401 : 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { client } = await authenticateRequest(request);
    const { searchParams } = new URL(request.url);
    const booth = searchParams.get("booth");
    const requestedEventId = searchParams.get("event") || "";
    if (!requestedEventId || !(await getEventMembership(requestedEventId, client))) {
      return NextResponse.json({ error: "无权查询这份list" }, { status: 403 });
    }
    const scope = await resolveCPPMatchScope(requestedEventId, client, false);
    if (!booth) {
      return NextResponse.json({ error: "缺少 booth 参数" }, { status: 400 });
    }
    const items = await getCPPItems(scope.eventId, scope.dayIds, client);
    const boothItems = new MatchIndex(items).getByBooth(booth);
    return NextResponse.json({ booth, count: boothItems.length, items: boothItems });
  } catch (error: any) {
    const unauthorized = error?.message === "AUTH_REQUIRED";
    return NextResponse.json(
      { error: unauthorized ? "登录状态无效，请刷新后重试" : `查询服务异常: ${error.message}` },
      { status: unauthorized ? 401 : 500 }
    );
  }
}
