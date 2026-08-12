"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EventMembership, SyncStatus, WishItem, WishItemConflict } from "@/lib/types";
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
import { dbRowToWishItem, getEventMembership } from "@/lib/db-service";
import { claimLegacyAccess, ensureAnonymousSession } from "@/lib/auth-client";
import { getClientId } from "@/lib/client-id";

function isConflictError(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value?.code === "40001" || Boolean(value?.message?.includes("WISH_ITEM_CONFLICT"));
}

export function useExhibitData(eventId: string) {
  const [items, setItems] = useState<WishItem[]>([]);
  const [eventInfo, setEventInfo] = useState<{ name: string; date: string; cppEventId?: string } | null>(null);
  const [membership, setMembership] = useState<EventMembership | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  const [conflicts, setConflicts] = useState<WishItemConflict[]>([]);
  const [ready, setReady] = useState(false);
  const itemsRef = useRef<WishItem[]>([]);
  const dirtyIdsRef = useRef(new Set<string>());
  itemsRef.current = items;

  const recordConflict = useCallback((conflict: WishItemConflict) => {
    setConflicts((current) => [...current.filter((entry) => entry.itemId !== conflict.itemId), conflict]);
  }, []);

  const refresh = useCallback(async () => {
    const remoteItems = await getWishItemsAsync(eventId);
    const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
    setItems((current) => {
      const next = remoteItems.map((remote) => {
        const local = current.find((item) => item.id === remote.id);
        if (local && dirtyIdsRef.current.has(remote.id)) {
          if (local.version !== remote.version) recordConflict({ itemId: remote.id, kind: "updated", local, remote });
          return local;
        }
        return remote;
      });
      for (const local of current) {
        if (!remoteById.has(local.id) && dirtyIdsRef.current.has(local.id)) {
          recordConflict({ itemId: local.id, kind: "deleted", local, remote: null });
          next.push(local);
        }
      }
      return next;
    });
  }, [eventId, recordConflict]);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError("");
      setAccessDenied(false);
      try {
        await ensureAnonymousSession();
        await claimLegacyAccess(getClientId());
        const member = await getEventMembership(eventId);
        if (!member) {
          if (!cancelled) setAccessDenied(true);
          return;
        }
        const { data: eventData, error: eventError } = await supabase
          .from("events")
          .select("name, days, cpp_event_id")
          .eq("id", eventId)
          .single();
        if (eventError) throw eventError;
        const wishItems = await getWishItemsAsync(eventId);
        if (cancelled) return;
        setMembership(member);
        setEventInfo({
          name: eventData.name,
          date: (eventData.days || []).map((day: { name: string }) => day.name).join(" / "),
          cppEventId: eventData.cpp_event_id || undefined,
        });
        setItems(wishItems);
        setReady(true);
      } catch (error) {
        console.error("加载展会数据失败:", error);
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "身份或数据加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId]);

  useEffect(() => {
    if (!ready) return;
    const channel = supabase
      .channel(`wish-items:${eventId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "wish_items", filter: `event_id=eq.${eventId}` }, (payload) => {
        const row = payload.eventType === "DELETE" ? payload.old : payload.new;
        const itemId = String(row.id || "");
        if (!itemId) return;
        const local = itemsRef.current.find((item) => item.id === itemId);
        if (payload.eventType === "DELETE") {
          if (local && dirtyIdsRef.current.has(itemId)) {
            recordConflict({ itemId, kind: "deleted", local, remote: null });
          } else {
            setItems((current) => current.filter((item) => item.id !== itemId));
          }
          return;
        }
        const remote = dbRowToWishItem(row);
        if (local && dirtyIdsRef.current.has(itemId)) {
          if (local.version !== remote.version) recordConflict({ itemId, kind: "updated", local, remote });
          return;
        }
        setItems((current) => {
          const exists = current.some((item) => item.id === itemId);
          return exists ? current.map((item) => item.id === itemId ? remote : item) : [...current, remote];
        });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setSyncStatus("live");
          // 补齐初始查询结束到 Realtime 订阅建立之间的变更窗口。
          void refresh();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setSyncStatus("reconnecting");
        } else if (status === "CLOSED") {
          setSyncStatus("offline");
        }
      });
    const online = () => { setSyncStatus("reconnecting"); void refresh(); };
    const offline = () => setSyncStatus("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      void supabase.removeChannel(channel);
    };
  }, [eventId, ready, recordConflict, refresh]);

  const addItem = useCallback(async (item: Omit<WishItem, "id">) => {
    const created = await createWishItemAsync(eventId, item);
    setItems((current) => current.some((entry) => entry.id === created.id) ? current : [...current, created]);
    return created;
  }, [eventId]);

  const updateItem = useCallback(async (itemId: string, updates: Partial<WishItem>) => {
    const current = itemsRef.current.find((item) => item.id === itemId);
    try {
      const updated = await updateWishItemAsync(eventId, itemId, { ...updates, version: current?.version });
      if (updated) setItems((all) => all.map((item) => item.id === itemId ? updated : item));
      return updated;
    } catch (error) {
      if (current && isConflictError(error)) {
        dirtyIdsRef.current.add(itemId);
        setItems((all) => all.map((item) => item.id === itemId ? { ...item, ...updates } : item));
        await refresh();
      }
      throw error;
    }
  }, [eventId, refresh]);

  const updateItemLocally = useCallback((itemId: string, updates: Partial<WishItem>) => {
    dirtyIdsRef.current.add(itemId);
    const nextItems = itemsRef.current.map((item) => item.id === itemId ? { ...item, ...updates } : item);
    itemsRef.current = nextItems;
    setItems(nextItems);
  }, []);

  const saveItemDrafts = useCallback(async (itemIdsOrDrafts: string[] | WishItem[]) => {
    if (itemIdsOrDrafts.length === 0) return [];
    const drafts = typeof itemIdsOrDrafts[0] === "string"
      ? itemsRef.current.filter((item) => (itemIdsOrDrafts as string[]).includes(item.id))
      : itemIdsOrDrafts as WishItem[];
    drafts.forEach((item) => dirtyIdsRef.current.add(item.id));
    const draftById = new Map(drafts.map((item) => [item.id, item]));
    const optimisticItems = itemsRef.current.map((item) => draftById.get(item.id) || item);
    itemsRef.current = optimisticItems;
    setItems(optimisticItems);
    try {
      const saved = await saveWishItemDraftsAsync(eventId, drafts);
      const savedById = new Map(saved.map((item) => [item.id, item]));
      saved.forEach((item) => dirtyIdsRef.current.delete(item.id));
      const savedIds = new Set(saved.map((item) => item.id));
      setConflicts((current) => current.filter((entry) => !savedIds.has(entry.itemId)));
      const nextItems = itemsRef.current.map((item) => savedById.get(item.id) || item);
      itemsRef.current = nextItems;
      setItems(nextItems);
      return saved;
    } catch (error) {
      if (isConflictError(error)) await refresh();
      throw error;
    }
  }, [eventId, refresh]);

  const removeItem = useCallback(async (itemId: string) => {
    await deleteWishItemAsync(eventId, itemId);
    dirtyIdsRef.current.delete(itemId);
    setItems((current) => current.filter((item) => item.id !== itemId));
  }, [eventId]);

  const removeItems = useCallback(async (itemIds: string[]) => {
    if (!itemIds.length) return;
    await deleteWishItemsAsync(eventId, itemIds);
    const ids = new Set(itemIds);
    itemIds.forEach((id) => dirtyIdsRef.current.delete(id));
    setItems((current) => current.filter((item) => !ids.has(item.id)));
  }, [eventId]);

  const addItems = useCallback(async (newItems: Omit<WishItem, "id">[]) => {
    const created = await createWishItemsAsync(eventId, newItems);
    setItems((current) => {
      const ids = new Set(current.map((item) => item.id));
      return [...current, ...created.filter((item) => !ids.has(item.id))];
    });
    return created;
  }, [eventId]);

  const useLatestConflict = useCallback((itemId: string) => {
    const conflict = conflicts.find((entry) => entry.itemId === itemId);
    if (!conflict) return;
    dirtyIdsRef.current.delete(itemId);
    setItems((current) => conflict.remote
      ? current.map((item) => item.id === itemId ? conflict.remote! : item)
      : current.filter((item) => item.id !== itemId));
    setConflicts((current) => current.filter((entry) => entry.itemId !== itemId));
  }, [conflicts]);

  const keepMyConflict = useCallback(async (itemId: string) => {
    const conflict = conflicts.find((entry) => entry.itemId === itemId);
    if (!conflict?.remote) return;
    const saved = await saveWishItemDraftsAsync(eventId, [{ ...conflict.local, version: conflict.remote.version }]);
    dirtyIdsRef.current.delete(itemId);
    setItems((current) => current.map((item) => item.id === itemId ? saved[0] : item));
    setConflicts((current) => current.filter((entry) => entry.itemId !== itemId));
  }, [conflicts, eventId]);

  return {
    items, eventInfo, membership, loading, accessDenied, loadError, syncStatus, conflicts,
    addItem, updateItem, updateItemLocally, saveItemDrafts, removeItem, removeItems, addItems, refresh,
    useLatestConflict, keepMyConflict,
  };
}
