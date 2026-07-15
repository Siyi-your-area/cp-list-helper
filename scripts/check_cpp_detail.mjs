import { readFileSync } from "node:fs";

let COOKIE_STR = "";
try {
  const cookies = JSON.parse(readFileSync("cpp-cookies.json", "utf-8"));
  COOKIE_STR = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
} catch {
  console.error("❌ 找不到 cpp-cookies.json");
  process.exit(1);
}

// 测试用已知的展品ID
const testIds = [1691881, 1594057, 1682073];

for (const doujinshiId of testIds) {
  console.log(`\n=== doujinshiId=${doujinshiId} ===`);
  
  // 1. 尝试搜索 API 看返回什么
  const searchParams = new URLSearchParams({
    keyword: "",
    orderBy: "1",
    pageIndex: "1",
    pageSize: "30",
    sellStatus: "",
    ideaType: "",
    tag: "",
    ideaStatus: "",
  });
  
  try {
    // 不带 eventId 搜索（看能否找到）
    const searchResp = await fetch(
      `https://www.allcpp.cn/api/doujinshi/search.do?${searchParams}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          Cookie: COOKIE_STR,
        },
      }
    );
    const searchJson = await searchResp.json();
    const found = (searchJson.result?.list || []).find(item => item.doujinshiId === doujinshiId);
    
    if (found) {
      console.log("搜索 API 能找到，返回字段:");
      // 只打印关键非嵌套字段
      for (const [k, v] of Object.entries(found)) {
        if (typeof v !== 'object' || v === null) {
          console.log(`  ${k}: ${JSON.stringify(v)}`);
        }
      }
      console.log(`  tags: ${found.tag}`);
      console.log(`  has hotCount: ${'hotCount' in found}`);
      console.log(`  has themeAlias: ${'themeAlias' in found}`);
      console.log(`  has sellStatus: ${'sellStatus' in found}`);
      if ('hotCount' in found) console.log(`    hotCount: ${found.hotCount}`);
      if ('themeAlias' in found) console.log(`    themeAlias: ${found.themeAlias}`);
      if ('sellStatus' in found) console.log(`    sellStatus: ${found.sellStatus}`);
    } else {
      console.log("搜索 API 找不到（可能需要 eventId 过滤）");
    }
  } catch (e) {
    console.log("搜索 API 调用失败:", e.message);
  }
  
  // 2. 尝试详情页 API
  try {
    const detailResp = await fetch(
      `https://www.allcpp.cn/api/doujinshi/doujinshiInfo.do?doujinshiId=${doujinshiId}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          Cookie: COOKIE_STR,
          Referer: `https://www.allcpp.cn/d/${doujinshiId}.do`,
        },
      }
    );
    const detailJson = await detailResp.json();
    if (detailJson.isSuccess && detailJson.result) {
      console.log("\n详情页 API 返回字段:");
      const result = detailJson.result;
      for (const [k, v] of Object.entries(result)) {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          const val = Array.isArray(v) ? `[Array(${v.length})]` : JSON.stringify(v);
          console.log(`  ${k}: ${val}`);
        }
      }
      // 看完整结构
      console.log("\n完整字段列表:");
      console.log(Object.keys(result).join(', '));
    } else {
      console.log("详情页 API 返回失败:", detailJson.message || "未知");
    }
  } catch (e) {
    console.log("详情页 API 调用失败:", e.message);
  }
  
  await new Promise(r => setTimeout(r, 500));
}
