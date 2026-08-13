/**
 * Supabase 数据服务层
 *
 * 封装所有对 Supabase 的读写操作，页面和 API 统一通过这里访问数据库。
 */

import { supabase } from "./supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Exhibit, WishItem, NormalizedCPPItem, MatchInput, MatchResult, MatchConfidence, EventMembership } from "./types";
import { createCompatibleUUID } from "./client-id";
import { getWishItemVenue } from "./wish-item-sort";

function databaseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    return [value.message, value.details, value.hint, value.code]
      .filter(Boolean)
      .map(String)
      .join("；");
  }
  return String(error || "数据库请求失败");
}

function isTransientDatabaseError(error: unknown): boolean {
  const message = databaseErrorMessage(error).toLowerCase();
  return [
    "failed to fetch",
    "fetch failed",
    "network",
    "timeout",
    "timed out",
    "connection",
    "502",
    "503",
    "504",
    "429",
  ].some((part) => message.includes(part));
}

async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
    }
  }
  throw new Error(databaseErrorMessage(lastError));
}

// ============================================================
// 展会管理
// ============================================================

/**
 * 获取当前设备可见的展会
 */
export async function getExhibitsFromDB(): Promise<Exhibit[]> {
  const { data, error } = await supabase.rpc("list_my_events");
  if (error) throw new Error(`读取list失败（请确认已执行 006 迁移）：${databaseErrorMessage(error)}`);
  return (data || []).map((event: any) => ({
    id: event.id,
    name: event.name,
    venue: "",
    date: (event.days || []).map((day: any) => day.name).join(" / "),
    items: Array.from({ length: Number(event.item_count || 0) }, (_, index) => ({ id: `${event.id}-${index}` } as WishItem)),
    accessRole: event.access_role,
    isCreator: Boolean(event.is_creator),
    collaboratorCount: Number(event.collaborator_count || 0),
    cppEventId: event.cpp_event_id || undefined,
    createdAt: new Date(event.created_at).getTime(),
    updatedAt: new Date(event.created_at).getTime(),
  }));
}

/**
 * 创建展会
 */
export async function createExhibitInDB(
  id: string,
  name: string,
  days: { id: string; name: string }[],
  cppEventId?: string,
  _clientId?: string
): Promise<Exhibit> {
  const { error } = await supabase.rpc("create_event_secure", {
    p_id: id, p_name: name, p_days: days, p_cpp_event_id: cppEventId || null,
  });
  if (error) throw error;

  return {
    id,
    name,
    venue: "",
    date: days.map((d) => d.name).join(" / "),
    cppEventId,
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * 删除用户创建的 list：删除心愿单和展会入口，不删 CPP 原始展品数据。
 * 展会入口删除后，share_code 也会一起失效。
 */
export async function deleteExhibitFromDB(id: string, clientId?: string): Promise<boolean> {
  void clientId;
  const { error } = await supabase.rpc("delete_or_leave_event", { p_event_id: id });
  if (error) throw error;
  return true;
}

export async function getEventMembership(eventId: string, client: SupabaseClient = supabase): Promise<EventMembership | null> {
  const { data, error } = await client.rpc("get_my_event_membership", { p_event_id: eventId });
  if (error) throw new Error(`确认list权限失败（身份或迁移异常）：${databaseErrorMessage(error)}`);
  const row = data?.[0];
  return row ? {
    role: row.role,
    isCreator: Boolean(row.is_creator),
    memberCount: Number(row.member_count || 0),
    collaboratorCount: Number(row.collaborator_count || 0),
  } : null;
}

export async function hasEventAccess(eventId: string, _clientId?: string, client: SupabaseClient = supabase): Promise<boolean> {
  return Boolean(await getEventMembership(eventId, client));
}

export interface CPPListSyncResult {
  updatedCount: number;
  matchedCount: number;
  syncedThrough: string | null;
}

export async function getLatestCPPDataTimestamp(cppEventId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("cpp_items")
    .select("source_updated_at")
    .eq("event_id", cppEventId)
    .not("source_updated_at", "is", null)
    .order("source_updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`读取 CPP 更新时间失败：${databaseErrorMessage(error)}`);
  return data?.source_updated_at || null;
}

export async function syncWishItemsFromLatestCPP(eventId: string): Promise<CPPListSyncResult> {
  const { data, error } = await supabase.rpc("sync_wish_items_from_cpp", {
    p_event_id: eventId,
  });
  if (error) throw new Error(`拉取 CPP 最新数据失败：${databaseErrorMessage(error)}`);

  const row = data?.[0];
  return {
    updatedCount: Number(row?.updated_count || 0),
    matchedCount: Number(row?.matched_count || 0),
    syncedThrough: row?.synced_through || null,
  };
}

// ============================================================
// 心愿单操作
// ============================================================

/**
 * 获取某个展会的所有心愿单条目
 */
export async function getWishItems(eventId: string): Promise<WishItem[]> {
  const { data, error } = await supabase
    .from("wish_items")
    .select("*")
    .eq("event_id", eventId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw error;

  return (data || []).map(dbRowToWishItem);
}

/**
 * 创建心愿单条目
 */
export async function createWishItem(
  eventId: string,
  item: Omit<WishItem, "id" | "createdAt" | "updatedAt">
): Promise<WishItem> {
  const row = {
    event_id: eventId,
    booth_number: item.boothNumber,
    product_name: item.productName,
    author: item.author || null,
    image_url: item.imageUrl || null,
    ...(item.openInfo !== undefined ? { open_info: item.openInfo || null } : {}),
    item_type: item.type || "paid",
    status: item.status || "pending",
    priority: item.priority || null,
    note: item.note || null,
    price: item.price ?? null,
    quantity: item.quantity ?? 1,
    purchase_limit: item.purchaseLimit || null,
    sort_order: 0,
    cpp_item_id: item.matchedCPPItem?.doujinshiId || null,
    hot_count: item.hotCount ?? null,
    description: item.description || null,
  };

  const { data, error } = await supabase
    .from("wish_items")
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return dbRowToWishItem(data);
}

/**
 * 更新心愿单条目
 */
export async function updateWishItem(
  eventId: string,
  itemId: string,
  updates: Partial<WishItem>,
  expectedVersion?: number
): Promise<WishItem | null> {
  const version = expectedVersion ?? updates.version;
  if (version === undefined) throw new Error("缺少条目版本，请刷新后重试");
  const { data, error } = await supabase.rpc("save_wish_item_cas", {
    p_event_id: eventId,
    p_item_id: itemId,
    p_expected_version: version,
    p_patch: wishItemPatchToRow(updates),
  });
  if (error) throw error;
  return data ? dbRowToWishItem(data) : null;
}

/**
 * 一次插入多条心愿单条目。
 */
export async function createWishItems(
  eventId: string,
  items: Omit<WishItem, "id" | "createdAt" | "updatedAt">[]
): Promise<WishItem[]> {
  if (items.length === 0) return [];

  const rows = items.map((item, index) => ({
    id: createCompatibleUUID(),
    event_id: eventId,
    booth_number: item.boothNumber,
    product_name: item.productName,
    author: item.author || null,
    image_url: item.imageUrl || null,
    ...(item.openInfo !== undefined ? { open_info: item.openInfo || null } : {}),
    item_type: item.type || "paid",
    status: item.status || "pending",
    priority: item.priority || null,
    note: item.note || null,
    price: item.price ?? null,
    quantity: item.quantity ?? 1,
    purchase_limit: item.purchaseLimit ?? null,
    sort_order: index,
    cpp_item_id: item.matchedCPPItem?.doujinshiId || null,
    hot_count: item.hotCount ?? null,
    description: item.description || null,
  }));

  return withTransientRetry(async () => {
    const { data, error } = await supabase
      .from("wish_items")
      .insert(rows)
      .select("*");

    if (error) throw error;
    return (data || []).map(dbRowToWishItem);
  });
}

/**
 * 一次性保存多条完整的心愿单草稿。
 */
export async function saveWishItemDrafts(
  eventId: string,
  items: WishItem[]
): Promise<WishItem[]> {
  if (items.length === 0) return [];

  const batch = items.map((item) => {
    if (item.version === undefined) throw new Error(`条目 ${item.id} 缺少版本，请刷新后重试`);
    return {
      item_id: item.id,
      expected_version: item.version,
      patch: wishItemPatchToRow(item),
    };
  });
  const { data, error } = await supabase.rpc("save_wish_items_batch_cas", {
    p_event_id: eventId,
    p_items: batch,
  });
  if (error) throw error;
  return (data || []).map(dbRowToWishItem);
}

/**
 * 批量更新心愿单状态
 */
export async function batchUpdateWishItems(
  eventId: string,
  itemIds: string[],
  updates: Partial<WishItem>
): Promise<void> {
  if (itemIds.length === 0) return;
  const ids = new Set(itemIds);
  const current = (await getWishItems(eventId)).filter((item) => ids.has(item.id));
  if (current.length !== ids.size) throw new Error("部分条目已不存在，请刷新后重试");
  await saveWishItemDrafts(eventId, current.map((item) => ({ ...item, ...updates })));
}

/**
 * 删除心愿单条目
 */
export async function deleteWishItem(eventId: string, itemId: string): Promise<boolean> {
  const { error } = await supabase
    .from("wish_items")
    .delete()
    .eq("event_id", eventId)
    .eq("id", itemId);

  if (error) throw error;
  return true;
}

export async function deleteWishItems(eventId: string, itemIds: string[]): Promise<boolean> {
  if (itemIds.length === 0) return true;

  const { error } = await supabase
    .from("wish_items")
    .delete()
    .eq("event_id", eventId)
    .in("id", itemIds);

  if (error) throw error;
  return true;
}

// ============================================================
// CPP 展品查询（供匹配 API 使用）
// ============================================================

function dbRowToCPPItem(row: any): NormalizedCPPItem {
  return {
    boothNumber: row.booth_number || "",
    boothName: row.booth_name || "",
    productName: row.product_name || "",
    author: row.author || "",
    imageUrl: row.image_url || "",
    tags: row.tags || [],
    eventName: "",
    dayId: row.day_id || undefined,
    sourceUrl: row.source_url || "",
    doujinshiId: row.doujinshi_id || 0,
    hotCount: row.hot_count || 0,
    originalWork: row.original_work || "",
    exchangeType: row.exchange_type || "",
    description: row.description || "",
  };
}

/**
 * 获取某个 CPP 展会的所有 CPP 展品（供构建匹配索引）。
 * CP32 的 event_id 统一是 cp32，一期/二期用 day_id 区分。
 */
export async function getCPPItems(eventId: string, dayIds?: string[], client: SupabaseClient = supabase): Promise<NormalizedCPPItem[]> {
  const rows: any[] = [];
  const pageSize = 1000;

  for (let offset = 0; ; offset += pageSize) {
    let query = client
      .from("cpp_items")
      .select("*")
      .eq("event_id", eventId)
      .range(offset, offset + pageSize - 1);

    if (dayIds && dayIds.length > 0) {
      query = query.in("day_id", dayIds);
    }

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows.map(dbRowToCPPItem);
}

/**
 * 按输入摊位批量读取第一阶段匹配候选，避免每次加载整个 CPP 数据集。
 */
export async function getCPPItemsByBooths(
  eventId: string,
  boothNumbers: string[],
  dayIds?: string[],
  doujinshiIds: number[] = [],
  client: SupabaseClient = supabase
): Promise<NormalizedCPPItem[]> {
  const uniqueBooths = Array.from(new Set(
    boothNumbers
      .flatMap((value) => [
        value.trim(),
        value.normalize("NFKC").replace(/\s+/g, ""),
      ])
      .filter(Boolean)
  ));
  const uniqueIds = Array.from(new Set(doujinshiIds.filter((value) => Number.isFinite(value))));
  if (uniqueBooths.length === 0 && uniqueIds.length === 0) return [];

  const rows: any[] = [];
  const chunkSize = 40;
  for (let index = 0; index < uniqueBooths.length; index += chunkSize) {
    const chunk = uniqueBooths.slice(index, index + chunkSize);
    let query = client
      .from("cpp_items")
      .select("*")
      .eq("event_id", eventId)
      .in("booth_number", chunk)
      .limit(5000);

    if (dayIds && dayIds.length > 0) {
      query = query.in("day_id", dayIds);
    }

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
  }

  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    let query = client
      .from("cpp_items")
      .select("*")
      .eq("event_id", eventId)
      .in("doujinshi_id", chunk)
      .limit(5000);

    if (dayIds && dayIds.length > 0) {
      query = query.in("day_id", dayIds);
    }

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
  }

  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = `${row.event_id}|${row.day_id}|${row.doujinshi_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(dbRowToCPPItem);
}

/**
 * 按完整 normalized_product 批量读取 CPG 空摊位候选。
 * 调用方传入与同步脚本相同规则生成的标准化名称；查询始终受 event/day scope 限制。
 */
export async function getCPPItemsByNormalizedProducts(
  eventId: string,
  normalizedProducts: string[],
  dayIds?: string[],
  client: SupabaseClient = supabase
): Promise<NormalizedCPPItem[]> {
  const uniqueProducts = Array.from(new Set(
    normalizedProducts.map((value) => value.trim().toLowerCase()).filter(Boolean)
  ));
  if (uniqueProducts.length === 0) return [];

  const rows: any[] = [];
  const chunkSize = 40;
  for (let index = 0; index < uniqueProducts.length; index += chunkSize) {
    const chunk = uniqueProducts.slice(index, index + chunkSize);
    let query = client
      .from("cpp_items")
      .select("*")
      .eq("event_id", eventId)
      .in("normalized_product", chunk)
      .limit(5000);

    if (dayIds && dayIds.length > 0) {
      query = query.in("day_id", dayIds);
    }

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
  }

  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = `${row.event_id}|${row.day_id}|${row.doujinshi_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(dbRowToCPPItem);
}

/**
 * 将用户展会 ID 解析为 CPP 数据库查询范围。
 * 例如页面展会是 cp32-day1/cp32-day2，cpp_items.event_id 统一是 cp32，
 * 再用 day_id=7040/7042 区分一期和二期。
 */
export function normalizeCPPMatchDayIds(
  cppEventId: string,
  days: unknown
): string[] | undefined {
  const dayIds = Array.isArray(days)
    ? days.map((day: any) => String(day?.id ?? "")).filter(Boolean)
    : undefined;

  // 仅兼容真实 CPP day 被确认前创建的 CPG08 单日 list；不改写存储数据。
  if (
    cppEventId === "cpg08" &&
    dayIds?.length === 1 &&
    dayIds[0] === "7073"
  ) {
    return ["7829"];
  }
  return dayIds;
}

export async function resolveCPPMatchScope(
  eventId: string,
  client: SupabaseClient = supabase,
  allowLegacyFallback = true
): Promise<{ eventId: string; dayIds?: string[] }> {
  try {
    const { data, error } = await client
      .from("events")
      .select("cpp_event_id, days")
      .eq("id", eventId)
      .maybeSingle();

    if (!error && data) {
      const cppEventId =
        data.cpp_event_id || (eventId.startsWith("cp32") ? "cp32" : eventId);
      const dayIds = normalizeCPPMatchDayIds(cppEventId, data.days);

      return {
        eventId: cppEventId,
        dayIds,
      };
    }
    if (error && !allowLegacyFallback) throw error;
    if (!data && !allowLegacyFallback) throw new Error("EVENT_SCOPE_NOT_FOUND");
  } catch (error) {
    if (!allowLegacyFallback) throw error;
    // 旧表结构或本地调试时降级到规则映射
  }

  if (eventId === "cp32-day1") return { eventId: "cp32", dayIds: ["7040"] };
  if (eventId === "cp32-day2") return { eventId: "cp32", dayIds: ["7042"] };
  if (eventId.startsWith("cp32")) return { eventId: "cp32" };
  return { eventId };
}

/**
 * 按摊位号查询 CPP 展品
 */
export async function getCPPItemsByBooth(
  eventId: string,
  boothNumber: string,
  dayIds?: string[]
): Promise<NormalizedCPPItem[]> {
  let query = supabase
    .from("cpp_items")
    .select("*")
    .eq("event_id", eventId)
    .eq("booth_number", boothNumber);

  if (dayIds && dayIds.length > 0) {
    query = query.in("day_id", dayIds);
  }

  const { data, error } = await query;

  if (error) throw error;

  return (data || []).map(dbRowToCPPItem);
}

/**
 * 按关键词搜索 CPP 展品
 */
export async function searchCPPItems(
  eventId: string,
  keyword: string,
  limit = 50,
  dayIds?: string[],
  client: SupabaseClient = supabase
): Promise<NormalizedCPPItem[]> {
  // 同时搜索原关键词和去掉空格的版本（处理"酥油 uno" vs "酥油 uno"）
  const keywordNoSpace = keyword.replace(/\s+/g, "");
  const keywords = keyword !== keywordNoSpace ? [keyword, keywordNoSpace] : [keyword];

  let allResults: any[] = [];
  for (const kw of keywords) {
    let query = client
      .from("cpp_items")
      .select("*")
      .eq("event_id", eventId)
      .ilike("product_name", `%${kw}%`)
      .limit(limit);

    if (dayIds && dayIds.length > 0) {
      query = query.in("day_id", dayIds);
    }

    const { data, error } = await query;

    if (error) throw error;
    if (data) allResults = allResults.concat(data);
  }

  // 去重
  const seen = new Set<number>();
  const unique = allResults.filter((row) => {
    if (seen.has(row.doujinshi_id)) return false;
    seen.add(row.doujinshi_id);
    return true;
  });

  return unique.map(dbRowToCPPItem);
}

// ============================================================
// 工具函数
// ============================================================

export function dbRowToWishItem(row: any): WishItem {
  return {
    id: row.id,
    boothNumber: row.booth_number || "",
    productName: row.product_name || "",
    author: row.author || undefined,
    imageUrl: row.image_url || undefined,
    openInfo: row.open_info || undefined,
    venue: getWishItemVenue({ boothNumber: row.booth_number || "" }),
    type: row.item_type || "paid",
    status: row.status || "pending",
    priority: row.priority || undefined,
    note: row.note || undefined,
    price: row.price ?? undefined,
    quantity: row.quantity ?? 1,
    purchaseLimit: row.purchase_limit || undefined,
    hotCount: row.hot_count ?? undefined,
    description: row.description || undefined,
    version: Number(row.version || 1),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : undefined,
  };
}

function wishItemPatchToRow(item: Partial<WishItem>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (item.boothNumber !== undefined) row.booth_number = item.boothNumber;
  if (item.productName !== undefined) row.product_name = item.productName;
  if (item.author !== undefined) row.author = item.author ?? null;
  if (item.imageUrl !== undefined) row.image_url = item.imageUrl ?? null;
  if (item.openInfo !== undefined) row.open_info = item.openInfo ?? null;
  if (item.type !== undefined) row.item_type = item.type;
  if (item.status !== undefined) row.status = item.status;
  if (item.priority !== undefined) row.priority = item.priority ?? null;
  if (item.note !== undefined) row.note = item.note ?? null;
  if (item.price !== undefined) row.price = item.price ?? null;
  if (item.quantity !== undefined) row.quantity = item.quantity ?? 1;
  if (item.purchaseLimit !== undefined) row.purchase_limit = item.purchaseLimit ?? null;
  if (item.matchedCPPItem !== undefined) row.cpp_item_id = item.matchedCPPItem?.doujinshiId ?? null;
  if (item.hotCount !== undefined) row.hot_count = item.hotCount ?? null;
  if (item.description !== undefined) row.description = item.description ?? null;
  return row;
}
