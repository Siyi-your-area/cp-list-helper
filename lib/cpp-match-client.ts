import type { MatchInput, MatchResult } from "./types";

export const CPP_MATCH_BATCH_SIZE = 20;
const CPP_MATCH_BATCH_RETRIES = 1;

export type CPPMatchFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

interface MatchInBatchesOptions {
  items: MatchInput[];
  eventId: string;
  fetcher: CPPMatchFetcher;
  clientTimings?: Record<string, number>;
  onProgress?: (completed: number, total: number) => void;
}

export interface BatchedMatchResponse {
  results: MatchResult[];
  stats: Record<string, any>;
  timings: Record<string, any>;
}

function mergeStats(
  target: Record<string, any>,
  incoming: Record<string, any>
) {
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === "number") {
      target[key] = (typeof target[key] === "number" ? target[key] : 0) + value;
    } else if (typeof value === "boolean") {
      target[key] = Boolean(target[key]) || value;
    } else if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

export async function matchCPPItemsInBatches({
  items,
  eventId,
  fetcher,
  clientTimings,
  onProgress,
}: MatchInBatchesOptions): Promise<BatchedMatchResponse> {
  const startedAt = performance.now();
  const results: MatchResult[] = [];
  const stats: Record<string, any> = {};
  let serverTotalMs = 0;
  let allServerBatchesWithinTarget = true;

  for (let offset = 0; offset < items.length; offset += CPP_MATCH_BATCH_SIZE) {
    const batch = items.slice(offset, offset + CPP_MATCH_BATCH_SIZE);
    let batchData: Record<string, any> | null = null;
    let lastError: unknown;

    for (let attempt = 0; attempt <= CPP_MATCH_BATCH_RETRIES; attempt += 1) {
      try {
        const response = await fetcher("/api/cpp/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: batch,
            eventId,
            ...(offset === 0 && clientTimings ? { clientTimings } : {}),
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || `匹配请求失败（HTTP ${response.status}）`);
        }
        if (!Array.isArray(data?.results) || data.results.length !== batch.length) {
          throw new Error(
            `匹配结果数量异常：期望 ${batch.length} 条，实际 ${data?.results?.length ?? 0} 条`
          );
        }
        batchData = data;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!batchData) {
      const batchNumber = Math.floor(offset / CPP_MATCH_BATCH_SIZE) + 1;
      throw new Error(
        `第 ${batchNumber} 批匹配失败：${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    }

    results.push(...(batchData.results as MatchResult[]));
    mergeStats(stats, batchData.stats || {});
    if (typeof batchData.timings?.serverTotalMs === "number") {
      serverTotalMs += batchData.timings.serverTotalMs;
    }
    if (batchData.timings?.withinTarget === false) {
      allServerBatchesWithinTarget = false;
    }
    onProgress?.(results.length, items.length);
  }

  stats.total = items.length;
  stats.matched = results.filter((result) => result.matched).length;
  stats.accepted = results.filter((result) => result.decision === "accepted").length;
  stats.review = results.filter((result) => result.decision === "review").length;
  stats.unmatched = results.filter((result) => result.decision === "unmatched").length;
  stats.none = stats.unmatched;
  stats.exact = results.filter((result) => result.confidence === "exact").length;
  stats.high = results.filter((result) => result.confidence === "high").length;
  stats.medium = results.filter((result) => result.confidence === "medium").length;
  stats.low = results.filter((result) => result.confidence === "low").length;

  return {
    results,
    stats,
    timings: {
      batchCount: Math.ceil(items.length / CPP_MATCH_BATCH_SIZE),
      requestMs: performance.now() - startedAt,
      serverTotalMs,
      withinTarget: allServerBatchesWithinTarget,
    },
  };
}
