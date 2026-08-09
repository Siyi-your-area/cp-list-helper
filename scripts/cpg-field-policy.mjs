import { readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_CPG_FIELD_POLICY = "config/cpg-field-policy.v1.json";

const ALLOWED_FIELDS = new Set([
  "event_id", "day_id", "doujinshi_id", "type_id", "type_name", "product_name",
  "author", "booth_number", "booth_name", "image_url", "tags", "source_url",
  "original_work", "hot_count", "exchange_type", "description", "normalized_booth",
  "normalized_product", "normalized_author", "booth_aliases", "product_aliases", "source_hash",
]);
const VALUES = {
  class: new Set(["identity", "stable", "volatile", "detail", "derived"]),
  source: new Set(["search", "detail", "derived"]),
  updateMode: new Set(["immutable", "replace", "fillMissing", "recompute"]),
  nullPolicy: new Set(["reject", "preserveExisting"]),
  cadence: new Set(["snapshot", "daily", "detail"]),
  hashGroup: new Set(["source", "none"]),
};

function fail(message) { throw new Error(`CPG field policy: ${message}`); }

export function validateCPGFieldPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) fail("根节点必须是对象");
  if (policy.schemaVersion !== 1 || !/^cpg08-fields-v\d+$/.test(policy.policyVersion) || policy.eventId !== "cpg08") fail("版本或 eventId 无效");
  if (!Array.isArray(policy.fields) || policy.fields.length !== ALLOWED_FIELDS.size) fail("fields 必须完整覆盖 whitelist");
  const seen = new Set();
  for (const field of policy.fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) fail("field 必须是对象");
    if (Object.keys(field).sort().join(",") !== "cadence,class,hashGroup,name,nullPolicy,source,updateMode") fail("field schema 含缺失或未知键");
    if (!ALLOWED_FIELDS.has(field.name) || seen.has(field.name)) fail(`未知或重复字段 ${field.name}`);
    seen.add(field.name);
    for (const key of Object.keys(VALUES)) if (!VALUES[key].has(field[key])) fail(`${field.name}.${key} 无效`);
  }
  if ([...ALLOWED_FIELDS].some((name) => !seen.has(name))) fail("whitelist 覆盖不完整");
  const byName = new Map(policy.fields.map((field) => [field.name, field]));
  for (const name of ["event_id", "day_id", "doujinshi_id"]) {
    const field = byName.get(name);
    if (field.class !== "identity" || field.updateMode !== "immutable") fail(`${name} 必须是 immutable identity`);
  }
  const hot = byName.get("hot_count");
  if (hot.class !== "volatile" || hot.source !== "search" || hot.updateMode !== "replace" || hot.cadence !== "daily") fail("hot_count 必须是 search volatile daily replace");
  for (const name of ["description", "exchange_type"]) {
    const field = byName.get(name);
    if (field.class !== "detail" || field.source !== "detail" || field.updateMode !== "fillMissing" || field.nullPolicy !== "preserveExisting") fail(`${name} 必须是 detail fillMissing`);
  }
  for (const field of policy.fields) {
    if (field.source === "search" && field.class === "detail") fail(`搜索快照不得写详情字段 ${field.name}`);
    if (field.class === "derived" && field.source !== "derived") fail(`${field.name} derived 来源无效`);
  }
  return policy;
}

export function loadCPGFieldPolicy(filename = DEFAULT_CPG_FIELD_POLICY) {
  return validateCPGFieldPolicy(JSON.parse(readFileSync(path.resolve(filename), "utf8")));
}

export function searchPromotionRow(snapshotRow, currentRow, policy) {
  validateCPGFieldPolicy(policy);
  const output = {};
  for (const field of policy.fields) {
    if (field.source === "detail") continue;
    const incoming = snapshotRow[field.name];
    if (field.updateMode === "immutable" && currentRow && currentRow[field.name] !== incoming) fail(`${field.name} identity 漂移`);
    const missing = incoming == null || incoming === "" || (Array.isArray(incoming) && incoming.length === 0);
    if (missing && field.nullPolicy === "preserveExisting" && currentRow && currentRow[field.name] != null) output[field.name] = currentRow[field.name];
    else if (incoming == null && field.nullPolicy === "reject") fail(`${field.name} 不允许 null/undefined`);
    else output[field.name] = incoming;
  }
  return output;
}
