#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import * as XLSX from "xlsx";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: "test-upload.xlsx" },
    sampleSize: { type: "string" },
    items: { type: "string", default: "public/cpp/cp32/items.json" },
    endpoint: {
      type: "string",
      default: "http://localhost:3000/api/cpp/match",
    },
    token: { type: "string" },
    event: { type: "string", default: "cp32" },
    iterations: { type: "string", default: "20" },
    output: {
      type: "string",
      default: ".matching-reports/wishlist-benchmark.json",
    },
  },
});

function percentile(samples, value) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)] || 0;
}

function parseWishlist(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
  });
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => /摊位|booth/i.test(String(cell || "")))
  );
  if (headerIndex < 0) throw new Error("找不到摊位号表头");
  const headers = rows[headerIndex].map((cell) => String(cell || "").trim());
  const boothIndex = headers.findIndex((header) => /社团摊位号|摊位号|booth/i.test(header));
  const productIndex = headers.findIndex((header) => /展品名称|制品名称|商品名|product/i.test(header));
  const authorIndex = headers.findIndex((header) => /作者|社团名|author/i.test(header));
  if (boothIndex < 0 || productIndex < 0) throw new Error("缺少摊位号或制品名称列");

  return rows.slice(headerIndex + 1)
    .map((row) => ({
      boothNumber: String(row[boothIndex] || "").trim(),
      productName: String(row[productIndex] || "").trim(),
      author: authorIndex >= 0 ? String(row[authorIndex] || "").trim() : undefined,
    }))
    .filter((item) => item.boothNumber || item.productName);
}

let buffer;
if (values.sampleSize) {
  const sourceItems = JSON.parse(readFileSync(path.resolve(values.items), "utf-8"));
  const unique = new Map();
  for (const item of sourceItems) {
    const key = `${item.boothNumber}|${item.productName}`;
    if (!unique.has(key)) unique.set(key, item);
    if (unique.size >= Number(values.sampleSize)) break;
  }
  const rows = [
    ["Generated matching benchmark"],
    ["社团摊位号", "展品名称", "作者"],
    ...Array.from(unique.values()).map((item) => [
      item.boothNumber,
      item.productName,
      item.author,
    ]),
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "心愿单");
  buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
} else {
  buffer = readFileSync(path.resolve(values.file));
}
const iterations = Math.max(1, Number(values.iterations));
const token = values.token || process.env.MATCH_API_TOKEN;
if (!token) throw new Error("API benchmark 需要 --token 或 MATCH_API_TOKEN，且 --event 必须是该 JWT 已加入的测试 list");
const samples = [];
let lastResponse = {};

for (let iteration = 0; iteration < iterations; iteration += 1) {
  const totalStartedAt = performance.now();
  const parseStartedAt = performance.now();
  const items = parseWishlist(buffer);
  const parseMs = performance.now() - parseStartedAt;

  const requestStartedAt = performance.now();
  const response = await fetch(values.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      eventId: values.event,
      items,
      clientTimings: { parseMs, dedupeMs: 0 },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  const requestMs = performance.now() - requestStartedAt;
  samples.push({
    parseMs,
    requestMs,
    endToEndMs: performance.now() - totalStartedAt,
  });
  lastResponse = data;
}

const totals = samples.map((sample) => sample.endToEndMs);
const report = {
  generatedAt: new Date().toISOString(),
  file: values.sampleSize
    ? `generated:${values.sampleSize}`
    : path.resolve(values.file),
  endpoint: values.endpoint,
  eventId: values.event,
  itemCount: lastResponse.stats?.total || 0,
  iterations,
  targetP95Ms: 30_000,
  p50Ms: percentile(totals, 50),
  p95Ms: percentile(totals, 95),
  maxMs: Math.max(...totals),
  averageMs: totals.reduce((sum, value) => sum + value, 0) / totals.length,
  withinTarget: percentile(totals, 95) <= 30_000,
  clientStages: {
    parseAverageMs:
      samples.reduce((sum, sample) => sum + sample.parseMs, 0) / samples.length,
    requestAverageMs:
      samples.reduce((sum, sample) => sum + sample.requestMs, 0) / samples.length,
  },
  serverStages: lastResponse.timings,
  matchStats: lastResponse.stats,
  samples,
};

const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  itemCount: report.itemCount,
  iterations,
  p50Ms: report.p50Ms.toFixed(1),
  p95Ms: report.p95Ms.toFixed(1),
  maxMs: report.maxMs.toFixed(1),
  withinTarget: report.withinTarget,
  serverStages: report.serverStages,
  output,
}, null, 2));

if (!report.withinTarget) process.exitCode = 1;
