#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadCPGFieldPolicy } from "./cpg-field-policy.mjs";
import { runCPGDaily } from "./cpg-daily-core.mjs";
import { createRestDatabaseTransport } from "./promote-cpp-snapshot.mjs";
import { runCPGScan } from "./scan-cpg.mjs";

const DEFAULT_SOURCE_FIXTURE = "tests/fixtures/cpg-snapshot-source.json";
const DEFAULT_DATABASE_FIXTURE = "tests/fixtures/cpg-daily-db.json";

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} 必须为正整数`);
  return number;
}

export function createFixtureDatabaseTransport(filename = DEFAULT_DATABASE_FIXTURE) {
  const rows = JSON.parse(readFileSync(path.resolve(filename), "utf8"));
  if (!Array.isArray(rows)) throw new Error("daily database fixture 必须是数组");
  return {
    async selectTargetRows() { return structuredClone(rows); },
    async upsertTargetRows() { throw new Error("daily 默认 dry-run 禁止数据库写入"); },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean", default: false },
    sourceFixture: { type: "string", default: DEFAULT_SOURCE_FIXTURE },
    databaseFixture: { type: "string", default: DEFAULT_DATABASE_FIXTURE },
    policy: { type: "string", default: "config/cpg-field-policy.v1.json" },
    outputDir: { type: "string", default: `.cpp-snapshots/daily/${Date.now()}-${process.pid}` },
    projectRef: { type: "string", default: "" },
    pageSize: { type: "string", default: "1000" },
    timeout: { type: "string", default: "15000" },
    dispatchInterval: { type: "string", default: "250" },
    maxInFlight: { type: "string", default: "4" },
    categoryWorkers: { type: "string", default: "4" },
  } });
  const fieldPolicy = loadCPGFieldPolicy(values.policy);
  const databaseTransport = values.projectRef
    ? createRestDatabaseTransport({ projectRef: values.projectRef, apiKey: process.env.SUPABASE_CPP_PROMOTION_KEY, approvedDayId: "7829" })
    : createFixtureDatabaseTransport(values.databaseFixture);
  const report = await runCPGDaily({
    scan: () => runCPGScan({
      fixture: !values.live,
      sourceFixture: values.sourceFixture,
      outputDir: values.outputDir,
      pageSize: positiveInteger(values.pageSize, "pageSize"),
      timeoutMs: positiveInteger(values.timeout, "timeout"),
      dispatchInterval: positiveInteger(values.dispatchInterval, "dispatchInterval"),
      maxInFlight: positiveInteger(values.maxInFlight, "maxInFlight"),
      categoryWorkers: positiveInteger(values.categoryWorkers, "categoryWorkers"),
    }),
    databaseTransport,
    projectRef: values.projectRef || "abcdefghijklmnopqrst",
    fieldPolicy,
    outputDir: values.outputDir,
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
