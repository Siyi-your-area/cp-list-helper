/**
 * Storage 层 — 统一从 Supabase 读写
 *
 * 保持与之前相同的函数签名，页面代码无需大改。
 */

import type { Exhibit, WishItem } from "./types";
import {
  getExhibitsFromDB,
  createExhibitInDB,
  deleteExhibitFromDB,
  getWishItems,
  createWishItem,
  createWishItems,
  updateWishItem,
  saveWishItemDrafts,
  deleteWishItem,
  deleteWishItems,
  batchUpdateWishItems,
} from "./db-service";

// ============================================================
// 展会 CRUD（保持旧签名，内部改为 Supabase）
// ============================================================

export function getExhibits(): Exhibit[] {
  // 同步版本返回空数组，页面用 getExhibitsAsync
  return [];
}

export async function getExhibitsAsync(clientId?: string): Promise<Exhibit[]> {
  void clientId;
  return getExhibitsFromDB();
}

export function createExhibit(name: string, _venue: string, date: string): Exhibit {
  // 同步版本不再支持，页面用 createExhibitAsync
  throw new Error("请使用 createExhibitAsync");
}

export async function createExhibitAsync(
  id: string,
  name: string,
  days: { id: string; name: string }[],
  cppEventId?: string,
  clientId?: string
): Promise<Exhibit> {
  return createExhibitInDB(id, name, days, cppEventId, clientId);
}

export function deleteExhibit(id: string): boolean {
  // 同步版本不再支持
  throw new Error("请使用 deleteExhibitAsync");
}

export async function deleteExhibitAsync(id: string, clientId?: string): Promise<boolean> {
  return deleteExhibitFromDB(id, clientId);
}

// ============================================================
// 心愿单 CRUD
// ============================================================

export async function getWishItemsAsync(eventId: string): Promise<WishItem[]> {
  return getWishItems(eventId);
}

export async function createWishItemAsync(
  eventId: string,
  item: Omit<WishItem, "id">
): Promise<WishItem> {
  return createWishItem(eventId, item);
}

export async function createWishItemsAsync(
  eventId: string,
  items: Omit<WishItem, "id">[]
): Promise<WishItem[]> {
  return createWishItems(eventId, items);
}

export async function updateWishItemAsync(
  eventId: string,
  itemId: string,
  updates: Partial<WishItem>
): Promise<WishItem | null> {
  return updateWishItem(eventId, itemId, updates, updates.version);
}

export async function saveWishItemDraftsAsync(
  eventId: string,
  items: WishItem[]
): Promise<WishItem[]> {
  return saveWishItemDrafts(eventId, items);
}

export async function deleteWishItemAsync(eventId: string, itemId: string): Promise<boolean> {
  return deleteWishItem(eventId, itemId);
}

export async function deleteWishItemsAsync(eventId: string, itemIds: string[]): Promise<boolean> {
  return deleteWishItems(eventId, itemIds);
}

export async function batchUpdateWishItemsAsync(
  eventId: string,
  itemIds: string[],
  updates: Partial<WishItem>
): Promise<void> {
  return batchUpdateWishItems(eventId, itemIds, updates);
}
