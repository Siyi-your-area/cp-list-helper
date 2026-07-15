/**
 * CPP 展品详情页爬取脚本
 *
 * 抓取每个展品的详情页 HTML，提取搜索 API 没有的字段：
 * - exchange_type（交换状态：有偿交换/无料交换）
 * - description（展品详情文字）
 * - hot_count（热度，搜索 API 也有但这里作为补充）
 * - original_work（原作，搜索 API 也有但这里作为补充）
 *
 * 支持断点续爬：进度保存到 crawl-detail-progress.json
 *
 * 使用方法：
 *   # 全量抓取（所有需要补充的展品）
 *   node scripts/crawl-cpp-details.mjs
 *
 *   # 只抓特定展会
 *   node scripts/crawl-cpp-details.mjs --event=cp32
 *
 *   # 测试（只抓前 10 条）
 *   node scripts/crawl-cpp-details.mjs --limit=10
 *
 *   # 跳过已有数据的条目（默认行为）
 *   node scripts/crawl-cpp-details.mjs --skip-filled
 *
 *   # 强制重抓所有条目
 *   node scripts/crawl-cpp-details.mjs --force
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// ---- 参数解析 ----

const { values } = parseArgs({
  options: {
    event: { type: "string", default: "cp32" },
    limit: { type: "string" },       // 限制抓取条数（测试用）
    skipFilled: { type: "boolean", default: true },  // 跳过已有 exchange_type 的
    force: { type: "boolean", default: false },       // 强制重抓
    concurrency: { type: "string", default: "5" },    // 并发数
    delay: { type: "string", default: "500" },        // 请求间隔 ms
  },
});

// ---- 配置 ----

const PROGRESS_FILE = path.join(process.cwd(), "scripts/crawl-detail-progress.json");
const CONCUR = parseInt(values.concurrency);
const DELAY = parseInt(values.delay);

// ---- Supabase 客户端 ----

const supabaseUrl = process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v";
const supabase = createClient(supabaseUrl, supabaseKey);

// ---- Cookie 读取 ----

let COOKIE_STR = "";
try {
  const cookiePath = path.join(process.cwd(), "cpp-cookies.json");
  const cookies = JSON.parse(readFileSync(cookiePath, "utf-8"));
  COOKIE_STR = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
} catch {
  console.error("❌ 找不到 cpp-cookies.json，请先登录 CPP 并导出 Cookie");
  process.exit(1);
}

// ---- HTML 解析函数 ----

/**
 * 从详情页 HTML 中提取信息
 */
function parseDetailHTML(html) {
  const result = {
    hot_count: 0,
    original_work: "",
    exchange_type: "",
    description: "",
  };

  // 1. 热度: class="djs-info-hot" 区域内的 <span>数字</span>
  const hotMatch = html.match(/class="djs-info-hot"[^>]*>[\s\S]*?<span>(\d+)<\/span>/);
  if (hotMatch) result.hot_count = parseInt(hotMatch[1]);

  // 2. KV 对：原作、交换
  const kvRegex = /([一-龥]{2,4})[：:]\s*([^<"\n]+)/g;
  let kvMatch;
  while ((kvMatch = kvRegex.exec(html)) !== null) {
    const key = kvMatch[1].trim();
    const val = kvMatch[2].trim();
    if (key === "原作") result.original_work = val;
    if (key === "交换") result.exchange_type = val;
  }

  // 3. 展品详情文字: class="djs-tab-box info textEllipsis" 的文本内容
  const descMatch = html.match(/class="djs-tab-box info textEllipsis"[^>]*>([\s\S]*?)<\/div>/);
  if (descMatch) {
    result.description = descMatch[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return result;
}

// ---- 抓取详情页 ----

async function fetchDetailPage(doujinshiId) {
  const url = `https://www.allcpp.cn/d/${doujinshiId}.do`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html",
      Cookie: COOKIE_STR,
    },
  });

  if (!resp.ok) return null;
  return await resp.text();
}

// ---- 进度管理 ----

function loadProgress() {
  if (existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
      return {
        done: Array.isArray(data.done) ? data.done : [],
        failed: Array.isArray(data.failed) ? data.failed : [],
        stats: data.stats || {},
      };
    } catch {
      return { done: [], failed: [], stats: {} };
    }
  }
  return { done: [], failed: [], stats: {} };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---- 批量更新 Supabase ----

async function batchUpdate(items) {
  if (items.length === 0) return;

  // 逐条更新（用 ID 定位），避免 upsert 需要所有 NOT NULL 字段
  for (const item of items) {
    const { error } = await supabase
      .from("cpp_items")
      .update({
        hot_count: item.hot_count,
        original_work: item.original_work,
        exchange_type: item.exchange_type,
        description: item.description,
      })
      .eq("id", item.id);

    if (error) {
      console.error(`    ❌ 更新 ID=${item.id} 失败：${error.message}`);
    }
  }
}

// ---- 主流程 ----

async function main() {
  const startTime = Date.now();
  console.log(`\n🔍 CPP 详情页爬取脚本`);
  console.log(`📅 展会：${values.event}`);
  console.log(`⚡ 并发：${CONCUR}，延迟：${DELAY}ms`);
  if (values.limit) console.log(` 限制：最多 ${values.limit} 条`);
  console.log(`⏭️  跳过已有数据：${values.skipFilled && !values.force ? "是" : "否（强制重抓）"}`);
  console.log("");

  // 1. 加载进度
  const progress = loadProgress();
  const doneSet = new Set(progress.done.map((d) => `${d.event_id}|${d.day_id}|${d.doujinshi_id}`));
  const failedSet = new Set(progress.failed.map((f) => `${f.event_id}|${f.day_id}|${f.doujinshi_id}`));

  console.log(`📊 已爬：${progress.done.length}，失败：${progress.failed.length}`);

  // 2. 查询需要爬取的条目（分页获取全部）
  console.log("\n 查询待爬取条目...");

  const allItems = [];
  let queryOffset = 0;
  const PAGE_SIZE = 1000;

  while (true) {
    let query = supabase
      .from("cpp_items")
      .select("id, event_id, day_id, doujinshi_id, product_name, source_url, exchange_type")
      .eq("event_id", values.event)
      .range(queryOffset, queryOffset + PAGE_SIZE - 1);

    if (values.skipFilled && !values.force) {
      query = query.eq("exchange_type", "");
    }

    const { data: page, error } = await query;

    if (error) {
      console.error(" 查询失败:", error.message);
      process.exit(1);
    }

    if (!page || page.length === 0) break;
    allItems.push(...page);

    console.log(`  已查询 ${allItems.length} 条...`);

    if (page.length < PAGE_SIZE) break;
    queryOffset += PAGE_SIZE;

    // 避免查询过快
    await new Promise((r) => setTimeout(r, 100));
  }

  // 过滤已完成的
  const toCrawl = allItems.filter(
    (item) => !doneSet.has(`${item.event_id}|${item.day_id}|${item.doujinshi_id}`)
  );

  // 限制条数
  const crawlList = values.limit
    ? toCrawl.slice(0, parseInt(values.limit))
    : toCrawl;

  console.log(`\n  待爬取：${crawlList.length} 条（总计 ${allItems.length}，已爬 ${progress.done.length}）`);

  if (crawlList.length === 0) {
    console.log("\n✅ 没有需要爬取的条目！");
    return;
  }

  // 3. 并发爬取
  let crawled = 0;
  let failed = 0;
  const updateBatch = [];
  const BATCH_SIZE = 20;

  console.log(`\n🚀 开始爬取...\n`);

  // 使用简单的并发控制
  const queue = [...crawlList];
  const workers = [];

  for (let w = 0; w < Math.min(CONCUR, queue.length); w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) break;

          const key = `${item.event_id}|${item.day_id}|${item.doujinshi_id}`;

          try {
            const html = await fetchDetailPage(item.doujinshi_id);
            if (!html) {
              failed++;
              progress.failed.push({ event_id: item.event_id, day_id: item.day_id, doujinshi_id: item.doujinshi_id });
              if (failed % 10 === 0) {
                console.log(`  ⚠️ 已失败 ${failed} 条`);
              }
              await new Promise((r) => setTimeout(r, DELAY));
              continue;
            }

            const parsed = parseDetailHTML(html);

            updateBatch.push({
              ...item,
              ...parsed,
            });

            crawled++;
            doneSet.add(key);
            progress.done.push({ event_id: item.event_id, day_id: item.day_id, doujinshi_id: item.doujinshi_id });

            // 定期更新进度和写入数据库
            if (updateBatch.length >= BATCH_SIZE) {
              await batchUpdate(updateBatch);
              console.log(`  ✅ 已更新 ${updateBatch.length} 条到数据库（累计 ${crawled}）`);
              updateBatch.length = 0;
              saveProgress(progress);
            }

            if (crawled % 50 === 0) {
              const pct = ((crawled / crawlList.length) * 100).toFixed(1);
              console.log(`  📊 进度：${crawled}/${crawlList.length} (${pct}%)`);
            }

            await new Promise((r) => setTimeout(r, DELAY));
          } catch (err) {
            failed++;
            progress.failed.push({ event_id: item.event_id, day_id: item.day_id, doujinshi_id: item.doujinshi_id });
            console.error(`  ❌ ${item.product_name} (ID:${item.doujinshi_id}): ${err.message}`);
            await new Promise((r) => setTimeout(r, DELAY * 2)); // 失败后加倍延迟
          }
        }
      })()
    );
  }

  await Promise.all(workers);

  // 4. 写入剩余批次
  if (updateBatch.length > 0) {
    await batchUpdate(updateBatch);
    console.log(`  ✅ 最后批次：${updateBatch.length} 条`);
    updateBatch.length = 0;
  }

  saveProgress(progress);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n✅ 完成！`);
  console.log(`   爬取：${crawled} 条`);
  console.log(`   失败：${failed} 条`);
  console.log(`   耗时：${elapsed} 秒`);

  // 查询验证
  const { count } = await supabase
    .from("cpp_items")
    .select("*", { count: "exact", head: true })
    .eq("event_id", values.event)
    .neq("exchange_type", "");

  console.log(`\n📊 已有交换状态的展品：${count} 条`);
}

main().catch((error) => {
  console.error("\n❌ 脚本执行失败:", error.message);
  process.exit(1);
});
