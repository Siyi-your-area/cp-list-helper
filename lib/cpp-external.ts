import fs from "node:fs";
import path from "node:path";
import {
  createMatchAliases,
  normalizeMatchText,
  splitBoothNumber,
} from "./cpp-matcher.ts";
import type {
  MatchInput,
  MatchResult,
  NormalizedCPPItem,
} from "./types";

const CPP_ORIGIN = "https://www.allcpp.cn";
const COOKIE_MAX_LENGTH = 32_768;
const CACHE_TTL_MS = 30 * 60 * 1000;
const DETAIL_TIMEOUT_MS = 5_000;

interface CachedValue<T> {
  value: T;
  storedAt: number;
}

export interface CPPDetailFields {
  hotCount?: number;
  originalWork?: string;
  exchangeType?: string;
  description?: string;
}

interface ScoredExternalCandidate {
  item: NormalizedCPPItem;
  score: number;
  nameScore: number;
  eventScore: number;
  boothScore: number;
  authorCircleScore: number;
  exactCoreName: boolean;
}

const searchCache = new Map<string, CachedValue<NormalizedCPPItem[]>>();
const detailCache = new Map<number, CachedValue<CPPDetailFields | null>>();

function sanitizeCookieHeader(value: string): string {
  const cookie = value.trim().replace(/^cookie\s*:\s*/i, "");
  if (
    !cookie ||
    cookie.length > COOKIE_MAX_LENGTH ||
    /[\r\n]/.test(cookie)
  ) {
    return "";
  }

  const parts = cookie.split(";").map((part) => part.trim()).filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return true;
      const name = part.slice(0, separator).trim();
      return !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
    })
  ) {
    return "";
  }

  return parts.join("; ");
}

/**
 * 从 Chrome 的 Copy as cURL (bash) 文本中只提取 Cookie。
 * 不执行 cURL，也不返回 URL、请求头或响应内容。
 */
export function extractCookieHeaderFromCurl(raw: string): string {
  const urlMatch = raw.match(/curl\s+'(https:\/\/[^']+)'/);
  if (!urlMatch) return "";

  try {
    const url = new URL(urlMatch[1]);
    if (url.protocol !== "https:" || url.hostname !== "www.allcpp.cn") {
      return "";
    }
  } catch {
    return "";
  }

  const cookieArgument = raw.match(/(?:-b|--cookie)\s+'([^']*)'/);
  if (cookieArgument) return sanitizeCookieHeader(cookieArgument[1]);

  for (const match of raw.matchAll(/(?:-H|--header)\s+'([^']*)'/g)) {
    const separator = match[1].indexOf(":");
    if (separator <= 0) continue;
    if (match[1].slice(0, separator).trim().toLowerCase() !== "cookie") {
      continue;
    }
    return sanitizeCookieHeader(match[1].slice(separator + 1));
  }

  return "";
}

export function cookieHeaderFromJson(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "cookies" in value &&
    Array.isArray((value as { cookies?: unknown }).cookies)
  ) {
    return cookieHeaderFromJson((value as { cookies: unknown[] }).cookies);
  }

  if (Array.isArray(value)) {
    return sanitizeCookieHeader(
      value
        .filter(
          (cookie): cookie is { name: string; value: string } =>
            Boolean(
              cookie &&
              typeof cookie === "object" &&
              typeof cookie.name === "string" &&
              typeof cookie.value === "string"
            )
        )
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ")
    );
  }

  if (value && typeof value === "object") {
    return sanitizeCookieHeader(
      Object.entries(value)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, cookieValue]) => `${name}=${cookieValue}`)
        .join("; ")
    );
  }

  return "";
}

/**
 * 生产环境优先使用 Cloudflare/进程 Secret：CPP_COOKIE。
 * 本地开发才会继续尝试 Git 忽略的请求文件或 Cookie JSON。
 */
export function getCPPCookieHeader(): string {
  const environmentCookie = sanitizeCookieHeader(process.env.CPP_COOKIE || "");
  if (environmentCookie) return environmentCookie;

  const localFiles = [
    {
      name: "cpp-search-request.txt",
      parse: extractCookieHeaderFromCurl,
    },
    {
      name: "cpp-cookies.json",
      parse: (raw: string) => cookieHeaderFromJson(JSON.parse(raw)),
    },
  ];

  for (const localFile of localFiles) {
    try {
      const raw = fs.readFileSync(
        path.join(process.cwd(), localFile.name),
        "utf8"
      );
      const cookie = localFile.parse(raw);
      if (cookie) return cookie;
    } catch {
      // 本地文件不存在、格式不合法或运行环境没有文件系统时安全跳过。
    }
  }

  return "";
}

export function extractCoreProductName(productName: string): string {
  if (!productName) return "";
  const cleaned = productName
    .replace(/^(?:\s*[【\[][^\]】]+[\]】]\s*)+/, "")
    .replace(/^(?:cp|comicup)\s*\d+(?:pre)?/i, "")
    .replace(/(?:cp|comicup)\s*\d+(?:pre)?/gi, "")
    .replace(/新刊|首发|场贩|通贩|二刷/g, "")
    .replace(/^[\s·|｜:：\-—]+|[\s·|｜:：\-—]+$/g, "")
    .trim();

  if (cleaned) return cleaned;
  return (
    createMatchAliases(productName)
      .sort((left, right) => right.length - left.length)[0] || ""
  );
}

export function isCPPExternalFallbackEligible(input: MatchInput): boolean {
  return Boolean(
    input.boothNumber?.trim() &&
    input.productName?.trim()
  );
}

function textSimilarity(left: string, right: string): number {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  if (a.length === 1 || b.length === 1) return 0;

  const pairs = (value: string) => {
    const output = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const pair = value.slice(index, index + 2);
      output.set(pair, (output.get(pair) || 0) + 1);
    }
    return output;
  };

  const leftPairs = pairs(a);
  const rightPairs = pairs(b);
  let overlap = 0;
  for (const [pair, count] of leftPairs) {
    overlap += Math.min(count, rightPairs.get(pair) || 0);
  }
  return (2 * overlap) / ((a.length - 1) + (b.length - 1));
}

function maxBoothSimilarity(left: string, right: string): number {
  if (!left.trim() || !right.trim()) return 0;
  const leftParts = [left, ...splitBoothNumber(left)];
  const rightParts = [right, ...splitBoothNumber(right)];
  let best = 0;
  for (const leftPart of leftParts) {
    for (const rightPart of rightParts) {
      best = Math.max(best, textSimilarity(leftPart, rightPart));
    }
  }
  return best;
}

function scoreExternalCandidate(
  input: MatchInput,
  item: NormalizedCPPItem,
  targetDayIds: string[]
): ScoredExternalCandidate {
  const inputCoreName = extractCoreProductName(input.productName);
  const itemCoreName = extractCoreProductName(item.productName);
  const exactCoreName =
    Boolean(normalizeMatchText(inputCoreName)) &&
    normalizeMatchText(inputCoreName) === normalizeMatchText(itemCoreName);
  const nameScore = exactCoreName
    ? 1
    : textSimilarity(inputCoreName, itemCoreName);
  const eventScore =
    targetDayIds.length === 0 ||
    Boolean(item.dayId && targetDayIds.includes(String(item.dayId)))
      ? 1
      : 0;
  const boothScore = maxBoothSimilarity(
    input.boothNumber || "",
    item.boothNumber || ""
  );
  const authorCircleScore = input.author
    ? Math.max(
        textSimilarity(input.author, item.author || ""),
        textSimilarity(input.author, item.boothName || "")
      )
    : 0;

  return {
    item,
    score:
      nameScore * 0.8 +
      eventScore * 0.1 +
      boothScore * 0.05 +
      authorCircleScore * 0.05,
    nameScore,
    eventScore,
    boothScore,
    authorCircleScore,
    exactCoreName,
  };
}

function externalReason(
  candidate: ScoredExternalCandidate,
  suffix?: string
): string {
  const percentage = (value: number) => `${Math.round(value * 100)}%`;
  return [
    `外部组合评分 ${percentage(candidate.score)}`,
    `名称 ${percentage(candidate.nameScore)}（权重 80%）`,
    `活动 ${percentage(candidate.eventScore)}（权重 10%）`,
    `摊位 ${percentage(candidate.boothScore)}（权重 5%）`,
    `作者/社团 ${percentage(candidate.authorCircleScore)}（权重 5%）`,
    suffix,
  ].filter(Boolean).join("；");
}

/**
 * 外部搜索只在数据库未接受时使用。
 * 核心名称完全一致必须是目标活动中的唯一制品 ID 才能自动通过。
 */
export function matchCPPExternalCandidates(
  input: MatchInput,
  candidates: NormalizedCPPItem[],
  targetDayIds: string[]
): MatchResult {
  if (!isCPPExternalFallbackEligible(input)) {
    return {
      matched: false,
      decision: "unmatched",
      confidence: "none",
      source: "external-api",
      reason: "摊位号或制品名称为空，不执行 CPP 外部兜底",
    };
  }

  if (candidates.length === 0) {
    return {
      matched: false,
      decision: "unmatched",
      confidence: "none",
      source: "external-api",
      reason: "CPP 外部搜索未返回候选",
    };
  }

  const scored = candidates
    .map((candidate) => scoreExternalCandidate(input, candidate, targetDayIds))
    .filter((candidate) => candidate.eventScore === 1)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return {
      matched: false,
      decision: "unmatched",
      confidence: "none",
      source: "external-api",
      reason: "CPP 外部候选不属于目标活动",
    };
  }

  const exactCandidates = scored.filter((candidate) => candidate.exactCoreName);
  const exactIds = new Set(
    exactCandidates.map((candidate) => candidate.item.doujinshiId)
  );
  const best = exactCandidates[0] || scored[0];
  const boothConsistent = best.boothScore >= 0.95;
  const exactUnique =
    best.exactCoreName &&
    exactIds.size === 1 &&
    boothConsistent;
  const nextDifferent = scored.find(
    (candidate) =>
      candidate.item.doujinshiId !== best.item.doujinshiId
  );
  const margin = nextDifferent ? best.score - nextDifferent.score : 1;

  if (exactUnique) {
    return {
      matched: true,
      decision: "accepted",
      confidence: "exact",
      cppItem: best.item,
      score: Math.round(best.score * 1000) / 1000,
      source: "external-api",
      reason: externalReason(best, "目标活动内核心名称唯一且完全一致"),
    };
  }

  if (
    !best.exactCoreName &&
    best.nameScore >= 0.95 &&
    best.score >= 0.9 &&
    margin >= 0.05
  ) {
    return {
      matched: true,
      decision: "accepted",
      confidence: "high",
      cppItem: best.item,
      score: Math.round(best.score * 1000) / 1000,
      source: "external-api",
      reason: externalReason(best, "高相似且候选不歧义"),
    };
  }

  if (best.nameScore < 0.55) {
    return {
      matched: false,
      decision: "unmatched",
      confidence: "none",
      source: "external-api",
      reason: externalReason(best, "名称相似度不足，不提供候选"),
    };
  }

  return {
    matched: false,
    decision: "review",
    confidence: best.score >= 0.72 ? "medium" : "low",
    candidate: best.item,
    score: Math.round(best.score * 1000) / 1000,
    source: "external-api",
    requiresReview: true,
    reason: externalReason(
      best,
      exactIds.size > 1
        ? "目标活动内存在同名制品，需人工确认"
        : best.exactCoreName && !boothConsistent
          ? "名称完全一致但摊位冲突，需人工确认"
        : "置信度不足，需人工确认"
    ),
  };
}

function normalizeImageUrl(value: string): string {
  if (!value) return "";
  if (/^https:\/\//i.test(value)) return value;
  const normalizedPath = value.startsWith("/") ? value : `/${value}`;
  return `https://imagecdn3.allcpp.cn/upload${normalizedPath}`;
}

function normalizeExternalSearchItems(
  json: any,
  dayId: string
): NormalizedCPPItem[] {
  if (!json?.isSuccess || !Array.isArray(json.result?.list)) return [];

  const output: NormalizedCPPItem[] = [];
  for (const item of json.result.list) {
    for (const event of Array.isArray(item.eventList) ? item.eventList : []) {
      if (String(event.eventID) !== String(dayId)) continue;
      output.push({
        boothNumber: event.position || event.positionName || "",
        boothName: event.circleName || item.circleName || "",
        productName: item.doujinshiName || "",
        author: (Array.isArray(item.authorList) ? item.authorList : [])
          .map((author: any) => author.authorName || "")
          .filter(Boolean)
          .join(", "),
        imageUrl: normalizeImageUrl(item.coverPicUrl || ""),
        tags: typeof item.tag === "string"
          ? item.tag.split("|").map((tag: string) => tag.trim()).filter(Boolean)
          : [],
        eventName: event.eventName || "",
        dayId: String(dayId),
        sourceUrl: `${CPP_ORIGIN}/d/${Number(item.doujinshiId) || 0}.do`,
        doujinshiId: Number(item.doujinshiId) || 0,
        hotCount: Number(item.hotCount) || 0,
        originalWork: item.themeAlias || "",
      });
    }
  }
  return output.filter((item) => item.doujinshiId > 0);
}

function remainingTimeout(deadline: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.floor(deadline - performance.now())));
}

export async function searchCPPExternal(
  keyword: string,
  dayIds: string[],
  cookie: string,
  deadline: number,
  timeoutMs = DETAIL_TIMEOUT_MS
): Promise<NormalizedCPPItem[]> {
  const cleanKeyword = keyword.trim();
  if (!cleanKeyword || !cookie || performance.now() >= deadline) return [];
  const cacheKey = `${dayIds.join(",")}|${normalizeMatchText(cleanKeyword)}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const pages = await Promise.all(
    dayIds.map(async (dayId) => {
      if (performance.now() >= deadline) return [];
      const params = new URLSearchParams({
        eventId: dayId,
        keyword: cleanKeyword,
        orderBy: "1",
        typeIds: "",
        pageIndex: "1",
        pageSize: "30",
        sellStatus: "",
        ideaType: "",
        tag: "",
        ideaStatus: "",
      });

      try {
        const response = await fetch(
          `${CPP_ORIGIN}/api/doujinshi/search.do?${params}`,
          {
            redirect: "manual",
            signal: AbortSignal.timeout(remainingTimeout(deadline, timeoutMs)),
            headers: {
              "User-Agent": "Mozilla/5.0",
              Accept: "application/json, text/plain, */*",
              Origin: "https://cp.allcpp.cn",
              Referer: "https://cp.allcpp.cn/",
              Cookie: cookie,
            },
          }
        );
        if (!response.ok) return [];
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) return [];
        return normalizeExternalSearchItems(await response.json(), dayId);
      } catch {
        return [];
      }
    })
  );

  const seen = new Set<string>();
  const items = pages.flat().filter((item) => {
    const key = `${item.dayId}|${item.doujinshiId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  searchCache.set(cacheKey, { value: items, storedAt: Date.now() });
  return items;
}

function decodeHTMLText(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#")) {
        const radix = entity.startsWith("#x") ? 16 : 10;
        const offset = entity.startsWith("#x") ? 2 : 1;
        const codePoint = Number.parseInt(entity.slice(offset), radix);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : "";
      }
      return namedEntities[entity.toLowerCase()] ?? "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCPPDetailHTML(html: string): CPPDetailFields {
  const detail: CPPDetailFields = {};
  const hotMatch = html.match(
    /class="djs-info-hot"[^>]*>[\s\S]*?<span>(\d+)<\/span>/
  );
  if (hotMatch) detail.hotCount = Number(hotMatch[1]);

  for (const match of html.matchAll(/([一-龥]{2,4})[：:]\s*([^<"\n]+)/g)) {
    const key = match[1].trim();
    const value = decodeHTMLText(match[2]);
    if (key === "原作" && value) detail.originalWork = value;
    if (key === "交换" && value) detail.exchangeType = value;
  }

  const descriptionMatch = html.match(
    /class="djs-tab-box info textEllipsis"[^>]*>([\s\S]*?)<\/div>/
  );
  if (descriptionMatch) {
    const description = decodeHTMLText(descriptionMatch[1]);
    if (description) detail.description = description;
  }

  return detail;
}

export async function fetchCPPExternalDetail(
  doujinshiId: number,
  cookie: string,
  deadline: number
): Promise<CPPDetailFields | null> {
  if (
    !Number.isInteger(doujinshiId) ||
    doujinshiId <= 0 ||
    !cookie ||
    performance.now() >= deadline
  ) {
    return null;
  }

  const cached = detailCache.get(doujinshiId);
  if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const response = await fetch(`${CPP_ORIGIN}/d/${doujinshiId}.do`, {
      redirect: "manual",
      signal: AbortSignal.timeout(
        remainingTimeout(deadline, DETAIL_TIMEOUT_MS)
      ),
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html,application/xhtml+xml",
        Referer: "https://cp.allcpp.cn/",
        Cookie: cookie,
      },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;
    const html = await response.text();
    if (!html.includes("djs-info") || /#\/login\/main/.test(html)) {
      return null;
    }

    const detail = parseCPPDetailHTML(html);
    detailCache.set(doujinshiId, {
      value: detail,
      storedAt: Date.now(),
    });
    return detail;
  } catch {
    detailCache.set(doujinshiId, {
      value: null,
      storedAt: Date.now(),
    });
    return null;
  }
}

export function enrichCPPItemWithDetail(
  item: NormalizedCPPItem,
  detail: CPPDetailFields | null
): NormalizedCPPItem {
  if (!detail) return item;
  return {
    ...item,
    hotCount: detail.hotCount ?? item.hotCount,
    originalWork: detail.originalWork || item.originalWork,
    exchangeType: detail.exchangeType || item.exchangeType,
    description: detail.description || item.description,
  };
}
