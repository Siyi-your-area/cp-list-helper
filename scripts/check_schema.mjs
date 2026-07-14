import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v";
const supabase = createClient(supabaseUrl, supabaseKey);

// RPC 查询表结构
const { data, error } = await supabase.rpc('get_table_columns', { table_name: 'cpp_items' });
if (error) {
  console.log("RPC 不可用，用替代方法...");
  // 用 SELECT 查所有字段
  const { data: rows, error: e2 } = await supabase.from('cpp_items').select('*').limit(1);
  if (e2) { console.log(e2); process.exit(1); }
  if (rows && rows[0]) {
    console.log("现有字段:", Object.keys(rows[0]).sort().join(', '));
  }
} else {
  console.log("列信息:");
  for (const col of data) {
    console.log(`  ${col.column_name} (${col.data_type}) ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
  }
}
