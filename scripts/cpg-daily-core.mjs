import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateFrozenSnapshot } from "./cpp-snapshot-core.mjs";
import { runPromotion } from "./promote-cpp-snapshot.mjs";

function writeJson(outputDir, filename, value) {
  const directory = path.resolve(outputDir);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, filename);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  return target;
}

export async function runCPGDaily({
  scan,
  databaseTransport,
  projectRef,
  fieldPolicy,
  outputDir,
  now = () => new Date(),
  promote = runPromotion,
}) {
  if (typeof scan !== "function") throw new Error("daily scan 未配置");
  const scanResult = await scan();
  const snapshot = scanResult?.snapshot;
  validateFrozenSnapshot(snapshot);
  if (snapshot.readOnly !== true || snapshot.dbWritesAttempted !== 0) throw new Error("daily snapshot 缺少零写证明");
  const promotion = await promote({
    snapshot,
    databaseTransport,
    projectRef,
    targetEvent: "cpg08",
    targetDay: snapshot.dayIds[0],
    approvedSnapshotHash: snapshot.snapshotHash,
    write: false,
    fieldPolicy,
  });
  if (promotion.mode !== "dry-run" || promotion.rowsWritten !== 0) throw new Error("daily 默认流程只能生成零写 dry-run");
  const planPath = writeJson(outputDir, `plan-${promotion.planHash}.json`, promotion);
  const report = {
    schemaVersion: 1,
    kind: "cpg-daily-dry-run-report",
    generatedAt: now().toISOString(),
    mode: "dry-run",
    dbWritesAttempted: 0,
    snapshot: scanResult.target,
    snapshotHash: snapshot.snapshotHash,
    fieldPolicyVersion: fieldPolicy.policyVersion,
    plan: planPath,
    planHash: promotion.planHash,
    inserted: promotion.inserted,
    updated: promotion.updated,
    unchanged: promotion.unchanged,
    missingFromSource: promotion.missingFromSource,
    nextStep: "人工审阅 snapshot/report/plan；如需写入，另行执行 docs/12 中的 promote:cpg 显式审批命令。",
  };
  const reportPath = writeJson(outputDir, `daily-${promotion.planHash}.report.json`, report);
  return { ...report, report: reportPath };
}
