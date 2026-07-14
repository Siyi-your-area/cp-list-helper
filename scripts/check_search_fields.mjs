import { readFileSync } from "node:fs";

let COOKIE_STR = "";
try {
  const cookies = JSON.parse(readFileSync("cpp-cookies.json", "utf-8"));
  COOKIE_STR = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
} catch { process.exit(1); }

// 用一期 dayId=7040, type=36(漫画) 查一页
const params = new URLSearchParams({
  eventId: "7040", keyword: "", orderBy: "1",
  typeIds: "36", pageIndex: "1", pageSize: "5",
  sellStatus: "", ideaType: "", tag: "", ideaStatus: "",
});

const resp = await fetch(`https://www.allcpp.cn/api/doujinshi/search.do?${params}`, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    Accept: "application/json", Cookie: COOKIE_STR,
  },
});
const json = await resp.json();
const list = json.result?.list || [];
console.log(`返回 ${list.length} 条\n`);

if (list[0]) {
  const item = list[0];
  console.log("=== 顶层字段 ===");
  for (const [k, v] of Object.entries(item)) {
    if (typeof v !== 'object' || v === null) {
      console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  
  // 看所有 key
  console.log("\n=== 所有 key ===");
  console.log(Object.keys(item).join(', '));
  
  // 看 eventList 结构
  if (item.eventList?.[0]) {
    console.log("\n=== eventList[0] keys ===");
    console.log(Object.keys(item.eventList[0]).join(', '));
    console.log("eventList[0]:", JSON.stringify(item.eventList[0], null, 2));
  }
  
  // 搜索关键字段
  const checkFields = ['hotCount', 'hot_count', 'themeAlias', 'theme_alias', 
    'sellStatus', 'sell_status', 'exchange', 'exchangeType', 'exchange_type',
    'originalWork', 'original_work', 'description', 'desc'];
  console.log("\n=== 关键新字段检查 ===");
  for (const f of checkFields) {
    console.log(`  ${f}: ${f in item ? JSON.stringify(item[f]) : ' 不存在'}`);
  }
}
