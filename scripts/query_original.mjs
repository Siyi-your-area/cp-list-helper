import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

const { data, error } = await supabase
  .from('cpp_items')
  .select('*')
  .eq('event_id', 'cp32')
  .eq('original_work', '原创')
  .order('hot_count', { ascending: false })
  .limit(50);

if (error) { console.log("Error:", error.message); process.exit(1); }

console.log(`共 ${data.length} 条（按热度降序，showing top 50）\n`);

for (const item of data) {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`商品名:   ${item.product_name}`);
  console.log(`热度:     ${item.hot_count}`);
  console.log(`原作:     ${item.original_work}`);
  console.log(`交换:     ${item.exchange_type || '(空)'}`);
  console.log(`作者:     ${item.author}`);
  console.log(`摊位号:   ${item.booth_number}`);
  console.log(`社团名:   ${item.booth_name}`);
  console.log(`分类:     ${item.type_name}`);
  console.log(`活动日:   ${item.day_id}`);
  console.log(`CPP ID:   ${item.doujinshi_id}`);
  console.log(`标签:     ${(item.tags||[]).join(', ')}`);
  console.log(`图片:     ${item.image_url?.slice(0, 60)}...`);
  console.log(`来源:     ${item.source_url}`);
  console.log(`详情:     ${item.description?.slice(0, 80) || '(空)'}`);
  console.log(`创建时间: ${item.created_at}`);
  console.log('');
}
