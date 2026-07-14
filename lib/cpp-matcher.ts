/**
 * CPP 匹配引擎
 *
 * 将 Excel 中的心愿单条目与 CPP 展品数据进行匹配，支持多级模糊匹配。
 *
 * 匹配策略（优先级从高到低）：
 * 1. 精确匹配：摊位号 + 展品名称完全一致
 * 2. 标准化匹配：全角转半角、去空格后匹配
 * 3. 包含匹配：摊位号匹配 + 名称互相包含
 * 4. 作者匹配：摊位号匹配 + 作者一致
 */

import type { NormalizedCPPItem, MatchInput, MatchResult, MatchConfidence } from "./types";

// ---- 工具函数 ----

/**
 * 标准化字符串：全角→半角、去空格、转小写
 */
function normalize(str: string): string {
  if (!str) return "";
  return str
    .replace(/[\s ]/g, "")
    .normalize("NFKC")
    .toLowerCase();
}

/**
 * 拆分合并摊位号
 *
 * CPP 数据中部分摊位号是合并格式，如 "伍C21伍C22"、"陆G01陆G02"。
 * 用户 Excel 中通常只写其中一个（如 "伍C21"），需要拆分后分别索引。
 *
 * 匹配模式：中文字符 + 可选字母 + 数字
 */
function splitBoothNumber(boothNumber: string): string[] {
  if (!boothNumber) return [];
  // 匹配：一个或多个中文字符 + 可选的大写字母 + 一个或多个数字
  const parts = boothNumber.match(/[一-鿿]+[A-Z]?\d+/g);
  return parts || [boothNumber];
}

/**
 * 计算两个字符串的相似度 (0-1)
 * 使用最长公共子序列的简化版本
 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;

  // 包含关系给较高分
  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }

  // 字符集合交集比例
  const setA = new Set(na.split(""));
  const setB = new Set(nb.split(""));
  let intersection = 0;
  for (const c of setA) {
    if (setB.has(c)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ---- 索引构建 ----

/**
 * 匹配索引，加速查找
 */
export class MatchIndex {
  // 精确查找表: "normalizedBooth|normalizedProduct" → item[]
  private exactMap: Map<string, NormalizedCPPItem[]> = new Map();
  // 摊位查找表: "normalizedBooth" → item[]
  private boothMap: Map<string, NormalizedCPPItem[]> = new Map();
  // 原始数据
  private items: NormalizedCPPItem[];

  constructor(items: NormalizedCPPItem[]) {
    this.items = items;
    this.buildIndex();
  }

  private buildIndex() {
    for (const item of this.items) {
      // 精确索引：原始组合 + 拆分后的各部分
      const normProduct = normalize(item.productName);
      const boothParts = splitBoothNumber(item.boothNumber);
      const boothKeys = new Set<string>();
      boothKeys.add(normalize(item.boothNumber)); // 原始
      for (const part of boothParts) {
        boothKeys.add(normalize(part)); // 拆分后的每个部分
      }

      for (const boothKey of boothKeys) {
        const exactKey = `${boothKey}|${normProduct}`;
        const existing = this.exactMap.get(exactKey);
        if (existing) {
          if (!existing.includes(item)) {
            existing.push(item);
          }
        } else {
          this.exactMap.set(exactKey, [item]);
        }

        // 摊位索引
        const boothItems = this.boothMap.get(boothKey);
        if (boothItems) {
          if (!boothItems.includes(item)) {
            boothItems.push(item);
          }
        } else {
          this.boothMap.set(boothKey, [item]);
        }
      }
    }
  }

  get size() {
    return this.items.length;
  }

  /**
   * 匹配单条输入
   */
  match(input: MatchInput): MatchResult {
    const normBooth = normalize(input.boothNumber);
    const normProduct = normalize(input.productName);

    // Level 1: 精确匹配
    const exactKey = `${normBooth}|${normProduct}`;
    const exactHits = this.exactMap.get(exactKey);
    if (exactHits && exactHits.length > 0) {
      return {
        matched: true,
        confidence: "exact",
        cppItem: exactHits[0],
        reason: "精确匹配",
      };
    }

    // 获取同摊位的所有条目（用于后续匹配）
    const boothItems = this.boothMap.get(normBooth) || [];

    if (boothItems.length === 0) {
      // 摊位号都没匹配到，尝试标准化匹配
      // 可能是全角半角差异
      for (const [key, items] of this.boothMap.entries()) {
        if (key === normBooth) continue;
        // 尝试模糊摊位号匹配
        if (similarity(input.boothNumber, items[0]?.boothNumber || "") > 0.9) {
          // 在这个摊位里找名称匹配的
          const nameHit = items.find(
            (item) =>
              normalize(item.productName) === normProduct ||
              normalize(item.productName).includes(normProduct) ||
              normProduct.includes(normalize(item.productName))
          );
          if (nameHit) {
            return {
              matched: true,
              confidence: "high",
              cppItem: nameHit,
              reason: `摊位号模糊匹配 (${items[0].boothNumber})`,
            };
          }
        }
      }

      return { matched: false, confidence: "none", reason: "摊位号未匹配" };
    }

    // Level 2: 摊位号匹配 + 名称完全一致（标准化后）
    const normProductHit = boothItems.find(
      (item) => normalize(item.productName) === normProduct
    );
    if (normProductHit) {
      return {
        matched: true,
        confidence: "high",
        cppItem: normProductHit,
        reason: "标准化匹配（全角/空格差异）",
      };
    }

    // Level 3: 摊位号匹配 + 名称包含
    const containHit = boothItems.find(
      (item) => {
        const np = normalize(item.productName);
        return np.includes(normProduct) || normProduct.includes(np);
      }
    );
    if (containHit) {
      return {
        matched: true,
        confidence: "medium",
        cppItem: containHit,
        reason: "名称包含匹配",
      };
    }

    // Level 4: 摊位号匹配 + 作者匹配
    if (input.author) {
      const normAuthor = normalize(input.author);
      const authorHit = boothItems.find(
        (item) => {
          const itemAuthor = normalize(item.author);
          return itemAuthor === normAuthor ||
            itemAuthor.includes(normAuthor) ||
            normAuthor.includes(itemAuthor);
        }
      );
      if (authorHit) {
        return {
          matched: true,
          confidence: "low",
          cppItem: authorHit,
          reason: "作者匹配（名称不一致，需确认）",
        };
      }
    }

    // Level 5: 摊位号匹配 + 名称相似度
    let bestSimilarity = 0;
    let bestItem: NormalizedCPPItem | null = null;
    for (const item of boothItems) {
      const sim = similarity(input.productName, item.productName);
      if (sim > bestSimilarity && sim > 0.6) {
        bestSimilarity = sim;
        bestItem = item;
      }
    }
    if (bestItem) {
      return {
        matched: true,
        confidence: "low",
        cppItem: bestItem,
        reason: `模糊匹配（相似度 ${(bestSimilarity * 100).toFixed(0)}%）`,
      };
    }

    return {
      matched: false,
      confidence: "none",
      reason: `摊位 ${input.boothNumber} 有 ${boothItems.length} 个展品，但无名称匹配`,
    };
  }

  /**
   * 批量匹配
   */
  matchBatch(inputs: MatchInput[]): MatchResult[] {
    return inputs.map((input) => this.match(input));
  }

  /**
   * 按摊位号查询所有展品
   */
  getByBooth(boothNumber: string): NormalizedCPPItem[] {
    return this.boothMap.get(normalize(boothNumber)) || [];
  }
}

// ---- 便捷函数 ----

/**
 * 从原始 CPP 数据创建匹配索引（支持 raw 格式和 normalized 格式）
 *
 * 判断逻辑：有 doujinshiId → 已经是 normalized 格式（即使有 participationInfo）
 * 否则 → 原始格式，需要从 participationInfo 展开
 */
export function createMatchIndex(rawItems: any[]): MatchIndex {
  // 检查是否已经是 normalized 格式
  if (rawItems.length > 0 && (rawItems[0].doujinshiId || rawItems[0].doujinshi_id)) {
    // 已经是 NormalizedCPPItem[]，直接使用
    return new MatchIndex(rawItems.map((item: any) => ({
      boothNumber: item.boothNumber || item.booth_number || "",
      boothName: item.boothName || item.booth_name || "",
      productName: item.productName || item.product_name || "",
      author: item.author || "",
      imageUrl: item.imageUrl || item.image_url || "",
      tags: item.tags || [],
      eventName: item.eventName || item.event_name || "",
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
    const participationList = item.participationInfo || [];
    if (participationList.length === 0) continue;

    for (const info of participationList) {
      normalized.push({
        boothNumber: info.boothNumber || "",
        boothName: info.boothName || "",
        productName: item.doujinshiName || "",
        author: Array.isArray(item.authors) ? item.authors.join(", ") : "",
        imageUrl: item.imageUrl || item.pic || "",
        tags: item.tags || [],
        eventName: info.eventName || "",
        sourceUrl: item.sourceUrl || "",
        doujinshiId: item.doujinshiId || 0,
        hotCount: item.hotCount || 0,
        originalWork: item.themeAlias || "",
        exchangeType: "",
        description: "",
      });
    }
  }

  return new MatchIndex(normalized);
}
