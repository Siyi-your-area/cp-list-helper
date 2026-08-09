export const SOURCE_EVENT_ID = "6377";
export const DATABASE_EVENT_ID = "cp32";
export const EVENT_DAYS = Object.freeze(["7040", "7042"]);
export const EVENT_TYPES = Object.freeze([
  { id: 36, name: "漫画" },
  { id: 37, name: "小说" },
  { id: 38, name: "图集" },
  { id: 39, name: "音乐" },
  { id: 40, name: "GAME" },
  { id: 43, name: "卡片" },
  { id: 44, name: "纸胶带" },
  { id: 45, name: "COS" },
  { id: 46, name: "其他" },
  { id: 48, name: "手办" },
  { id: 49, name: "亚克力" },
  { id: 50, name: "图文志" },
  { id: 51, name: "海报集" },
  { id: 52, name: "其他作品集" },
  { id: 53, name: "徽章" },
  { id: 54, name: "色纸" },
]);
export const EXPECTED_TASK_KEYS = Object.freeze(
  EVENT_DAYS.flatMap((dayId) =>
    EVENT_TYPES.map((type) => `${dayId}:${type.id}`)
  )
);

const OLD_TYPE_IDS = new Set([33, 34, 41, 42]);
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RETRYABLE_CPP_STATUSES = new Set([429, 502, 503, 504]);
const COMPARED_FIELDS = Object.freeze([
  "type_id",
  "type_name",
  "product_name",
  "author",
  "booth_number",
  "booth_name",
  "image_url",
  "tags",
  "source_url",
  "hot_count",
  "original_work",
]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCookiePair(name, value) {
  if (
    typeof name !== "string" ||
    !COOKIE_NAME_PATTERN.test(name) ||
    typeof value !== "string" ||
    /[\u0000-\u001f\u007f;]/.test(value)
  ) {
    fail("Cookie 配置包含无效的 name/value");
  }
  return { name, value };
}

function cookiePairsFromObject(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (!isPlainObject(entry)) {
        fail("CPP_COOKIE_JSON 数组条目格式无效");
      }
      return validateCookiePair(entry.name, entry.value);
    });
  }
  if (!isPlainObject(value)) {
    fail("CPP_COOKIE_JSON 必须是数组或对象");
  }
  if (Object.hasOwn(value, "cookies")) {
    if (!Array.isArray(value.cookies)) {
      fail("CPP_COOKIE_JSON.cookies 必须是数组");
    }
    return cookiePairsFromObject(value.cookies);
  }
  return Object.entries(value).map(([name, cookieValue]) =>
    validateCookiePair(name, cookieValue)
  );
}

function joinCookiePairs(pairs) {
  if (pairs.length === 0) fail("Cookie 配置为空");
  const names = new Set();
  for (const pair of pairs) {
    if (names.has(pair.name)) fail("Cookie 配置包含重复 name");
    names.add(pair.name);
  }
  return pairs.map(({ name, value }) => `${name}=${value}`).join("; ");
}

export function cookieHeaderFromJson(rawJson) {
  if (typeof rawJson !== "string" || rawJson.trim() === "") {
    return "";
  }
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    fail("CPP_COOKIE_JSON 不是合法 JSON");
  }
  return joinCookiePairs(cookiePairsFromObject(parsed));
}

function validateRawCookieHeader(rawHeader) {
  if (typeof rawHeader !== "string" || rawHeader.trim() === "") return "";
  const pairs = rawHeader.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) fail("CPP_COOKIE 格式无效");
    return validateCookiePair(
      part.slice(0, separator).trim(),
      part.slice(separator + 1).trim()
    );
  });
  return joinCookiePairs(pairs);
}

export function resolveCookieHeader(environment) {
  if (!isPlainObject(environment)) fail("Cookie 环境配置无效");
  if (
    typeof environment.CPP_COOKIE === "string" &&
    environment.CPP_COOKIE.trim() !== ""
  ) {
    return validateRawCookieHeader(environment.CPP_COOKIE);
  }
  return cookieHeaderFromJson(environment.CPP_COOKIE_JSON);
}

function retryAfterDelayMs(response, nowMs) {
  const raw = response?.headers?.get?.("retry-after");
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return Math.max(0, Math.ceil(Number(value) * 1000));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

export function createCPPRequestController({
  fetchImpl = globalThis.fetch,
  sleep = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  now = () => Date.now(),
  random = Math.random,
  minIntervalMs = 900,
  maxAttempts = 6,
  maxBackoffMs = 30000,
  onRetry = () => {},
} = {}) {
  if (typeof fetchImpl !== "function" || typeof sleep !== "function") {
    fail("CPP 请求控制器缺少 fetch/sleep");
  }
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 800) {
    fail("CPP 最小请求间隔不得低于 800ms");
  }
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 6
  ) {
    fail("CPP 最大尝试次数必须在 1..6");
  }
  if (
    !Number.isSafeInteger(maxBackoffMs) ||
    maxBackoffMs < 1 ||
    maxBackoffMs > 30000
  ) {
    fail("CPP 重试等待上限必须在 1..30000ms");
  }

  let queue = Promise.resolve();
  let lastRequestAt = null;

  async function throttle() {
    if (lastRequestAt != null) {
      const remaining = minIntervalMs - (now() - lastRequestAt);
      if (remaining > 0) await sleep(remaining);
    }
    lastRequestAt = now();
  }

  async function execute(url, initOrFactory, label) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await throttle();
      const init =
        typeof initOrFactory === "function"
          ? initOrFactory()
          : initOrFactory;
      const response = await fetchImpl(url, init);
      if (!RETRYABLE_CPP_STATUSES.has(response.status)) return response;
      if (attempt >= maxAttempts) {
        fail(
          `${label} HTTP ${response.status}，CPP 重试已耗尽 (${maxAttempts} 次)`
        );
      }
      const retryAfter = retryAfterDelayMs(response, now());
      const exponential =
        1000 * (2 ** (attempt - 1)) +
        Math.floor(Math.max(0, Math.min(1, random())) * 250);
      const delayMs = Math.min(
        maxBackoffMs,
        retryAfter == null ? exponential : retryAfter
      );
      onRetry({
        label,
        status: response.status,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
      });
      if (delayMs > 0) await sleep(delayMs);
    }
    fail(`${label} CPP 请求状态异常`);
  }

  return {
    request(url, initOrFactory, label = "cpp-request") {
      const run = queue.then(() => execute(url, initOrFactory, label));
      queue = run.catch(() => {});
      return run;
    },
  };
}

function sortedUnique(values, compare = undefined) {
  return [...new Set(values)].sort(compare);
}

function numericSort(a, b) {
  return Number(a) - Number(b);
}

function normalizeTypeName(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function parseEmbeddedManifest(html) {
  const match = html.match(
    /<script\b[^>]*\bid=["']event6377-scanner-manifest["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    fail(`event6377 页面内嵌清单不是合法 JSON：${error.message}`);
  }
}

function extractAttributeIds(html, attribute) {
  const output = [];
  const pattern = new RegExp(
    `\\b${attribute}=["'](\\d+)["']`,
    "gi"
  );
  for (const match of html.matchAll(pattern)) output.push(match[1]);
  return output;
}

function extractJsonIds(html, key) {
  const output = [];
  const pattern = new RegExp(
    `["']${key}["']\\s*:\\s*["']?(\\d+)["']?`,
    "g"
  );
  for (const match of html.matchAll(pattern)) output.push(match[1]);
  return output;
}

function extractZEidDays(html) {
  return Array.from(
    html.matchAll(
      /\bzEids\s*\.\s*push\s*\(\s*["']?(\d+)["']?\s*\)\s*;?/g
    ),
    (match) => match[1]
  );
}

function attributeValue(tag, attribute) {
  const pattern = new RegExp(
    `(?:^|\\s)${attribute}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`,
    "i"
  );
  const match = tag.match(pattern);
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

function eventIdsFromText(value) {
  return Array.from(
    String(value).matchAll(/(?:[?&]|&amp;)event=(\d+)/gi),
    (match) => match[1]
  );
}

function extractCurrentSourceEventIds(html) {
  const explicit = [
    ...extractAttributeIds(html, "data-source-event-id"),
    ...extractAttributeIds(html, "data-current-event-id"),
    ...extractJsonIds(html, "sourceEventId"),
    ...extractJsonIds(html, "currentEventId"),
  ];
  for (const match of html.matchAll(
    /\b(?:sourceEventId|currentEventId)\s*=\s*["']?(\d+)["']?/g
  )) {
    explicit.push(match[1]);
  }
  for (const tag of html.match(/<[^>]+>/g) || []) {
    const isCanonical =
      /\brel=["'][^"']*\bcanonical\b[^"']*["']/i.test(tag);
    const isSelected =
      /\bselected\b/i.test(tag) ||
      /\baria-current=["'](?:page|true)["']/i.test(tag) ||
      /\bclass=["'][^"']*\b(?:current|active|selected)\b[^"']*["']/i.test(
        tag
      );
    const isEventInput =
      /^<input\b/i.test(tag) &&
      /\bname=["']event["']/i.test(tag);
    if (isCanonical || isSelected) {
      explicit.push(...eventIdsFromText(tag));
    }
    if (isEventInput) {
      const value = tag.match(/\bvalue=["'](\d+)["']/i);
      if (value) explicit.push(value[1]);
    }
  }
  const explicitIds = sortedUnique(explicit.filter(Boolean), numericSort);
  if (explicitIds.length > 0) return explicitIds;

  const linkedIds = sortedUnique(eventIdsFromText(html), numericSort);
  return linkedIds.includes(SOURCE_EVENT_ID)
    ? [SOURCE_EVENT_ID]
    : linkedIds;
}

function extractTypePairs(html) {
  const dedicated = [];
  for (const match of html.matchAll(
    /<span\b([^>]*)>([\s\S]*?)<\/span>/gi
  )) {
    const attributes = match[1];
    const elementId = attributeValue(attributes, "id");
    const typeMatch = elementId?.match(/^type(\d+)$/i);
    if (!typeMatch) continue;
    const dataId = attributeValue(attributes, "data-id");
    if (!dataId || !/^\d+$/.test(dataId)) {
      fail(`event6377 分类元素 ${elementId} 缺少合法 data-id`);
    }
    if (typeMatch[1] !== dataId) {
      fail(
        `event6377 分类元素 ID 不一致：${elementId} / data-id=${dataId}`
      );
    }
    const name = normalizeTypeName(match[2].replace(/<[^>]*>/g, ""));
    if (!name) fail(`event6377 分类元素 ${elementId} 缺少名称`);
    dedicated.push({ id: Number(dataId), name });
  }
  if (dedicated.length > 0) return dedicated;

  const output = [];
  const attributePattern =
    /\bdata-type-id=["'](\d+)["'][^>]*\bdata-type-name=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    output.push({ id: Number(match[1]), name: normalizeTypeName(match[2]) });
  }
  const reversedAttributePattern =
    /\bdata-type-name=["']([^"']+)["'][^>]*\bdata-type-id=["'](\d+)["']/gi;
  for (const match of html.matchAll(reversedAttributePattern)) {
    output.push({ id: Number(match[2]), name: normalizeTypeName(match[1]) });
  }
  const elementTextPattern =
    /<[^>]+\bdata-type-id=["'](\d+)["'][^>]*>([^<]+)<\/[^>]+>/gi;
  for (const match of html.matchAll(elementTextPattern)) {
    output.push({ id: Number(match[1]), name: normalizeTypeName(match[2]) });
  }
  const jsonPattern =
    /["']typeId["']\s*:\s*["']?(\d+)["']?\s*,\s*["'](?:typeName|name)["']\s*:\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(jsonPattern)) {
    output.push({ id: Number(match[1]), name: normalizeTypeName(match[2]) });
  }
  const genericJsonPattern =
    /["']id["']\s*:\s*["']?(\d+)["']?\s*,\s*["']typeName["']\s*:\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(genericJsonPattern)) {
    output.push({ id: Number(match[1]), name: normalizeTypeName(match[2]) });
  }
  return output;
}

export function parseAndValidateEventPage(html) {
  if (typeof html !== "string" || html.trim() === "") {
    fail("event6377 页面为空");
  }

  const embedded = parseEmbeddedManifest(html);
  const sourceEventIds = embedded
    ? [String(embedded.sourceEventId ?? "")]
    : extractCurrentSourceEventIds(html);
  const zEidDays = embedded ? [] : extractZEidDays(html);
  const days = embedded
    ? embedded.days
    : zEidDays.length > 0
      ? zEidDays
      : [
        ...extractAttributeIds(html, "data-day-id"),
        ...extractJsonIds(html, "dayId"),
        ...extractJsonIds(html, "eventID"),
        ...extractJsonIds(html, "eventId").filter(
          (value) => value !== SOURCE_EVENT_ID
        ),
        ];
  const types = embedded ? embedded.types : extractTypePairs(html);

  if (!Array.isArray(days) || !Array.isArray(types)) {
    fail("event6377 页面缺少活动日或分类定义");
  }

  const parsedEventIds = sortedUnique(
    sourceEventIds.map(String).filter(Boolean),
    numericSort
  );
  if (
    parsedEventIds.length !== 1 ||
    parsedEventIds[0] !== SOURCE_EVENT_ID
  ) {
    fail(
      `event6377 页面活动 ID 漂移：${parsedEventIds.join(",") || "未找到"}`
    );
  }

  const parsedDays = sortedUnique(days.map(String), numericSort);
  const expectedDays = [...EVENT_DAYS].sort(numericSort);
  if (JSON.stringify(parsedDays) !== JSON.stringify(expectedDays)) {
    fail(
      `event6377 活动日 ID 漂移：期望 ${expectedDays.join(",")}，实际 ${parsedDays.join(",") || "未找到"}`
    );
  }

  const typeMap = new Map();
  for (const type of types) {
    if (!isPlainObject(type)) fail("event6377 分类定义格式无效");
    const id = Number(type.id ?? type.typeId);
    const name = normalizeTypeName(type.name ?? type.typeName);
    if (!Number.isSafeInteger(id) || id <= 0 || !name) {
      fail("event6377 分类 ID 或名称无效");
    }
    if (OLD_TYPE_IDS.has(id)) {
      fail(`event6377 页面仍包含旧分类 ID ${id}`);
    }
    if (typeMap.has(id) && typeMap.get(id) !== name) {
      fail(`event6377 分类 ${id} 出现冲突名称`);
    }
    typeMap.set(id, name);
  }

  const actualTypeIds = [...typeMap.keys()].sort(numericSort);
  const expectedTypeIds = EVENT_TYPES.map((type) => type.id).sort(numericSort);
  if (JSON.stringify(actualTypeIds) !== JSON.stringify(expectedTypeIds)) {
    fail(
      `event6377 分类 ID 漂移：期望 ${expectedTypeIds.join(",")}，实际 ${actualTypeIds.join(",") || "未找到"}`
    );
  }
  for (const expected of EVENT_TYPES) {
    if (typeMap.get(expected.id) !== expected.name) {
      fail(
        `event6377 分类 ${expected.id} 名称漂移：期望 ${expected.name}，实际 ${typeMap.get(expected.id)}`
      );
    }
  }

  return {
    sourceEventId: SOURCE_EVENT_ID,
    days: [...EVENT_DAYS],
    types: EVENT_TYPES.map((type) => ({ ...type })),
  };
}

function validateManifestTask(taskKey, task) {
  if (!isPlainObject(task)) fail(`fixture 任务 ${taskKey} 定义无效`);
  if (typeof task.legalEmpty !== "boolean") {
    fail(`fixture 任务 ${taskKey} 必须声明 legalEmpty`);
  }
  if (!isPlainObject(task.orders)) {
    fail(`fixture 任务 ${taskKey} 必须声明 orders/pages`);
  }
  for (const [orderBy, pages] of Object.entries(task.orders)) {
    if (!["0", "1", "3"].includes(orderBy)) {
      fail(`fixture 任务 ${taskKey} 使用非法排序 ${orderBy}`);
    }
    if (
      !Array.isArray(pages) ||
      pages.length === 0 ||
      pages.some(
        (page, index) =>
          !Number.isSafeInteger(page) || page <= 0 || page !== index + 1
      )
    ) {
      fail(`fixture 任务 ${taskKey}/${orderBy} 页清单必须从 1 连续声明`);
    }
  }
  if (!Object.hasOwn(task.orders, "1")) {
    fail(`fixture 任务 ${taskKey} 缺少默认排序 1`);
  }
}

export function validateSourceFixture(fixture) {
  if (!isPlainObject(fixture) || !isPlainObject(fixture.manifest)) {
    fail("source fixture 缺少 manifest");
  }
  parseAndValidateEventPage(fixture.eventPageHtml);
  if (
    String(fixture.manifest.sourceEventId) !== SOURCE_EVENT_ID ||
    JSON.stringify(fixture.manifest.days) !== JSON.stringify(EVENT_DAYS) ||
    JSON.stringify(fixture.manifest.typeIds) !==
      JSON.stringify(EVENT_TYPES.map((type) => type.id))
  ) {
    fail("source fixture manifest 的 event/day/type 清单不匹配");
  }
  if (!isPlainObject(fixture.manifest.tasks)) {
    fail("source fixture manifest 缺少 tasks");
  }
  const actualTaskKeys = Object.keys(fixture.manifest.tasks).sort();
  const expectedTaskKeys = [...EXPECTED_TASK_KEYS].sort();
  if (JSON.stringify(actualTaskKeys) !== JSON.stringify(expectedTaskKeys)) {
    const missing = expectedTaskKeys.filter(
      (key) => !actualTaskKeys.includes(key)
    );
    const extra = actualTaskKeys.filter(
      (key) => !expectedTaskKeys.includes(key)
    );
    fail(
      `source fixture 必须恰好声明 32 个任务；missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`
    );
  }
  if (!isPlainObject(fixture.responses)) {
    fail("source fixture 缺少 responses");
  }

  const declaredResponseKeys = new Set();
  for (const taskKey of expectedTaskKeys) {
    const task = fixture.manifest.tasks[taskKey];
    validateManifestTask(taskKey, task);
    for (const [orderBy, pages] of Object.entries(task.orders)) {
      for (const pageIndex of pages) {
        const responseKey = `${taskKey}:${orderBy}:${pageIndex}`;
        declaredResponseKeys.add(responseKey);
        if (!Object.hasOwn(fixture.responses, responseKey)) {
          fail(`source fixture 缺少已声明页面 ${responseKey}`);
        }
      }
    }
    const firstResponse = fixture.responses[`${taskKey}:1:1`];
    const firstTotal = firstResponse?.result?.total;
    if (firstTotal === 0 && task.legalEmpty !== true) {
      fail(`source fixture 任务 ${taskKey} 为空但未声明 legalEmpty`);
    }
    if (
      Number.isSafeInteger(firstTotal) &&
      firstTotal >= 9500 &&
      (!Object.hasOwn(task.orders, "0") ||
        !Object.hasOwn(task.orders, "3"))
    ) {
      fail(`source fixture 高容量任务 ${taskKey} 缺少排序 0/3 页面`);
    }
  }
  for (const responseKey of Object.keys(fixture.responses)) {
    if (!declaredResponseKeys.has(responseKey)) {
      fail(`source fixture 含未声明页面 ${responseKey}`);
    }
  }
  return fixture;
}

export function createFixtureSourceTransport(fixture) {
  validateSourceFixture(fixture);
  return {
    async getEventPage() {
      return fixture.eventPageHtml;
    },
    async getSearchPage({ dayId, typeId, orderBy, pageIndex }) {
      const taskKey = `${dayId}:${typeId}`;
      const task = fixture.manifest.tasks[taskKey];
      const pages = task?.orders?.[String(orderBy)];
      if (!pages?.includes(pageIndex)) {
        fail(
          `source fixture 未声明请求页面 ${taskKey}:${orderBy}:${pageIndex}`
        );
      }
      return structuredClone(
        fixture.responses[`${taskKey}:${orderBy}:${pageIndex}`]
      );
    },
  };
}

export function validateDatabaseFixture(fixture) {
  if (
    !isPlainObject(fixture) ||
    !isPlainObject(fixture.manifest) ||
    !Array.isArray(fixture.rows)
  ) {
    fail("database fixture 必须包含 manifest 和 rows");
  }
  if (
    fixture.manifest.eventId !== DATABASE_EVENT_ID ||
    JSON.stringify(fixture.manifest.days) !== JSON.stringify(EVENT_DAYS)
  ) {
    fail("database fixture 的 event/day 清单不匹配");
  }
  return fixture;
}

export function createFixtureDatabaseTransport(fixture) {
  validateDatabaseFixture(fixture);
  return {
    async selectCppItemsPage({ offset, limit }) {
      return {
        rows: structuredClone(fixture.rows.slice(offset, offset + limit)),
        exactTotal: fixture.rows.length,
      };
    },
  };
}

export function parseExactContentRange(header, { offset, rowCount }) {
  if (typeof header !== "string" || header.trim() === "") {
    fail("Supabase SELECT 缺少 Content-Range");
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0
  ) {
    fail("Content-Range 校验参数无效");
  }
  const value = header.trim();
  const emptyMatch = value.match(/^\*\/(\d+)$/);
  if (emptyMatch) {
    const exactTotal = Number(emptyMatch[1]);
    if (!Number.isSafeInteger(exactTotal) || rowCount !== 0) {
      fail("Supabase SELECT Content-Range 与响应行数不一致");
    }
    return exactTotal;
  }
  const match = value.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (!match) {
    fail("Supabase SELECT Content-Range 格式无效或不是 exact count");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const exactTotal = Number(match[3]);
  if (
    ![start, end, exactTotal].every(Number.isSafeInteger) ||
    start !== offset ||
    end < start ||
    end - start + 1 !== rowCount ||
    exactTotal < end + 1
  ) {
    fail("Supabase SELECT Content-Range 与 offset/响应行数不一致");
  }
  return exactTotal;
}

function validateSearchEnvelope(value, { pageSize, label }) {
  if (!isPlainObject(value)) fail(`${label} 响应不是对象`);
  if (value.isSuccess !== true) fail(`${label} isSuccess 不为 true`);
  if (!isPlainObject(value.result)) fail(`${label} 缺少 result`);
  const { total, list } = value.result;
  if (!Number.isSafeInteger(total) || total < 0) {
    fail(`${label} total 不是非负安全整数`);
  }
  if (!Array.isArray(list)) fail(`${label} list 不是数组`);
  if (list.length > pageSize) {
    fail(`${label} list 长度 ${list.length} 超过 pageSize ${pageSize}`);
  }
  return { total, list };
}

function validateString(value, label) {
  if (typeof value !== "string") fail(`${label} 必须是字符串`);
  return value;
}

export function normalizeHotCount(value, label = "hotCount") {
  if (value == null || value === "") return 0;
  let number;
  if (typeof value === "number") {
    number = value;
  } else if (
    typeof value === "string" &&
    (value === "-1" || /^\d+$/.test(value))
  ) {
    number = Number(value);
  } else {
    fail(`${label} 无效`);
  }
  if (
    !Number.isSafeInteger(number) ||
    number < -1
  ) {
    fail(`${label} 无效`);
  }
  return number;
}

function normalizeSourceItem(item, dayId, type, label) {
  if (!isPlainObject(item)) fail(`${label} 条目不是对象`);
  if (!Number.isSafeInteger(item.doujinshiId) || item.doujinshiId <= 0) {
    fail(`${label} doujinshiId 无效`);
  }
  validateString(item.doujinshiName, `${label}.doujinshiName`);
  if (!Array.isArray(item.eventList) || item.eventList.length === 0) {
    fail(`${label}.eventList 缺失`);
  }
  const eventEntries = item.eventList.filter(
    (event) =>
      isPlainObject(event) && String(event.eventID ?? event.eventId) === dayId
  );
  if (eventEntries.length === 0) {
    fail(`${label} 不属于请求活动日 ${dayId}`);
  }
  if (eventEntries.length > 1) {
    fail(`${label} 在活动日 ${dayId} 出现重复 eventList 记录`);
  }
  const event = eventEntries[0];
  if (!Array.isArray(item.authorList)) {
    fail(`${label}.authorList 必须是数组`);
  }
  const author = item.authorList
    .map((entry, index) => {
      if (!isPlainObject(entry)) {
        fail(`${label}.authorList[${index}] 不是对象`);
      }
      const value = entry.authorName ?? String(entry.authorId ?? "");
      return validateString(value, `${label}.authorList[${index}].authorName`);
    })
    .filter(Boolean)
    .join(", ");
  const tags =
    item.tag == null || item.tag === ""
      ? []
      : validateString(item.tag, `${label}.tag`)
          .split("|")
          .map((tag) => tag.trim())
          .filter(Boolean);
  const hotCount = normalizeHotCount(item.hotCount, `${label}.hotCount`);
  const boothNumber = validateString(
    event.position ?? "",
    `${label}.event.position`
  );
  const boothName = validateString(
    event.circleName ?? "",
    `${label}.event.circleName`
  );
  const coverPicUrl = validateString(
    item.coverPicUrl ?? "",
    `${label}.coverPicUrl`
  );
  const sourceUrl = `https://www.allcpp.cn/d/${item.doujinshiId}.do`;
  return {
    event_id: DATABASE_EVENT_ID,
    day_id: dayId,
    type_id: type.id,
    type_name: type.name,
    doujinshi_id: item.doujinshiId,
    product_name: item.doujinshiName,
    author,
    booth_number: boothNumber,
    booth_name: boothName,
    image_url: coverPicUrl
      ? `https://imagecdn3.allcpp.cn/upload${coverPicUrl}`
      : "",
    tags,
    source_url: sourceUrl,
    hot_count: hotCount,
    original_work: validateString(
      item.themeAlias ?? "",
      `${label}.themeAlias`
    ),
  };
}

function rowKey(row) {
  return `${row.day_id}:${row.doujinshi_id}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  return String(value ?? "");
}

function fieldDifferences(left, right) {
  return COMPARED_FIELDS.filter(
    (field) => canonicalValue(left[field]) !== canonicalValue(right[field])
  );
}

function pairwiseSetDifferences(orderScans) {
  const output = [];
  for (let leftIndex = 0; leftIndex < orderScans.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < orderScans.length;
      rightIndex += 1
    ) {
      const left = orderScans[leftIndex];
      const right = orderScans[rightIndex];
      const leftSet = new Set(left.rows.map(rowKey));
      const rightSet = new Set(right.rows.map(rowKey));
      output.push({
        leftOrder: left.orderBy,
        rightOrder: right.orderBy,
        onlyLeftIds: [...leftSet]
          .filter((key) => !rightSet.has(key))
          .map((key) => Number(key.split(":")[1]))
          .sort(numericSort),
        onlyRightIds: [...rightSet]
          .filter((key) => !leftSet.has(key))
          .map((key) => Number(key.split(":")[1]))
          .sort(numericSort),
      });
    }
  }
  return output;
}

async function scanOrdering({
  sourceTransport,
  dayId,
  type,
  orderBy,
  pageSize,
  maxWindow,
}) {
  const rows = [];
  const pages = [];
  const seenIds = new Map();
  const duplicates = [];
  let frozenTotal = null;
  let pageIndex = 1;
  let sentinelSeen = false;
  let sentinelReportedTotal = null;
  let rawRows = 0;
  let effectivePageSize = null;

  while (true) {
    const label = `day=${dayId} type=${type.id} order=${orderBy} page=${pageIndex}`;
    const envelope = validateSearchEnvelope(
      await sourceTransport.getSearchPage({
        sourceEventId: SOURCE_EVENT_ID,
        dayId,
        typeId: type.id,
        orderBy,
        pageIndex,
        pageSize,
      }),
      { pageSize, label }
    );
    if (frozenTotal == null) frozenTotal = envelope.total;
    pages.push({
      pageIndex,
      total: envelope.total,
      rows: envelope.list.length,
    });

    if (envelope.list.length === 0) {
      const expectedVisible = Math.min(frozenTotal, maxWindow);
      if (rawRows !== expectedVisible) {
        fail(
          `${label} sentinel 覆盖不完整：已读 ${rawRows}，期望 ${expectedVisible}`
        );
      }
      if (envelope.total !== frozenTotal && envelope.total !== 0) {
        fail(
          `${label} sentinel total 漂移：冻结值 ${frozenTotal}，当前 ${envelope.total}`
        );
      }
      sentinelReportedTotal = envelope.total;
      sentinelSeen = true;
      break;
    }

    if (envelope.total !== frozenTotal) {
      fail(
        `${label} 非空页 total 漂移：冻结值 ${frozenTotal}，当前 ${envelope.total}`
      );
    }
    if (frozenTotal === 0) {
      fail(`${label} 非空页不能报告 total=0`);
    }

    if (effectivePageSize == null) {
      effectivePageSize = envelope.list.length;
    }
    const expectedVisible = Math.min(frozenTotal, maxWindow);
    const remaining = expectedVisible - rawRows;
    if (remaining <= 0) {
      fail(`${label} 返回条目超过冻结 total/window`);
    }
    const expectedRows = Math.min(effectivePageSize, remaining);
    if (envelope.list.length !== expectedRows) {
      if (envelope.list.length < expectedRows) {
        fail(
          `${label} 中间异常短页：有效页宽 ${effectivePageSize}，本页 ${envelope.list.length}，剩余 ${remaining}`
        );
      }
      fail(
        `${label} 页宽或末页行数异常：有效页宽 ${effectivePageSize}，本页 ${envelope.list.length}，期望 ${expectedRows}`
      );
    }

    const normalized = envelope.list.map((item, index) =>
      normalizeSourceItem(
        item,
        dayId,
        type,
        `${label}.list[${index}]`
      )
    );
    for (const row of normalized) {
      const previous = seenIds.get(row.doujinshi_id);
      if (previous) {
        duplicates.push({
          id: row.doujinshi_id,
          firstPage: previous.pageIndex,
          duplicatePage: pageIndex,
          changedFields: fieldDifferences(previous.row, row),
          boothCircles: sortedUnique([
            `${previous.row.booth_number}\u0000${previous.row.booth_name}`,
            `${row.booth_number}\u0000${row.booth_name}`,
          ]).map((pair) => {
            const [boothNumber, boothName] = pair.split("\u0000");
            return { boothNumber, boothName };
          }),
        });
      } else {
        seenIds.set(row.doujinshi_id, { pageIndex, row });
      }
      rows.push(row);
    }
    rawRows += envelope.list.length;
    if (rawRows > expectedVisible) {
      fail(`${label} 返回条目超过冻结 total/window`);
    }
    pageIndex += 1;
  }

  return {
    orderBy: String(orderBy),
    total: frozenTotal ?? 0,
    requestedPageSize: pageSize,
    effectivePageSize,
    rawRows,
    uniqueRows: seenIds.size,
    pages,
    sentinelSeen,
    sentinelReportedTotal,
    rows,
    crossPageDuplicates: duplicates,
  };
}

async function scanTask({
  sourceTransport,
  dayId,
  type,
  pageSize,
  capThreshold,
  maxWindow,
}) {
  const primary = await scanOrdering({
    sourceTransport,
    dayId,
    type,
    orderBy: "1",
    pageSize,
    maxWindow,
  });
  const capRisk = primary.total >= capThreshold;
  const orders = capRisk ? ["1", "0", "3"] : ["1"];
  const orderScans = [primary];
  for (const orderBy of orders.slice(1)) {
    orderScans.push(
      await scanOrdering({
        sourceTransport,
        dayId,
        type,
        orderBy,
        pageSize,
        maxWindow,
      })
    );
  }
  if (orderScans.some((scan) => scan.total !== primary.total)) {
    fail(`day=${dayId} type=${type.id} 不同排序的 total 不一致`);
  }

  const union = new Map();
  const orderConflicts = [];
  for (const scan of orderScans) {
    for (const row of scan.rows) {
      const key = rowKey(row);
      const previous = union.get(key);
      if (!previous) {
        union.set(key, row);
      } else {
        const changedFields = fieldDifferences(previous, row);
        if (changedFields.length > 0) {
          orderConflicts.push({
            id: row.doujinshi_id,
            changedFields,
          });
        }
      }
    }
  }

  const setDifferences = pairwiseSetDifferences(orderScans);
  const hasSetDifference = setDifferences.some(
    (difference) =>
      difference.onlyLeftIds.length > 0 ||
      difference.onlyRightIds.length > 0
  );
  const coverageComplete = union.size === primary.total;
  const orderingCoverageValid =
    primary.total > maxWindow ? coverageComplete : !hasSetDifference;
  const duplicateCount = orderScans.reduce(
    (sum, scan) => sum + scan.crossPageDuplicates.length,
    0
  );

  return {
    dayId,
    typeId: type.id,
    typeName: type.name,
    total: primary.total,
    requestedPageSize: pageSize,
    effectivePageSizes: Object.fromEntries(
      orderScans.map((scan) => [scan.orderBy, scan.effectivePageSize])
    ),
    sentinelReportedTotals: Object.fromEntries(
      orderScans.map((scan) => [scan.orderBy, scan.sentinelReportedTotal])
    ),
    capRisk,
    ordersScanned: orders,
    coverageComplete,
    orderingCoverageValid,
    orderSetDifferences: setDifferences,
    orderConflicts,
    crossPageDuplicates: orderScans.flatMap((scan) =>
      scan.crossPageDuplicates.map((duplicate) => ({
        orderBy: scan.orderBy,
        ...duplicate,
      }))
    ),
    pages: orderScans.map((scan) => ({
      orderBy: scan.orderBy,
      requestedPageSize: scan.requestedPageSize,
      effectivePageSize: scan.effectivePageSize,
      pages: scan.pages,
      sentinelSeen: scan.sentinelSeen,
      sentinelReportedTotal: scan.sentinelReportedTotal,
      rawRows: scan.rawRows,
      uniqueRows: scan.uniqueRows,
    })),
    sourceRows: [...union.values()],
    valid:
      coverageComplete &&
      orderingCoverageValid &&
      duplicateCount === 0 &&
      orderConflicts.length === 0,
  };
}

function validateDbRow(row, index) {
  const label = `database.rows[${index}]`;
  if (!isPlainObject(row)) fail(`${label} 不是对象`);
  if (row.event_id !== DATABASE_EVENT_ID) {
    fail(`${label}.event_id 不是 ${DATABASE_EVENT_ID}`);
  }
  const dayId = String(row.day_id);
  if (!EVENT_DAYS.includes(dayId)) fail(`${label}.day_id 无效`);
  const typeId = Number(row.type_id);
  if (!Number.isSafeInteger(typeId) || typeId <= 0) {
    fail(`${label}.type_id 无效`);
  }
  if (!Number.isSafeInteger(Number(row.doujinshi_id)) || Number(row.doujinshi_id) <= 0) {
    fail(`${label}.doujinshi_id 无效`);
  }
  const typeName = validateString(row.type_name ?? "", `${label}.type_name`);
  return {
    event_id: DATABASE_EVENT_ID,
    day_id: dayId,
    type_id: typeId,
    type_name: typeName,
    doujinshi_id: Number(row.doujinshi_id),
    product_name: validateString(row.product_name ?? "", `${label}.product_name`),
    author: validateString(row.author ?? "", `${label}.author`),
    booth_number: validateString(row.booth_number ?? "", `${label}.booth_number`),
    booth_name: validateString(row.booth_name ?? "", `${label}.booth_name`),
    image_url: validateString(row.image_url ?? "", `${label}.image_url`),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    source_url: validateString(row.source_url ?? "", `${label}.source_url`),
    hot_count: normalizeHotCount(row.hot_count, `${label}.hot_count`),
    original_work: validateString(row.original_work ?? "", `${label}.original_work`),
  };
}

function databaseTypeNameMismatches(rows) {
  return rows
    .flatMap((row) => {
      const expected = EVENT_TYPES.find(
        (type) => type.id === row.type_id
      );
      if (expected && row.type_name === expected.name) return [];
      return [{
        dayId: row.day_id,
        id: row.doujinshi_id,
        typeId: row.type_id,
        expectedName: expected?.name ?? null,
        actualName: row.type_name,
      }];
    })
    .sort(
      (left, right) =>
        numericSort(left.dayId, right.dayId) ||
        left.id - right.id ||
        left.typeId - right.typeId
    );
}

async function readDatabase({ databaseTransport, pageSize }) {
  const rows = [];
  let offset = 0;
  let page = 0;
  let frozenTotal = null;
  while (true) {
    const result = await databaseTransport.selectCppItemsPage({
      eventId: DATABASE_EVENT_ID,
      dayIds: [...EVENT_DAYS],
      offset,
      limit: pageSize,
      columns: [
        "event_id",
        "day_id",
        "type_id",
        "type_name",
        "doujinshi_id",
        ...COMPARED_FIELDS.filter(
          (field) => !["type_id", "type_name"].includes(field)
        ),
      ],
    });
    if (
      !isPlainObject(result) ||
      !Array.isArray(result.rows) ||
      !Number.isSafeInteger(result.exactTotal) ||
      result.exactTotal < 0
    ) {
      fail(
        `database SELECT page ${page + 1} 必须返回 rows + exactTotal`
      );
    }
    if (frozenTotal == null) frozenTotal = result.exactTotal;
    if (result.exactTotal !== frozenTotal) {
      fail(
        `database SELECT total 漂移：首值 ${frozenTotal}，当前 ${result.exactTotal}`
      );
    }
    const chunk = result.rows;
    if (chunk.length > pageSize) {
      fail(`database SELECT page ${page + 1} 超过分页大小`);
    }
    if (offset + chunk.length > frozenTotal) {
      fail(`database SELECT page ${page + 1} 返回行数超过 exact total`);
    }
    if (chunk.length === 0 && offset < frozenTotal) {
      fail(
        `database SELECT page ${page + 1} 无进展：offset ${offset} 尚未覆盖 exact total ${frozenTotal}`
      );
    }
    rows.push(
      ...chunk.map((row, index) => validateDbRow(row, offset + index))
    );
    page += 1;
    offset += chunk.length;
    if (offset >= frozenTotal) break;
  }
  return { rows, pages: page, exactTotal: frozenTotal ?? 0 };
}

function duplicateSummary(rows, scope) {
  const occurrences = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    if (!occurrences.has(key)) occurrences.set(key, []);
    occurrences.get(key).push(row);
  }
  return [...occurrences.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([key, values]) => ({
      scope,
      dayId: key.split(":")[0],
      id: Number(key.split(":")[1]),
      occurrences: values.map((row) => ({
        typeId: row.type_id,
        boothNumber: row.booth_number,
        boothName: row.booth_name,
      })),
    }))
    .sort((a, b) => a.id - b.id);
}

function boothCircleConflicts(rows, scope) {
  return duplicateSummary(rows, scope)
    .map((duplicate) => {
      const pairs = sortedUnique(
        duplicate.occurrences.map(
          (item) => `${item.boothNumber}\u0000${item.boothName}`
        )
      );
      if (pairs.length <= 1) return null;
      return {
        ...duplicate,
        boothCircles: pairs.map((pair) => {
          const [boothNumber, boothName] = pair.split("\u0000");
          return { boothNumber, boothName };
        }),
      };
    })
    .filter(Boolean);
}

function indexUnique(rows) {
  const output = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    if (!output.has(key)) output.set(key, row);
  }
  return output;
}

function compareDay(dayId, sourceRows, databaseRows) {
  const source = indexUnique(
    sourceRows.filter((row) => row.day_id === dayId)
  );
  const database = indexUnique(
    databaseRows.filter((row) => row.day_id === dayId)
  );
  const missingIds = [...source.keys()]
    .filter((key) => !database.has(key))
    .map((key) => Number(key.split(":")[1]))
    .sort(numericSort);
  const extraIds = [...database.keys()]
    .filter((key) => !source.has(key))
    .map((key) => Number(key.split(":")[1]))
    .sort(numericSort);
  const changed = [];
  const misclassified = [];
  for (const [key, sourceRow] of source) {
    const databaseRow = database.get(key);
    if (!databaseRow) continue;
    const changedFields = fieldDifferences(sourceRow, databaseRow);
    if (changedFields.length > 0) {
      changed.push({
        id: sourceRow.doujinshi_id,
        fields: changedFields,
      });
    }
    if (
      sourceRow.type_id !== databaseRow.type_id ||
      sourceRow.type_name !== databaseRow.type_name
    ) {
      misclassified.push({
        id: sourceRow.doujinshi_id,
        sourceTypeId: sourceRow.type_id,
        sourceTypeName: sourceRow.type_name,
        databaseTypeId: databaseRow.type_id,
        databaseTypeName: databaseRow.type_name,
      });
    }
  }
  return {
    dayId,
    sourceUnique: source.size,
    dbUnique: database.size,
    databaseUnique: database.size,
    missingIds,
    extraIds,
    changedIds: changed.map((item) => item.id),
    changed,
    misclassifiedIds: misclassified.map((item) => item.id),
    misclassified,
    valid:
      missingIds.length === 0 &&
      extraIds.length === 0 &&
      changed.length === 0 &&
      misclassified.length === 0,
  };
}

export async function runEvent6377Audit({
  sourceTransport,
  databaseTransport,
  pageSize = 100,
  databasePageSize = 1000,
  capThreshold = 9500,
  maxWindow = 10000,
  now = () => new Date(),
  onTaskComplete = () => {},
} = {}) {
  if (!sourceTransport || !databaseTransport) {
    fail("sourceTransport 和 databaseTransport 均为必填");
  }
  for (const [name, value] of [
    ["pageSize", pageSize],
    ["databasePageSize", databasePageSize],
    ["capThreshold", capThreshold],
    ["maxWindow", maxWindow],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} 必须为正整数`);
  }
  const startedAt = now().toISOString();
  const eventDefinition = parseAndValidateEventPage(
    await sourceTransport.getEventPage({
      sourceEventId: SOURCE_EVENT_ID,
    })
  );

  const tasks = [];
  for (const dayId of EVENT_DAYS) {
    for (const type of EVENT_TYPES) {
      const task = await scanTask({
          sourceTransport,
          dayId,
          type,
          pageSize,
          capThreshold,
          maxWindow,
        });
      tasks.push(task);
      onTaskComplete({
        dayId: task.dayId,
        typeId: task.typeId,
        typeName: task.typeName,
        total: task.total,
        valid: task.valid,
        capRisk: task.capRisk,
      });
    }
  }

  const sourceRows = tasks.flatMap((task) => task.sourceRows);
  const database = await readDatabase({
    databaseTransport,
    pageSize: databasePageSize,
  });
  const crossTypeDuplicates = duplicateSummary(sourceRows, "source").filter(
    (duplicate) =>
      new Set(duplicate.occurrences.map((item) => item.typeId)).size > 1
  );
  const databaseDuplicates = duplicateSummary(database.rows, "database");
  const typeNameMismatches = databaseTypeNameMismatches(database.rows);
  const multiBoothCircleConflicts = [
    ...tasks.flatMap((task) =>
      task.crossPageDuplicates
        .filter((duplicate) => duplicate.boothCircles.length > 1)
        .map((duplicate) => ({
          scope: "source-cross-page",
          dayId: task.dayId,
          typeId: task.typeId,
          id: duplicate.id,
          boothCircles: duplicate.boothCircles,
        }))
    ),
    ...boothCircleConflicts(sourceRows, "source"),
    ...boothCircleConflicts(database.rows, "database"),
  ];
  const days = EVENT_DAYS.map((dayId) =>
    compareDay(dayId, sourceRows, database.rows)
  );
  const invalidTasks = tasks
    .filter((task) => !task.valid)
    .map((task) => `${task.dayId}:${task.typeId}`);
  const valid =
    invalidTasks.length === 0 &&
    days.every((day) => day.valid) &&
    crossTypeDuplicates.length === 0 &&
    databaseDuplicates.length === 0 &&
    typeNameMismatches.length === 0 &&
    multiBoothCircleConflicts.length === 0;
  const report = {
    schemaVersion: 1,
    scanner: "event6377-read-only-audit",
    sourceEventId: SOURCE_EVENT_ID,
    databaseEventId: DATABASE_EVENT_ID,
    readOnly: true,
    dbWritesAttempted: 0,
    startedAt,
    finishedAt: now().toISOString(),
    status: valid ? "ok" : "invalid",
    valid,
    eventDefinition,
    totals: {
      tasks: tasks.length,
      invalidTasks: invalidTasks.length,
      sourceUnique: indexUnique(sourceRows).size,
      databaseUnique: indexUnique(database.rows).size,
      databaseExactTotal: database.exactTotal,
      databasePages: database.pages,
      databaseTypeNameMismatches: typeNameMismatches.length,
      capRiskTasks: tasks.filter((task) => task.capRisk).length,
    },
    invalidTaskKeys: invalidTasks,
    tasks: tasks.map(({ sourceRows, ...task }) => ({
      ...task,
      sourceKeys: sourceRows
        .map((row) => ({
          dayId: row.day_id,
          typeId: row.type_id,
          id: row.doujinshi_id,
        }))
        .sort((left, right) => left.id - right.id),
    })),
    days,
    crossPageDuplicates: tasks.flatMap((task) =>
      task.crossPageDuplicates.map((duplicate) => ({
        dayId: task.dayId,
        typeId: task.typeId,
        ...duplicate,
      }))
    ),
    crossTypeDuplicates,
    databaseDuplicates,
    databaseTypeNameMismatches: typeNameMismatches,
    multiBoothCircleConflicts,
  };
  return report;
}
