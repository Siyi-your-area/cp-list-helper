import { createHash } from "node:crypto";

export const CPG_SOURCE_EVENT_ID = "7073";
export const CPG_DATABASE_EVENT_ID = "cpg08";
export const CPG_EXPECTED_TYPE_COUNT = 16;
export const CPG_SCAN_ORDER_BY = "0";
export const CPG_DEFAULT_CATEGORY_WORKERS = 4;
export const CPG_MAX_CATEGORY_WORKERS = 6;
const CPG_SCAN_STRATEGY = Object.freeze({
  categoryOrderBy: CPG_SCAN_ORDER_BY,
  sameCategoryPages: "strictly-serial",
  categoryEpochs: "dirty-type-restart-from-page-1",
  validation: "full-reverse-pass",
  barriers: "two-consecutive-global-and-16-type-totals",
  maxDirtyEpochs: 3,
  maxBarrierRounds: 3,
  maxConvergenceRounds: 8,
});

const RETRYABLE_CPP_STATUSES = new Set([429, 502, 503, 504]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

class SourceChangingError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceChangingError";
  }
}

function sourceChanging(message) {
  throw new SourceChangingError(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTypeName(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function attributeValue(text, attribute) {
  const match = text.match(new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function unique(values) {
  return [...new Set(values)];
}

function eventIdsFromText(value) {
  return Array.from(String(value).matchAll(/(?:[?&]|&amp;)event=(\d+)/gi), (match) => match[1]);
}

function currentSourceEventIds(html) {
  const explicit = [
    ...Array.from(html.matchAll(/\bdata-(?:source-|current-)event-id=["'](\d+)["']/gi), (match) => match[1]),
    ...Array.from(html.matchAll(/\b(?:sourceEventId|currentEventId)\s*=\s*["']?(\d+)["']?/g), (match) => match[1]),
  ];
  for (const tag of html.match(/<[^>]+>/g) || []) {
    const isCanonical = /\brel=["'][^"']*\bcanonical\b[^"']*["']/i.test(tag);
    const isSelected = /\bselected\b/i.test(tag) || /\baria-current=["'](?:page|true)["']/i.test(tag) || /\bclass=["'][^"']*\b(?:current|active|selected)\b[^"']*["']/i.test(tag);
    const isEventInput = /^<input\b/i.test(tag) && /\bname=["']event["']/i.test(tag);
    if (isCanonical || isSelected) explicit.push(...eventIdsFromText(tag));
    if (isEventInput) {
      const value = tag.match(/\bvalue=["'](\d+)["']/i);
      if (value) explicit.push(value[1]);
    }
  }
  const explicitIds = unique(explicit.filter(Boolean));
  if (explicitIds.length > 0) return explicitIds;
  const linkedIds = unique(eventIdsFromText(html));
  return linkedIds.includes(CPG_SOURCE_EVENT_ID) ? [CPG_SOURCE_EVENT_ID] : linkedIds;
}

export function parseCPGEventPage(html) {
  if (typeof html !== "string" || html.trim() === "") fail("CPG 活动页面为空");
  const embeddedMatch = html.match(/<script\b[^>]*\bid=["']cpp-snapshot-manifest["'][^>]*>([\s\S]*?)<\/script>/i);
  let sourceEventIds = [];
  let dayIds = [];
  let types = [];
  if (embeddedMatch) {
    let embedded;
    try {
      embedded = JSON.parse(embeddedMatch[1]);
    } catch (error) {
      fail(`CPG 页面内嵌定义不是合法 JSON：${error.message}`);
    }
    sourceEventIds = [String(embedded.sourceEventId ?? "")];
    dayIds = Array.isArray(embedded.dayIds) ? embedded.dayIds.map(String) : [];
    types = Array.isArray(embedded.types) ? embedded.types : [];
  } else {
    sourceEventIds = currentSourceEventIds(html);
    dayIds = unique([
      ...Array.from(html.matchAll(/\bzEids\s*\.\s*push\s*\(\s*["']?(\d+)["']?\s*\)/g), (match) => match[1]),
      ...Array.from(html.matchAll(/\bdata-day-id=["'](\d+)["']/gi), (match) => match[1]),
    ]);
    for (const match of html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)) {
      const elementId = attributeValue(match[1], "id");
      const typeMatch = elementId?.match(/^type(\d+)$/i);
      if (!typeMatch) continue;
      const dataId = attributeValue(match[1], "data-id");
      if (dataId !== typeMatch[1]) fail(`CPG 分类 ${elementId} 的 data-id 不一致`);
      const name = normalizeTypeName(match[2].replace(/<[^>]+>/g, ""));
      types.push({ id: Number(dataId), name });
    }
  }

  const eventIds = unique(sourceEventIds.filter(Boolean));
  if (eventIds.length !== 1 || eventIds[0] !== CPG_SOURCE_EVENT_ID) {
    fail(`CPG source event 门禁失败：期望 ${CPG_SOURCE_EVENT_ID}，实际 ${eventIds.join(",") || "未发现"}`);
  }
  const days = unique(dayIds.map(String).filter(Boolean));
  if (
    days.length !== 1 ||
    !/^\d+$/.test(days[0]) ||
    !Number.isSafeInteger(Number(days[0])) ||
    Number(days[0]) <= 0
  ) {
    fail(`CPG day 门禁失败：必须动态发现唯一正安全整数，实际 ${days.join(",") || "未发现"}`);
  }
  const typeMap = new Map();
  for (const type of types) {
    const id = Number(type?.id ?? type?.typeId);
    const name = normalizeTypeName(type?.name ?? type?.typeName);
    if (!Number.isSafeInteger(id) || id <= 0 || !name) fail("CPG 分类 ID/名称无效");
    if (typeMap.has(id)) fail(`CPG 分类 ID ${id} 重复`);
    typeMap.set(id, name);
  }
  if (typeMap.size !== CPG_EXPECTED_TYPE_COUNT) {
    fail(`CPG 分类门禁失败：期望 ${CPG_EXPECTED_TYPE_COUNT}，实际 ${typeMap.size}`);
  }
  const sortedTypes = [...typeMap].map(([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id);
  return {
    internalEventId: CPG_DATABASE_EVENT_ID,
    sourceEventId: CPG_SOURCE_EVENT_ID,
    dayIds: days,
    types: sortedTypes,
  };
}

export function createCPPRequestController({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  minIntervalMs = 250,
  maxInFlight = 4,
  maxAttempts = 6,
  maxBackoffMs = 30000,
} = {}) {
  if (typeof fetchImpl !== "function") fail("缺少 fetch 实现");
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 250) fail("CPP dispatch interval 不得低于 250ms");
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 6) fail("CPP maxInFlight 必须在 1..6");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6) fail("CPP 最大尝试次数必须在 1..6");
  if (!Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < 1 || maxBackoffMs > 30000) fail("CPP 重试等待上限必须在 1..30000ms");
  const startedAt = now();
  const metrics = { requestStarts: 0, retries: 0, status429: 0, maxInFlight: 0 };
  let effectiveMinInterval = minIntervalMs;
  let successStreak = 0;
  let globalPauseUntil = 0;
  let nextStartAt = 0;
  let limiterQueue = Promise.resolve();
  let inFlight = 0;
  let activeRequests = 0;
  const semaphoreWaiters = [];

  async function acquireSemaphore() {
    if (inFlight >= maxInFlight) await new Promise((resolve) => semaphoreWaiters.push(resolve));
    inFlight += 1;
  }

  function releaseSemaphore() {
    inFlight -= 1;
    semaphoreWaiters.shift()?.();
  }

  function waitForDispatchSlot() {
    const slot = limiterQueue.then(async () => {
      while (true) {
        const target = Math.max(nextStartAt, globalPauseUntil);
        const delay = target - now();
        if (delay <= 0) break;
        await sleep(delay);
      }
      nextStartAt = now() + effectiveMinInterval;
    });
    limiterQueue = slot.catch(() => {});
    return slot;
  }

  function retryAfterMs(response) {
    const raw = response.headers?.get?.("retry-after");
    if (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim())) return Math.ceil(Number(raw.trim()) * 1000);
    if (typeof raw === "string") {
      const timestamp = Date.parse(raw);
      if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now());
    }
    return null;
  }

  async function execute(url, init, label) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await acquireSemaphore();
      let response;
      let started = false;
      try {
        await waitForDispatchSlot();
        metrics.requestStarts += 1;
        activeRequests += 1;
        started = true;
        metrics.maxInFlight = Math.max(metrics.maxInFlight, activeRequests);
        response = await fetchImpl(url, init);
      } finally {
        if (started) activeRequests -= 1;
        releaseSemaphore();
      }
      if (!RETRYABLE_CPP_STATUSES.has(response.status)) {
        if (response.status >= 200 && response.status < 400) {
          successStreak += 1;
          if (successStreak >= 100 && effectiveMinInterval > minIntervalMs) {
            effectiveMinInterval = Math.max(minIntervalMs, Math.ceil(effectiveMinInterval * 0.9));
            successStreak = 0;
          }
        } else {
          successStreak = 0;
        }
        return response;
      }
      if (attempt === maxAttempts) fail(`${label} HTTP ${response.status} 重试耗尽`);
      metrics.retries += 1;
      successStreak = 0;
      const delay = Math.min(maxBackoffMs, retryAfterMs(response) ?? 1000 * 2 ** (attempt - 1));
      if (response.status === 429) {
        metrics.status429 += 1;
        effectiveMinInterval = Math.min(maxBackoffMs, Math.max(minIntervalMs * 2, effectiveMinInterval * 2));
        globalPauseUntil = Math.max(globalPauseUntil, now() + delay);
      } else if (delay > 0) {
        await sleep(delay);
      }
    }
  }
  return {
    request(url, init, label = "CPP request") {
      return execute(url, init, label);
    },
    getMetrics() {
      return {
        ...metrics,
        effectiveMinInterval,
        elapsedMs: Math.max(0, now() - startedAt),
      };
    },
    getPolicy() {
      return { configuredMinIntervalMs: minIntervalMs, maxInFlight };
    },
  };
}

function normalize(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\u00a0]+/g, "").replace(/[·•・—–－_\-~～,，。.!！?？:：;；'"“”‘’()[\]（）【】{}《》「」『』]/g, "").toLowerCase();
}

function splitBooths(value) {
  return String(value || "").match(/[一-鿿]+[A-Z]?\d+/g) || [String(value || "")];
}

function aliases(value) {
  const output = new Set([normalize(value)]);
  for (const match of String(value || "").matchAll(/[【\[《「『(（]([^】\]》」』)）]+)[】\]》」』)）]/g)) output.add(normalize(match[1]));
  return [...output].filter((item) => item.length >= 2);
}

export function sourceHash(row) {
  const source = {
    event_id: row.event_id, day_id: row.day_id, type_id: row.type_id,
    doujinshi_id: row.doujinshi_id, product_name: row.product_name,
    author: row.author, booth_number: row.booth_number, booth_name: row.booth_name,
    image_url: row.image_url, tags: row.tags, source_url: row.source_url,
    hot_count: row.hot_count, original_work: row.original_work,
  };
  return sha256(JSON.stringify(source));
}

function canonicalRow(item, dayId, type) {
  if (!isObject(item) || !Number.isSafeInteger(item.doujinshiId) || item.doujinshiId <= 0) fail("CPP 条目 doujinshiId 无效");
  if (typeof item.doujinshiName !== "string" || !item.doujinshiName.trim()) fail(`CPP ${item.doujinshiId} 制品名称为空`);
  const events = Array.isArray(item.eventList) ? item.eventList.filter((entry) => String(entry?.eventID ?? entry?.eventId) === dayId) : [];
  if (events.length !== 1) fail(`CPP ${item.doujinshiId} 在 day ${dayId} 的 eventList 数量不是 1`);
  if (!Array.isArray(item.authorList)) fail(`CPP ${item.doujinshiId} authorList 无效`);
  const event = events[0];
  const hotCount = item.hotCount == null || item.hotCount === "" ? 0 : Number(item.hotCount);
  if (!Number.isSafeInteger(hotCount) || hotCount < -1) fail(`CPP ${item.doujinshiId} hotCount 无效`);
  const row = {
    event_id: CPG_DATABASE_EVENT_ID,
    day_id: dayId,
    type_id: type.id,
    type_name: type.name,
    doujinshi_id: item.doujinshiId,
    product_name: item.doujinshiName,
    author: item.authorList.map((author) => author?.authorName || String(author?.authorId ?? "")).join(", "),
    booth_number: String(event.position ?? ""),
    booth_name: String(event.circleName ?? ""),
    image_url: item.coverPicUrl ? `https://imagecdn3.allcpp.cn/upload${item.coverPicUrl}` : "",
    tags: item.tag ? String(item.tag).split("|").map((tag) => tag.trim()).filter(Boolean) : [],
    source_url: `https://www.allcpp.cn/d/${item.doujinshiId}.do`,
    hot_count: hotCount,
    original_work: String(item.themeAlias ?? ""),
    normalized_booth: normalize(event.position ?? ""),
    normalized_product: normalize(item.doujinshiName),
    normalized_author: normalize(item.authorList.map((author) => author?.authorName || "").join(", ")),
    booth_aliases: [...new Set(splitBooths(event.position ?? "").map(normalize).filter(Boolean))],
    product_aliases: aliases(item.doujinshiName),
  };
  row.source_hash = sourceHash(row);
  return row;
}

function validateEnvelope(envelope, pageSize, label) {
  if (!isObject(envelope) || envelope.isSuccess !== true || !isObject(envelope.result)) fail(`${label} 响应结构无效`);
  const { total, list } = envelope.result;
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(list) || list.length > pageSize) fail(`${label} total/list 无效`);
  return { total, list };
}

async function scanTask(sourceTransport, definition, type, pageSize) {
  const dayId = definition.dayIds[0];
  const rows = [];
  const seen = new Set();
  const pageHashes = [];
  let total = null;
  let effectivePageSize = null;
  for (let pageIndex = 1; ; pageIndex += 1) {
    const label = `day=${dayId} type=${type.id} page=${pageIndex}`;
    const envelope = validateEnvelope(await sourceTransport.getSearchPage({ sourceEventId: CPG_SOURCE_EVENT_ID, dayId, typeId: type.id, orderBy: CPG_SCAN_ORDER_BY, pageIndex, pageSize }), pageSize, label);
    if (total == null) total = envelope.total;
    if (pageIndex === 1 && total >= 9500) fail(`${label} 声明 ${total} 条，达到二级分区门禁；当前扫描器不猜测未冻结的分区维度`);
    if (envelope.list.length === 0) {
      if (envelope.total !== total && envelope.total !== 0) sourceChanging(`${label} sentinel total 漂移`);
      if (rows.length !== total) sourceChanging(`${label} sentinel 覆盖不完整：${rows.length}/${total}`);
      pageHashes.push(sha256(stableJson({ pageIndex, total: envelope.total, ids: [] })));
      break;
    }
    if (envelope.total !== total || total === 0) sourceChanging(`${label} total 漂移`);
    if (effectivePageSize == null) effectivePageSize = envelope.list.length;
    const expected = Math.min(effectivePageSize, total - rows.length);
    if (envelope.list.length !== expected) sourceChanging(`${label} 页宽异常：期望 ${expected}，实际 ${envelope.list.length}`);
    const pageRows = envelope.list.map((item) => canonicalRow(item, dayId, type));
    for (const row of pageRows) {
      if (seen.has(row.doujinshi_id)) sourceChanging(`${label} 跨页重复 ID ${row.doujinshi_id}`);
      seen.add(row.doujinshi_id);
      rows.push(row);
    }
    pageHashes.push(sha256(stableJson({ pageIndex, total, rows: pageRows })));
  }
  return { dayId, typeId: type.id, typeName: type.name, orderBy: CPG_SCAN_ORDER_BY, declared: total ?? 0, rawRows: rows.length, uniqueRows: seen.size, pages: pageHashes.length, pageHashes, rows };
}

async function scanProvisionalTask(sourceTransport, definition, type, pageSize) {
  const dayId = definition.dayIds[0];
  const rowsById = new Map();
  const pageHashes = [];
  let rawRows = 0;
  let duplicates = 0;
  let lastObservedTotal = 0;
  for (let pageIndex = 1; ; pageIndex += 1) {
    if (pageIndex > 10000) fail(`provisional type=${type.id} 页数超过安全上限`);
    const label = `provisional day=${dayId} type=${type.id} page=${pageIndex}`;
    const envelope = validateEnvelope(await sourceTransport.getSearchPage({ sourceEventId: CPG_SOURCE_EVENT_ID, dayId, typeId: type.id, orderBy: CPG_SCAN_ORDER_BY, pageIndex, pageSize }), pageSize, label);
    if (envelope.total >= 9500) fail(`${label} 达到二级分区门禁`);
    lastObservedTotal = envelope.total || lastObservedTotal;
    if (envelope.list.length === 0) {
      pageHashes.push(sha256(stableJson({ pageIndex, total: envelope.total, ids: [] })));
      break;
    }
    const pageRows = envelope.list.map((item) => canonicalRow(item, dayId, type));
    rawRows += pageRows.length;
    for (const row of pageRows) {
      if (rowsById.has(row.doujinshi_id)) duplicates += 1;
      else rowsById.set(row.doujinshi_id, row);
    }
    pageHashes.push(sha256(stableJson({ pageIndex, total: envelope.total, rows: pageRows })));
  }
  return {
    dayId, typeId: type.id, typeName: type.name, orderBy: CPG_SCAN_ORDER_BY,
    observedTotalDuringScan: lastObservedTotal, rawRows, uniqueRows: rowsById.size,
    duplicates, pages: pageHashes.length, pageHashes, rows: [...rowsById.values()],
  };
}

export function snapshotDefinition(snapshot) {
  return {
    internalEventId: snapshot.internalEventId,
    sourceEventId: snapshot.sourceEventId,
    dayIds: snapshot.dayIds,
    types: snapshot.types,
    declaredTotal: snapshot.declaredTotal,
    declaredTotalSource: snapshot.declaredTotalSource,
    categoryOrderBy: snapshot.categoryOrderBy,
    scanStrategy: snapshot.scanStrategy,
  };
}

export function calculateDefinitionHash(definition) {
  return sha256(stableJson(definition));
}

export function calculateSnapshotHash(snapshot) {
  if (snapshot.schemaVersion === 4) {
    return sha256(stableJson({
      definitionHash: snapshot.definitionHash,
      provisionalEvidence: snapshot.provisionalEvidence,
      tasks: snapshot.tasks,
      rows: snapshot.rows,
    }));
  }
  return sha256(stableJson({
    definitionHash: snapshot.definitionHash,
    finalBarriers: snapshot.finalBarriers,
    tasks: snapshot.tasks,
    dirtyRetries: snapshot.dirtyRetries,
    convergenceRounds: snapshot.convergenceRounds,
    rows: snapshot.rows,
  }));
}

function definitionSignature(definition) {
  return calculateDefinitionHash(definition);
}

function assertStableDefinition(expected, actual, label) {
  if (definitionSignature(expected) !== definitionSignature(actual)) {
    fail(`${label} 活动 topology 漂移`);
  }
}

function countProbeEvidence(probe) {
  return {
    checkpoint: probe.checkpoint,
    dayId: probe.dayId,
    typeIds: probe.typeIds,
    orderBy: probe.orderBy,
    requestSemanticsVersion: probe.requestSemanticsVersion,
    total: probe.total,
    resultShape: probe.resultShape,
  };
}

function calculateCountProbeHash(probe) {
  return sha256(stableJson(countProbeEvidence(probe)));
}

function validateGlobalCountEnvelope(value, { dayId, checkpoint }) {
  if (!isObject(value) || value.isSuccess !== true || !isObject(value.result)) fail(`${checkpoint} 无 type 总数响应结构无效`);
  const { total, list } = value.result;
  if (!Number.isSafeInteger(total) || total <= 0 || !Array.isArray(list)) fail(`${checkpoint} 无 type 总数必须是正安全整数且 list 必须是数组`);
  const probe = {
    checkpoint,
    dayId,
    typeIds: "",
    orderBy: CPG_SCAN_ORDER_BY,
    requestSemanticsVersion: "cpp-unfiltered-search-v1",
    total,
    resultShape: {
      isSuccess: true,
      resultIsObject: true,
      listIsArray: true,
    },
  };
  probe.probeHash = calculateCountProbeHash(probe);
  return probe;
}

async function readCheckpoint(sourceTransport, checkpoint) {
  const topology = parseCPGEventPage(await sourceTransport.getEventPage({ sourceEventId: CPG_SOURCE_EVENT_ID, checkpoint }));
  if (typeof sourceTransport.getDeclaredTotal !== "function") fail("sourceTransport 缺少 getDeclaredTotal");
  const dayId = topology.dayIds[0];
  const probe = validateGlobalCountEnvelope(await sourceTransport.getDeclaredTotal({ dayId, checkpoint }), { dayId, checkpoint });
  return { topology, probe };
}

function validatePassTotals(tasks, globalTotal, label) {
  const declared = tasks.reduce((sum, task) => sum + task.declared, 0);
  const rawRows = tasks.reduce((sum, task) => sum + task.rawRows, 0);
  const rows = tasks.flatMap((task) => task.rows);
  const uniqueRows = new Set(rows.map((row) => row.doujinshi_id)).size;
  if (uniqueRows !== rows.length) fail(`${label} 跨分类重复 ID`);
  if (declared !== globalTotal || rawRows !== globalTotal || rows.length !== globalTotal || uniqueRows !== globalTotal) {
    fail(`${label} global/type 总数门禁失败：global ${globalTotal}，任务 ${declared}，raw ${rawRows}，rows ${rows.length}，unique ${uniqueRows}`);
  }
  return { declared, rawRows, rows, uniqueRows };
}

function taskProof(task) {
  const rows = [...task.rows].sort((left, right) => left.doujinshi_id - right.doujinshi_id);
  return {
    total: task.declared,
    idsHash: sha256(stableJson(rows.map((row) => row.doujinshi_id))),
    canonicalHash: sha256(stableJson(rows)),
    sourceHashesHash: sha256(stableJson(rows.map((row) => row.source_hash))),
  };
}

function publicTaskScan(task) {
  const { rows, ...scan } = task;
  return { ...scan, ...taskProof(task) };
}

function sameTaskProof(left, right) {
  const leftProof = taskProof(left);
  const rightProof = taskProof(right);
  return ["total", "idsHash", "canonicalHash", "sourceHashesHash"].every((field) => leftProof[field] === rightProof[field]);
}

async function scanTypeEpoch({ sourceTransport, definition, type, pageSize, tracker }) {
  for (let epoch = 1; epoch <= 3; epoch += 1) {
    tracker.fullEpochs += 1;
    try {
      return await scanTask(sourceTransport, definition, type, pageSize);
    } catch (error) {
      if (!(error instanceof SourceChangingError)) throw error;
      if (epoch === 3) fail(`type=${type.id} dirty epoch budget 耗尽：${error.message}`);
      tracker.dirtyRetries += 1;
      tracker.dirtyByType.set(type.id, (tracker.dirtyByType.get(type.id) || 0) + 1);
    }
  }
}

async function runSnapshotPass({ sourceTransport, definition, pageSize, types, onTaskComplete, pass, categoryWorkers, tracker }) {
  const tasks = new Array(types.length);
  let nextIndex = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(categoryWorkers, types.length) }, async () => {
    while (!failure) {
      const index = nextIndex;
      if (index >= types.length) return;
      nextIndex += 1;
      try {
        const task = await scanTypeEpoch({ sourceTransport, definition, type: types[index], pageSize, tracker });
        tasks[index] = task;
        onTaskComplete({ pass, typeId: task.typeId, typeName: task.typeName, total: task.declared });
      } catch (error) {
        failure ||= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return tasks;
}

function barrierHash(barrier) {
  return sha256(stableJson({
    checkpoint: barrier.checkpoint,
    global: barrier.global,
    typeTotals: barrier.typeTotals,
    sumTypeTotals: barrier.sumTypeTotals,
    unionUnique: barrier.unionUnique,
  }));
}

function candidateAggregate(candidate, definition) {
  const tasks = definition.types.map((type) => candidate.get(type.id));
  if (tasks.some((task) => !task)) fail("candidate 缺少分类");
  const rows = tasks.flatMap((task) => task.rows);
  const uniqueRows = new Set(rows.map((row) => row.doujinshi_id)).size;
  if (uniqueRows !== rows.length) fail("candidate 跨分类重复 ID");
  return {
    tasks,
    rows,
    declared: tasks.reduce((sum, task) => sum + task.declared, 0),
    rawRows: tasks.reduce((sum, task) => sum + task.rawRows, 0),
    uniqueRows,
  };
}

async function readBarrier({ sourceTransport, definition, pageSize, candidate, checkpoint }) {
  const dayId = definition.dayIds[0];
  const [eventPage, globalEnvelope, ...typeEnvelopes] = await Promise.all([
    sourceTransport.getEventPage({ sourceEventId: CPG_SOURCE_EVENT_ID, checkpoint }),
    sourceTransport.getDeclaredTotal({ dayId, checkpoint }),
    ...definition.types.map((type) => sourceTransport.getSearchPage({
      sourceEventId: CPG_SOURCE_EVENT_ID,
      dayId,
      typeId: type.id,
      orderBy: CPG_SCAN_ORDER_BY,
      pageIndex: 1,
      pageSize,
    })),
  ]);
  assertStableDefinition({
    internalEventId: definition.internalEventId,
    sourceEventId: definition.sourceEventId,
    dayIds: definition.dayIds,
    types: definition.types,
  }, parseCPGEventPage(eventPage), `${checkpoint} topology`);
  const global = validateGlobalCountEnvelope(globalEnvelope, { dayId, checkpoint });
  const typeTotals = definition.types.map((type, index) => {
    const envelope = validateEnvelope(typeEnvelopes[index], pageSize, `${checkpoint} type=${type.id} page=1`);
    if (envelope.total >= 9500) fail(`${checkpoint} type=${type.id} 达到二级分区门禁`);
    return { typeId: type.id, total: envelope.total };
  });
  const aggregate = candidateAggregate(candidate, definition);
  const barrier = {
    checkpoint,
    global,
    typeTotals,
    sumTypeTotals: typeTotals.reduce((sum, item) => sum + item.total, 0),
    unionUnique: aggregate.uniqueRows,
  };
  barrier.barrierHash = barrierHash(barrier);
  return barrier;
}

function barrierDirtyTypes(barrier, candidate) {
  return barrier.typeTotals.filter((item) => candidate.get(item.typeId)?.declared !== item.total).map((item) => item.typeId);
}

function barrierIsComplete(barrier) {
  return barrier.global.total === barrier.sumTypeTotals && barrier.sumTypeTotals === barrier.unionUnique;
}

function sameBarrierTotals(left, right) {
  return left.global.total === right.global.total && stableJson(left.typeTotals) === stableJson(right.typeTotals);
}

async function collectStableBarriers({ sourceTransport, definition, pageSize, candidate, phase }) {
  let previous = null;
  for (let round = 1; round <= 3; round += 1) {
    const current = await readBarrier({ sourceTransport, definition, pageSize, candidate, checkpoint: `${phase}-barrier-${round}` });
    const dirtyTypeIds = barrierDirtyTypes(current, candidate);
    if (dirtyTypeIds.length) return { dirtyTypeIds };
    if (!barrierIsComplete(current)) {
      previous = null;
      continue;
    }
    if (previous && sameBarrierTotals(previous, current)) return { barriers: [previous, current] };
    previous = current;
  }
  fail(`${phase} barrier budget 耗尽，未得到连续两次一致证明`);
}

function recordDirtyRescan(tracker, typeIds) {
  for (const typeId of typeIds) {
    if ((tracker.outerRescansByType.get(typeId) || 0) >= 3) fail(`type=${typeId} outer extra rescan budget 耗尽`);
  }
  for (const typeId of typeIds) {
    tracker.outerRescansByType.set(typeId, (tracker.outerRescansByType.get(typeId) || 0) + 1);
    tracker.dirtyRetries += 1;
    tracker.dirtyByType.set(typeId, (tracker.dirtyByType.get(typeId) || 0) + 1);
  }
}

async function rescanTypes({ sourceTransport, definition, pageSize, typeIds, onTaskComplete, pass, categoryWorkers, tracker }) {
  const wanted = new Set(typeIds);
  const types = definition.types.filter((type) => wanted.has(type.id));
  const tasks = await runSnapshotPass({ sourceTransport, definition, pageSize, types, onTaskComplete, pass, categoryWorkers, tracker });
  return new Map(tasks.map((task) => [task.typeId, task]));
}

async function prepareCandidate({ sourceTransport, definition, pageSize, candidate, onTaskComplete, categoryWorkers, tracker }) {
  for (let round = 1; round <= 8; round += 1) {
    const result = await collectStableBarriers({ sourceTransport, definition, pageSize, candidate, phase: `candidate-${round}` });
    if (result.barriers) return result.barriers;
    recordDirtyRescan(tracker, result.dirtyTypeIds);
    const rescanned = await rescanTypes({ sourceTransport, definition, pageSize, typeIds: result.dirtyTypeIds, onTaskComplete, pass: `candidate-dirty-${round}`, categoryWorkers, tracker });
    for (const [typeId, task] of rescanned) candidate.set(typeId, task);
  }
  fail("candidate dirty convergence budget 耗尽");
}

export async function runCPGSnapshot({ sourceTransport, pageSize = 100, categoryWorkers = CPG_DEFAULT_CATEGORY_WORKERS, now = () => new Date(), onTaskComplete = () => {} } = {}) {
  if (!sourceTransport) fail("sourceTransport 必填");
  if (!Number.isSafeInteger(categoryWorkers) || categoryWorkers < 1 || categoryWorkers > CPG_MAX_CATEGORY_WORKERS) fail(`categoryWorkers 必须在 1..${CPG_MAX_CATEGORY_WORKERS}`);
  const discoveredAt = now().toISOString();
  const firstCheckpoint = await readCheckpoint(sourceTransport, "A-before");
  const definition = {
    ...firstCheckpoint.topology,
    declaredTotal: firstCheckpoint.probe.total,
    declaredTotalSource: "cpp-unfiltered-search",
    categoryOrderBy: CPG_SCAN_ORDER_BY,
    scanStrategy: CPG_SCAN_STRATEGY,
  };
  const tracker = { fullEpochs: 0, dirtyRetries: 0, dirtyByType: new Map(), outerRescansByType: new Map() };
  const firstPass = await runSnapshotPass({ sourceTransport, definition, pageSize, types: definition.types, onTaskComplete, pass: "candidate", categoryWorkers, tracker });
  const candidate = new Map(firstPass.map((task) => [task.typeId, task]));
  await prepareCandidate({ sourceTransport, definition, pageSize, candidate, onTaskComplete, categoryWorkers, tracker });

  const validation = await runSnapshotPass({ sourceTransport, definition, pageSize, types: [...definition.types].reverse(), onTaskComplete, pass: "validation", categoryWorkers, tracker });
  const validationByType = new Map(validation.map((task) => [task.typeId, task]));
  const stablePairs = new Map();
  let dirtyTypeIds = [];
  for (const type of definition.types) {
    const current = candidate.get(type.id);
    const checked = validationByType.get(type.id);
    if (sameTaskProof(current, checked)) stablePairs.set(type.id, [current, checked]);
    else {
      candidate.set(type.id, checked);
      dirtyTypeIds.push(type.id);
    }
  }

  let finalBarriers = null;
  let convergenceRounds = 0;
  for (let round = 1; round <= 8; round += 1) {
    convergenceRounds = round;
    if (dirtyTypeIds.length) {
      recordDirtyRescan(tracker, dirtyTypeIds);
      const rescanned = await rescanTypes({ sourceTransport, definition, pageSize, typeIds: dirtyTypeIds, onTaskComplete, pass: `convergence-${round}`, categoryWorkers, tracker });
      const nextDirty = [];
      for (const typeId of dirtyTypeIds) {
        const current = candidate.get(typeId);
        const checked = rescanned.get(typeId);
        if (sameTaskProof(current, checked)) stablePairs.set(typeId, [current, checked]);
        else {
          candidate.set(typeId, checked);
          stablePairs.delete(typeId);
          nextDirty.push(typeId);
        }
      }
      dirtyTypeIds = nextDirty;
      if (dirtyTypeIds.length) continue;
    }
    const barrierResult = await collectStableBarriers({ sourceTransport, definition, pageSize, candidate, phase: `final-${round}` });
    if (barrierResult.barriers) {
      finalBarriers = barrierResult.barriers;
      break;
    }
    dirtyTypeIds = barrierResult.dirtyTypeIds;
    for (const typeId of dirtyTypeIds) stablePairs.delete(typeId);
  }
  if (!finalBarriers || stablePairs.size !== CPG_EXPECTED_TYPE_COUNT) fail("dirty convergence budget 耗尽，未形成每类双 epoch 与双 barrier 证明");

  definition.declaredTotal = finalBarriers[1].global.total;
  const aggregate = candidateAggregate(candidate, definition);
  if (aggregate.declared !== definition.declaredTotal || aggregate.rawRows !== definition.declaredTotal || aggregate.rows.length !== definition.declaredTotal || aggregate.uniqueRows !== definition.declaredTotal) fail("最终 global/type/union 门禁失败");
  const rows = [...aggregate.rows].sort((a, b) => a.doujinshi_id - b.doujinshi_id);
  const tasks = definition.types.map((type) => {
    const task = candidate.get(type.id);
    const proof = taskProof(task);
    return {
      dayId: task.dayId, typeId: task.typeId, typeName: task.typeName, orderBy: task.orderBy,
      declared: task.declared, rawRows: task.rawRows, uniqueRows: task.uniqueRows,
      idsHash: proof.idsHash, canonicalHash: proof.canonicalHash, sourceHashesHash: proof.sourceHashesHash,
      stableEpochs: stablePairs.get(type.id).map(publicTaskScan), stableAcrossScans: true,
      dirtyRetries: tracker.dirtyByType.get(type.id) || 0,
      rowHash: proof.canonicalHash,
    };
  });
  const snapshot = {
    schemaVersion: 3, kind: "cpp-canonical-snapshot", state: "snapshot_ready",
    internalEventId: definition.internalEventId, sourceEventId: definition.sourceEventId,
    dayIds: definition.dayIds, types: definition.types, declaredTotal: definition.declaredTotal,
    discoveredAt, readOnly: true, dbWritesAttempted: 0,
    tasksCompleted: tasks.length, tasksExpected: CPG_EXPECTED_TYPE_COUNT,
    scanPasses: tracker.fullEpochs,
    topologyChecks: ["initial"],
    declaredTotalSource: definition.declaredTotalSource,
    categoryOrderBy: definition.categoryOrderBy,
    scanStrategy: definition.scanStrategy,
    execution: { categoryWorkers },
    finalBarriers,
    dirtyRetries: tracker.dirtyRetries,
    convergenceRounds,
    requestMetrics: typeof sourceTransport.getRequestMetrics === "function"
      ? sourceTransport.getRequestMetrics()
      : { requestStarts: 0, retries: 0, status429: 0, maxInFlight: 0, effectiveMinInterval: 250, elapsedMs: 0 },
    totals: { declared: aggregate.declared, rawRows: aggregate.rawRows, uniqueRows: aggregate.uniqueRows },
    tasks,
    rows,
  };
  snapshot.definitionHash = calculateDefinitionHash(snapshotDefinition(snapshot));
  snapshot.snapshotHash = calculateSnapshotHash(snapshot);
  return snapshot;
}

function provisionalEvidenceHash(evidence) {
  const { evidenceHash, ...input } = evidence;
  return sha256(stableJson(input));
}

async function runProvisionalPass({ sourceTransport, definition, pageSize, categoryWorkers, onTaskComplete }) {
  const tasks = new Array(definition.types.length);
  let nextIndex = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(categoryWorkers, definition.types.length) }, async () => {
    while (!failure) {
      const index = nextIndex;
      if (index >= definition.types.length) return;
      nextIndex += 1;
      const type = definition.types[index];
      try {
        const task = await scanProvisionalTask(sourceTransport, definition, type, pageSize);
        tasks[index] = task;
        onTaskComplete({ pass: "provisional", typeId: task.typeId, typeName: task.typeName, total: task.observedTotalDuringScan });
      } catch (error) {
        failure ||= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return tasks;
}

async function readProvisionalEvidence({ sourceTransport, definition, pageSize, uniqueRows, duplicates }) {
  const checkpoint = "provisional-final";
  const dayId = definition.dayIds[0];
  const eventPage = await sourceTransport.getEventPage({ sourceEventId: CPG_SOURCE_EVENT_ID, checkpoint });
  assertStableDefinition({
    internalEventId: definition.internalEventId,
    sourceEventId: definition.sourceEventId,
    dayIds: definition.dayIds,
    types: definition.types,
  }, parseCPGEventPage(eventPage), `${checkpoint} topology`);
  const [globalEnvelope, ...typeEnvelopes] = await Promise.all([
    sourceTransport.getDeclaredTotal({ dayId, checkpoint }),
    ...definition.types.map((type) => sourceTransport.getSearchPage({ sourceEventId: CPG_SOURCE_EVENT_ID, dayId, typeId: type.id, orderBy: CPG_SCAN_ORDER_BY, pageIndex: 1, pageSize })),
  ]);
  const global = validateGlobalCountEnvelope(globalEnvelope, { dayId, checkpoint });
  const typeTotals = definition.types.map((type, index) => {
    const envelope = validateEnvelope(typeEnvelopes[index], pageSize, `${checkpoint} type=${type.id}`);
    if (envelope.total >= 9500) fail(`${checkpoint} type=${type.id} 达到二级分区门禁`);
    return { typeId: type.id, total: envelope.total };
  });
  const globalProbeTotal = global.total;
  const sumTypeTotals = typeTotals.reduce((sum, entry) => sum + entry.total, 0);
  const globalCountCapped = globalProbeTotal === 10000 && sumTypeTotals > 10000;
  if (!globalCountCapped && sumTypeTotals !== globalProbeTotal) fail(`provisional sumTypeTotals ${sumTypeTotals} != globalProbeTotal ${globalProbeTotal}`);
  const observedTotalSource = globalCountCapped ? "sum-type-totals" : "cpp-unfiltered-search";
  const observedGlobal = globalCountCapped ? sumTypeTotals : globalProbeTotal;
  const lag = observedGlobal - uniqueRows;
  const allowedError = Math.max(100, Math.ceil(observedGlobal * 0.005));
  if (lag < 0 || lag > allowedError) fail(`provisional lag ${lag} 超出 0..${allowedError}`);
  if (duplicates > allowedError) fail(`provisional duplicates ${duplicates} 超出 ${allowedError}`);
  const evidence = { checkpoint, global, globalCountCapped, globalProbeTotal, observedTotalSource, typeTotals, observedGlobal, sumTypeTotals, uniqueRows, duplicates, lag, allowedError };
  evidence.evidenceHash = provisionalEvidenceHash(evidence);
  return evidence;
}

export async function runCPGProvisionalSnapshot({ sourceTransport, pageSize = 100, categoryWorkers = CPG_DEFAULT_CATEGORY_WORKERS, now = () => new Date(), onTaskComplete = () => {} } = {}) {
  if (!sourceTransport) fail("sourceTransport 必填");
  if (!Number.isSafeInteger(categoryWorkers) || categoryWorkers < 1 || categoryWorkers > CPG_MAX_CATEGORY_WORKERS) fail(`categoryWorkers 必须在 1..${CPG_MAX_CATEGORY_WORKERS}`);
  const discoveredAt = now().toISOString();
  const topology = parseCPGEventPage(await sourceTransport.getEventPage({ sourceEventId: CPG_SOURCE_EVENT_ID, checkpoint: "provisional-initial" }));
  const definition = { ...topology, declaredTotal: 0, declaredTotalSource: "cpp-unfiltered-search", categoryOrderBy: CPG_SCAN_ORDER_BY, scanStrategy: CPG_SCAN_STRATEGY };
  const scannedTasks = await runProvisionalPass({ sourceTransport, definition, pageSize, categoryWorkers, onTaskComplete });
  const rows = [];
  const globalIds = new Set();
  for (const task of scannedTasks) {
    for (const row of task.rows) {
      if (globalIds.has(row.doujinshi_id)) fail(`provisional 跨分类同 ID 冲突 ${row.doujinshi_id}`);
      globalIds.add(row.doujinshi_id);
      rows.push(row);
    }
  }
  rows.sort((left, right) => left.doujinshi_id - right.doujinshi_id);
  const duplicates = scannedTasks.reduce((sum, task) => sum + task.duplicates, 0);
  const provisionalEvidence = await readProvisionalEvidence({ sourceTransport, definition, pageSize, uniqueRows: rows.length, duplicates });
  definition.declaredTotal = provisionalEvidence.observedGlobal;
  const tasks = scannedTasks.map((task) => {
    const proof = taskProof({ declared: task.uniqueRows, rows: task.rows });
    const { rows: taskRows, ...publicTask } = task;
    return { ...publicTask, idsHash: proof.idsHash, canonicalHash: proof.canonicalHash, sourceHashesHash: proof.sourceHashesHash };
  });
  const snapshot = {
    schemaVersion: 4, kind: "cpp-canonical-snapshot", state: "snapshot_ready_provisional",
    internalEventId: definition.internalEventId, sourceEventId: definition.sourceEventId,
    dayIds: definition.dayIds, types: definition.types, declaredTotal: definition.declaredTotal,
    declaredTotalSource: definition.declaredTotalSource, categoryOrderBy: definition.categoryOrderBy,
    scanStrategy: definition.scanStrategy, discoveredAt, readOnly: true, dbWrites: 0, dbWritesAttempted: 0,
    tasksCompleted: tasks.length, tasksExpected: CPG_EXPECTED_TYPE_COUNT, scanPasses: 1,
    topologyChecks: ["provisional-initial"], execution: { categoryWorkers, provisionalSinglePass: true },
    provisionalEvidence,
    requestMetrics: typeof sourceTransport.getRequestMetrics === "function" ? sourceTransport.getRequestMetrics() : { requestStarts: 0, retries: 0, status429: 0, maxInFlight: 0, effectiveMinInterval: 250, elapsedMs: 0 },
    totals: { observedGlobal: provisionalEvidence.observedGlobal, observedTotalSource: provisionalEvidence.observedTotalSource, globalCountCapped: provisionalEvidence.globalCountCapped, globalProbeTotal: provisionalEvidence.globalProbeTotal, sumTypeTotals: provisionalEvidence.sumTypeTotals, rawRows: scannedTasks.reduce((sum, task) => sum + task.rawRows, 0), uniqueRows: rows.length, duplicates, lag: provisionalEvidence.lag },
    tasks, rows,
  };
  snapshot.definitionHash = calculateDefinitionHash(snapshotDefinition(snapshot));
  snapshot.snapshotHash = calculateSnapshotHash(snapshot);
  return snapshot;
}

function validateProvisionalSnapshot(snapshot) {
  if (snapshot.schemaVersion !== 4 || snapshot.state !== "snapshot_ready_provisional") fail("provisional snapshot 必须使用 v4 snapshot_ready_provisional");
  if (snapshot.readOnly !== true || snapshot.dbWrites !== 0 || snapshot.dbWritesAttempted !== 0 || snapshot.scanPasses !== 1 || snapshot.tasksCompleted !== CPG_EXPECTED_TYPE_COUNT || snapshot.tasksExpected !== CPG_EXPECTED_TYPE_COUNT || stableJson(snapshot.topologyChecks) !== stableJson(["provisional-initial"])) fail("provisional snapshot 只读/单轮证据无效");
  if (!isObject(snapshot.execution) || snapshot.execution.provisionalSinglePass !== true || !Number.isSafeInteger(snapshot.execution.categoryWorkers) || snapshot.execution.categoryWorkers < 1 || snapshot.execution.categoryWorkers > CPG_MAX_CATEGORY_WORKERS) fail("provisional execution 证据无效");
  const definition = snapshotDefinition(snapshot);
  if (definition.internalEventId !== CPG_DATABASE_EVENT_ID || definition.sourceEventId !== CPG_SOURCE_EVENT_ID || !Array.isArray(definition.dayIds) || definition.dayIds.length !== 1 || !/^\d+$/.test(definition.dayIds[0]) || !Array.isArray(definition.types) || definition.types.length !== CPG_EXPECTED_TYPE_COUNT || definition.categoryOrderBy !== CPG_SCAN_ORDER_BY || definition.declaredTotalSource !== "cpp-unfiltered-search" || stableJson(definition.scanStrategy) !== stableJson(CPG_SCAN_STRATEGY)) fail("provisional definition 无效");
  if (!Array.isArray(snapshot.rows) || !Array.isArray(snapshot.tasks) || snapshot.tasks.length !== CPG_EXPECTED_TYPE_COUNT) fail("provisional rows/tasks 无效");
  const ids = new Set();
  const typeMap = new Map(definition.types.map((type) => [type.id, type.name]));
  for (const row of snapshot.rows) {
    if (ids.has(row.doujinshi_id) || row.event_id !== CPG_DATABASE_EVENT_ID || row.day_id !== definition.dayIds[0] || typeMap.get(row.type_id) !== row.type_name || sourceHash(row) !== row.source_hash) fail("provisional canonical row 无效");
    ids.add(row.doujinshi_id);
  }
  let duplicates = 0;
  const taskTypes = new Set();
  for (const task of snapshot.tasks) {
    const taskRows = snapshot.rows.filter((row) => row.type_id === task.typeId);
    const proof = taskProof({ declared: taskRows.length, rows: taskRows });
    if (taskTypes.has(task.typeId) || typeMap.get(task.typeId) !== task.typeName || task.orderBy !== CPG_SCAN_ORDER_BY || task.uniqueRows !== taskRows.length || task.rawRows !== task.uniqueRows + task.duplicates || !Number.isSafeInteger(task.observedTotalDuringScan) || task.observedTotalDuringScan < 0 || task.observedTotalDuringScan >= 9500 || !Number.isSafeInteger(task.duplicates) || task.duplicates < 0 || !Number.isSafeInteger(task.pages) || task.pages < 1 || !Array.isArray(task.pageHashes) || task.pageHashes.length !== task.pages || task.pageHashes.some((hash) => !HASH_PATTERN.test(hash)) || task.idsHash !== proof.idsHash || task.canonicalHash !== proof.canonicalHash || task.sourceHashesHash !== proof.sourceHashesHash) fail("provisional task 证据无效");
    taskTypes.add(task.typeId);
    duplicates += task.duplicates;
  }
  const evidence = snapshot.provisionalEvidence;
  const validTypeTotals = isObject(evidence) && Array.isArray(evidence.typeTotals) && evidence.typeTotals.length === CPG_EXPECTED_TYPE_COUNT;
  const recomputedSumTypeTotals = validTypeTotals ? evidence.typeTotals.reduce((sum, entry) => sum + entry.total, 0) : Number.NaN;
  const recomputedGlobalProbeTotal = isObject(evidence?.global) ? evidence.global.total : Number.NaN;
  const recomputedGlobalCountCapped = recomputedGlobalProbeTotal === 10000 && recomputedSumTypeTotals > 10000;
  const recomputedObservedTotalSource = recomputedGlobalCountCapped ? "sum-type-totals" : "cpp-unfiltered-search";
  const recomputedObservedGlobal = recomputedGlobalCountCapped ? recomputedSumTypeTotals : recomputedGlobalProbeTotal;
  if (!isObject(evidence) || evidence.evidenceHash !== provisionalEvidenceHash(evidence) || !Number.isSafeInteger(evidence.observedGlobal) || evidence.observedGlobal <= 0 || evidence.observedGlobal !== definition.declaredTotal || evidence.globalCountCapped !== recomputedGlobalCountCapped || evidence.globalProbeTotal !== recomputedGlobalProbeTotal || evidence.observedTotalSource !== recomputedObservedTotalSource || evidence.observedGlobal !== recomputedObservedGlobal || (!recomputedGlobalCountCapped && recomputedSumTypeTotals !== recomputedGlobalProbeTotal) || evidence.uniqueRows !== snapshot.rows.length || evidence.duplicates !== duplicates || evidence.sumTypeTotals !== recomputedSumTypeTotals || evidence.lag !== evidence.observedGlobal - evidence.uniqueRows || evidence.allowedError !== Math.max(100, Math.ceil(evidence.observedGlobal * 0.005)) || evidence.lag < 0 || evidence.lag > evidence.allowedError || evidence.duplicates > evidence.allowedError || !validTypeTotals || evidence.typeTotals.some((entry, index) => entry.typeId !== definition.types[index].id || !Number.isSafeInteger(entry.total) || entry.total < 0) || !isObject(evidence.global) || evidence.global.checkpoint !== "provisional-final" || evidence.global.dayId !== definition.dayIds[0] || evidence.global.typeIds !== "" || evidence.global.orderBy !== CPG_SCAN_ORDER_BY || evidence.global.requestSemanticsVersion !== "cpp-unfiltered-search-v1" || stableJson(evidence.global.resultShape) !== stableJson({ isSuccess: true, resultIsObject: true, listIsArray: true }) || evidence.global.probeHash !== calculateCountProbeHash(evidence.global)) fail("provisional 误差证据无效");
  if (snapshot.totals?.observedGlobal !== evidence.observedGlobal || snapshot.totals?.observedTotalSource !== evidence.observedTotalSource || snapshot.totals?.globalCountCapped !== evidence.globalCountCapped || snapshot.totals?.globalProbeTotal !== evidence.globalProbeTotal || snapshot.totals?.sumTypeTotals !== evidence.sumTypeTotals || snapshot.totals?.uniqueRows !== evidence.uniqueRows || snapshot.totals?.duplicates !== evidence.duplicates || snapshot.totals?.lag !== evidence.lag) fail("provisional totals 不自洽");
  if (snapshot.definitionHash !== calculateDefinitionHash(definition) || snapshot.snapshotHash !== calculateSnapshotHash(snapshot)) fail("provisional snapshot hash 无效");
  return snapshot;
}

export function validateFrozenSnapshot(snapshot) {
  if (!isObject(snapshot) || snapshot.kind !== "cpp-canonical-snapshot") fail("只接受 canonical snapshot");
  if (snapshot.schemaVersion === 4 || snapshot.state === "snapshot_ready_provisional") return validateProvisionalSnapshot(snapshot);
  if (snapshot.state !== "snapshot_ready") fail("只接受 snapshot_ready 的 canonical snapshot");
  if (snapshot.schemaVersion !== 3 || snapshot.declaredTotalSource !== "cpp-unfiltered-search") fail("snapshot 必须使用 v3 dirty-convergence 总数契约");
  if (snapshot.categoryOrderBy !== CPG_SCAN_ORDER_BY) fail(`snapshot 分类排序必须为 orderBy=${CPG_SCAN_ORDER_BY}`);
  if (stableJson(snapshot.scanStrategy) !== stableJson(CPG_SCAN_STRATEGY)) fail("snapshot 并发扫描策略无效");
  if (!isObject(snapshot.execution) || !Number.isSafeInteger(snapshot.execution.categoryWorkers) || snapshot.execution.categoryWorkers < 1 || snapshot.execution.categoryWorkers > CPG_MAX_CATEGORY_WORKERS) fail("snapshot categoryWorkers 证据无效");
  const requestMetrics = snapshot.requestMetrics;
  if (!isObject(requestMetrics) || ["requestStarts", "retries", "status429", "maxInFlight", "effectiveMinInterval", "elapsedMs"].some((field) => !Number.isSafeInteger(requestMetrics[field]) || requestMetrics[field] < 0) || requestMetrics.maxInFlight > 6 || requestMetrics.effectiveMinInterval < 250) fail("snapshot request metrics 无效");
  if (snapshot.readOnly !== true || snapshot.dbWritesAttempted !== 0) fail("snapshot 缺少只读证据");
  const definition = snapshotDefinition(snapshot);
  const snapshotDays = definition.dayIds;
  if (definition.internalEventId !== CPG_DATABASE_EVENT_ID || definition.sourceEventId !== CPG_SOURCE_EVENT_ID || !Array.isArray(snapshotDays) || snapshotDays.length !== 1 || !/^\d+$/.test(snapshotDays[0]) || !Number.isSafeInteger(Number(snapshotDays[0])) || Number(snapshotDays[0]) <= 0) fail("snapshot event/day 契约不匹配");
  const snapshotDay = snapshotDays[0];
  if (!Array.isArray(definition.types) || definition.types.length !== CPG_EXPECTED_TYPE_COUNT || !Number.isSafeInteger(definition.declaredTotal) || definition.declaredTotal <= 0) fail("snapshot 16 类/动态声明总数门禁失败");
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length !== definition.declaredTotal || snapshot.tasksCompleted !== CPG_EXPECTED_TYPE_COUNT || snapshot.tasksExpected !== CPG_EXPECTED_TYPE_COUNT || !Number.isSafeInteger(snapshot.scanPasses) || snapshot.scanPasses < CPG_EXPECTED_TYPE_COUNT * 2) fail("snapshot 不完整");
  if (JSON.stringify(snapshot.topologyChecks) !== JSON.stringify(["initial"])) fail("snapshot topology 检查证据不完整");
  if (!Number.isSafeInteger(snapshot.dirtyRetries) || snapshot.dirtyRetries < 0 || !Number.isSafeInteger(snapshot.convergenceRounds) || snapshot.convergenceRounds < 1 || snapshot.convergenceRounds > 8) fail("snapshot convergence 指标无效");
  if (!Array.isArray(snapshot.finalBarriers) || snapshot.finalBarriers.length !== 2) fail("snapshot 最终双 barrier 证据不完整");
  for (const barrier of snapshot.finalBarriers) {
    if (!isObject(barrier) || !isObject(barrier.global) || barrier.global.dayId !== snapshotDay || barrier.global.typeIds !== "" || barrier.global.orderBy !== CPG_SCAN_ORDER_BY || barrier.global.requestSemanticsVersion !== "cpp-unfiltered-search-v1" || barrier.global.total !== definition.declaredTotal || stableJson(barrier.global.resultShape) !== stableJson({ isSuccess: true, resultIsObject: true, listIsArray: true }) || barrier.global.probeHash !== calculateCountProbeHash(barrier.global) || !Array.isArray(barrier.typeTotals) || barrier.typeTotals.length !== CPG_EXPECTED_TYPE_COUNT || barrier.typeTotals.some((entry, index) => entry.typeId !== definition.types[index].id || !Number.isSafeInteger(entry.total) || entry.total < 0 || snapshot.rows.filter((row) => row.type_id === entry.typeId).length !== entry.total) || barrier.typeTotals.reduce((sum, entry) => sum + entry.total, 0) !== barrier.sumTypeTotals || barrier.sumTypeTotals !== definition.declaredTotal || barrier.unionUnique !== definition.declaredTotal || barrier.barrierHash !== barrierHash(barrier)) fail("snapshot barrier 无效");
  }
  if (!sameBarrierTotals(snapshot.finalBarriers[0], snapshot.finalBarriers[1])) fail("snapshot 最终 barriers 不连续一致");
  if (snapshot.totals?.declared !== definition.declaredTotal || snapshot.totals?.rawRows !== definition.declaredTotal || snapshot.totals?.uniqueRows !== definition.declaredTotal) fail("snapshot 动态总数不自洽");
  if (!HASH_PATTERN.test(snapshot.definitionHash) || calculateDefinitionHash(definition) !== snapshot.definitionHash) fail("snapshot definitionHash 无效");
  if (!HASH_PATTERN.test(snapshot.snapshotHash) || calculateSnapshotHash(snapshot) !== snapshot.snapshotHash) fail("snapshot snapshotHash 无效");
  const ids = new Set();
  const definitionTypes = new Map(definition.types.map((type) => [type.id, type.name]));
  for (const row of snapshot.rows) {
    if (row.event_id !== CPG_DATABASE_EVENT_ID || row.day_id !== snapshotDay || definitionTypes.get(row.type_id) !== row.type_name || ids.has(row.doujinshi_id) || sourceHash(row) !== row.source_hash) fail(`snapshot canonical row 无效：${row?.doujinshi_id ?? "unknown"}`);
    ids.add(row.doujinshi_id);
  }
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.length !== CPG_EXPECTED_TYPE_COUNT) fail("snapshot task 数量无效");
  let taskTotal = 0;
  const taskTypeIds = new Set();
  for (const task of snapshot.tasks) {
    if (taskTypeIds.has(task.typeId) || task.dayId !== snapshotDay || task.orderBy !== CPG_SCAN_ORDER_BY || definitionTypes.get(task.typeId) !== task.typeName) fail(`snapshot task topology 无效：${task.typeId}`);
    taskTypeIds.add(task.typeId);
    const taskRows = snapshot.rows.filter((row) => row.type_id === task.typeId);
    const proof = taskProof({ declared: task.declared, rows: taskRows });
    if (task.stableAcrossScans !== true || task.declared !== task.rawRows || task.rawRows !== task.uniqueRows || task.declared !== taskRows.length || task.idsHash !== proof.idsHash || task.canonicalHash !== proof.canonicalHash || task.sourceHashesHash !== proof.sourceHashesHash || task.rowHash !== proof.canonicalHash) fail(`snapshot task 自洽验证失败：${task.typeId}`);
    if (!Number.isSafeInteger(task.dirtyRetries) || task.dirtyRetries < 0 || task.dirtyRetries > 3 || !Array.isArray(task.stableEpochs) || task.stableEpochs.length !== 2) fail(`snapshot 双 epoch 证明无效：${task.typeId}`);
    for (const scan of task.stableEpochs) {
      if (!scan || scan.dayId !== snapshotDay || scan.orderBy !== CPG_SCAN_ORDER_BY || scan.typeId !== task.typeId || scan.typeName !== task.typeName || scan.declared !== task.declared || scan.rawRows !== task.rawRows || scan.uniqueRows !== task.uniqueRows || scan.total !== task.declared || scan.idsHash !== proof.idsHash || scan.canonicalHash !== proof.canonicalHash || scan.sourceHashesHash !== proof.sourceHashesHash) fail(`snapshot 双 epoch 证明无效：${task.typeId}`);
    }
    taskTotal += task.declared;
  }
  if (snapshot.tasks.reduce((sum, task) => sum + task.dirtyRetries, 0) !== snapshot.dirtyRetries) fail("snapshot dirtyRetries 不自洽");
  if (taskTypeIds.size !== definitionTypes.size || taskTotal !== definition.declaredTotal || ids.size !== definition.declaredTotal) fail("snapshot task/unique 动态总数不自洽");
  return snapshot;
}

export function createGeneratedFixtureTransport(fixture) {
  if (!isObject(fixture) || typeof fixture.eventPageHtml !== "string" || !Number.isSafeInteger(fixture.declaredTotal) || fixture.declaredTotal <= 0 || !isObject(fixture.taskTotals)) fail("CPG fixture 无效");
  const definition = parseCPGEventPage(fixture.eventPageHtml);
  const expectedKeys = definition.types.map((type) => String(type.id)).sort();
  if (JSON.stringify(Object.keys(fixture.taskTotals).sort()) !== JSON.stringify(expectedKeys)) fail("CPG fixture taskTotals 必须恰好覆盖 16 类");
  const offsets = new Map();
  let nextId = Number(fixture.firstDoujinshiId ?? 707300001);
  for (const type of definition.types) {
    offsets.set(type.id, nextId);
    nextId += fixture.taskTotals[type.id];
  }
  return {
    async getEventPage() { return fixture.eventPageHtml; },
    async getDeclaredTotal() {
      return { isSuccess: true, result: { total: fixture.declaredTotal, list: [] } };
    },
    getRequestMetrics() {
      return { requestStarts: 0, retries: 0, status429: 0, maxInFlight: 0, effectiveMinInterval: 250, elapsedMs: 0 };
    },
    async getSearchPage({ dayId, typeId, pageIndex, pageSize }) {
      const total = fixture.taskTotals[typeId];
      if (!Number.isSafeInteger(total) || total < 0) fail(`fixture type ${typeId} total 无效`);
      const start = (pageIndex - 1) * pageSize;
      const length = Math.max(0, Math.min(pageSize, total - start));
      const list = Array.from({ length }, (_, index) => {
        const id = offsets.get(typeId) + start + index;
        return { doujinshiId: id, doujinshiName: `CPG fixture ${id}`, authorList: [{ authorName: `作者${typeId}` }], eventList: [{ eventID: dayId, position: `甲A${(index % 99) + 1}`, circleName: `社团${typeId}` }], coverPicUrl: "", tag: "fixture", hotCount: 0, themeAlias: "fixture" };
      });
      return { isSuccess: true, result: { total, list } };
    },
  };
}
