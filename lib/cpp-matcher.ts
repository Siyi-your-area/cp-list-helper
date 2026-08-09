/**
 * CPP 两阶段匹配中的本地评分引擎。
 *
 * 自动接受仅限 exact/high；medium/low 只作为人工确认候选返回，
 * 防止用激进模糊匹配换取表面命中率。
 */

import type {
  MatchConfidence,
  MatchInput,
  MatchResult,
  MatchSource,
  NormalizedCPPItem,
} from "./types";

export function normalizeMatchText(value: string): string {
  if (!value) return "";
  return value
    .normalize("NFKC")
    .replace(/[\s\u00a0]+/g, "")
    .replace(/[·•・—–－_\-~～,，。.!！?？:：;；'"“”‘’()[\]（）【】{}《》「」『』]/g, "")
    .toLowerCase();
}

export function createMatchAliases(value: string): string[] {
  if (!value) return [];
  const aliases = new Set<string>();
  const add = (candidate: string) => {
    const normalized = normalizeMatchText(candidate);
    if (normalized.length >= 2) aliases.add(normalized);
  };

  const removeLeadingLabels = (candidate: string) => {
    let result = candidate.trim();
    for (let index = 0; index < 4; index += 1) {
      const next = result
        .replace(/^\s*(?:【[^】]+】|\[[^\]]+\]|（[^）]+）|\([^)]+\))\s*/u, "")
        .trim();
      if (next === result) break;
      result = next;
    }
    return result;
  };
  const removeMarketingWords = (candidate: string) => candidate
    .replace(/(?:cp|comicup)\s*\d+(?:pre)?/gi, "")
    .replace(/新刊|首发|场贩|通贩/g, "")
    .trim();

  add(value);
  // 《书名》和「标题」通常是作品名；【图奈】【帝限】等方括号前缀更常见于
  // 题材或属性标签，不能单独作为“名称完全一致”的依据。
  for (const match of value.matchAll(/[《「『]([^》」』]+)[》」』]/g)) {
    add(match[1]);
  }
  const withoutLeadingLabels = removeLeadingLabels(value);
  add(withoutLeadingLabels);
  add(removeMarketingWords(value));
  add(removeMarketingWords(withoutLeadingLabels));
  return Array.from(aliases);
}

export function splitBoothNumber(boothNumber: string): string[] {
  if (!boothNumber) return [];
  return boothNumber.match(/[一-鿿]+[A-Z]?\d+/g) || [boothNumber];
}

function charSimilarity(left: string, right: string): number {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }

  const pairs = (value: string) => {
    const output = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const pair = value.slice(index, index + 2);
      output.set(pair, (output.get(pair) || 0) + 1);
    }
    return output;
  };
  if (a.length === 1 || b.length === 1) return a === b ? 1 : 0;

  const leftPairs = pairs(a);
  const rightPairs = pairs(b);
  let overlap = 0;
  for (const [pair, count] of leftPairs) {
    overlap += Math.min(count, rightPairs.get(pair) || 0);
  }
  return (2 * overlap) / ((a.length - 1) + (b.length - 1));
}

function maxAliasSimilarity(left: string[], right: string[]): number {
  let best = 0;
  for (const a of left) {
    for (const b of right) {
      best = Math.max(best, charSimilarity(a, b));
    }
  }
  return best;
}

/**
 * CPG 空摊位安全匹配：只接受完整标准化名称精确相等，不复用模糊评分阈值。
 * 只有完整制品名与输入社团名同时精确相等，且候选唯一时才接受。
 */
export function matchEmptyBoothByExactProductAndCircle(
  input: MatchInput,
  candidates: NormalizedCPPItem[],
  source: MatchSource = "database-search"
): MatchResult {
  if (normalizeMatchText(input.boothNumber)) {
    return {
      matched: false,
      decision: "unmatched",
      confidence: "none",
      source,
      reason: "空摊位精确名称匹配仅处理未填写摊位号的条目",
    };
  }

  const normalizedProduct = normalizeMatchText(input.productName);
  if (!normalizedProduct) {
    return {
      matched: false,
      decision: "unmatched",
      confidence: "none",
      source,
      reason: "制品名称为空，无法执行空摊位精确匹配",
    };
  }

  const exactById = new Map<number, NormalizedCPPItem>();
  for (const candidate of candidates) {
    if (
      !normalizeMatchText(candidate.boothNumber) &&
      normalizeMatchText(candidate.productName) === normalizedProduct
    ) {
      exactById.set(candidate.doujinshiId, candidate);
    }
  }
  const exactCandidates = Array.from(exactById.values());
  if (exactCandidates.length === 0) {
    return {
      matched: false,
      decision: "unmatched",
      confidence: "none",
      source,
      reason: "数据库中没有完整标准化名称相同的 CPG 制品",
    };
  }

  // 新客户端将社团与作者分开；author 回退只兼容尚未升级的 CPG 客户端。
  const normalizedCircle = normalizeMatchText(input.circleName || input.author || "");
  const boothNameMatches = normalizedCircle
    ? exactCandidates.filter(
        (candidate) => normalizeMatchText(candidate.boothName) === normalizedCircle
      )
    : [];
  const accepted = boothNameMatches.length === 1 ? boothNameMatches[0] : undefined;

  if (accepted) {
    return {
      matched: true,
      decision: "accepted",
      confidence: "exact",
      cppItem: accepted,
      score: 1,
      source,
      reason: "完整标准化名称与社团名称同时精确匹配，且候选唯一",
    };
  }

  return {
    matched: false,
    decision: "review",
    confidence: "medium",
    candidate: exactCandidates[0],
    score: 1,
    source,
    requiresReview: true,
    reason: !normalizedCircle
      ? "完整名称存在候选，但缺少社团名称，需人工确认"
      : boothNameMatches.length === 0
        ? "完整名称存在候选，但社团名称不一致，需人工确认"
        : `存在 ${boothNameMatches.length} 个完整名称与社团名称均相同的 CPG 制品，需人工确认`,
  };
}

interface ScoredCandidate {
  item: NormalizedCPPItem;
  score: number;
  boothScore: number;
  nameScore: number;
  authorScore: number;
  exactNameAlias: boolean;
}

function scoreCandidate(input: MatchInput, item: NormalizedCPPItem): ScoredCandidate {
  const inputBooths = splitBoothNumber(input.boothNumber).map(normalizeMatchText);
  const itemBooths = splitBoothNumber(item.boothNumber).map(normalizeMatchText);
  const boothScore = maxAliasSimilarity(inputBooths, itemBooths);

  const inputNames = createMatchAliases(input.productName);
  const itemNames = createMatchAliases(item.productName);
  const exactNameAlias = inputNames.some((alias) => itemNames.includes(alias));
  const nameScore = exactNameAlias ? 1 : maxAliasSimilarity(inputNames, itemNames);

  const authorScore = input.author
    ? charSimilarity(input.author, item.author)
    : 0;

  return {
    item,
    score: (boothScore * 0.45) + (nameScore * 0.45) + (authorScore * 0.1),
    boothScore,
    nameScore,
    authorScore,
    exactNameAlias,
  };
}

function resultFromCandidate(
  candidate: ScoredCandidate,
  source: MatchSource,
  ambiguous: boolean
): MatchResult {
  const rawScore = Math.round(candidate.score * 1000) / 1000;
  let confidence: MatchConfidence;
  let accepted = false;

  if (
    !ambiguous &&
    candidate.boothScore === 1 &&
    candidate.exactNameAlias
  ) {
    confidence = "exact";
    accepted = true;
  } else if (
    !ambiguous &&
    candidate.boothScore >= 0.95 &&
    (
      // 同摊位、唯一候选下，允许“【漫本/新刊】Moments”与
      // “【漫本】#3 Moments”这类仅差宣发标签/序号的名称自动通过。
      candidate.nameScore >= 0.77 ||
      (candidate.authorScore >= 0.9 && candidate.nameScore >= 0.68)
    )
  ) {
    confidence = "high";
    accepted = true;
  } else if (rawScore >= 0.72) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  const reason = [
    `组合评分 ${(rawScore * 100).toFixed(1)}%`,
    `摊位 ${(candidate.boothScore * 100).toFixed(0)}%`,
    `名称 ${(candidate.nameScore * 100).toFixed(0)}%`,
    ambiguous ? "候选接近，需人工确认" : "",
  ].filter(Boolean).join("；");

  if (accepted) {
    return {
      matched: true,
      decision: "accepted",
      confidence,
      cppItem: candidate.item,
      score: rawScore,
      source,
      reason,
    };
  }

  return {
    matched: false,
    decision: "review",
    confidence,
    candidate: candidate.item,
    score: rawScore,
    source,
    requiresReview: true,
    reason,
  };
}

export class MatchIndex {
  private readonly idMap = new Map<number, NormalizedCPPItem>();
  private readonly exactMap = new Map<string, NormalizedCPPItem[]>();
  private readonly boothMap = new Map<string, NormalizedCPPItem[]>();
  private readonly items: NormalizedCPPItem[];

  constructor(items: NormalizedCPPItem[]) {
    this.items = items;
    this.buildIndex();
  }

  private buildIndex() {
    for (const item of this.items) {
      if (item.doujinshiId) this.idMap.set(item.doujinshiId, item);
      const boothKeys = new Set(
        [item.boothNumber, ...splitBoothNumber(item.boothNumber)]
          .map(normalizeMatchText)
          .filter(Boolean)
      );
      const productAliases = createMatchAliases(item.productName);

      for (const boothKey of boothKeys) {
        const boothItems = this.boothMap.get(boothKey) || [];
        if (!boothItems.includes(item)) boothItems.push(item);
        this.boothMap.set(boothKey, boothItems);

        for (const productAlias of productAliases) {
          const key = `${boothKey}|${productAlias}`;
          const exactItems = this.exactMap.get(key) || [];
          if (!exactItems.includes(item)) exactItems.push(item);
          this.exactMap.set(key, exactItems);
        }
      }
    }
  }

  get size() {
    return this.items.length;
  }

  match(input: MatchInput, source: MatchSource = "database-index"): MatchResult {
    if (input.doujinshiId) {
      const byId = this.idMap.get(input.doujinshiId);
      if (byId) {
        return {
          matched: true,
          decision: "accepted",
          confidence: "exact",
          cppItem: byId,
          score: 1,
          source,
          reason: "CPP 唯一标识匹配",
        };
      }
    }

    const boothKeys = new Set(
      [input.boothNumber, ...splitBoothNumber(input.boothNumber)]
        .map(normalizeMatchText)
        .filter(Boolean)
    );
    const productAliases = createMatchAliases(input.productName);

    // 摊位和完整名称完全一致时优先接受。公共【标签】不能再让不同商品
    // 以相同分数挤进候选集合，覆盖真正的完整名称命中。
    const fullName = normalizeMatchText(input.productName);
    if (fullName) {
      const fullNameCandidates = new Map<number, NormalizedCPPItem>();
      for (const boothKey of boothKeys) {
        for (const item of this.boothMap.get(boothKey) || []) {
          if (normalizeMatchText(item.productName) === fullName) {
            fullNameCandidates.set(item.doujinshiId, item);
          }
        }
      }
      if (fullNameCandidates.size > 0) {
        const item = fullNameCandidates.values().next().value as NormalizedCPPItem;
        return resultFromCandidate(scoreCandidate(input, item), source, false);
      }
    }

    const exactCandidates = new Set<NormalizedCPPItem>();
    for (const boothKey of boothKeys) {
      for (const alias of productAliases) {
        for (const item of this.exactMap.get(`${boothKey}|${alias}`) || []) {
          exactCandidates.add(item);
        }
      }
    }
    if (exactCandidates.size === 1) {
      const item = Array.from(exactCandidates)[0];
      return resultFromCandidate(scoreCandidate(input, item), source, false);
    }

    const candidates = new Set<NormalizedCPPItem>(exactCandidates);
    for (const boothKey of boothKeys) {
      for (const item of this.boothMap.get(boothKey) || []) candidates.add(item);
    }
    if (candidates.size === 0) {
      return {
        matched: false,
        decision: "unmatched",
        confidence: "none",
        source,
        reason: "数据库中没有对应摊位候选",
      };
    }

    const scored = Array.from(candidates)
      .map((item) => scoreCandidate(input, item))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 0.6) {
      return {
        matched: false,
        decision: "unmatched",
        confidence: "none",
        source,
        reason: `找到 ${candidates.size} 个同摊位候选，但最高评分不足 60%`,
      };
    }

    const nextDifferentProduct = scored.find(
      (candidate, index) =>
        index > 0 &&
        candidate.item.doujinshiId !== best.item.doujinshiId
    );
    const ambiguous = Boolean(
      nextDifferentProduct && best.score - nextDifferentProduct.score < 0.03
    );
    return resultFromCandidate(best, source, ambiguous);
  }

  matchBatch(inputs: MatchInput[], source: MatchSource = "database-index"): MatchResult[] {
    return inputs.map((input) => this.match(input, source));
  }

  getByBooth(boothNumber: string): NormalizedCPPItem[] {
    const items = new Set<NormalizedCPPItem>();
    for (const part of [boothNumber, ...splitBoothNumber(boothNumber)]) {
      for (const item of this.boothMap.get(normalizeMatchText(part)) || []) items.add(item);
    }
    return Array.from(items);
  }
}

export function createMatchIndex(rawItems: any[]): MatchIndex {
  if (rawItems.length > 0 && (rawItems[0].doujinshiId || rawItems[0].doujinshi_id)) {
    return new MatchIndex(rawItems.map((item: any) => ({
      boothNumber: item.boothNumber || item.booth_number || "",
      boothName: item.boothName || item.booth_name || "",
      productName: item.productName || item.product_name || "",
      author: item.author || "",
      imageUrl: item.imageUrl || item.image_url || "",
      tags: item.tags || [],
      eventName: item.eventName || item.event_name || "",
      dayId: item.dayId || item.day_id || undefined,
      sourceUrl: item.sourceUrl || item.source_url || "",
      doujinshiId: item.doujinshiId || item.doujinshi_id || 0,
      hotCount: item.hotCount || item.hot_count || 0,
      originalWork: item.originalWork || item.original_work || "",
      exchangeType: item.exchangeType || item.exchange_type || "",
      description: item.description || "",
    })));
  }

  const normalized: NormalizedCPPItem[] = [];
  for (const item of rawItems) {
    for (const info of item.participationInfo || []) {
      normalized.push({
        boothNumber: info.boothNumber || "",
        boothName: info.boothName || "",
        productName: item.doujinshiName || item.productName || "",
        author: Array.isArray(item.authors) ? item.authors.join(", ") : "",
        imageUrl: item.imageUrl || item.pic || "",
        tags: item.tags || [],
        eventName: info.eventName || "",
        sourceUrl: item.sourceUrl || "",
        doujinshiId: item.doujinshiId || 0,
        hotCount: item.hotCount || 0,
        originalWork: item.themeAlias || "",
        exchangeType: item.exchangeType || "",
        description: item.description || "",
      });
    }
  }
  return new MatchIndex(normalized);
}
