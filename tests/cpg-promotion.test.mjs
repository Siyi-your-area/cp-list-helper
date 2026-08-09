import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { createGeneratedFixtureTransport, runCPGProvisionalSnapshot, runCPGSnapshot } from "../scripts/cpp-snapshot-core.mjs";
import { buildPromotionPlan, runPromotion } from "../scripts/promote-cpp-snapshot.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/cpg-snapshot-source.json", import.meta.url), "utf8"));
const snapshot = await runCPGSnapshot({ sourceTransport: createGeneratedFixtureTransport(fixture), pageSize: 1000, now: () => new Date("2026-08-02T00:00:00.000Z") });
const provisionalFixture = structuredClone(fixture);
provisionalFixture.declaredTotal = 16;
for (const typeId of Object.keys(provisionalFixture.taskTotals)) provisionalFixture.taskTotals[typeId] = 1;
const provisionalSnapshot = await runCPGProvisionalSnapshot({ sourceTransport: createGeneratedFixtureTransport(provisionalFixture), pageSize: 1, now: () => new Date("2026-08-02T00:00:00.000Z") });
const projectRef = "abcdefghijklmnopqrst";

function databaseRows() {
  return [
    { ...snapshot.rows[0], id: 1 },
    { ...snapshot.rows[1], id: 2, source_hash: "0".repeat(64), product_name: "旧值" },
    { ...snapshot.rows[0], id: 3, doujinshi_id: 999999999, source_hash: "f".repeat(64) },
  ];
}

test("dry-run 输出 inserted/updated/unchanged/missingFromSource 且绝不写入", async () => {
  let writeCalls = 0;
  const transport = {
    async selectTargetRows() { return databaseRows(); },
    async upsertTargetRows() { writeCalls += 1; },
  };
  const report = await runPromotion({ snapshot, databaseTransport: transport, projectRef, targetEvent: "cpg08", targetDay: "7829", approvedSnapshotHash: snapshot.snapshotHash });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.inserted, 38186);
  assert.equal(report.updated, 1);
  assert.equal(report.unchanged, 1);
  assert.equal(report.missingFromSource, 1);
  assert.equal(report.rowsWritten, 0);
  assert.equal(writeCalls, 0);
});

test("promotion 只接受 cpg08 与已批准 snapshot 唯一 day、完整 snapshot_ready 与显式 approved hash", async () => {
  let databaseReads = 0;
  const transport = { async selectTargetRows() { databaseReads += 1; return []; }, async upsertTargetRows() { throw new Error("must not write"); } };
  await assert.rejects(() => runPromotion({ snapshot, databaseTransport: transport, projectRef, targetEvent: "cpg", targetDay: "7829", approvedSnapshotHash: snapshot.snapshotHash }), /只允许 cpg08\/7829/);
  await assert.rejects(() => runPromotion({ snapshot, databaseTransport: transport, projectRef, targetEvent: "cpg08", targetDay: "7829", approvedSnapshotHash: "0".repeat(64) }), /approvedSnapshotHash/);
  const partial = structuredClone(snapshot);
  partial.state = "partial";
  await assert.rejects(() => runPromotion({ snapshot: partial, databaseTransport: transport, projectRef, targetEvent: "cpg08", targetDay: "7829", approvedSnapshotHash: partial.snapshotHash }), /snapshot_ready/);
  const legacyHtmlTotal = structuredClone(snapshot);
  legacyHtmlTotal.schemaVersion = 1;
  legacyHtmlTotal.declaredTotalSource = "event-html";
  await assert.rejects(() => runPromotion({ snapshot: legacyHtmlTotal, databaseTransport: transport, projectRef, targetEvent: "cpg08", targetDay: "7829", approvedSnapshotHash: legacyHtmlTotal.snapshotHash }), /v3 dirty-convergence/);
  await assert.rejects(() => runPromotion({ snapshot, databaseTransport: transport, projectRef, targetEvent: "cpg08", targetDay: "7073", approvedSnapshotHash: snapshot.snapshotHash }), /只允许 cpg08\/7829/);
  assert.equal(databaseReads, 0, "错误 targetDay 必须在数据库读取前失败");
});

test("provisional v4 promotion 默认拒绝且仅显式 allowProvisional 后进入既有 dry-run 门禁", async () => {
  let databaseReads = 0;
  const transport = { async selectTargetRows() { databaseReads += 1; return []; }, async upsertTargetRows() { throw new Error("must not write"); } };
  const args = { snapshot: provisionalSnapshot, databaseTransport: transport, projectRef, targetEvent: "cpg08", targetDay: "7829", approvedSnapshotHash: provisionalSnapshot.snapshotHash };
  await assert.rejects(() => runPromotion(args), /--allowProvisional/);
  assert.equal(databaseReads, 0);
  const report = await runPromotion({ ...args, allowProvisional: true });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.inserted, 16);
  assert.equal(report.rowsWritten, 0);
  assert.equal(databaseReads, 1);
  const tampered = structuredClone(provisionalSnapshot);
  tampered.provisionalEvidence.lag = tampered.provisionalEvidence.allowedError + 1;
  await assert.rejects(() => runPromotion({ ...args, snapshot: tampered, approvedSnapshotHash: tampered.snapshotHash, allowProvisional: true }), /provisional 误差证据无效/);
  assert.equal(databaseReads, 1, "provisional 阈值必须在数据库读取前重新验证");
});

test("write 还必须审批最新 dry-run planHash 和完整确认串", async () => {
  let writeCalls = 0;
  const rows = databaseRows();
  const transport = { async selectTargetRows() { return rows; }, async upsertTargetRows() { writeCalls += 1; } };
  const { plan } = buildPromotionPlan(snapshot, rows, { projectRef, targetEvent: "cpg08", targetDay: "7829" });
  await assert.rejects(() => runPromotion({ snapshot, databaseTransport: transport, projectRef, targetEvent: "cpg08", targetDay: "7829", approvedSnapshotHash: snapshot.snapshotHash, write: true, approvedPlanHash: "0".repeat(64), confirmation: `PROMOTE:${snapshot.snapshotHash}:${plan.planHash}` }), /approvedPlanHash/);
  await assert.rejects(() => runPromotion({ snapshot, databaseTransport: transport, projectRef, targetEvent: "cpg08", targetDay: "7829", approvedSnapshotHash: snapshot.snapshotHash, write: true, approvedPlanHash: plan.planHash, confirmation: "PROMOTE" }), /显式 promotion/);
  assert.equal(writeCalls, 0);
});

test("写入前生成并校验加密 recovery delta，然后只批量 upsert 变化行并写后验证", async () => {
  const rows = databaseRows();
  const { plan } = buildPromotionPlan(snapshot, rows, { projectRef, targetEvent: "cpg08", targetDay: "7829" });
  const batches = [];
  const stored = new Map(rows.map((row) => [row.doujinshi_id, row]));
  const recoveryDir = mkdtempSync(path.join(tmpdir(), "cpg-promotion-recovery-"));
  const report = await runPromotion({
    snapshot,
    databaseTransport: {
      async selectTargetRows({ eventId, dayId }) { assert.equal(eventId, "cpg08"); assert.equal(dayId, "7829"); return [...stored.values()]; },
      async upsertTargetRows(call) { batches.push(call); for (const row of call.rows) stored.set(row.doujinshi_id, row); },
    },
    projectRef,
    targetEvent: "cpg08",
    targetDay: "7829",
    approvedSnapshotHash: snapshot.snapshotHash,
    write: true,
    approvedPlanHash: plan.planHash,
    confirmation: `PROMOTE:${snapshot.snapshotHash}:${plan.planHash}`,
    recoveryDir,
    recoveryKey: "11".repeat(32),
    batchSize: 10000,
    now: () => new Date("2026-08-02T01:00:00.000Z"),
  });
  assert.ok(existsSync(report.recovery.path));
  const recovery = JSON.parse(readFileSync(report.recovery.path, "utf8"));
  assert.equal(recovery.kind, "cpp-promotion-encrypted-recovery-delta");
  assert.equal(recovery.algorithm, "aes-256-gcm");
  assert.equal(report.recovery.encrypted, true);
  assert.equal(report.recovery.beforeRows, 1);
  assert.equal(report.recovery.insertedIds, 38186);
  assert.equal(report.rowsWritten, 38187);
  assert.equal(report.verified, true);
  assert.equal(report.databaseRowsAfter, 38189);
  assert.equal(batches.length, 4);
  assert.ok(batches.every((batch) => batch.eventId === "cpg08" && batch.dayId === "7829" && batch.rows.every((row) => row.event_id === "cpg08" && row.day_id === "7829")));
});

test("promotion 实现静态证明无 destructive method、RPC 或 scope 外表", () => {
  const source = readFileSync(new URL("../scripts/promote-cpp-snapshot.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.delete\s*\(/i);
  assert.doesNotMatch(source, /method:\s*["']DELETE["']/i);
  assert.doesNotMatch(source, /\/rest\/v1\/(?!cpp_items)/i);
  assert.doesNotMatch(source, /\/rpc\//i);
  assert.match(source, /CPG_DATABASE_EVENT_ID/);
  assert.match(source, /approvedSnapshotDay/);
});
