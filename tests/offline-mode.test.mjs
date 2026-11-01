import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { findOfflineConflicts, mergeOfflineDrafts } from "../lib/offline-list.ts";
import { prepareOfflinePageCache } from "../lib/offline-page-cache.ts";

function item(id, version, overrides = {}) {
  return {
    id,
    version,
    boothNumber: "壹A01",
    productName: `制品${id}`,
    status: "pending",
    type: "paid",
    quantity: 1,
    ...overrides,
  };
}

function record(items) {
  return {
    key: "user:event",
    userId: "user",
    eventId: "event",
    active: true,
    eventInfo: { name: "CPG08", date: "8.22-8.23" },
    membership: { role: "owner", isCreator: true, memberCount: 1, collaboratorCount: 0 },
    items,
    pending: {},
    preparedAt: 1,
    updatedAt: 1,
  };
}

test("离线修改立即写入快照，并在多次修改时保留最初云端版本", () => {
  const original = item("one", 7);
  const first = mergeOfflineDrafts(record([original]), [original], [{ ...original, status: "purchased" }], 2);
  const second = mergeOfflineDrafts(first, first.items, [{ ...first.items[0], quantity: 3, version: 99 }], 3);

  assert.equal(second.items[0].status, "purchased");
  assert.equal(second.items[0].quantity, 3);
  assert.equal(second.pending.one.baseVersion, 7);
  assert.equal(second.pending.one.item.version, 7);
  assert.equal(Object.keys(second.pending).length, 1);
});

test("恢复同步前能识别协作者更新和删除，不把冲突内容直接覆盖", () => {
  const localA = item("a", 2, { status: "purchased" });
  const localB = item("b", 4, { quantity: 2 });
  const pending = {
    a: { item: localA, baseVersion: 2 },
    b: { item: localB, baseVersion: 4 },
  };
  const conflicts = findOfflineConflicts(pending, [item("a", 3)]);

  assert.deepEqual(conflicts.map(({ itemId, kind }) => ({ itemId, kind })), [
    { itemId: "a", kind: "updated" },
    { itemId: "b", kind: "deleted" },
  ]);
});

test("手机版用离线入口替换编辑入口，离线时停用新增删除和图片上传", async () => {
  const page = await readFile(new URL("../app/exhibit/[id]/page.tsx", import.meta.url), "utf8");
  const mobile = await readFile(new URL("../components/MobileTableView.tsx", import.meta.url), "utf8");

  assert.match(page, /sm:hidden[\s\S]*进入离线模式/);
  assert.match(page, /hidden[\s\S]*sm:flex[\s\S]*编辑模式/);
  assert.match(page, /!editMode && !manualOffline/);
  assert.match(mobile, /离线模式暂不支持上传图片/);
  assert.match(mobile, /!manualOffline && swipedItemId/);
  assert.match(mobile, /!manualOffline && \(/);
});

test("手动离线 Service Worker 优先读缓存，不会在弱网中自动重试", async () => {
  const worker = await readFile(new URL("../public/offline-list-sw.js", import.meta.url), "utf8");
  const offlineBranch = worker.slice(worker.indexOf("if (offlineRoute)"), worker.indexOf("try {", worker.indexOf("if (offlineRoute)")));

  assert.match(offlineBranch, /cache\.match/);
  assert.doesNotMatch(offlineBranch, /fetch\(/);
  assert.match(worker, /SET_MANUAL_OFFLINE/);
});

test("离线准备会收集当前页面引用的脚本与样式", async () => {
  const cacheModule = await readFile(new URL("../lib/offline-page-cache.ts", import.meta.url), "utf8");

  assert.match(cacheModule, /script\[src\]/);
  assert.match(cacheModule, /link\[href\]/);
});

test("首次注册后使用 ready 返回的已激活 Worker，不读取注册前的过期状态", async () => {
  const cacheModule = await readFile(new URL("../lib/offline-page-cache.ts", import.meta.url), "utf8");

  assert.match(cacheModule, /const readyRegistration = await navigator\.serviceWorker\.ready/);
  assert.match(cacheModule, /navigator\.serviceWorker\.controller \|\| readyRegistration\.active/);
  assert.doesNotMatch(cacheModule, /^\s*await navigator\.serviceWorker\.ready;\s*$/m);
});

test("没有 Service Worker 时保留基础离线，不再把整个离线模式判为不可用", async () => {
  const cacheModule = await readFile(new URL("../lib/offline-page-cache.ts", import.meta.url), "utf8");
  const hook = await readFile(new URL("../hooks/useExhibitData.ts", import.meta.url), "utf8");

  assert.match(cacheModule, /if \(!worker\) return false/);
  assert.match(cacheModule, /return true/);
  assert.match(hook, /setOfflinePrepared\(true\)[\s\S]*await prepareOfflinePageCache/);
  assert.match(hook, /完整离线页面准备失败，已保留基础离线模式/);
  assert.match(hook, /if \(pagePrepared && manualOfflineRef\.current\) await setManualOfflineCache\(true\)/);
  assert.match(hook, /if \(offlinePagePrepared\) \{[\s\S]*setManualOfflineCache\(true\)\.catch/);
});

test("运行环境没有离线页面能力时返回降级结果而不是抛错", async () => {
  assert.equal(await prepareOfflinePageCache([]), false);
});

test("基础离线恢复同步不依赖 Service Worker", async () => {
  const hook = await readFile(new URL("../hooks/useExhibitData.ts", import.meta.url), "utf8");

  assert.match(hook, /setManualOfflineCache\(false\)\.catch\(\(\) => undefined\)/);
  assert.match(hook, /if \(offlinePagePrepared\) await setManualOfflineCache\(true\)\.catch/);
});

test("手机端明确区分基础离线和完整离线的使用限制", async () => {
  const page = await readFile(new URL("../app/exhibit/[id]/page.tsx", import.meta.url), "utf8");

  assert.match(page, /完整离线已准备好/);
  assert.match(page, /基础离线已准备好/);
  assert.match(page, /请勿关闭或刷新页面/);
});
