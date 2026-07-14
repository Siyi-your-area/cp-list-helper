/**
 * Supabase 数据服务层
 *
 * 封装所有对 Supabase 的读写操作，页面和 API 统一通过这里访问数据库。
 */

import { supabase } from "./supabase";
import type { Exhibit, WishItem, NormalizedCPPItem, MatchInput, MatchResult, MatchConfidence } from "./types";

// ============================================================
// 展会管理
// ============================================================

/**
 * 获取所有展会
 */
export async function getExhibitsFromDB(): Promise<Exhibit[]> {
  const { data: events, error } = await supabase
    .from("events")
    .select("*")
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
  cppEventId?: string
): Promise<Exhibit> {
  const { error } = await supabase.from("events").upsert({
    id,
    name,
    days,
    cpp_event_id: cppEventId,
    status: "active",
  });

  if (error) throw error;

  return {
    id,
    name,
    venue: "",
    date: days.map((d) => d.name).join(" / "),
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * 删除展会（只删心愿单，不删 CPP 展品数据）
 */
export async function deleteExhibitFromDB(id: string): Promise<boolean> {
  const { error } = await supabase
    .from("wish_items")
    .delete()
    .eq("event_id", id);

  if (error) throw error;
  return true;
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
    price: item.price || null,
    quantity: item.quantity || 1,
    purchase_limit: item.purchaseLimit || null,
    sort_order: 0,
    cpp_item_id: item.matchedCPPItem?.doujinshiId || null,
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

  const { data, error } = await supabase
    .from("wish_items")
    .update(row)
    .eq("event_id", eventId)
    .eq("id", itemId)
    .select()
    .single();

  if (error) throw error;
  return dbRowToWishItem(data);
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

// ============================================================
// CPP 展品查询（供匹配 API 使用）
// ============================================================

/**
 * 获取某个展会的所有 CPP 展品（供构建匹配索引）
 */
export async function getCPPItems(eventId: string): Promise<NormalizedCPPItem[]> {
  const { data, error } = await supabase
    .from("cpp_items")
    .select("*")
    .eq("event_id", eventId);

  if (error) throw error;

  return (data || []).map((row: any) => ({
    boothNumber: row.booth_number || "",
    boothName: row.booth_name || "",
    productName: row.product_name || "",
    author: row.author || "",
    imageUrl: row.image_url || "",
    tags: row.tags || [],
    eventName: "",
    sourceUrl: row.source_url || "",
    doujinshiId: row.doujinshi_id || 0,
    hotCount: row.hot_count || 0,
    originalWork: row.original_work || "",
    exchangeType: row.exchange_type || "",
    description: row.description || "",
  }));
}

/**
 * 按摊位号查询 CPP 展品
 */
export async function getCPPItemsByBooth(eventId: string, boothNumber: string): Promise<NormalizedCPPItem[]> {
  const { data, error } = await supabase
    .from("cpp_items")
    .select("*")
    .eq("event_id", eventId)
    .eq("booth_number", boothNumber);

  if (error) throw error;

  return (data || []).map((row: any) => ({
    boothNumber: row.booth_number || "",
    boothName: row.booth_name || "",
    productName: row.product_name || "",
    author: row.author || "",
    imageUrl: row.image_url || "",
    tags: row.tags || [],
    eventName: "",
    sourceUrl: row.source_url || "",
    doujinshiId: row.doujinshi_id || 0,
    hotCount: row.hot_count || 0,
    originalWork: row.original_work || "",
    exchangeType: row.exchange_type || "",
    description: row.description || "",
  }));
}

/**
 * 按关键词搜索 CPP 展品
 */
export async function searchCPPItems(
  eventId: string,
  keyword: string,
  limit = 50
): Promise<NormalizedCPPItem[]> {
  const { data, error } = await supabase
    .from("cpp_items")
    .select("*")
    .eq("event_id", eventId)
    .ilike("product_name", `%${keyword}%`)
    .limit(limit);

  if (error) throw error;

  return (data || []).map((row: any) => ({
    boothNumber: row.booth_number || "",
    boothName: row.booth_name || "",
    productName: row.product_name || "",
    author: row.author || "",
    imageUrl: row.image_url || "",
    tags: row.tags || [],
    eventName: "",
    sourceUrl: row.source_url || "",
    doujinshiId: row.doujinshi_id || 0,
    hotCount: row.hot_count || 0,
    originalWork: row.original_work || "",
    exchangeType: row.exchange_type || "",
    description: row.description || "",
  }));
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
    price: row.price || undefined,
    quantity: row.quantity || 1,
    purchaseLimit: row.purchase_limit || undefined,
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
