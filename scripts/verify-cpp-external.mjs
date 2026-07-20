#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  enrichCPPItemWithDetail,
  extractCoreProductName,
  fetchCPPExternalDetail,
  getCPPCookieHeader,
  matchCPPExternalCandidates,
  searchCPPExternal,
} from "../lib/cpp-external.ts";

const { values } = parseArgs({
  options: {
    keyword: {
      type: "string",
      default: "【图奈】葵记炒货小铺",
    },
    booth: {
      type: "string",
      default: "肆Q40",
    },
    author: {
      type: "string",
      default: "",
    },
    day: {
      type: "string",
      default: "7042",
    },
    expectedId: {
      type: "string",
      default: "1626497",
    },
  },
});

const cookie = getCPPCookieHeader();
if (!cookie) {
  console.error(
    "未找到 CPP 登录态。请设置 CPP_COOKIE Secret，或使用 Git 忽略的本地请求文件。"
  );
  process.exit(1);
}

const deadline = performance.now() + 15_000;
const startedAt = performance.now();
const coreName = extractCoreProductName(values.keyword);
const candidates = await searchCPPExternal(
  coreName,
  [values.day],
  cookie,
  deadline
);
const searchMs = performance.now() - startedAt;
let result = matchCPPExternalCandidates(
  {
    boothNumber: values.booth,
    productName: values.keyword,
    author: values.author || undefined,
  },
  candidates,
  [values.day]
);

let detailMs = 0;
if (result.decision === "accepted" && result.cppItem) {
  const detailStartedAt = performance.now();
  const detail = await fetchCPPExternalDetail(
    result.cppItem.doujinshiId,
    cookie,
    deadline
  );
  detailMs = performance.now() - detailStartedAt;
  result = {
    ...result,
    cppItem: enrichCPPItemWithDetail(result.cppItem, detail),
  };
}

const selected = result.cppItem || result.candidate;
const expectedId = Number(values.expectedId);
const passed =
  result.decision === "accepted" &&
  selected?.doujinshiId === expectedId;

// 只打印公开制品字段和指标；Cookie、请求头与账号信息永不输出。
console.log(JSON.stringify({
  input: {
    coreName,
    dayId: values.day,
  },
  search: {
    candidateCount: candidates.length,
    searchMs: Math.round(searchMs),
  },
  result: {
    decision: result.decision,
    confidence: result.confidence,
    score: result.score,
    doujinshiId: selected?.doujinshiId || null,
    productName: selected?.productName || "",
    boothNumber: selected?.boothNumber || "",
    author: selected?.author || "",
    hotCount: selected?.hotCount || 0,
    originalWork: selected?.originalWork || "",
    exchangeType: selected?.exchangeType || "",
    hasImage: Boolean(selected?.imageUrl),
    hasDescription: Boolean(selected?.description),
  },
  detailMs: Math.round(detailMs),
  totalMs: Math.round(performance.now() - startedAt),
  expectedId,
  passed,
}, null, 2));

if (!passed) process.exitCode = 1;
