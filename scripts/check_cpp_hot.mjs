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

// 找 djs-info-hot 区域
const hotSection = html.match(/class="djs-info-hot"[^>]*>([\s\S]*?)<\/div>/);
if (hotSection) {
  console.log("Hot section HTML:", hotSection[0].slice(0, 300));
  // 提取数字
  const num = hotSection[1].match(/(\d+)/);
  console.log("Hot number:", num?.[1]);
}

// 也直接搜索 "总热度" 附近的内容
const hotContext = html.match(/总热度[\s\S]{0,200}/);
console.log("\n总热度上下文:");
console.log(hotContext?.[0].replace(/\s+/g, ' ').trim().slice(0, 300));

