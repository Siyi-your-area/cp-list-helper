import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);
const { data, error } = await supabase.from('cpp_items').select('hot_count,original_work,exchange_type,description').limit(1);
if (error) { console.log("", error.message); process.exit(1); }
console.log("✅ 新字段可用:", Object.keys(data[0]).join(', '));

// 检查4个缺失分类当前数据量
const missingTypes = [[33,'卡片'],[34,'纸胶带'],[41,'COS'],[42,'手办']];
for (const [id, name] of missingTypes) {
  const { count } = await supabase.from('cpp_items').select('*', { count: 'exact', head: true }).eq('event_id','cp32').eq('type_id', id);
  console.log(`  ${name}(${id}): ${count} 条`);
}
