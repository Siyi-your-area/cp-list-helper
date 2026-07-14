import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v";
const supabase = createClient(supabaseUrl, supabaseKey);

// Detailed type breakdown
const { data: byType } = await supabase
  .from('cpp_items')
  .select('type_id, type_name, day_id')
  .eq('event_id', 'cp32');

const typeCounts = {};
const dayCounts = {};
for (const r of byType) {
  const key = `${r.type_name}(${r.type_id})`;
  typeCounts[key] = (typeCounts[key] || 0) + 1;
  dayCounts[r.day_id] = (dayCounts[r.day_id] || 0) + 1;
}
console.log('By type:');
for (const [k, v] of Object.entries(typeCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k}: ${v}`);
}
console.log('\nBy day:');
for (const [k, v] of Object.entries(dayCounts)) {
  console.log(`  day ${k}: ${v}`);
}

// Check if 幼猫修行 exists
const { data: search } = await supabase
  .from('cpp_items')
  .select('product_name, doujinshi_id, booth_number')
  .eq('event_id', 'cp32')
  .ilike('product_name', '%幼猫%');
console.log('\n幼猫 search:', search?.length || 0, 'results');
if (search?.length) {
  for (const r of search) {
    console.log(' ', JSON.stringify(r));
  }
}

// Check if 幼猫修行 exists by ID
const { data: byId } = await supabase
  .from('cpp_items')
  .select('*')
  .eq('event_id', 'cp32')
  .eq('doujinshi_id', 1682073);
console.log('\n幼猫 ID 1682073:', byId?.length || 0, 'results');
