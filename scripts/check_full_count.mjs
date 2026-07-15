import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

// 分批查询，看实际有多少条
let total = 0;
const typeGrid = {};
const dayGrid = {};
let pageSize = 1000;
let offset = 0;

while (true) {
  const { data, error } = await supabase
    .from('cpp_items')
    .select('type_id, type_name, day_id')
    .eq('event_id', 'cp32')
    .range(offset, offset + pageSize - 1);
  
  if (error) { console.log("Error:", error); break; }
  if (!data || data.length === 0) break;
  
  total += data.length;
  for (const r of data) {
    const key = `${r.type_name}(${r.type_id})`;
    typeGrid[key] = (typeGrid[key] || 0) + 1;
    dayGrid[r.day_id] = (dayGrid[r.day_id] || 0) + 1;
  }
  
  console.log(`已查 ${total} 条 (offset ${offset}-${offset + data.length - 1})`);
  
  if (data.length < pageSize) break;
  offset += pageSize;
}

console.log(`\n=== 最终结果 ===`);
console.log(`cp32 总条目: ${total}`);
console.log(`\n按分类:`);
for (const [k, v] of Object.entries(typeGrid).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k}: ${v}`);
}
console.log(`\n按日期:`);
for (const [k, v] of Object.entries(dayGrid).sort()) {
  console.log(`  day ${k}: ${v}`);
}

const allTypes = Object.keys(typeGrid).length;
console.log(`\n分类覆盖: ${allTypes} / 16`);
