#!/usr/bin/env node
/**
 * CPP 数据预处理脚本
 *
 * 将爬虫产出的原始数据转换为应用可用的格式，部署到 public/cpp/ 目录。
 *
 * 输入: data/cpp-data/cp32-total.json
 * 输出:
 *   public/cpp/cp32/manifest.json      - 展会元数据 + 统计
 *   public/cpp/cp32/items.json         - 标准化后的全量扁平数据（用于 API）
 *   public/cpp/cp32/booths/{num}.json  - 按摊位拆分（用于按摊位查询）
 *   public/cpp/index.json              - 展会索引
 *
 * 用法: npx tsx scripts/prepare-cpp-data.ts
 */

const fs = require("fs");
const path = require("path");

// 路径配置
const PROJECT_ROOT = path.resolve(__dirname, "..");
const INPUT_FILE = path.join(PROJECT_ROOT, "data/cpp-data/cp32-total.json");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "public/cpp/cp32");
const BOOTHS_DIR = path.join(OUTPUT_DIR, "booths");
const INDEX_FILE = path.join(PROJECT_ROOT, "public/cpp/index.json");

// ---- 工具函数 ----

function normalize(str) {
  return str
    .replace(/[\s ]/g, "")
    .normalize("NFKC")
    .toLowerCase();
}

function normalizeCPPItem(raw) {
  // 一个展品可能在多个摊位/期数出现，每个 participationInfo 生成一条记录
  const records = [];

  const participationList = raw.participationInfo || [];
  if (participationList.length === 0) {
    // 无参展信息，跳过
    return records;
  }

  for (const info of participationList) {
    records.push({
      boothNumber: info.boothNumber || "",
      boothName: info.boothName || "",
      productName: raw.productName || "",
      author: Array.isArray(raw.authors) ? raw.authors.join(", ") : "",
      imageUrl: raw.imageUrl || "",
      tags: raw.tags || [],
      eventName: info.eventName || "",
      sourceUrl: raw.sourceUrl || "",
      doujinshiId: raw.doujinshiId || 0,
      // 预计算标准化字段，加速匹配
      _normBooth: normalize(info.boothNumber || ""),
      _normProduct: normalize(raw.productName || ""),
      _normAuthor: normalize(Array.isArray(raw.authors) ? raw.authors.join(", ") : ""),
    });
  }

  return records;
}

// ---- 主流程 ----

function main() {
  console.log("=== CPP 数据预处理 ===\n");

  // 1. 读取原始数据
  console.log("1. 读取原始数据...");
  const rawData = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
  const rawItems = rawData.items || rawData;
  console.log(`   原始条目数: ${rawItems.length}`);

  // 2. 标准化
  console.log("2. 标准化数据...");
  const normalizedItems = [];
  for (const item of rawItems) {
    const records = normalizeCPPItem(item);
    normalizedItems.push(...records);
  }
  console.log(`   标准化后条目数: ${normalizedItems.length}（一个展品可能参展多个摊位）`);

  // 3. 按摊位分组
  console.log("3. 按摊位分组...");
  const boothMap = {};
  for (const item of normalizedItems) {
    const key = item.boothNumber;
    if (!boothMap[key]) {
      boothMap[key] = [];
    }
    boothMap[key].push(item);
  }
  const boothCount = Object.keys(boothMap).length;
  console.log(`   摊位数: ${boothCount}`);

  // 4. 创建输出目录
  console.log("4. 创建输出目录...");
  fs.mkdirSync(BOOTHS_DIR, { recursive: true });

  // 5. 写入全量数据（去除 _norm 前缀的辅助字段）
  console.log("5. 写入全量数据...");
  const cleanItems = normalizedItems.map(({ _normBooth, _normProduct, _normAuthor, ...rest }) => rest);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "items.json"),
    JSON.stringify(cleanItems, null, 0) // 无缩进，减小体积
  );
  const itemsFileSize = (fs.statSync(path.join(OUTPUT_DIR, "items.json")).size / 1024 / 1024).toFixed(2);
  console.log(`   items.json: ${itemsFileSize} MB`);

  // 6. 按摊位拆分文件
  console.log("6. 按摊位拆分文件...");
  for (const [boothNumber, items] of Object.entries(boothMap)) {
    const safeName = boothNumber.replace(/[/\\?%*:|"<>]/g, "_");
    const cleanBoothItems = items.map(({ _normBooth, _normProduct, _normAuthor, ...rest }) => rest);
    fs.writeFileSync(
      path.join(BOOTHS_DIR, `${safeName}.json`),
      JSON.stringify(cleanBoothItems, null, 0)
    );
  }
  console.log(`   生成 ${boothCount} 个摊位文件`);

  // 7. 生成 manifest
  console.log("7. 生成 manifest...");
  const manifest = {
    eventId: rawData.eventId || "cp32",
    eventName: rawData.eventName || "CP32",
    crawlDate: rawData.crawlDate || new Date().toISOString(),
    totalItems: normalizedItems.length,
    totalBooths: boothCount,
    days: (rawData.dayIds || []).map((id) => ({
      id,
      name: id === "7040" ? "一期" : id === "7042" ? "二期" : id,
    })),
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  // 8. 生成展会索引
  console.log("8. 生成展会索引...");
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  const index = {
    events: [
      {
        id: manifest.eventId,
        name: manifest.eventName,
        dataPath: `/cpp/${manifest.eventId}`,
        totalItems: manifest.totalItems,
        totalBooths: manifest.totalBooths,
      },
    ],
  };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

  // 9. 统计
  const boothsDirSize = (
    fs.readdirSync(BOOTHS_DIR).reduce((sum, f) => {
      return sum + fs.statSync(path.join(BOOTHS_DIR, f)).size;
    }, 0) / 1024 / 1024
  ).toFixed(2);

  console.log("\n=== 完成 ===");
  console.log(`  全量数据: ${itemsFileSize} MB`);
  console.log(`  摊位文件: ${boothsDirSize} MB (${boothCount} 个)`);
  console.log(`  输出目录: public/cpp/`);
  console.log(`\n下一步: git push 后 Vercel 自动部署`);
}

main();
