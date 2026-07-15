import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

// 方法1: count head
const { count: headCount } = await supabase.from('cpp_items').select('*', { count: 'exact', head: true }).eq('event_id', 'cp32');
console.log("方法1 (head count):", headCount);

// 方法2: 实际查出来数
const { data: all } = await supabase.from('cpp_items').select('id').eq('event_id', 'cp32');
console.log("方法2 (实际查询):", all?.length || 0);

// 方法3: 不带 filter
const { count: totalCount } = await supabase.from('cpp_items').select('*', { count: 'exact', head: true });
console.log("方法3 (总数据量):", totalCount);

// 方法4: 按 event_id 分组
const { data: byEvent } = await supabase.from('cpp_items').select('event_id').limit(10000);
const eventCounts = {};
for (const r of (byEvent || [])) {
  eventCounts[r.event_id] = (eventCounts[r.event_id] || 0) + 1;
}
console.log("方法4 (前10000条按event_id):", JSON.stringify(eventCounts));

