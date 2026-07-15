/**
 * CPP 展品数据爬取脚本（Supabase 版）
 *
 * 按分类逐个爬取搜索 API，存储基础字段。
 * 新增字段抓取（交换、详情文字）请使用 crawl-cpp-details.mjs。
 *
 * 使用方法：
 *   # 全量爬取（所有 16 个分类 + 两天）
 *   node scripts/crawl-cpp-supabase.mjs --mode=full
 *
 *   # 只补特定分类
 *   node scripts/crawl-cpp-supabase.mjs --mode=full --types=33,34,41,42
 *
 *   # 指定展会和日期
 *   node scripts/crawl-cpp-supabase.mjs --mode=full --event=cp32 --days=7040,7042
 *
 *   # 测试（限制每个分类最多 2 页）
 *   node scripts/crawl-cpp-supabase.mjs --mode=full --max=2
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ---- 参数解析 ----

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "full" },   // full | pilot
    event: { type: "string", default: "cp32" },
    days: { type: "string", default: "7040,7042" },
    types: { type: "string" },                   // 指定分类ID，逗号分隔
    max: { type: "string" },                     // 测试用：限制每个分类最多爬几页
  },
});

// ---- 配置 ----

const CPP_BASE_URL = "https://www.allcpp.cn";
const API_URL = `${CPP_BASE_URL}/api/doujinshi/search.do`;

// 分类映射
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

// 试点分类
const PILOT_TYPES = [36, 33]; // 漫画 + 卡片

// 分类选择逻辑
let selectedTypes;
if (values.types) {
  // 指定分类
  const typeIds = values.types.split(",").map((t) => parseInt(t.trim()));
  selectedTypes = TYPE_MAP.filter((t) => typeIds.includes(t.id));
} else if (values.mode === "full") {
  selectedTypes = TYPE_MAP; // 全部 16 个
} else {
  selectedTypes = TYPE_MAP.filter((t) => PILOT_TYPES.includes(t.id)); // 试点
}

const dayIds = values.days.split(",").map((d) => d.trim());

// ---- Supabase 客户端 ----

const supabaseUrl = process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v";
const supabase = createClient(supabaseUrl, supabaseKey);

// ---- Cookie 读取 ----

let COOKIE_STR = "";
try {
  const cookiePath = new URL("../cpp-cookies.json", import.meta.url);
  const cookies = JSON.parse(readFileSync(cookiePath, "utf-8"));
  COOKIE_STR = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
} catch {
  console.error("❌ 找不到 cpp-cookies.json，请先登录 CPP 并导出 Cookie");
  process.exit(1);
}

// ---- 打印配置 ----

console.log(`\n🚀 CPP 爬取脚本（Supabase 版）`);
console.log(`📋 模式：${values.mode === "full" ? "全量（16个分类）" : "试点（漫画+卡片）"}`);
console.log(`📅 展会：${values.event}`);
console.log(`📆 活动日：${dayIds.join(", ")}`);
console.log(`📂 分类：${selectedTypes.map((t) => t.name).join(", ")}`);
if (values.max) console.log(`🧪 限制：每个分类最多 ${values.max} 页`);
console.log("");

// ---- 爬取单页 ----

async function fetchPage(dayId, typeId, pageIndex, pageSize = 30) {
  const params = new URLSearchParams({
    eventId: String(dayId),
    keyword: "",
    orderBy: "1",
    typeIds: String(typeId),
    pageIndex: String(pageIndex),
    pageSize: String(pageSize),
    sellStatus: "",
    ideaType: "",
    tag: "",
    ideaStatus: "",
  });

  const response = await fetch(`${API_URL}?${params}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: COOKIE_STR,
      Referer: "https://www.allcpp.cn/allcpp/event/eventdoujinshi.do?event=6377",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();

  if (!json.isSuccess) {
    // Cookie 可能过期了
    if (json.message && (json.message.includes("登录") || json.message.includes("login"))) {
      throw new Error(`Cookie 已过期，请重新登录 CPP 并更新 cpp-cookies.json`);
    }
    throw new Error(`API 错误：${json.message || "未知错误"}`);
  }

  return json.result;
}

// ---- 爬取单个分类 ----

async function crawlCategory(dayId, type) {
  const allItems = [];
  let pageIndex = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const data = await fetchPage(dayId, type.id, pageIndex);
      const list = data.list || [];

      if (list.length === 0) {
        hasMore = false;
        break;
      }

      for (const item of list) {
        const eventData = (item.eventList || []).filter(
          (e) => String(e.eventID) === String(dayId)
        );

        for (const event of eventData) {
          allItems.push({
            event_id: values.event,
            day_id: String(dayId),
            type_id: type.id,
            type_name: type.name,
            doujinshi_id: item.doujinshiId,
            product_name: item.doujinshiName || "",
            author: (item.authorList || [])
              .map((a) => a.authorName || String(a.authorId))
              .join(", "),
            booth_number: event.position || "",
            booth_name: event.circleName || "",
            image_url: item.coverPicUrl
              ? `https://imagecdn3.allcpp.cn/upload${item.coverPicUrl}`
              : "",
            tags: item.tag ? item.tag.split("|") : [],
            source_url: `${CPP_BASE_URL}/d/${item.doujinshiId}.do`,
            // 新增字段（搜索 API 直接返回）
            hot_count: item.hotCount || 0,
            original_work: item.themeAlias || "",
          });
        }
      }

      console.log(
        `    📊 ${type.name} 第 ${pageIndex} 页：${list.length} 个展品 (累计 ${allItems.length}/${data.total})`
      );

      pageIndex++;

      if (allItems.length >= data.total) {
        hasMore = false;
      }

      if (values.max && pageIndex > parseInt(values.max)) {
        hasMore = false;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      console.error(`    ❌ ${type.name} 第 ${pageIndex} 页失败：`, error.message);
      throw error; // Cookie 过期等严重错误直接终止
    }
  }

  return allItems;
}

// ---- 写入 Supabase ----

async function upsertToSupabase(items) {
  if (items.length === 0) return;

  // 批次内去重（同一个 doujinshi_id 可能因 eventList 多次出现）
  const seen = new Set();
  const deduped = items.filter((item) => {
    const key = `${item.event_id}|${item.day_id}|${item.doujinshi_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) return;

  const { data, error } = await supabase
    .from("cpp_items")
    .upsert(deduped, {
      onConflict: "event_id,day_id,doujinshi_id",
      ignoreDuplicates: false,
    });

  if (error) {
    console.error(`    ❌ Supabase 写入失败：`, error.message);
    throw error;
  }

  console.log(`    ✅ Supabase 写入成功：${deduped.length} 条${deduped.length < items.length ? ` (去重 ${items.length - deduped.length} 条)` : ""}`);
}

// ---- 主流程 ----

async function main() {
  const startTime = Date.now();

  for (const dayId of dayIds) {
    console.log(`\n📅 活动日 day=${dayId}`);

    for (const type of selectedTypes) {
      console.log(`\n  📂 ${type.name} (typeId=${type.id})`);

      try {
        const items = await crawlCategory(dayId, type);
        console.log(`  📦 ${type.name} 共 ${items.length} 条`);

        // 分批写入 Supabase（每批 100 条）
        const batchSize = 100;
        for (let i = 0; i < items.length; i += batchSize) {
          const batch = items.slice(i, i + batchSize);
          await upsertToSupabase(batch);
        }
      } catch (error) {
        console.error(`  ❌ ${type.name} 爬取失败：`, error.message);
        console.error(`\n💡 如果提示 Cookie 过期，请重新登录 CPP 并更新 cpp-cookies.json`);
        process.exit(1);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n✅ 完成！耗时 ${elapsed} 秒`);

  // 查询验证
  const { count } = await supabase
    .from("cpp_items")
    .select("*", { count: "exact", head: true })
    .eq("event_id", values.event);

  console.log(`📊 数据库中 ${values.event} 共有 ${count} 条展品`);
}

main().catch((error) => {
  console.error("\n❌ 脚本执行失败：", error.message);
  process.exit(1);
});
