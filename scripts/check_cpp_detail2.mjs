import { readFileSync } from "node:fs";

let COOKIE_STR = "";
try {
  const cookies = JSON.parse(readFileSync("cpp-cookies.json", "utf-8"));
  COOKIE_STR = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
} catch {
  console.error("❌ 找不到 cpp-cookies.json");
  process.exit(1);
}

const doujinshiId = 1594057; // 用户截图中的 ID

// 尝试多个可能的 API 端点
const endpoints = [
  `https://www.allcpp.cn/api/doujinshi/detail.do?doujinshiId=${doujinshiId}`,
  `https://www.allcpp.cn/api/doujinshi/get.do?doujinshiId=${doujinshiId}`,
  `https://www.allcpp.cn/api/doujinshi/info.do?doujinshiId=${doujinshiId}`,
  `https://www.allcpp.cn/api/doujinshi/getDoujinshiInfo.do?doujinshiId=${doujinshiId}`,
];

for (const url of endpoints) {
  console.log(`\n--- ${url.split('.do?')[1]} ---`);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json, text/plain, */*",
        Cookie: COOKIE_STR,
        Referer: `https://www.allcpp.cn/d/${doujinshiId}.do`,
      },
    });
    const contentType = resp.headers.get('content-type');
    console.log(`Status: ${resp.status}, Content-Type: ${contentType}`);
    
    if (contentType && contentType.includes('json')) {
      const json = await resp.json();
      console.log(JSON.stringify(json, null, 2).slice(0, 500));
    } else {
      const text = await resp.text();
      console.log(text.slice(0, 300));
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 300));
}

// 也试试 HTML 页面看有没有嵌入的数据
console.log("\n--- HTML detail page ---");
try {
  const resp = await fetch(`https://www.allcpp.cn/d/${doujinshiId}.do`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html",
      Cookie: COOKIE_STR,
    },
  });
  const html = await resp.text();
  // 搜索关键信息
  const exchanges = html.match(/交换[：:]\s*([^<\n]+)/g);
  const hotCounts = html.match(/hotCount[^,}]*/g);
  const themeAlias = html.match(/themeAlias[^,}]*/g);
  const descBlock = html.match(/展品详情[\s\S]{0,500}/);
  
  console.log("交换 info:", exchanges?.[0] || "not found");
  console.log("hotCount:", hotCounts?.[0] || "not found");
  console.log("themeAlias:", themeAlias?.[0] || "not found");
  console.log("desc sample:", descBlock?.[0]?.slice(0, 200) || "not found");
  
  // 看看有没有 __NEXT_DATA__ 或类似的嵌入 JSON
  const nextData = html.match(/__NEXT_DATA__|window\.__data|window\.detailInfo/g);
  console.log("Embedded data markers:", nextData || "none");
  
  // 看看有没有 Vue/React 初始数据
  const initData = html.match(/window\.\w+\s*=\s*\{/g);
  console.log("Window data:", initData || "none");
  
} catch (e) {
  console.log(`HTML Error: ${e.message}`);
}
