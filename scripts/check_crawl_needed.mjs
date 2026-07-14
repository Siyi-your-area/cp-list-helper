import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

// 统计各字段填充情况
let offset = 0;
const stats = { total: 0, hasExchange: 0, hasDesc: 0, hasHot: 0, hasOriginal: 0, needsDetail: 0 };

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
    if (!r.exchange_type || !r.description) stats.needsDetail++;
  }
  if (data.length < 1000) break;
  offset += 1000;
}

console.log(`总条目: ${stats.total}`);
console.log(`已有热度: ${stats.hasHot} (${(stats.hasHot/stats.total*100).toFixed(1)}%)`);
console.log(`已有原作: ${stats.hasOriginal} (${(stats.hasOriginal/stats.total*100).toFixed(1)}%)`);
console.log(`已有交换: ${stats.hasExchange} (${(stats.hasExchange/stats.total*100).toFixed(1)}%)`);
console.log(`已有详情: ${stats.hasDesc} (${(stats.hasDesc/stats.total*100).toFixed(1)}%)`);
console.log(`需要爬详情页: ${stats.needsDetail}`);

const timeAt500ms = stats.needsDetail * 0.5 / 3600;
const timeAt300ms = stats.needsDetail * 0.3 / 3600;
console.log(`\n预计耗时 (并发5, 延迟500ms): ${timeAt500ms.toFixed(1)} 小时`);
console.log(`预计耗时 (并发5, 延迟300ms): ${timeAt300ms.toFixed(1)} 小时`);
