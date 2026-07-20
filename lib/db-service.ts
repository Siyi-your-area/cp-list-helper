/**
 * Supabase 数据服务层
 *
 * 封装所有对 Supabase 的读写操作，页面和 API 统一通过这里访问数据库。
 */

import { supabase } from "./supabase";
import type { Exhibit, WishItem, NormalizedCPPItem, MatchInput, MatchResult, MatchConfidence } from "./types";
import { createCompatibleUUID } from "./client-id";

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
export async function getExhibitsFromDB(clientId?: string): Promise<Exhibit[]> {
  if (!clientId) return [];

  const { data: accessRows, error: accessError } = await supabase
    .from("event_access")
    .select("event_id, role")
    .eq("client_id", clientId);

  if (accessError) {
    if (accessError.code === "42P01" || accessError.message?.includes("event_access")) {
      return [];
    }
    throw accessError;
  }

  const eventIds = Array.from(new Set((accessRows || []).map((row: any) => row.event_id).filter(Boolean)));
  if (eventIds.length === 0) return [];
  const accessRoleByEventId = new Map(
    (accessRows || []).map((row: any) => [row.event_id, row.role as "owner" | "viewer"])
  );

  const { data: events, error } = await supabase
    .from("events")
    .select("*")
    .in("id", eventIds)
    .order("created_at", { ascending: false });

  if (error) throw error;

  const exhibits: Exhibit[] = [];
  for (const event of events || []) {
    const { data: wishItems, error: itemsError } = await supabase
      .from("wish_items")
      .select("id")
      .eq("event_id", event.id);

    if (itemsError) throw itemsError;

    const days = event.days || [];
    const dateStr = days.map((d: any) => d.name).join(" / ");

    exhibits.push({
      id: event.id,
      name: event.name,
      venue: "",
      date: dateStr,
      items: (wishItems || []).map((w: any) => ({ id: w.id } as WishItem)),
      shareCode: event.share_code || undefined,
      accessRole: accessRoleByEventId.get(event.id) || "viewer",
      cppEventId: event.cpp_event_id || undefined,
      cppData: undefined,
      createdAt: new Date(event.created_at).getTime(),
      updatedAt: new Date(event.created_at).getTime(),
    });
  }

  return exhibits;
}

/**
 * 创建展会
 */
export async function createExhibitInDB(
  id: string,
  name: string,
  days: { id: string; name: string }[],
  cppEventId?: string,
  clientId?: string
): Promise<Exhibit> {
  const { error } = await supabase.from("events").upsert({
    id,
    name,
    days,
    cpp_event_id: cppEventId,
    status: "active",
  });

  if (error) throw error;

  if (clientId) {
    await grantEventAccess(id, clientId, "owner");
  }

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
  if (clientId) {
    const { data: accessRow, error: accessError } = await supabase
      .from("event_access")
      .select("role")
      .eq("event_id", id)
      .eq("client_id", clientId)
      .maybeSingle();

    if (accessError) throw accessError;

    if (accessRow?.role !== "owner") {
      const { error: removeAccessError } = await supabase
        .from("event_access")
        .delete()
        .eq("event_id", id)
        .eq("client_id", clientId);

      if (removeAccessError) throw removeAccessError;
      return true;
    }
  }

  const { error: itemsError } = await supabase
    .from("wish_items")
    .delete()
    .eq("event_id", id);

  if (itemsError) throw itemsError;

  const { error: accessDeleteError } = await supabase
    .from("event_access")
    .delete()
    .eq("event_id", id);

  if (accessDeleteError) throw accessDeleteError;

  const { error: eventError } = await supabase
    .from("events")
    .delete()
    .eq("id", id);

  if (eventError) throw eventError;
  return true;
}

export async function grantEventAccess(
  eventId: string,
  clientId: string,
  role: "owner" | "viewer"
): Promise<void> {
  const { data: existing, error: existingError } = await supabase
    .from("event_access")
    .select("role")
    .eq("event_id", eventId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.role === "owner") return;

  const { error } = await supabase
    .from("event_access")
    .upsert(
      {
        event_id: eventId,
        client_id: clientId,
        role,
      },
      { onConflict: "event_id,client_id" }
    );

  if (error) throw error;
}

export async function hasEventAccess(eventId: string, clientId?: string): Promise<boolean> {
  if (!clientId) return false;

  const { data, error } = await supabase
    .from("event_access")
    .select("event_id")
    .eq("event_id", eventId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01" || error.message?.includes("event_access")) {
      return false;
    }
    throw error;
  }

  return Boolean(data);
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
  updates: Partial<WishItem>
): Promise<WishItem | null> {
  const row: any = {};
  if (updates.boothNumber !== undefined) row.booth_number = updates.boothNumber;
  if (updates.productName !== undefined) row.product_name = updates.productName;
  if (updates.author !== undefined) row.author = updates.author;
  if (updates.imageUrl !== undefined) row.image_url = updates.imageUrl;
  if (updates.type !== undefined) row.item_type = updates.type;
  if (updates.status !== undefined) row.status = updates.status;
  if (updates.priority !== undefined) row.priority = updates.priority;
  if (updates.note !== undefined) row.note = updates.note;
  if (updates.price !== undefined) row.price = updates.price;
  if (updates.quantity !== undefined) row.quantity = updates.quantity;
  if (updates.purchaseLimit !== undefined) row.purchase_limit = updates.purchaseLimit;
  if (updates.hotCount !== undefined) row.hot_count = updates.hotCount;
  if (updates.description !== undefined) row.description = updates.description;

  const { error } = await supabase
    .from("wish_items")
    .update(row)
    .eq("event_id", eventId)
    .eq("id", itemId);

  if (error) throw error;

  const { data, error: readError } = await supabase
    .from("wish_items")
    .select("*")
    .eq("event_id", eventId)
    .eq("id", itemId)
    .maybeSingle();

  if (readError) throw readError;
  if (!data) {
    throw new Error("更新后未找到对应条目，请刷新页面后重试");
  }

  return dbRowToWishItem(data);
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
      .upsert(rows, { onConflict: "id" })
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

  const rows = items.map((item) => ({
    id: item.id,
    event_id: eventId,
    booth_number: item.boothNumber,
    product_name: item.productName,
    author: item.author || null,
    image_url: item.imageUrl || null,
    item_type: item.type || "paid",
    status: item.status || "pending",
    priority: item.priority || null,
    note: item.note || null,
    price: item.price ?? null,
    quantity: item.quantity ?? 1,
    purchase_limit: item.purchaseLimit ?? null,
    cpp_item_id: item.matchedCPPItem?.doujinshiId || null,
    hot_count: item.hotCount ?? null,
    description: item.description || null,
  }));

  const { data, error } = await supabase
    .from("wish_items")
    .upsert(rows, { onConflict: "id" })
    .select("*");

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
  const row: any = {};
  if (updates.status !== undefined) row.status = updates.status;
  if (updates.note !== undefined) row.note = updates.note;

  const { error } = await supabase
    .from("wish_items")
    .update(row)
    .eq("event_id", eventId)
    .in("id", itemIds);

  if (error) throw error;
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
export async function getCPPItems(eventId: string, dayIds?: string[]): Promise<NormalizedCPPItem[]> {
  const rows: any[] = [];
  const pageSize = 1000;

  for (let offset = 0; ; offset += pageSize) {
    let query = supabase
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
  doujinshiIds: number[] = []
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
    let query = supabase
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
    let query = supabase
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
 * 将用户展会 ID 解析为 CPP 数据库查询范围。
 * 例如页面展会是 cp32-day1/cp32-day2，cpp_items.event_id 统一是 cp32，
 * 再用 day_id=7040/7042 区分一期和二期。
 */
export async function resolveCPPMatchScope(eventId: string): Promise<{ eventId: string; dayIds?: string[] }> {
  try {
    const { data, error } = await supabase
      .from("events")
      .select("cpp_event_id, days")
      .eq("id", eventId)
      .maybeSingle();

    if (!error && data) {
      const dayIds = Array.isArray(data.days)
        ? data.days.map((day: any) => String(day.id)).filter(Boolean)
        : undefined;

      return {
        eventId: data.cpp_event_id || (eventId.startsWith("cp32") ? "cp32" : eventId),
        dayIds,
      };
    }
  } catch {
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
  dayIds?: string[]
): Promise<NormalizedCPPItem[]> {
  // 同时搜索原关键词和去掉空格的版本（处理"酥油 uno" vs "酥油 uno"）
  const keywordNoSpace = keyword.replace(/\s+/g, "");
  const keywords = keyword !== keywordNoSpace ? [keyword, keywordNoSpace] : [keyword];

  let allResults: any[] = [];
  for (const kw of keywords) {
    let query = supabase
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

function dbRowToWishItem(row: any): WishItem {
  return {
    id: row.id,
    boothNumber: row.booth_number || "",
    productName: row.product_name || "",
    author: row.author || undefined,
    imageUrl: row.image_url || undefined,
    venue: row.booth_number?.charAt(0) || "",
    type: row.item_type || "paid",
    status: row.status || "pending",
    priority: row.priority || undefined,
    note: row.note || undefined,
    price: row.price ?? undefined,
    quantity: row.quantity ?? 1,
    purchaseLimit: row.purchase_limit || undefined,
    hotCount: row.hot_count ?? undefined,
    description: row.description || undefined,
  };
}

// ============================================================
// 分享码
// ============================================================

/**
 * 生成 4 位分享码（去掉易混淆的 0/O/1/I）
 */
export function generateShareCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join("");
}

/**
 * 获取展会的分享码，没有则自动生成并保存
 */
export async function getOrCreateShareCode(eventId: string): Promise<string> {
  // 先查已有的
  const { data, error } = await supabase
    .from("events")
    .select("share_code")
    .eq("id", eventId)
    .single();

  if (error) {
    // 列不存在时降级处理
    if (error.code === "42703" || error.message?.includes("share_code")) {
      return "NEED_MIGRATION";
    }
    throw error;
  }

  if (data?.share_code) return data.share_code;

  // 没有则生成新的（需要重试以防碰撞）
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateShareCode();
    const { error: updateError } = await supabase
      .from("events")
      .update({ share_code: code })
      .eq("id", eventId);

    if (!updateError) return code;
    // 唯一约束冲突，重试
    if (updateError.code === "23505") continue;
    // 列不存在
    if (updateError.code === "42703" || updateError.message?.includes("share_code")) {
      return "NEED_MIGRATION";
    }
    throw updateError;
  }
  throw new Error("生成分享码失败：多次碰撞");
}

/**
 * 通过分享码查找展会
 */
export async function resolveShareCode(code: string): Promise<{ eventId: string; eventName: string } | null> {
  const { data, error } = await supabase
    .from("events")
    .select("id, name")
    .eq("share_code", code.toUpperCase())
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // 未找到
    if (error.code === "42703" || error.message?.includes("share_code")) {
      return null; // 列不存在
    }
    throw error;
  }

  return { eventId: data.id, eventName: data.name };
}
