import type { EventMembership, WishItem, WishItemConflict } from "./types";

export interface OfflinePendingItem {
  item: WishItem;
  baseVersion: number;
}

export interface OfflineListRecord {
  key: string;
  userId: string;
  eventId: string;
  active: boolean;
  eventInfo: { name: string; date: string; cppEventId?: string };
  membership: EventMembership;
  items: WishItem[];
  pending: Record<string, OfflinePendingItem>;
  preparedAt: number;
  updatedAt: number;
}

const DB_NAME = "cp-list-helper-offline";
const STORE_NAME = "lists";
const DB_VERSION = 1;
const ACTIVE_KEY_PREFIX = "cp-list-helper:offline-active:";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("当前浏览器不支持离线存储"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开离线存储"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("离线存储操作失败"));
  });
}

export function offlineListKey(userId: string, eventId: string): string {
  return `${userId}:${eventId}`;
}

export function getActiveOfflineUserId(eventId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(`${ACTIVE_KEY_PREFIX}${eventId}`);
}

export function setActiveOfflineUserId(eventId: string, userId: string | null): void {
  if (typeof localStorage === "undefined") return;
  const key = `${ACTIVE_KEY_PREFIX}${eventId}`;
  if (userId) localStorage.setItem(key, userId);
  else localStorage.removeItem(key);
}

export async function readOfflineList(
  userId: string,
  eventId: string
): Promise<OfflineListRecord | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const result = await requestResult(
      transaction.objectStore(STORE_NAME).get(offlineListKey(userId, eventId))
    );
    return (result as OfflineListRecord | undefined) || null;
  } finally {
    database.close();
  }
}

export async function writeOfflineList(record: OfflineListRecord): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    await requestResult(transaction.objectStore(STORE_NAME).put(record));
  } finally {
    database.close();
  }
}

export function mergeOfflineDrafts(
  record: OfflineListRecord,
  currentItems: WishItem[],
  drafts: WishItem[],
  now = Date.now()
): OfflineListRecord {
  const pending = { ...record.pending };
  const draftById = new Map(drafts.map((item) => [item.id, item]));
  const items = currentItems.map((item) => draftById.get(item.id) || item);
  for (const item of draftById.values()) {
    const existing = pending[item.id];
    const baseVersion = existing?.baseVersion ?? item.version;
    if (baseVersion === undefined) throw new Error(`条目 ${item.productName} 缺少版本，无法离线保存`);
    pending[item.id] = { item: { ...item, version: baseVersion }, baseVersion };
  }
  return { ...record, items, pending, updatedAt: now };
}

export function findOfflineConflicts(
  pending: Record<string, OfflinePendingItem>,
  remoteItems: WishItem[]
): WishItemConflict[] {
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
  const conflicts: WishItemConflict[] = [];
  for (const entry of Object.values(pending)) {
    const remote = remoteById.get(entry.item.id) || null;
    if (!remote) {
      conflicts.push({ itemId: entry.item.id, kind: "deleted", local: entry.item, remote });
      continue;
    }
    if (remote.version !== entry.baseVersion) {
      conflicts.push({ itemId: entry.item.id, kind: "updated", local: entry.item, remote });
    }
  }
  return conflicts;
}
