#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { MatchIndex } from "../lib/cpp-matcher.ts";

const { values } = parseArgs({
  options: {
    dataset: {
      type: "string",
      default: "tests/fixtures/matching-golden.json",
    },
    items: {
      type: "string",
      default: "public/cpp/cp32/items.json",
    },
    endpoint: { type: "string" },
    token: { type: "string" },
    event: { type: "string", default: "cp32" },
    iterations: { type: "string", default: "5" },
    output: {
      type: "string",
      default: ".matching-reports/latest.json",
    },
  },
});

const dataset = JSON.parse(readFileSync(path.resolve(values.dataset), "utf-8"));
const iterations = Math.max(1, Number(values.iterations));

function percentile(valuesList, percentileValue) {
  if (valuesList.length === 0) return 0;
  const sorted = [...valuesList].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1
  );
  return sorted[index];
}

function calculateQuality(results) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  let wrongAccepted = 0;
  let review = 0;
  let externalAccepted = 0;

  const cases = dataset.map((entry, index) => {
    const result = results[index] || {
      matched: false,
      decision: "unmatched",
      confidence: "none",
    };
    const predictedId = result.matched ? result.cppItem?.doujinshiId || null : null;
    const expectedId = entry.expectedDoujinshiId;
    const expectedPositive = expectedId != null;
    const accepted = predictedId != null;
    const correct = expectedPositive ? predictedId === expectedId : !accepted;

    if (result.decision === "review") review += 1;
    if (result.source === "external-api" && accepted) externalAccepted += 1;

    if (expectedPositive && predictedId === expectedId) {
      truePositive += 1;
    } else if (expectedPositive && !accepted) {
      falseNegative += 1;
    } else if (expectedPositive && accepted && predictedId !== expectedId) {
      falsePositive += 1;
      falseNegative += 1;
      wrongAccepted += 1;
    } else if (!expectedPositive && accepted) {
      falsePositive += 1;
      wrongAccepted += 1;
    } else {
      trueNegative += 1;
    }

    return {
      case: entry.case,
      expectedId,
      predictedId,
      decision: result.decision,
      confidence: result.confidence,
      score: result.score,
      source: result.source,
      correct,
    };
  });

  const acceptedCount = truePositive + falsePositive;
  const positiveCount = truePositive + falseNegative;
  return {
    total: dataset.length,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    review,
    autoMatchPrecision: acceptedCount > 0 ? truePositive / acceptedCount : 0,
    recall: positiveCount > 0 ? truePositive / positiveCount : 0,
    misMatchRate: acceptedCount > 0 ? wrongAccepted / acceptedCount : 0,
    externalFallbackRate: dataset.length > 0 ? externalAccepted / dataset.length : 0,
    rowAccuracy: dataset.length > 0 ? (truePositive + trueNegative) / dataset.length : 0,
    cases,
  };
}

async function evaluateOffline() {
  if (!existsSync(values.items)) {
    throw new Error(`找不到本地 CPP 数据：${values.items}`);
  }
  const items = JSON.parse(readFileSync(path.resolve(values.items), "utf-8"));
  const indexStartedAt = performance.now();
  const index = new MatchIndex(items);
  const indexBuildMs = performance.now() - indexStartedAt;
  const latencies = [];
  let results = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    results = index.matchBatch(dataset.map((entry) => entry.input));
    latencies.push(performance.now() - startedAt);
  }
  return {
    mode: "offline-index",
    results,
    latencies,
    timingDetails: { indexBuildMs },
  };
}

async function evaluateEndpoint() {
  const token = values.token || process.env.MATCH_API_TOKEN;
  if (!token) throw new Error("Endpoint 模式需要 --token 或 MATCH_API_TOKEN，且 --event 必须是该 JWT 已加入的测试 list");
  const latencies = [];
  let results = [];
  let lastTimings = {};
  let lastStats = {};
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    const response = await fetch(values.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventId: values.event,
        items: dataset.map((entry) => entry.input),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    latencies.push(performance.now() - startedAt);
    results = data.results || [];
    lastTimings = data.timings || {};
    lastStats = data.stats || {};
  }
  return {
    mode: "endpoint",
    results,
    latencies,
    timingDetails: lastTimings,
    endpointStats: lastStats,
  };
}

const execution = values.endpoint ? await evaluateEndpoint() : await evaluateOffline();
const quality = calculateQuality(execution.results);
const performanceMetrics = {
  iterations,
  minMs: Math.min(...execution.latencies),
  averageMs:
    execution.latencies.reduce((sum, value) => sum + value, 0) /
    execution.latencies.length,
  p95Ms: percentile(execution.latencies, 95),
  maxMs: Math.max(...execution.latencies),
  targetP95Ms: 30_000,
  withinTarget: percentile(execution.latencies, 95) <= 30_000,
  stages: execution.timingDetails,
};
const report = {
  generatedAt: new Date().toISOString(),
  dataset: path.resolve(values.dataset),
  mode: execution.mode,
  targets: {
    autoMatchPrecision: 0.95,
    p95Ms: 30_000,
  },
  quality,
  performance: performanceMetrics,
  endpointStats: execution.endpointStats,
  passed:
    quality.autoMatchPrecision >= 0.95 &&
    performanceMetrics.withinTarget,
};

const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  autoMatchPrecision: `${(quality.autoMatchPrecision * 100).toFixed(2)}%`,
  recall: `${(quality.recall * 100).toFixed(2)}%`,
  misMatchRate: `${(quality.misMatchRate * 100).toFixed(2)}%`,
  externalFallbackRate: `${(quality.externalFallbackRate * 100).toFixed(2)}%`,
  review: quality.review,
  p95Ms: performanceMetrics.p95Ms.toFixed(1),
  passed: report.passed,
  output,
}, null, 2));

if (!report.passed) process.exitCode = 1;
