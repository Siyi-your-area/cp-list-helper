import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || "https://jfmbeixamoaxodzmqzro.supabase.co";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "sb_publishable_74q7gzaLn0BwhesWPBoToA_RyaL4c-v";
const supabase = createClient(supabaseUrl, supabaseKey);

const { count } = await supabase.from('cpp_items').select('*', { count: 'exact', head: true }).eq('event_id', 'cp32');
console.log('cp32 items:', count);

const { data: sample } = await supabase.from('cpp_items').select('*').eq('event_id', 'cp32').limit(1);
if (sample && sample[0]) {
  console.log('Fields:', Object.keys(sample[0]).sort().join(', '));
  console.log('Sample:', JSON.stringify(sample[0], null, 2));
}

const { data: byType } = await supabase
  .from('cpp_items')
  .select('type_name')
  .eq('event_id', 'cp32')
  .order('type_name');
const types = [...new Set(byType.map(r => r.type_name))].sort();
console.log('Types covered:', types.join(', '));
console.log('Types count:', types.length, '/ 16');

const { data: byDay } = await supabase
  .from('cpp_items')
  .select('day_id')
  .eq('event_id', 'cp32');
const days = [...new Set(byDay.map(r => r.day_id))];
console.log('Days covered:', days.join(', '));
