#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  CPG_DATABASE_EVENT_ID,
  calculateSnapshotHash,
  sha256,
  validateFrozenSnapshot,
} from "./cpp-snapshot-core.mjs";
import { loadCPGFieldPolicy, searchPromotionRow } from "./cpg-field-policy.mjs";

function fail(message) { throw new Error(message); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function approvedSnapshotDay(snapshot) {
  const dayIds = snapshot.dayIds;
  if (!Array.isArray(dayIds) || dayIds.length !== 1) fail("promotion snapshot 必须包含唯一 day");
  return dayIds[0];
}

function validatePromotionScope(snapshot, targetEvent, targetDay) {
  const snapshotDay = approvedSnapshotDay(snapshot);
  if (targetEvent !== CPG_DATABASE_EVENT_ID || targetDay !== snapshotDay) {
    fail(`promotion 只允许 ${CPG_DATABASE_EVENT_ID}/${snapshotDay}（已批准 snapshot day）`);
  }
  return snapshotDay;
}

function validatePromotionSnapshot(snapshot, allowProvisional) {
  validateFrozenSnapshot(snapshot);
  if (snapshot.schemaVersion === 4 && allowProvisional !== true) fail("provisional v4 promotion 需要显式 --allowProvisional");
}

export function buildPromotionPlan(snapshot, databaseRows, { projectRef, targetEvent, targetDay, allowProvisional = false }) {
  validatePromotionSnapshot(snapshot, allowProvisional);
  validatePromotionScope(snapshot, targetEvent, targetDay);
  if (!/^[a-z0-9]{20}$/.test(projectRef)) fail("projectRef 格式无效");
  if (!Array.isArray(databaseRows)) fail("databaseRows 必须是数组");
  const existing = new Map();
  for (const row of databaseRows) {
    if (row.event_id !== targetEvent || String(row.day_id) !== targetDay) fail("SELECT 返回了目标 event/day 之外的行");
    const id = Number(row.doujinshi_id);
    if (!Number.isSafeInteger(id) || existing.has(id)) fail(`数据库身份键无效或重复：${row.doujinshi_id}`);
    existing.set(id, row);
  }
  const sourceIds = new Set(snapshot.rows.map((row) => row.doujinshi_id));
  const insertedRows = [];
  const updatedRows = [];
  let unchanged = 0;
  for (const row of snapshot.rows) {
    const current = existing.get(row.doujinshi_id);
    if (!current) insertedRows.push(row);
    else if (current.source_hash !== row.source_hash) updatedRows.push(row);
    else unchanged += 1;
  }
  const missingFromSourceIds = [...existing.keys()].filter((id) => !sourceIds.has(id)).sort((a, b) => a - b);
  const plan = {
    schemaVersion: 1,
    kind: "cpp-snapshot-promotion-plan",
    projectRef,
    targetEvent,
    targetDay,
    snapshotHash: snapshot.snapshotHash,
    inserted: insertedRows.length,
    updated: updatedRows.length,
    unchanged,
    missingFromSource: missingFromSourceIds.length,
    insertedIds: insertedRows.map((row) => row.doujinshi_id),
    updatedIds: updatedRows.map((row) => row.doujinshi_id),
    missingFromSourceIds,
  };
  plan.planHash = sha256(stableJson(plan));
  return { plan, insertedRows, updatedRows };
}

function recoveryPayload(snapshot, plan, databaseRows) {
  const updatedIds = new Set(plan.updatedIds);
  const beforeRows = databaseRows.filter((row) => updatedIds.has(Number(row.doujinshi_id))).sort((a, b) => Number(a.doujinshi_id) - Number(b.doujinshi_id));
  if (beforeRows.length !== plan.updated) fail("before-image 行数与 updated diff 不一致");
  const payload = {
    schemaVersion: 1,
    kind: "cpp-promotion-recovery-delta",
    scope: { eventId: plan.targetEvent, dayId: plan.targetDay },
    snapshotHash: snapshot.snapshotHash,
    planHash: plan.planHash,
    insertedIds: plan.insertedIds,
    beforeRows,
  };
  payload.payloadHash = sha256(stableJson(payload));
  return payload;
}

function recoveryKeyBytes(recoveryKey) {
  if (typeof recoveryKey !== "string" || !/^[a-f0-9]{64}$/i.test(recoveryKey)) fail("写入需要独立的 32-byte hex CPG_RECOVERY_KEY");
  return Buffer.from(recoveryKey, "hex");
}

export function writeVerifiedRecoveryArtifact({ snapshot, plan, databaseRows, recoveryDir, recoveryKey }) {
  const directory = path.resolve(recoveryDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const payload = recoveryPayload(snapshot, plan, databaseRows);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", recoveryKeyBytes(recoveryKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    schemaVersion: 1,
    kind: "cpp-promotion-encrypted-recovery-delta",
    algorithm: "aes-256-gcm",
    snapshotHash: snapshot.snapshotHash,
    planHash: plan.planHash,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  const target = path.join(directory, `before-${plan.planHash}.enc.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  const verified = JSON.parse(readFileSync(target, "utf8"));
  const decipher = createDecipheriv("aes-256-gcm", recoveryKeyBytes(recoveryKey), Buffer.from(verified.iv, "base64"));
  decipher.setAuthTag(Buffer.from(verified.authTag, "base64"));
  const decrypted = JSON.parse(Buffer.concat([decipher.update(Buffer.from(verified.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  const { payloadHash: claimedHash, ...hashInput } = decrypted;
  if (claimedHash !== sha256(stableJson(hashInput))) fail("recovery artifact 写后解密/hash 校验失败");
  return { path: target, encrypted: true, algorithm: envelope.algorithm, payloadHash: claimedHash, insertedIds: payload.insertedIds.length, beforeRows: payload.beforeRows.length };
}

export async function runPromotion({
  snapshot,
  databaseTransport,
  projectRef,
  targetEvent,
  targetDay,
  approvedSnapshotHash,
  write = false,
  approvedPlanHash = "",
  confirmation = "",
  recoveryDir = ".cpp-promotion",
  recoveryKey = "",
  batchSize = 500,
  allowProvisional = false,
  fieldPolicy = null,
  now = () => new Date(),
}) {
  validatePromotionSnapshot(snapshot, allowProvisional);
  if (approvedSnapshotHash !== snapshot.snapshotHash || calculateSnapshotHash(snapshot) !== approvedSnapshotHash) fail("approvedSnapshotHash 与冻结快照不一致");
  validatePromotionScope(snapshot, targetEvent, targetDay);
  const databaseRows = await databaseTransport.selectTargetRows({ eventId: targetEvent, dayId: targetDay });
  const { plan, insertedRows, updatedRows } = buildPromotionPlan(snapshot, databaseRows, { projectRef, targetEvent, targetDay, allowProvisional });
  const result = { mode: write ? "write" : "dry-run", ...plan, recovery: null, batchesWritten: 0, rowsWritten: 0, verified: false };
  if (!write) return result;
  if (approvedPlanHash !== plan.planHash) fail("approvedPlanHash 与当前 dry-run diff 不一致；必须重新 dry-run 审批");
  if (confirmation !== `PROMOTE:${snapshot.snapshotHash}:${plan.planHash}`) fail("缺少与 snapshot/plan 一致的显式 promotion 确认参数");
  result.recovery = writeVerifiedRecoveryArtifact({ snapshot, plan, databaseRows, recoveryDir, recoveryKey });
  const currentById = new Map(databaseRows.map((row) => [Number(row.doujinshi_id), row]));
  const changed = [...insertedRows, ...updatedRows].map((row) => ({
    ...(fieldPolicy ? searchPromotionRow(row, currentById.get(row.doujinshi_id), fieldPolicy) : row),
    source_updated_at: now().toISOString(),
    crawl_run_id: snapshot.snapshotHash,
  }));
  for (let offset = 0; offset < changed.length; offset += batchSize) {
    const batch = changed.slice(offset, offset + batchSize);
    await databaseTransport.upsertTargetRows({ eventId: targetEvent, dayId: targetDay, rows: batch });
    result.batchesWritten += 1;
    result.rowsWritten += batch.length;
  }
  const databaseRowsAfter = await databaseTransport.selectTargetRows({ eventId: targetEvent, dayId: targetDay });
  const { plan: verification } = buildPromotionPlan(snapshot, databaseRowsAfter, { projectRef, targetEvent, targetDay, allowProvisional });
  if (verification.inserted !== 0 || verification.updated !== 0 || verification.unchanged !== snapshot.rows.length) {
    fail(`promotion 写后验证失败：remaining inserted=${verification.inserted} updated=${verification.updated} unchanged=${verification.unchanged}`);
  }
  result.verified = true;
  result.databaseRowsAfter = databaseRowsAfter.length;
  return result;
}

function parseContentRange(header, offset, count) {
  const match = String(header ?? "").match(/^(\d+)-(\d+)\/(\d+)$/);
  if (!match) {
    if (count === 0 && String(header) === "*/0") return 0;
    fail("数据库 SELECT 缺少 exact Content-Range");
  }
  if (Number(match[1]) !== offset || Number(match[2]) !== offset + count - 1) fail("数据库 SELECT Content-Range 不连续");
  return Number(match[3]);
}

export function createRestDatabaseTransport({ projectRef, apiKey, approvedDayId, fetchImpl = globalThis.fetch, pageSize = 1000 }) {
  if (!/^[a-z0-9]{20}$/.test(projectRef)) fail("projectRef 格式无效");
  if (typeof apiKey !== "string" || apiKey.trim() === "") fail("缺少 SUPABASE_CPP_PROMOTION_KEY");
  if (typeof approvedDayId !== "string" || !/^\d+$/.test(approvedDayId)) fail("数据库 transport 缺少已批准 snapshot day");
  const origin = `https://${projectRef}.supabase.co`;
  const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
  return {
    async selectTargetRows({ eventId, dayId }) {
      if (eventId !== CPG_DATABASE_EVENT_ID || dayId !== approvedDayId) fail("数据库读取 scope 越界");
      const rows = [];
      let exactTotal = null;
      while (exactTotal == null || rows.length < exactTotal) {
        const url = new URL("/rest/v1/cpp_items", origin);
        url.searchParams.set("select", "*");
        url.searchParams.set("event_id", `eq.${eventId}`);
        url.searchParams.set("day_id", `eq.${dayId}`);
        url.searchParams.set("order", "doujinshi_id.asc");
        url.searchParams.set("offset", String(rows.length));
        url.searchParams.set("limit", String(pageSize));
        const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { ...headers, Prefer: "count=exact" } });
        if (!response.ok) fail(`cpp_items SELECT HTTP ${response.status}`);
        const page = await response.json();
        if (!Array.isArray(page)) fail("cpp_items SELECT 响应不是数组");
        const total = parseContentRange(response.headers.get("content-range"), rows.length, page.length);
        if (exactTotal != null && total !== exactTotal) fail("cpp_items SELECT exact total 漂移");
        exactTotal = total;
        if (page.length === 0 && rows.length < exactTotal) fail("cpp_items SELECT 分页无进展");
        rows.push(...page);
      }
      return rows;
    },
    async upsertTargetRows({ eventId, dayId, rows }) {
      if (eventId !== CPG_DATABASE_EVENT_ID || dayId !== approvedDayId) fail("数据库写入 scope 越界");
      if (rows.some((row) => row.event_id !== eventId || row.day_id !== dayId)) fail("upsert batch 含 scope 外行");
      const url = new URL("/rest/v1/cpp_items", origin);
      url.searchParams.set("on_conflict", "event_id,day_id,doujinshi_id");
      const response = await fetchImpl(url, { method: "POST", redirect: "error", headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
      if (!response.ok) fail(`cpp_items upsert HTTP ${response.status}`);
    },
  };
}

function writeReport(outputDir, report) {
  const directory = path.resolve(outputDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `promotion-${report.planHash}-${report.mode}.report.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  return target;
}

async function main() {
  const { values } = parseArgs({ options: {
    snapshot: { type: "string" }, approvedSnapshotHash: { type: "string" },
    projectRef: { type: "string" }, targetEvent: { type: "string" }, targetDay: { type: "string" },
    write: { type: "boolean", default: false }, approvedPlanHash: { type: "string", default: "" },
    confirmPromotion: { type: "string", default: "" }, outputDir: { type: "string", default: ".cpp-promotion" },
    recoveryDir: { type: "string", default: ".cpp-promotion/recovery" }, batchSize: { type: "string", default: "500" },
    allowProvisional: { type: "boolean", default: false },
  } });
  for (const required of ["snapshot", "approvedSnapshotHash", "projectRef", "targetEvent", "targetDay"]) if (!values[required]) fail(`--${required} 必填`);
  const batchSize = Number(values.batchSize);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) fail("batchSize 必须在 1..1000");
  const snapshot = JSON.parse(readFileSync(path.resolve(values.snapshot), "utf8"));
  validatePromotionSnapshot(snapshot, values.allowProvisional);
  const databaseTransport = createRestDatabaseTransport({ projectRef: values.projectRef, apiKey: process.env.SUPABASE_CPP_PROMOTION_KEY, approvedDayId: approvedSnapshotDay(snapshot), pageSize: 1000 });
  const report = await runPromotion({ snapshot, databaseTransport, projectRef: values.projectRef, targetEvent: values.targetEvent, targetDay: values.targetDay, approvedSnapshotHash: values.approvedSnapshotHash, write: values.write, approvedPlanHash: values.approvedPlanHash, confirmation: values.confirmPromotion, recoveryDir: values.recoveryDir, recoveryKey: process.env.CPG_RECOVERY_KEY, batchSize, allowProvisional: values.allowProvisional, fieldPolicy: loadCPGFieldPolicy() });
  const target = writeReport(values.outputDir, report);
  console.log(JSON.stringify({ mode: report.mode, snapshotHash: report.snapshotHash, planHash: report.planHash, inserted: report.inserted, updated: report.updated, unchanged: report.unchanged, missingFromSource: report.missingFromSource, rowsWritten: report.rowsWritten, verified: report.verified, recovery: report.recovery, report: target }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
