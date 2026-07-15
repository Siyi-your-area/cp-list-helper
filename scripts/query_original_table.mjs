import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co",
  process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v"
);

const { data } = await supabase
  .from('cpp_items')
  .select('product_name, hot_count, exchange_type, author, booth_number, type_name, day_id, doujinshi_id, original_work, description')
  .eq('event_id', 'cp32')
  .eq('original_work', '原创')
  .order('hot_count', { ascending: false })
  .limit(50);

for (const [i, item] of data.entries()) {
  const desc = (item.description || '').replace(/\n/g, ' ').slice(0, 50);
  console.log(`${String(i+1).padStart(2)} | 热度${String(item.hot_count).padStart(5)} | ${item.exchange_type === '无料交换' ? '无料' : '有偿'} | ${item.product_name.slice(0, 22).padEnd(24)} | 作者:${(item.author||'-').slice(0, 10).padEnd(10)} | ${item.booth_number || '-'} | ${item.type_name} | ${desc}...`);
}
