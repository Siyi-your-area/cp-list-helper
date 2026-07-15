import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

// 按原作统计 Top 10
console.log("=== 原作 Top 10 ===");
let off2 = 0;
const origMap = {};
while (true) {
  const { data } = await supabase.from('cpp_items').select('original_work').eq('event_id','cp32').neq('original_work','').range(off2, off2+999);
  if (!data || data.length === 0) break;
  for (const r of data) { origMap[r.original_work] = (origMap[r.original_work]||0)+1; }
  if (data.length < 1000) break;
  off2 += 1000;
}
const topOrigins = Object.entries(origMap).sort((a,b)=>b[1]-a[1]).slice(0,10);
for (const [name, count] of topOrigins) {
  console.log(`  ${name}: ${count} 条`);
}

// 之前匹配失败的"幼猫修行"
console.log("\n=== 幼猫修行(ID:1682073) ===");
const { data: byId } = await supabase.from('cpp_items').select('*').eq('event_id','cp32').eq('doujinshi_id', 1682073);
console.log("直接ID查询:", byId?.length || 0, "条");

// 搜索"幼猫修行"
const { data: byName } = await supabase.from('cpp_items').select('product_name,doujinshi_id,booth_number,exchange_type,original_work,author,hot_count').eq('event_id','cp32').ilike('product_name','%幼猫修行%');
console.log("名称搜索:", byName?.length || 0, "条");
for (const r of (byName||[])) {
  console.log(`  ${r.product_name} | ID:${r.doujinshi_id} | 摊位:${r.booth_number}`);
  console.log(`    作者:${r.author} | 交换:${r.exchange_type} | 原作:${r.original_work} | 热度:${r.hot_count}`);
}

// 无料交换示例
console.log("\n=== 无料交换示例 ===");
const { data: freeItems } = await supabase.from('cpp_items').select('product_name,exchange_type,author,booth_number').eq('event_id','cp32').eq('exchange_type','无料交换').limit(5);
for (const r of (freeItems||[])) {
  console.log(`  ${r.product_name} | 摊位:${r.booth_number} | 作者:${r.author}`);
}

// 缺少交换状态的条目
console.log("\n=== 缺少交换状态 ===");
let missingCount = 0;
let off3 = 0;
while (true) {
  const { data } = await supabase.from('cpp_items').select('id').eq('event_id','cp32').eq('exchange_type','').range(off3, off3+999);
  if (!data || data.length === 0) break;
  missingCount += data.length;
  if (data.length < 1000) break;
  off3 += 1000;
}
console.log(`缺少交换状态的条目: ${missingCount}`);
