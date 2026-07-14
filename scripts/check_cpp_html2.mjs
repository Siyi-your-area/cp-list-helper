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

const resp = await fetch(`https://www.allcpp.cn/d/${doujinshiId}.do`, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    Accept: "text/html",
    Cookie: COOKIE_STR,
  },
});
let html = await resp.text();

// 去掉换行方便匹配
html = html.replace(/\r\n/g, '\n');

// 1. 热度 - 可能是 "总热度  151"
const hotMatch = html.match(/总热度\s+(\d+)/);
console.log("热度:", hotMatch?.[1] || "not found");

// 2. 找出所有 key-value 对 (原作、口味、开本、页数、交换、首发)
const kvPairs = html.match(/([一-龥]+)[：:]\s*([^<\n"]+)/g);
console.log("\nKey-Value pairs:");
for (const pair of (kvPairs || [])) {
  console.log(" ", pair.trim());
}

// 3. 找出详情文字内容 - 在 id="tabType" 区域中
// 先找到 tabType 区域
const tabTypeSection = html.match(/id="tabType[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*id="tabType/g);
console.log("\nTabType sections found:", tabTypeSection?.length || 0);

// 尝试另一种方式 - 找展品详情内容
// 在 HTML 中可能有类似 <div class="djs-info"> 或类似的结构
const infoSections = html.match(/class="[^"]*info[^"]*"[^>]*>([\s\S]{50,500}?)(?=<div|<span|<\/div>)/g);
console.log("\nInfo sections:", infoSections?.length || 0);
if (infoSections) {
  for (let i = 0; i < Math.min(3, infoSections.length); i++) {
    console.log(`  Section ${i}:`, infoSections[i].replace(/<[^>]+>/g, '').trim().slice(0, 200));
  }
}

// 4. 找"仅供现场"
const sellStatusMatch = html.match(/仅供现场/);
console.log("\n仅供现场:", sellStatusMatch ? "found" : "not found");

// 5. 看看 HTML 里有没有 description 或 intro 内容
// 可能在某个特定的 div class 中
const descDivs = html.match(/class="[^"]*desc[^"]*"[^>]*>([\s\S]*?)<\/div>/gi);
console.log("\nDesc divs:", descDivs?.length || 0);
if (descDivs) {
  for (const d of descDivs) {
    console.log(" ", d.replace(/<[^>]+>/g, '').trim().slice(0, 200));
  }
}

// 6. 看"展品详情"tab 下面的内容
// 从截图中看到详情文字是："一本基于官方结局后日谈的奈费勒中心..."
const introMatch = html.match(/一本基于[^<]{10,500}/);
console.log("\nIntro text:", introMatch?.[0]?.slice(0, 200) || "not found");

// 7. 看看 HTML 中有哪些 div class 包含内容
const contentClasses = [...new Set(html.match(/class="([\w\s-]*content[\w\s-]*)"/gi) || [])];
console.log("\nContent classes:", contentClasses);

// 8. 找包含中文文本较多的区域（可能是详情）
const longTextBlocks = html.match(/<p[^>]*>[一-龥，。、；：""''（）《》\n]{50,}[一-龥。]/g);
console.log("\nLong text blocks:", longTextBlocks?.length || 0);
if (longTextBlocks) {
  for (let i = 0; i < Math.min(5, longTextBlocks.length); i++) {
    console.log(`  Block ${i}:`, longTextBlocks[i].replace(/<[^>]+>/g, '').trim().slice(0, 200));
  }
}
