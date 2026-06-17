import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { createMatchIndex, MatchIndex } from "@/lib/cpp-matcher";
import type { NormalizedCPPItem, MatchInput } from "@/lib/types";

// ---- 数据缓存（避免每次请求都读文件）----

let cachedIndex: MatchIndex | null = null;
let cachedTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function getIndex(): MatchIndex {
  const now = Date.now();
  if (cachedIndex && now - cachedTime < CACHE_TTL) {
    return cachedIndex;
  }

  // 读取标准化后的 CPP 数据
  // Vercel Serverless Function 中 process.cwd() = 项目根目录
  const dataPath = path.join(process.cwd(), "public/cpp/cp32/items.json");
  const rawData = fs.readFileSync(dataPath, "utf-8");
  const items: NormalizedCPPItem[] = JSON.parse(rawData);

  cachedIndex = new MatchIndex(items);
  cachedTime = now;

  console.log(`[CPP Match] 加载数据完成，共 ${cachedIndex.size} 条`);
  return cachedIndex;
}

// ---- API Handler ----

/**
 * POST /api/cpp/match
 *
 * 请求体:
 * {
 *   "items": [
 *     { "boothNumber": "陆P03", "productName": "最近可以了", "author": "TaTaG" },
 *     ...
 *   ]
 * }
 *
 * 响应:
 * {
 *   "results": [
 *     {
 *       "matched": true,
 *       "confidence": "exact",
 *       "reason": "精确匹配",
 *       "cppItem": { "boothNumber": "陆P03", "productName": "...", ... }
 *     },
 *     ...
 *   ],
 *   "stats": {
 *     "total": 100,
 *     "matched": 85,
 *     "exact": 60,
 *     "high": 15,
 *     "medium": 8,
 *     "low": 2,
 *     "none": 15
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const items: MatchInput[] = body.items || [];

    if (items.length === 0) {
      return NextResponse.json({ results: [], stats: {} });
    }

    // 限制单次最大匹配数量
    if (items.length > 1000) {
      return NextResponse.json(
        { error: "单次最多匹配 1000 条" },
        { status: 400 }
      );
    }

    const index = getIndex();
    const results = index.matchBatch(items);

    // 统计
    const stats = {
      total: items.length,
      matched: results.filter((r) => r.matched).length,
      exact: results.filter((r) => r.confidence === "exact").length,
      high: results.filter((r) => r.confidence === "high").length,
      medium: results.filter((r) => r.confidence === "medium").length,
      low: results.filter((r) => r.confidence === "low").length,
      none: results.filter((r) => r.confidence === "none").length,
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
 * GET /api/cpp/match?booth=陆P03
 * 按摊位号查询所有展品
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const booth = searchParams.get("booth");

    if (!booth) {
      return NextResponse.json(
        { error: "缺少 booth 参数" },
        { status: 400 }
      );
    }

    const index = getIndex();
    const items = index.getByBooth(booth);

    return NextResponse.json({ booth, count: items.length, items });
  } catch (error: any) {
    console.error("[CPP Query] 查询失败:", error);
    return NextResponse.json(
      { error: "查询服务异常: " + error.message },
      { status: 500 }
    );
  }
}
