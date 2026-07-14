"use client";

import { useState, useEffect, useCallback } from "react";
import type { WishItem } from "@/lib/types";
import {
  getWishItemsAsync,
  createWishItemAsync,
  updateWishItemAsync,
  deleteWishItemAsync,
} from "@/lib/storage";
import { supabase } from "@/lib/supabase";

/**
 * 展会数据 hook — 替代旧的 localStorage 模式
 *
 * 从 Supabase 加载心愿单，提供增删改查方法。
 */
export function useExhibitData(eventId: string) {
  const [items, setItems] = useState<WishItem[]>([]);
  const [eventInfo, setEventInfo] = useState<{ name: string; date: string } | null>(null);
  const [loading, setLoading] = useState(true);

  // 加载数据
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        // 加载展会信息
        const { data: eventData } = await supabase
          .from("events")
          .select("name, days")
          .eq("id", eventId)
          .single();

        if (eventData) {
          const days = eventData.days || [];
          setEventInfo({
            name: eventData.name,
            date: days.map((d: any) => d.name).join(" / "),
          });
        }

        // 加载心愿单
        const wishItems = await getWishItemsAsync(eventId);
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

  // 删除条目
  const removeItem = useCallback(async (itemId: string) => {
    await deleteWishItemAsync(eventId, itemId);
    setItems((prev) => prev.filter((item) => item.id !== itemId));
  }, [eventId]);

  // 批量添加（Excel 导入）
  const addItems = useCallback(async (newItems: Omit<WishItem, "id">[]) => {
    const results: WishItem[] = [];
    for (const item of newItems) {
      const created = await createWishItemAsync(eventId, item);
      results.push(created);
    }
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
    addItem,
    updateItem,
    removeItem,
    addItems,
    refresh,
  };
}
