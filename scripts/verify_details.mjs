import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

const { data } = await supabase
  .from('cpp_items')
  .select('product_name, hot_count, original_work, exchange_type, description')
  .eq('event_id', 'cp32')
  .neq('exchange_type', '')
  .limit(5);

if (data) {
  for (const item of data) {
    console.log(`\n--- ${item.product_name} ---`);
    console.log(`  热度: ${item.hot_count}`);
    console.log(`  原作: ${item.original_work}`);
    console.log(`  交换: ${item.exchange_type}`);
    console.log(`  详情: ${item.description?.slice(0, 80) || '(空)'}...`);
  }
} else {
  console.log("无数据");
}
