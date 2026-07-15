import { NextRequest, NextResponse } from "next/server";
import { createMatchIndex, MatchIndex } from "@/lib/cpp-matcher";
import { getCPPItems, searchCPPItems } from "@/lib/db-service";
import type { NormalizedCPPItem, MatchInput, MatchResult } from "@/lib/types";

// ---- 数据缓存（避免每次请求都查数据库）----

const indexCache = new Map<string, { index: MatchIndex; time: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

async function getIndex(eventId: string): Promise<MatchIndex> {
  const now = Date.now();
  const cached = indexCache.get(eventId);
  if (cached && now - cached.time < CACHE_TTL) {
    return cached.index;
  }

  const items = await getCPPItems(eventId);
  const index = new MatchIndex(items);
  indexCache.set(eventId, { index, time: now });

  console.log(`[CPP Match] ${eventId} 加载数据完成，共 ${index.size} 条`);
  return index;
}

// ---- CPP API 实时查询（兜底）----

interface CachedFetch {
  items: NormalizedCPPItem[];
  time: number;
}

const keywordCache = new Map<string, CachedFetch>();
const KEYWORD_CACHE_TTL = 30 * 60 * 1000;

function getCookies(): string {
  try {
    const cookiePath = path.join(process.cwd(), "cpp-cookies.json");
    const fs = require("fs");
    const cookies = JSON.parse(fs.readFileSync(cookiePath, "utf-8"));
    return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

async function fetchByKeyword(
  keyword: string,
  boothNumber?: string,
  dayIds: string[] = ["7040", "7042"]
): Promise<NormalizedCPPItem[]> {
  if (!keyword.trim()) return [];

  const cacheKey = `${keyword}|${boothNumber || ""}`;
  const cached = keywordCache.get(cacheKey);
  if (cached && Date.now() - cached.time < KEYWORD_CACHE_TTL) {
    return cached.items;
  }

  const cookieStr = getCookies();
  if (!cookieStr) return [];

  const items: NormalizedCPPItem[] = [];

  for (const dayId of dayIds) {
    try {
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

      const response = await fetch(
        `https://www.allcpp.cn/api/doujinshi/search.do?${params}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            Accept: "application/json",
            "Content-Type": "application/json",
            Cookie: cookieStr,
            Referer: "https://www.allcpp.cn/allcpp/event/eventdoujinshi.do?event=6377",
          },
        }
      );

      if (!response.ok) continue;

      const json = await response.json();
      if (!json.isSuccess) continue;

      const list = json.result?.list || [];
      for (const item of list) {
        const eventData = (item.eventList || []).filter((e: any) =>
          String(e.eventID) === String(dayId)
        );

        for (const event of eventData) {
          if (boothNumber && event.position !== boothNumber) continue;

          items.push({
            boothNumber: event.position || "",
            boothName: event.circleName || "",
            productName: item.doujinshiName || "",
            author: (item.authorList || [])
              .map((a: any) => a.authorName || String(a.authorId))
              .join(", "),
            imageUrl: item.coverPicUrl
              ? `https://imagecdn3.allcpp.cn/upload${item.coverPicUrl}`
              : "",
            tags: item.tag ? item.tag.split("|") : [],
            eventName: event.eventName || "",
            sourceUrl: `https://www.allcpp.cn/d/${item.doujinshiId}.do`,
            doujinshiId: item.doujinshiId || 0,
          });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      console.warn(`[CPP Fetch] keyword="${keyword}" day=${dayId} 失败:`, error);
    }
  }

  keywordCache.set(cacheKey, { items, time: Date.now() });
  return items;
}

function extractSearchKeyword(productName: string): string {
  if (!productName) return "";

  let cleaned = productName;

  // Step 1: 分离摊位号和后续内容
  // "肆Q40《Fairy Tales》" → "《Fairy Tales》"
  const boothMatch = cleaned.match(/^[一-\u9fff]+[A-Z]?\d+(.*)/);
  if (boothMatch && boothMatch[1].trim()) {
    cleaned = boothMatch[1].trim();
  }

  // Step 2: 去掉前缀标记 【】《》「」『』[]()（）
  cleaned = cleaned.replace(/^[\(（【\[「『《][^\)）】\]」』》]*[\)）】\]」』》]\s*/g, "");

  // Step 3: 如果处理后太短，尝试从原始输入中提取书名号内容
  if (cleaned.trim().length < 2) {
    const bracketMatch = productName.match(/[【\[《「『]([^】\]》」』]+)[】\]》」』]/);
    if (bracketMatch && bracketMatch[1].trim().length >= 2) {
      cleaned = bracketMatch[1].trim();
    } else {
      cleaned = productName;
    }
  }

  // Step 4: 去掉常见角色名前缀（跟 · • - ｜ | 或 《 的）
  cleaned = cleaned.replace(/^(图奈|奈费勒|苏游|萨米尔|花苏)[·•\-｜|《]\s*/g, "");

  // Step 5: 去掉尾部残留的括号标记
  cleaned = cleaned.replace(/[\)）】\]」』》]+$/, "");

  // 去掉首尾空格，保留中间空格
  cleaned = cleaned.trim();

  return cleaned.slice(0, 20);
}


// ---- API Handler ----

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const items: MatchInput[] = body.items || [];
    const eventId: string = body.eventId || "cp32";

    if (items.length === 0) {
      return NextResponse.json({ results: [], stats: {} });
    }

    if (items.length > 1000) {
      return NextResponse.json(
        { error: "单次最多匹配 1000 条" },
        { status: 400 }
      );
    }

    // 第一轮：Supabase 数据匹配
    const index = await getIndex(eventId);
    const results: MatchResult[] = index.matchBatch(items);

    // 第二轮：未匹配的条目，用 Supabase 搜索 API 查找
    const unmatchedIndices: number[] = [];
    results.forEach((r, i) => {
      if (!r.matched) unmatchedIndices.push(i);
    });

    let dbSearchCount = 0;
    if (unmatchedIndices.length > 0) {
      console.log(`[CPP Match] ${unmatchedIndices.length} 条未匹配，尝试 Supabase 搜索...`);

      const searchTasks = new Map<string, { indices: number[]; keyword: string; booth: string }>();

      for (const i of unmatchedIndices) {
        const input = items[i];
        const keyword = extractSearchKeyword(input.productName);
        if (!keyword) continue;

        const taskKey = `${input.boothNumber}|${keyword}`;
        const existing = searchTasks.get(taskKey);
        if (existing) {
          existing.indices.push(i);
        } else {
          searchTasks.set(taskKey, {
            indices: [i],
            keyword,
            booth: input.boothNumber,
          });
        }
      }

      const taskEntries = Array.from(searchTasks.values());
      const batchSize = 5;

      for (let b = 0; b < taskEntries.length; b += batchSize) {
        const batch = taskEntries.slice(b, b + batchSize);
        await Promise.all(
          batch.map(async (task) => {
            const freshItems = await searchCPPItems(eventId, task.keyword);
            if (freshItems.length === 0) return;

            dbSearchCount += freshItems.length;

            const freshIndex = createMatchIndex(
              freshItems.map((item) => ({
                ...item,
                participationInfo: [{
                  status: "",
                  eventName: item.eventName,
                  eventDate: "",
                  boothName: item.boothName,
                  boothNumber: item.boothNumber,
                }],
              }))
            );

            for (const i of task.indices) {
              if (results[i].matched) continue;
              const freshResult = freshIndex.match(items[i]);
              if (freshResult.matched) {
                results[i] = {
                  ...freshResult,
                  reason: `搜索匹配（${freshResult.reason}）`,
                };
              }
            }
          })
        );
      }

      console.log(`[CPP Match] Supabase 搜索完成，额外匹配 ${dbSearchCount} 条`);
    }

    // 第二轮补充：仍未匹配的，不限摊位号，仅按商品名搜索（兜底）
    const stillUnmatchedAfterDb: number[] = [];
    results.forEach((r, i) => {
      if (!r.matched) stillUnmatchedAfterDb.push(i);
    });

    if (stillUnmatchedAfterDb.length > 0) {
      const nameOnlyTasks = new Map<string, { indices: number[]; keyword: string }>();
      for (const i of stillUnmatchedAfterDb) {
        const input = items[i];
        const keyword = extractSearchKeyword(input.productName);
        if (!keyword) continue;
        const existing = nameOnlyTasks.get(keyword);
        if (existing) {
          existing.indices.push(i);
        } else {
          nameOnlyTasks.set(keyword, { indices: [i], keyword });
        }
      }

      for (const [, task] of nameOnlyTasks) {
        const freshItems = await searchCPPItems(eventId, task.keyword);
        if (freshItems.length === 0) continue;

        // 找到同摊位或名称最接近的
        const freshIndex = createMatchIndex(
          freshItems.map((item) => ({
            ...item,
            participationInfo: [{
              status: "",
              eventName: item.eventName,
              eventDate: "",
              boothName: item.boothName,
              boothNumber: item.boothNumber,
            }],
          }))
        );

        for (const i of task.indices) {
          if (results[i].matched) continue;
          // 不限摊位号，只按名称匹配
          const input = items[i];
          const normProduct = input.productName.replace(/[\s ]/g, "").normalize("NFKC").toLowerCase();
          const nameHit = freshItems.find((item) => {
            const np = item.productName.replace(/[\s ]/g, "").normalize("NFKC").toLowerCase();
            return np.includes(normProduct) || normProduct.includes(np);
          });
          if (nameHit) {
            results[i] = {
              matched: true,
              confidence: "medium",
              cppItem: nameHit,
              reason: `名称兜底匹配（摊位 ${nameHit.boothNumber}）`,
            };
          }
        }
      }
    }

    // 第三轮：仍然未匹配的，尝试 CPP API 实时查询
    const stillUnmatched: number[] = [];
    results.forEach((r, i) => {
      if (!r.matched) stillUnmatched.push(i);
    });

    let apiFetchCount = 0;
    if (stillUnmatched.length > 0) {
      console.log(`[CPP Match] ${stillUnmatched.length} 条仍未匹配，尝试 CPP API 实时查询...`);

      const fetchTasks = new Map<string, { indices: number[]; keyword: string; booth: string }>();

      for (const i of stillUnmatched) {
        const input = items[i];
        const keyword = extractSearchKeyword(input.productName);
        if (!keyword) continue;

        const taskKey = `${input.boothNumber}|${keyword}`;
        const existing = fetchTasks.get(taskKey);
        if (existing) {
          existing.indices.push(i);
        } else {
          fetchTasks.set(taskKey, {
            indices: [i],
            keyword,
            booth: input.boothNumber,
          });
        }
      }

      const taskEntries = Array.from(fetchTasks.values());
      const batchSize = 3;

      for (let b = 0; b < taskEntries.length; b += batchSize) {
        const batch = taskEntries.slice(b, b + batchSize);
        await Promise.all(
          batch.map(async (task) => {
            const freshItems = await fetchByKeyword(task.keyword, task.booth);
            if (freshItems.length === 0) return;

            apiFetchCount += freshItems.length;

            const freshIndex = createMatchIndex(
              freshItems.map((item) => ({
                ...item,
                participationInfo: [{
                  status: "",
                  eventName: item.eventName,
                  eventDate: "",
                  boothName: item.boothName,
                  boothNumber: item.boothNumber,
                }],
              }))
            );

            for (const i of task.indices) {
              if (results[i].matched) continue;
              const freshResult = freshIndex.match(items[i]);
              if (freshResult.matched) {
                results[i] = {
                  ...freshResult,
                  reason: `实时匹配（${freshResult.reason}）`,
                };
              }
            }
          })
        );
      }

      console.log(`[CPP Match] CPP API 查询完成，获取 ${apiFetchCount} 个新展品`);
    }

    const stats = {
      total: items.length,
      matched: results.filter((r) => r.matched).length,
      exact: results.filter((r) => r.confidence === "exact").length,
      high: results.filter((r) => r.confidence === "high").length,
      medium: results.filter((r) => r.confidence === "medium").length,
      low: results.filter((r) => r.confidence === "low").length,
      none: results.filter((r) => r.confidence === "none").length,
      fromSupabase: dbSearchCount,
      fromAPI: apiFetchCount,
    };

    return NextResponse.json({ results, stats });
  } catch (error: any) {
    console.error("[CPP Match] 匹配失败:", error);
    return NextResponse.json(
      { error: "匹配服务异常: " + error.message },
      { status: 500 }
    );
  }
}

/**
 * GET /api/cpp/match?booth=陆P03&event=cp32
 * 按摊位号查询所有展品
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const booth = searchParams.get("booth");
    const eventId = searchParams.get("event") || "cp32";

    if (!booth) {
      return NextResponse.json({ error: "缺少 booth 参数" }, { status: 400 });
    }

    const items = await getCPPItems(eventId);
    const index = new MatchIndex(items);
    const boothItems = index.getByBooth(booth);

    return NextResponse.json({ booth, count: boothItems.length, items: boothItems });
  } catch (error: any) {
    console.error("[CPP Query] 查询失败:", error);
    return NextResponse.json(
      { error: "查询服务异常: " + error.message },
      { status: 500 }
    );
  }
}

import fs from "fs";
import path from "path";
