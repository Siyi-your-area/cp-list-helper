import { readFileSync } from "node:fs";

let COOKIE_STR = "";
try {
  const cookies = JSON.parse(readFileSync("cpp-cookies.json", "utf-8"));
  COOKIE_STR = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
} catch {
  process.exit(1);
}

const doujinshiId = 1594057;

const resp = await fetch(`https://www.allcpp.cn/d/${doujinshiId}.do`, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    Accept: "text/html",
    Cookie: COOKIE_STR,
  },
});
const html = await resp.text();

// 找出 djs-info 区域（包含所有 info）
const djsInfoMatch = html.match(/class="djs-info[^"]*"[^>]*>([\s\S]*?)(?=<div class="djs-tabs|<div class="djs-tab")/);
if (djsInfoMatch) {
  const infoHtml = djsInfoMatch[1];
  // 提取热度
  const hotMatch = infoHtml.match(/总热度\s*<\/[^>]+>\s*<\/[^>]+>\s*(\d+)/);
  console.log("热度 (v1):", hotMatch?.[1] || "not found");
  
  // 更宽松的匹配
  const hotNumMatch = infoHtml.match(/总热度[\s\S]{0,100}?(\d{1,6})/);
  console.log("热度 (v2):", hotNumMatch?.[1] || "not found");
  
  // 提取所有 info-txt 中的内容
  const txtMatch = infoHtml.match(/class="djs-info-txt">([\s\S]*?)<\/div>/);
  if (txtMatch) {
    console.log("\ninfo-txt 内容:");
    console.log(txtMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }
}

// 找出 tab 内容区（详情文字）
// 从截图中看到"展品详情" tab 下有文字
// 试试找 id 包含 tab 的元素
const tabContentIds = html.match(/id="(tab[^"]*)"/g);
console.log("\nTab IDs:", tabContentIds);

// 找 class 包含 tab 的元素
const tabClasses = [...new Set(html.match(/class="([\w\s-]*tab[\w\s-]*)"/gi) || [])];
console.log("Tab classes:", tabClasses);

// 找 djs-tab 相关
const djsTabMatches = html.match(/class="djs-tab[^"]*"[^>]*>([\s\S]{50,2000}?)(?=<div class="djs|<\/div>\s*<div)/g);
console.log("\ndjs-tab matches:", djsTabMatches?.length || 0);
if (djsTabMatches) {
  for (let i = 0; i < djsTabMatches.length; i++) {
    const text = djsTabMatches[i].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    console.log(`  Tab ${i}: "${text}"`);
  }
}

// 试试找包含"一本基于"的完整上下文
const context = html.match(/([\s\S]{0,200})一本基于([\s\S]{0,500})/);
if (context) {
  console.log("\n详情文字上下文:");
  console.log("Before:", context[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(-200));
  console.log("Text:", "一本基于" + context[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300));
}

// 看 HTML 中 "仅供现场" 的上下文
const sellContext = html.match(/([\s\S]{0,100})仅供现场([\s\S]{0,100})/);
if (sellContext) {
  console.log("\n仅供现场上下文:", sellContext[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

// 看看整个 djs-info 区域的完整内容
const fullDjsInfo = html.match(/class="djs-info"[^>]*>([\s\S]*?)(?=\n\s*<div class="djs-tabs)/);
if (fullDjsInfo) {
  console.log("\n=== 完整 djs-info ===");
  console.log(fullDjsInfo[1].replace(/\s+/g, ' ').trim().slice(0, 1500));
}

