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
import { normalizeWishItemLocation } from "@/lib/wish-item-sort";
import { dbRowToWishItem, getEventMembership } from "@/lib/db-service";
import { claimLegacyAccess, ensureAnonymousSession } from "@/lib/auth-client";
import { getClientId } from "@/lib/client-id";
import {
  getActiveOfflineUserId,
  findOfflineConflicts,
  mergeOfflineDrafts,
  offlineListKey,
  readOfflineList,
  setActiveOfflineUserId,
  writeOfflineList,
  type OfflineListRecord,
} from "@/lib/offline-list";
import { prepareOfflinePageCache, setManualOfflineCache } from "@/lib/offline-page-cache";

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
  const [manualOffline, setManualOffline] = useState(false);
  const [offlinePrepared, setOfflinePrepared] = useState(false);
  const [offlinePagePrepared, setOfflinePagePrepared] = useState(false);
  const [offlinePreparedAt, setOfflinePreparedAt] = useState<number | null>(null);
  const [offlinePendingCount, setOfflinePendingCount] = useState(0);
  const [offlineSyncing, setOfflineSyncing] = useState(false);
  const [offlineMessage, setOfflineMessage] = useState("");
  const itemsRef = useRef<WishItem[]>([]);
  const dirtyIdsRef = useRef(new Set<string>());
  const manualOfflineRef = useRef(false);
  const offlineUserIdRef = useRef("");
  const offlineRecordRef = useRef<OfflineListRecord | null>(null);
  const offlineWriteRef = useRef(Promise.resolve());
  itemsRef.current = items;
  manualOfflineRef.current = manualOffline;

  const queueOfflineWrite = useCallback((record: OfflineListRecord) => {
    offlineRecordRef.current = record;
    offlineWriteRef.current = offlineWriteRef.current.then(() => writeOfflineList(record));
    return offlineWriteRef.current;
  }, []);

  const saveOfflineDrafts = useCallback(async (drafts: WishItem[]) => {
    const currentRecord = offlineRecordRef.current;
    if (!currentRecord) throw new Error("离线数据尚未准备，请重新打开这份list");
    const nextRecord = mergeOfflineDrafts(currentRecord, itemsRef.current, drafts);
    itemsRef.current = nextRecord.items;
    setItems(nextRecord.items);
    setOfflinePendingCount(Object.keys(nextRecord.pending).length);
    await queueOfflineWrite(nextRecord);
    const nextById = new Map(nextRecord.items.map((item) => [item.id, item]));
    return drafts.map((draft) => nextById.get(draft.id)!);
  }, [queueOfflineWrite]);

  const recordConflict = useCallback((conflict: WishItemConflict) => {
    setConflicts((current) => [...current.filter((entry) => entry.itemId !== conflict.itemId), conflict]);
  }, []);

  const refresh = useCallback(async () => {
    if (manualOfflineRef.current) return;
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
        const activeUserId = getActiveOfflineUserId(eventId);
        if (activeUserId) {
          const cached = await readOfflineList(activeUserId, eventId);
          if (cached?.active) {
            offlineUserIdRef.current = activeUserId;
            offlineRecordRef.current = cached;
            setItems(cached.items);
            itemsRef.current = cached.items;
            setMembership(cached.membership);
            setEventInfo(cached.eventInfo);
            setManualOffline(true);
            manualOfflineRef.current = true;
            setOfflinePrepared(true);
            setOfflinePagePrepared(Boolean("serviceWorker" in navigator && navigator.serviceWorker.controller));
            setOfflinePreparedAt(cached.preparedAt);
            setOfflinePendingCount(Object.keys(cached.pending).length);
            setSyncStatus("offline");
            setReady(true);
            supabase.auth.stopAutoRefresh();
            return;
          }
          setActiveOfflineUserId(eventId, null);
        }

        const session = await ensureAnonymousSession();
        offlineUserIdRef.current = session.user.id;
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
        itemsRef.current = wishItems;
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
    if (!ready || manualOffline) return;
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
  }, [eventId, ready, manualOffline, recordConflict, refresh]);

  useEffect(() => {
    if (!ready || manualOffline || !eventInfo || !membership || !offlineUserIdRef.current) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      const record: OfflineListRecord = {
        key: offlineListKey(offlineUserIdRef.current, eventId),
        userId: offlineUserIdRef.current,
        eventId,
        active: false,
        eventInfo,
        membership,
        items: itemsRef.current,
        pending: {},
        preparedAt: now,
        updatedAt: now,
      };
      void queueOfflineWrite(record)
        .then(async () => {
          setOfflinePrepared(true);
          setOfflinePreparedAt(now);
          setOfflineMessage("");
          try {
            const pagePrepared = await prepareOfflinePageCache(itemsRef.current.map((item) => item.imageUrl || ""));
            if (pagePrepared && manualOfflineRef.current) await setManualOfflineCache(true);
            setOfflinePagePrepared(pagePrepared);
          } catch (error) {
            console.warn("完整离线页面准备失败，已保留基础离线模式:", error);
            setOfflinePagePrepared(false);
          }
        })
        .catch((error) => {
          console.error("准备基础离线数据失败:", error);
          setOfflinePrepared(false);
          setOfflinePagePrepared(false);
          setOfflineMessage(error instanceof Error ? error.message : "准备基础离线数据失败");
        });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [eventId, eventInfo, items, manualOffline, membership, queueOfflineWrite, ready]);

  const addItem = useCallback(async (item: Omit<WishItem, "id">) => {
    if (manualOfflineRef.current) throw new Error("离线模式暂不支持新增制品");
    const created = await createWishItemAsync(eventId, item);
    setItems((current) => current.some((entry) => entry.id === created.id) ? current : [...current, created]);
    return created;
  }, [eventId]);

  const updateItem = useCallback(async (itemId: string, updates: Partial<WishItem>) => {
    const current = itemsRef.current.find((item) => item.id === itemId);
    if (manualOfflineRef.current) {
      if (!current) return null;
      const saved = await saveOfflineDrafts([{ ...current, ...updates }]);
      return saved[0] || null;
    }
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
  }, [eventId, refresh, saveOfflineDrafts]);

  const updateItemLocally = useCallback((itemId: string, updates: Partial<WishItem>) => {
    dirtyIdsRef.current.add(itemId);
    const nextItems = itemsRef.current.map((item) => item.id === itemId ? { ...item, ...updates } : item);
    itemsRef.current = nextItems;
    setItems(nextItems);
  }, []);

  const saveItemDrafts = useCallback(async (itemIdsOrDrafts: string[] | WishItem[]) => {
    if (itemIdsOrDrafts.length === 0) return [];
    const draftSource = typeof itemIdsOrDrafts[0] === "string"
      ? itemsRef.current.filter((item) => (itemIdsOrDrafts as string[]).includes(item.id))
      : itemIdsOrDrafts as WishItem[];
    const drafts = draftSource.map(normalizeWishItemLocation);
    if (manualOfflineRef.current) return saveOfflineDrafts(drafts);
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
  }, [eventId, refresh, saveOfflineDrafts]);

  const removeItem = useCallback(async (itemId: string) => {
    if (manualOfflineRef.current) throw new Error("离线模式暂不支持删除制品");
    await deleteWishItemAsync(eventId, itemId);
    dirtyIdsRef.current.delete(itemId);
    setItems((current) => current.filter((item) => item.id !== itemId));
  }, [eventId]);

  const removeItems = useCallback(async (itemIds: string[]) => {
    if (manualOfflineRef.current) throw new Error("离线模式暂不支持删除制品");
    if (!itemIds.length) return;
    await deleteWishItemsAsync(eventId, itemIds);
    const ids = new Set(itemIds);
    itemIds.forEach((id) => dirtyIdsRef.current.delete(id));
    setItems((current) => current.filter((item) => !ids.has(item.id)));
  }, [eventId]);

  const addItems = useCallback(async (newItems: Omit<WishItem, "id">[]) => {
    if (manualOfflineRef.current) throw new Error("离线模式暂不支持新增制品");
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
    if (manualOfflineRef.current && offlineRecordRef.current) {
      const pending = { ...offlineRecordRef.current.pending };
      delete pending[itemId];
      const nextItems = conflict.remote
        ? itemsRef.current.map((item) => item.id === itemId ? conflict.remote! : item)
        : itemsRef.current.filter((item) => item.id !== itemId);
      itemsRef.current = nextItems;
      setOfflinePendingCount(Object.keys(pending).length);
      void queueOfflineWrite({ ...offlineRecordRef.current, items: nextItems, pending, updatedAt: Date.now() });
    }
  }, [conflicts, queueOfflineWrite]);

  const keepMyConflict = useCallback(async (itemId: string) => {
    const conflict = conflicts.find((entry) => entry.itemId === itemId);
    if (!conflict?.remote) return;
    const saved = await saveWishItemDraftsAsync(eventId, [{ ...conflict.local, version: conflict.remote.version }]);
    dirtyIdsRef.current.delete(itemId);
    setItems((current) => current.map((item) => item.id === itemId ? saved[0] : item));
    setConflicts((current) => current.filter((entry) => entry.itemId !== itemId));
    if (manualOfflineRef.current && offlineRecordRef.current) {
      const pending = { ...offlineRecordRef.current.pending };
      delete pending[itemId];
      const nextItems = itemsRef.current.map((item) => item.id === itemId ? saved[0] : item);
      itemsRef.current = nextItems;
      setOfflinePendingCount(Object.keys(pending).length);
      await queueOfflineWrite({ ...offlineRecordRef.current, items: nextItems, pending, updatedAt: Date.now() });
    }
  }, [conflicts, eventId, queueOfflineWrite]);

  const enterManualOffline = useCallback(async () => {
    const currentRecord = offlineRecordRef.current;
    if (!offlinePrepared || !currentRecord || !offlineUserIdRef.current) {
      throw new Error(offlineMessage || "离线数据尚未准备完成，请保持网络后重试");
    }
    await offlineWriteRef.current;
    const nextRecord = { ...currentRecord, active: true, items: itemsRef.current, updatedAt: Date.now() };
    await queueOfflineWrite(nextRecord);
    setActiveOfflineUserId(eventId, offlineUserIdRef.current);
    if (offlinePagePrepared) {
      await setManualOfflineCache(true).catch((error) => {
        console.warn("完整离线页面未能启用，继续使用基础离线模式:", error);
        setOfflinePagePrepared(false);
      });
    }
    supabase.auth.stopAutoRefresh();
    manualOfflineRef.current = true;
    setManualOffline(true);
    setSyncStatus("offline");
    setOfflineMessage("已进入离线模式，修改将保存在本机");
  }, [eventId, offlineMessage, offlinePagePrepared, offlinePrepared, queueOfflineWrite]);

  const exitManualOfflineAndSync = useCallback(async () => {
    const record = offlineRecordRef.current;
    if (!record || offlineSyncing) return;
    setOfflineSyncing(true);
    setOfflineMessage("");
    await setManualOfflineCache(false).catch(() => undefined);
    supabase.auth.startAutoRefresh();
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user || userData.user.id !== record.userId) {
        throw new Error("登录状态不可用，请连接稳定网络后重试");
      }
      const remoteItems = await getWishItemsAsync(eventId);
      const pendingEntries = Object.values(record.pending);
      const nextConflicts = findOfflineConflicts(record.pending, remoteItems);
      if (nextConflicts.length > 0) {
        setConflicts(nextConflicts);
        throw new Error(`发现 ${nextConflicts.length} 条协作冲突，请先选择保留哪份修改`);
      }
      if (pendingEntries.length > 0) {
        await saveWishItemDraftsAsync(eventId, pendingEntries.map((entry) => ({
          ...entry.item,
          version: entry.baseVersion,
        })));
      }
      const freshItems = await getWishItemsAsync(eventId);
      const now = Date.now();
      const nextRecord = {
        ...record,
        active: false,
        items: freshItems,
        pending: {},
        preparedAt: now,
        updatedAt: now,
      };
      itemsRef.current = freshItems;
      setItems(freshItems);
      setOfflinePendingCount(0);
      await queueOfflineWrite(nextRecord);
      setActiveOfflineUserId(eventId, null);
      manualOfflineRef.current = false;
      setManualOffline(false);
      setSyncStatus("connecting");
      setOfflineMessage(`已同步 ${pendingEntries.length} 项修改，已恢复在线模式`);
    } catch (error) {
      if (offlinePagePrepared) await setManualOfflineCache(true).catch(() => undefined);
      supabase.auth.stopAutoRefresh();
      setSyncStatus("offline");
      const message = error instanceof Error ? error.message : "同步失败，请稍后重试";
      setOfflineMessage(message);
      throw error;
    } finally {
      setOfflineSyncing(false);
    }
  }, [eventId, offlinePagePrepared, offlineSyncing, queueOfflineWrite]);

  return {
    items, eventInfo, membership, loading, accessDenied, loadError, syncStatus, conflicts,
    addItem, updateItem, updateItemLocally, saveItemDrafts, removeItem, removeItems, addItems, refresh,
    useLatestConflict, keepMyConflict,
    manualOffline, offlinePrepared, offlinePagePrepared, offlinePreparedAt, offlinePendingCount, offlineSyncing, offlineMessage,
    enterManualOffline, exitManualOfflineAndSync,
  };
}
