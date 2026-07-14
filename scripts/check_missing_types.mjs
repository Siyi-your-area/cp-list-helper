import { readFileSync } from "node:fs";

let COOKIE_STR = "";
try {
  const cookies = JSON.parse(readFileSync("cpp-cookies.json", "utf-8"));
  COOKIE_STR = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
} catch { process.exit(1); }

// 测试1: 不带 eventId 搜索，看卡片分类有没有数据
const typesToCheck = [[33,'卡片'],[34,'纸胶带'],[41,'COS'],[42,'手办']];

for (const [typeId, typeName] of typesToCheck) {
  // 不带 eventId
  const params1 = new URLSearchParams({
    keyword: "", orderBy: "1", typeIds: String(typeId),
    pageIndex: "1", pageSize: "5",
    sellStatus: "", ideaType: "", tag: "", ideaStatus: "",
  });
  
  const resp1 = await fetch(`https://www.allcpp.cn/api/doujinshi/search.do?${params1}`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json", Cookie: COOKIE_STR },
  });
  const json1 = await resp1.json();
  const total1 = json1.result?.total || 0;
  
  // 带 eventId=7040
  const params2 = new URLSearchParams({
    eventId: "7040", keyword: "", orderBy: "1", typeIds: String(typeId),
    pageIndex: "1", pageSize: "5",
    sellStatus: "", ideaType: "", tag: "", ideaStatus: "",
  });
  
  const resp2 = await fetch(`https://www.allcpp.cn/api/doujinshi/search.do?${params2}`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json", Cookie: COOKIE_STR },
  });
  const json2 = await resp2.json();
  const total2 = json2.result?.total || 0;
  
  console.log(`${typeName}(typeId=${typeId}): 全局=${total1}, 一期(7040)=${total2}`);
  
  await new Promise(r => setTimeout(r, 300));
}
