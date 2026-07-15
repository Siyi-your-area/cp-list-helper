import { readFileSync } from "node:fs";

let COOKIE_STR = "";
try {
  const cookies = JSON.parse(readFileSync("cpp-cookies.json", "utf-8"));
  COOKIE_STR = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
} catch {
  console.error(" 找不到 cpp-cookies.json");
  process.exit(1);
}

const doujinshiId = 1594057;

// 抓取 HTML 详情页面，解析关键信息
const resp = await fetch(`https://www.allcpp.cn/d/${doujinshiId}.do`, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    Accept: "text/html",
    Cookie: COOKIE_STR,
  },
});
const html = await resp.text();

// 1. 找出"交换"信息
const exchangeMatch = html.match(/交换[：:]\s*([^<"]+)/g);
console.log("交换:", exchangeMatch);

// 2. 找出"原作"信息  
const originalMatch = html.match(/原作[：:]\s*([^<"]+)/g);
console.log("原作:", originalMatch);

// 3. 找出"热度"信息
const hotMatch = html.match(/总热度\s+(\d+)/g);
console.log("热度:", hotMatch);

// 4. 找出展品详情文字（在 tab 内容区域）
const descMatch = html.match(/id="tabType[^"]*"[^>]*>([\s\S]*?)<\/div>/g);
console.log("\n详情区域 (前500字):");
if (descMatch) {
  for (let i = 0; i < Math.min(3, descMatch.length); i++) {
    const text = descMatch[i].replace(/<[^>]+>/g, '').trim().slice(0, 300);
    console.log(`  Tab ${i}: "${text}"`);
  }
}

// 5. 搜索可能的 JSON 数据嵌入
const scriptBlocks = html.match(/<script[^>]*>[\s\S]*?<\/script>/g);
console.log("\nScript blocks:", scriptBlocks?.length || 0);
if (scriptBlocks) {
  for (let i = 0; i < scriptBlocks.length; i++) {
    const src = scriptBlocks[i].match(/src="([^"]+)"/);
    if (src) {
      console.log(`  Script ${i}: src=${src[1]}`);
    } else {
      const text = scriptBlocks[i].slice(0, 100);
      if (text.length > 30) {
        console.log(`  Script ${i}: inline (${text.slice(0, 80)}...)`);
      }
    }
  }
}

// 6. 看 AJAX 请求路径 - 找 fetch/xhr 相关
const apiCalls = html.match(/\/api\/[a-zA-Z\/]+/g);
console.log("\nAPI calls in HTML:", [...new Set(apiCalls || [])]);

// 7. 看有没有 Vue/React 的初始数据
const vueMatch = html.match(/window\.__[A-Z_]+__\s*=/g);
console.log("Vue/React markers:", vueMatch);

// 8. 搜索 "doujinshi" 关键字在 HTML 中的位置
const doujMatches = html.match(/doujinshi[A-Z]*[a-z]*[^,;]{0,100}/gi);
console.log("\ndoujinshi references:", doujMatches?.slice(0, 5));

