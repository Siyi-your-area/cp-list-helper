import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

// 按 type_id × day_id 分组统计
const { data } = await supabase
  .from('cpp_items')
  .select('type_id, type_name, day_id')
  .eq('event_id', 'cp32');

const grid = {};
for (const r of data) {
  const key = `${r.type_name}(${r.type_id})`;
  if (!grid[key]) grid[key] = {};
  grid[key][r.day_id] = (grid[key][r.day_id] || 0) + 1;
}

console.log("type_id | type_name | 7040(一期) | 7042(二期) | 合计");
console.log("---");
let total7040 = 0, total7042 = 0;
for (const [name, days] of Object.entries(grid).sort()) {
  const d1 = days['7040'] || 0;
  const d2 = days['7042'] || 0;
  console.log(`${name.padEnd(20)} | ${String(d1).padStart(6)} | ${String(d2).padStart(6)} | ${d1+d2}`);
  total7040 += d1;
  total7042 += d2;
}
console.log("---");
console.log(`合计: 一期=${total7040}, 二期=${total7042}, 总计=${total7040+total7042}`);

// 检查是否有其他 day_id
const allDays = [...new Set(data.map(r => r.day_id))];
console.log("\n所有 day_id:", allDays.sort().join(', '));

// 总类型数
const allTypes = [...new Set(data.map(r => r.type_id))];
console.log("所有 type_id:", allTypes.sort((a,b) => a-b).join(', '));
console.log("类型数:", allTypes.length, "/ 16");
