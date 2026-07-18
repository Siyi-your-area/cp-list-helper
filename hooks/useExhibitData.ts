"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { WishItem } from "@/lib/types";
import {
  getWishItemsAsync,
  createWishItemAsync,
  createWishItemsAsync,
  updateWishItemAsync,
  saveWishItemDraftsAsync,
  deleteWishItemAsync,
  deleteWishItemsAsync,
} from "@/lib/storage";
import { supabase } from "@/lib/supabase";
import { hasEventAccess } from "@/lib/db-service";
import { getClientId } from "@/lib/client-id";

/**
 * 展会数据 hook — 替代旧的 localStorage 模式
 *
 * 从 Supabase 加载心愿单，提供增删改查方法。
 */
export function useExhibitData(eventId: string) {
  const [items, setItems] = useState<WishItem[]>([]);
  const [eventInfo, setEventInfo] = useState<{ name: string; date: string; cppEventId?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const itemsRef = useRef<WishItem[]>([]);
  itemsRef.current = items;

  // 加载数据
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setAccessDenied(false);
      try {
        const clientId = getClientId();
        const accessPromise = hasEventAccess(eventId, clientId);
        const eventPromise = supabase
          .from("events")
          .select("name, days, cpp_event_id")
          .eq("id", eventId)
          .single();
        const itemsPromise = getWishItemsAsync(eventId);

        const [allowed, eventResult, wishItems] = await Promise.all([
          accessPromise,
          eventPromise,
          itemsPromise,
        ]);

        if (!allowed) {
          if (!cancelled) {
            setEventInfo(null);
            setItems([]);
            setAccessDenied(true);
          }
          return;
        }

        const { data: eventData, error: eventError } = eventResult;
        if (eventError) throw eventError;

        if (eventData) {
          const days = eventData.days || [];
          setEventInfo({
            name: eventData.name,
            date: days.map((d: any) => d.name).join(" / "),
            cppEventId: eventData.cpp_event_id || undefined,
          });
        }

        if (!cancelled) setItems(wishItems);
      } catch (error) {
        console.error("加载展会数据失败:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [eventId]);

  // 添加条目
  const addItem = useCallback(async (item: Omit<WishItem, "id">) => {
    const newItem = await createWishItemAsync(eventId, item);
    setItems((prev) => [...prev, newItem]);
    return newItem;
  }, [eventId]);

  // 更新条目
  const updateItem = useCallback(async (itemId: string, updates: Partial<WishItem>) => {
    const updated = await updateWishItemAsync(eventId, itemId, updates);
    if (updated) {
      setItems((prev) => prev.map((item) => (item.id === itemId ? updated : item)));
    }
    return updated;
  }, [eventId]);

  const updateItemLocally = useCallback((itemId: string, updates: Partial<WishItem>) => {
    setItems((prev) => prev.map((item) => (
      item.id === itemId ? { ...item, ...updates } : item
    )));
  }, []);

  const saveItemDrafts = useCallback(async (itemIdsOrDrafts: string[] | WishItem[]) => {
    if (itemIdsOrDrafts.length === 0) return [];
    const drafts = typeof itemIdsOrDrafts[0] === "string"
      ? itemsRef.current.filter((item) => (itemIdsOrDrafts as string[]).includes(item.id))
      : itemIdsOrDrafts as WishItem[];
    const saved = await saveWishItemDraftsAsync(eventId, drafts);
    const savedById = new Map(saved.map((item) => [item.id, item]));
    setItems((current) => current.map((item) => savedById.get(item.id) || item));
    return saved;
  }, [eventId]);

  // 删除条目
  const removeItem = useCallback(async (itemId: string) => {
    await deleteWishItemAsync(eventId, itemId);
    setItems((prev) => prev.filter((item) => item.id !== itemId));
  }, [eventId]);

  const removeItems = useCallback(async (itemIds: string[]) => {
    if (itemIds.length === 0) return;
    await deleteWishItemsAsync(eventId, itemIds);
    const idSet = new Set(itemIds);
    setItems((prev) => prev.filter((item) => !idSet.has(item.id)));
  }, [eventId]);

  // 批量添加（Excel 导入）
  const addItems = useCallback(async (newItems: Omit<WishItem, "id">[]) => {
    const results = await createWishItemsAsync(eventId, newItems);
    setItems((prev) => [...prev, ...results]);
    return results;
  }, [eventId]);

  // 刷新
  const refresh = useCallback(async () => {
    const wishItems = await getWishItemsAsync(eventId);
    setItems(wishItems);
  }, [eventId]);

  return {
    items,
    eventInfo,
    loading,
    accessDenied,
    addItem,
    updateItem,
    updateItemLocally,
    saveItemDrafts,
    removeItem,
    removeItems,
    addItems,
    refresh,
  };
}
