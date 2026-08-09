import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCPGFieldPolicy, searchPromotionRow, validateCPGFieldPolicy } from "../scripts/cpg-field-policy.mjs";
import { runCPGDaily } from "../scripts/cpg-daily-core.mjs";
import { createGeneratedFixtureTransport, runCPGProvisionalSnapshot } from "../scripts/cpp-snapshot-core.mjs";

const policy = loadCPGFieldPolicy();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/cpg-snapshot-source.json", import.meta.url), "utf8"));
fixture.declaredTotal = 16;
for (const typeId of Object.keys(fixture.taskTotals)) fixture.taskTotals[typeId] = 1;
const snapshot = await runCPGProvisionalSnapshot({
  sourceTransport: createGeneratedFixtureTransport(fixture),
  pageSize: 1,
  now: () => new Date("2026-08-04T00:00:00.000Z"),
});

test("字段策略完整覆盖 whitelist，固定 hot/detail 契约并拒绝未知字段", () => {
  assert.equal(validateCPGFieldPolicy(structuredClone(policy)).policyVersion, "cpg08-fields-v1");
  assert.equal(policy.fields.find((field) => field.name === "hot_count").cadence, "daily");
  for (const name of ["description", "exchange_type"]) {
    const field = policy.fields.find((entry) => entry.name === name);
    assert.deepEqual([field.class, field.source, field.updateMode, field.nullPolicy], ["detail", "detail", "fillMissing", "preserveExisting"]);
  }
  const unknown = structuredClone(policy);
  unknown.fields[0].name = "unexpected_column";
  assert.throws(() => validateCPGFieldPolicy(unknown), /未知或重复字段/);
  const incomplete = structuredClone(policy);
  incomplete.fields.pop();
  assert.throws(() => validateCPGFieldPolicy(incomplete), /完整覆盖 whitelist/);
});

test("搜索 promotion row 不携带详情列且不改变作者/社团替换语义", () => {
  const source = { ...snapshot.rows[0], author: "", booth_name: "", description: "来源搜索不应写入" };
  const output = searchPromotionRow(source, { ...source, author: "既有作者", booth_name: "既有社团", description: "既有详情" }, policy);
  assert.equal(output.author, "");
  assert.equal(output.booth_name, "");
  assert.equal("description" in output, false);
  assert.equal("exchange_type" in output, false);
});

test("daily 默认链路 scan→validate→promotion dry-run，全 unchanged 零 POST 并输出 plan/report", async () => {
  let postCalls = 0;
  const outputDir = mkdtempSync(path.join(tmpdir(), "cpg-daily-"));
  const report = await runCPGDaily({
    scan: async () => ({ snapshot, target: path.join(outputDir, "fixture.snapshot.json") }),
    databaseTransport: {
      async selectTargetRows() { return structuredClone(snapshot.rows); },
      async upsertTargetRows() { postCalls += 1; },
    },
    projectRef: "abcdefghijklmnopqrst",
    fieldPolicy: policy,
    outputDir,
    now: () => new Date("2026-08-04T01:00:00.000Z"),
    promote: async (args) => {
      const { runPromotion } = await import("../scripts/promote-cpp-snapshot.mjs");
      return runPromotion({ ...args, allowProvisional: true });
    },
  });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.unchanged, 16);
  assert.equal(report.inserted, 0);
  assert.equal(report.updated, 0);
  assert.equal(report.dbWritesAttempted, 0);
  assert.equal(postCalls, 0);
  assert.ok(existsSync(report.plan));
  assert.ok(existsSync(report.report));
});

test("scan 或 validate 失败即停，不进入 promotion", async () => {
  let promotionCalls = 0;
  await assert.rejects(() => runCPGDaily({
    scan: async () => { throw new Error("fixture scan failed"); },
    databaseTransport: {}, projectRef: "abcdefghijklmnopqrst", fieldPolicy: policy,
    outputDir: mkdtempSync(path.join(tmpdir(), "cpg-daily-fail-")),
    promote: async () => { promotionCalls += 1; },
  }), /fixture scan failed/);
  assert.equal(promotionCalls, 0);
});
