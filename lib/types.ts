// ============================================================
// CP List Helper - 共享类型定义
// ============================================================

/**
 * 展会数据
 */
export interface Exhibit {
  id: string;
  name: string;
  venue: string;
  date: string;
  items: WishItem[];
  cppData?: CPPDataItem[]; // 已废弃，保留兼容
  createdAt: number;
  updatedAt: number;
}

/**
 * 心愿单条目（用户上传或手动添加）
 */
export interface WishItem {
  id: string;
  boothNumber: string;       // 社团摊位号 (e.g., "伍A01")
  productName: string;       // 展品名称
  author?: string;           // 作者/社团名
  imageUrl?: string;         // 图片URL
  venue?: string;            // 场馆（摊位号第一个字）
  openInfo?: string;         // 开摊信息
  priority?: Priority;
  status: string;            // "pending" | "purchased" | "soldout" | "待领取" | "已领取"
  price?: number;
  note?: string;
  quantity?: number;
  purchaseLimit?: number;
  type?: "paid" | "free";    // 有料 / 无料
  actualPrice?: number;      // 实付金额
  actualQuantity?: number;   // 实购数量
  purchaseNote?: string;     // 购买备注
  // 匹配相关字段（自动填充）
  matchConfidence?: MatchConfidence;
  matchedCPPItem?: NormalizedCPPItem;
}

/**
 * CPP 原始数据条目（爬虫输出格式）
 */
export interface RawCPPItem {
  doujinshiId: number;
  productName: string;
  imageUrl: string;
  authors: string[];
  tags: string[];
  hotCount: number;
  participationInfo: ParticipationInfo[];
  sourceUrl: string;
}

/**
 * CPP 参展信息
 */
export interface ParticipationInfo {
  status: string;
  eventName: string;
  eventDate: string;
  boothName: string;
  boothNumber: string;
}

/**
 * 标准化后的 CPP 数据条目（应用内部统一使用）
 */
export interface NormalizedCPPItem {
  boothNumber: string;       // "陆P03"
  boothName: string;         // "上火茶楼"
  productName: string;       // "最近可以了"
  author: string;            // "TaTaG, 7U7U"
  imageUrl: string;          // CDN URL
  tags: string[];            // ["罗小黑战记"]
  eventName: string;         // "CP32-一期"
  sourceUrl: string;         // CPP 详情页链接
  doujinshiId: number;
}

/**
 * CPP 数据条目（旧格式，兼容用）
 */
export interface CPPDataItem {
  boothNumber: string;
  productName: string;
  pic: string;
  author?: string;
}

/**
 * 优先级
 */
export type Priority = "首摊" | "次摊" | "P1" | "P2" | "P3" | "随缘";

/**
 * 匹配置信度
 */
export type MatchConfidence = "exact" | "high" | "medium" | "low" | "none";

/**
 * 匹配输入（从 Excel 解析出的单条数据）
 */
export interface MatchInput {
  boothNumber: string;
  productName: string;
  author?: string;
}

/**
 * 匹配结果
 */
export interface MatchResult {
  matched: boolean;
  confidence: MatchConfidence;
  cppItem?: NormalizedCPPItem;
  reason?: string;
}

/**
 * CPP 展会元数据
 */
export interface CPPEventMeta {
  eventId: string;           // "cp32"
  eventName: string;         // "CP32"
  crawlDate: string;
  totalItems: number;
  totalBooths: number;
  days: { id: string; name: string }[];
}

/**
 * 摊位索引条目
 */
export interface BoothIndexEntry {
  boothNumber: string;
  itemCount: number;
  file: string;
}

/**
 * 状态文本映射
 */
export const STATUS_TEXT: Record<string, string> = {
  pending: "待购买",
  purchased: "已购买",
  soldout: "已售罄",
  "待领取": "待领取",
  "已领取": "已领取",
};

/**
 * 状态颜色映射
 */
export const STATUS_COLOR: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  purchased: "bg-green-100 text-green-800",
  soldout: "bg-red-100 text-red-800",
  "待领取": "bg-blue-100 text-blue-800",
  "已领取": "bg-indigo-100 text-indigo-800",
};

/**
 * 优先级排序权重
 */
export const PRIORITY_ORDER: Record<string, number> = {
  "首摊": 1,
  "次摊": 2,
  "P1": 3,
  "P2": 4,
  "P3": 5,
  "随缘": 6,
};

/**
 * 优先级颜色
 */
export const PRIORITY_COLOR: Record<string, string> = {
  "首摊": "bg-red-100 text-red-800 border-red-300",
  "次摊": "bg-orange-100 text-orange-800 border-orange-300",
  "P1": "bg-yellow-100 text-yellow-800 border-yellow-300",
  "P2": "bg-green-100 text-green-800 border-green-300",
  "P3": "bg-blue-100 text-blue-800 border-blue-300",
  "随缘": "bg-slate-100 text-slate-600 border-slate-300",
};
