import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

// 1. 整体统计
let offset = 0;
const stats = { total: 0, hasExchange: 0, hasDesc: 0, hasHot: 0, hasOriginal: 0, freeCount: 0, paidCount: 0 };

while (true) {
  const { data } = await supabase
    .from('cpp_items')
    .select('exchange_type, description, hot_count, original_work')
    .eq('event_id', 'cp32')
    .range(offset, offset + 999);
  if (!data || data.length === 0) break;
  stats.total += data.length;
  for (const r of data) {
    if (r.exchange_type) stats.hasExchange++;
    if (r.description) stats.hasDesc++;
    if (r.hot_count > 0) stats.hasHot++;
    if (r.original_work) stats.hasOriginal++;
    if (r.exchange_type?.includes('无料')) stats.freeCount++;
    if (r.exchange_type?.includes('有偿')) stats.paidCount++;
  }
  if (data.length < 1000) break;
  offset += 1000;
}

console.log("=== 数据覆盖统计 ===");
console.log(`总条目: ${stats.total}`);
console.log(`热度: ${stats.hasHot} (${(stats.hasHot/stats.total*100).toFixed(1)}%)`);
console.log(`原作: ${stats.hasOriginal} (${(stats.hasOriginal/stats.total*100).toFixed(1)}%)`);
console.log(`交换状态: ${stats.hasExchange} (${(stats.hasExchange/stats.total*100).toFixed(1)}%)`);
console.log(`详情文字: ${stats.hasDesc} (${(stats.hasDesc/stats.total*100).toFixed(1)}%)`);
console.log(`\n有料: ${stats.paidCount}, 无料: ${stats.freeCount}`);

// 2. 抽样验证
console.log("\n=== 抽样验证 (10条) ===");
const { data: sample } = await supabase
  .from('cpp_items')
  .select('product_name, hot_count, original_work, exchange_type, description')
  .eq('event_id', 'cp32')
  .neq('exchange_type', '')
  .limit(10);

for (const item of (sample || [])) {
  console.log(`\n  ${item.product_name}`);
  console.log(`    热度:${item.hot_count} | 原作:${item.original_work} | 交换:${item.exchange_type}`);
  console.log(`    详情:${item.description?.slice(0, 50) || '(空)'}...`);
}

// 3. 检查之前匹配失败的"幼猫修行"
console.log("\n=== 幼猫修行检查 ===");
const { data: youmao } = await supabase
  .from('cpp_items')
  .select('product_name, doujinshi_id, exchange_type, original_work, booth_number')
  .eq('event_id', 'cp32')
  .ilike('product_name', '%幼猫%');
console.log(`找到 ${youmao?.length || 0} 条:`);
for (const r of (youmao || [])) {
  console.log(`  ${r.product_name} | ID:${r.doujinshi_id} | 摊位:${r.booth_number} | 交换:${r.exchange_type} | 原作:${r.original_work}`);
}
