import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function loadLocationHelpers() {
  const source = read("lib/wish-item-sort.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replace(/^import .*$/gm, "")
    .replace(/^export\s+/gm, "");

  return Function(`${compiled}\nreturn { getWishItemVenue, normalizeWishItemLocation };`)();
}

test("creator booths keep their booth number and never infer a venue", () => {
  const { getWishItemVenue, normalizeWishItemLocation } = loadLocationHelpers();
  assert.equal(getWishItemVenue({ boothNumber: "创064", venue: "壹" }), "");
  assert.equal(getWishItemVenue({ boothNumber: "创００７", venue: "伍" }), "");
  assert.equal(getWishItemVenue({ boothNumber: "壹A01" }), "壹");
  assert.deepEqual(
    normalizeWishItemLocation({ id: "1", boothNumber: "创064", venue: "创", productName: "test", status: "pending" }),
    { id: "1", boothNumber: "创064", venue: "", productName: "test", status: "pending" }
  );
});

test("export removes the image URL column but keeps embedded images in column E", () => {
  const source = read("app/exhibit/[id]/page.tsx");
  assert.doesNotMatch(source, /header:\s*"图片链接"/);
  assert.match(source, /worksheet\.addImage\(imageId,[\s\S]*?col:\s*4\.15/);
});

test("draft state is updated synchronously before saving", () => {
  const hook = read("hooks/useExhibitData.ts");
  assert.match(hook, /itemsRef\.current = nextItems;\s*setItems\(nextItems\);/);
  assert.match(hook, /itemsRef\.current = optimisticItems;\s*setItems\(optimisticItems\);/);
  assert.match(hook, /const drafts = draftSource\.map\(normalizeWishItemLocation\);/);

  const page = read("app/exhibit/[id]/page.tsx");
  assert.match(page, /await saveItemDrafts\(Array\.from\(dirtyIds\)\);/);
  assert.doesNotMatch(page, /const drafts = items\s*\.filter\(\(item\) => dirtyIds\.has\(item\.id\)\)/);
});

test("mobile drawer keeps its content scrollable and actions reachable", () => {
  const source = read("components/MobileTableView.tsx");
  assert.match(source, /max-h-\[92dvh\][^"\n]*min-h-0[^"\n]*overflow-hidden/);
  assert.match(source, /min-h-0 flex-1 overflow-y-auto px-4 pb-6/);
});

test("mobile drawer adopts the saved row version before another edit", () => {
  const mobile = read("components/MobileTableView.tsx");
  const page = read("app/exhibit/[id]/page.tsx");

  assert.match(mobile, /onSaveItem: \(item: WishItem\) => Promise<WishItem>/);
  assert.match(mobile, /const savedItem = await onSaveItem\(drawerItem\);\s*setDrawerItem\(savedItem\);/);
  assert.match(page, /const savedItems = await saveItemDrafts\(\[normalizedItem\]\);/);
  assert.match(page, /return savedItem;/);
});

test("free items keep the note editor available", () => {
  const source = read("components/MobileTableView.tsx");
  assert.match(source, /<EditField label="备注"[\s\S]{0,250}handleDrawerUpdate\("note", v\)/);
  assert.doesNotMatch(source, /drawerItem\.type !== "free"\s*&&\s*\([\s\S]{0,300}<EditField label="备注"/);
});

test("new lists enter edit mode once and emphasize the save action", () => {
  const home = read("app/page.tsx");
  const detail = read("app/exhibit/[id]/page.tsx");

  assert.match(home, /router\.push\(`\/exhibit\/\$\{listId\}\?edit=1`\)/);
  assert.match(home, /router\.push\(`\/exhibit\/\$\{data\.eventId\}`\)/);
  assert.match(detail, /url\.searchParams\.get\("edit"\) !== "1"/);
  assert.match(detail, /setEditMode\(true\);[\s\S]{0,120}url\.searchParams\.delete\("edit"\)/);
  assert.match(detail, /bg-amber-500 text-white shadow-md ring-2 ring-amber-200/);
});

test("mobile list displays priority and the drawer can edit it", () => {
  const source = read("components/MobileTableView.tsx");

  assert.match(source, /const PRIORITY_OPTIONS: Priority\[\] = \["首摊", "次摊", "P1", "P2", "P3", "随缘"\]/);
  assert.match(source, /PRIORITY_COLOR\[item\.priority \|\| "随缘"\]/);
  assert.match(source, /\{item\.priority \|\| "随缘"\}/);
  assert.match(source, /PRIORITY_OPTIONS\.map\(\(priority\) =>/);
  assert.match(source, /handleDrawerUpdate\("priority", priority\)/);
  assert.match(source, /PRIORITY_COLOR\[drawerItem\.priority \|\| "随缘"\]/);
});
