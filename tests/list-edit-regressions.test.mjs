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

test("CPG08 creator booths keep their booth number and resolve to venue 贰", () => {
  const { getWishItemVenue, normalizeWishItemLocation } = loadLocationHelpers();
  assert.equal(getWishItemVenue({ boothNumber: "创064", venue: "壹" }), "贰");
  assert.equal(getWishItemVenue({ boothNumber: "创００７", venue: "伍" }), "贰");
  assert.equal(getWishItemVenue({ boothNumber: "壹A01" }), "壹");
  assert.deepEqual(
    normalizeWishItemLocation({ id: "1", boothNumber: "创064", venue: "创", productName: "test", status: "pending" }),
    { id: "1", boothNumber: "创064", venue: "贰", productName: "test", status: "pending" }
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

test("mobile first image upload is saved with the complete drawer draft", () => {
  const mobile = read("components/MobileTableView.tsx");
  const page = read("app/exhibit/[id]/page.tsx");

  assert.match(mobile, /onSaveItem: \(item: WishItem\) => Promise<WishItem>/);
  assert.match(mobile, /readImageFileAsDataUrl\(file, setImageUploadProgress\)/);
  assert.match(mobile, /handleDrawerUpdate\("imageUrl", dataUrl\)/);
  assert.match(mobile, /const savedItem = await onSaveItem\(drawerItem\);\s*setDrawerItem\(savedItem\);/);
  assert.match(page, /const savedItems = await saveItemDrafts\(\[normalizedItem\]\);/);
  assert.match(page, /return savedItem;/);
});

test("mobile replacement image can select the same file and adopts the new saved version", () => {
  const mobile = read("components/MobileTableView.tsx");

  assert.match(mobile, /e\.target\.value = ""/);
  assert.match(mobile, /const savedItem = await onSaveItem\(drawerItem\);\s*setDrawerItem\(savedItem\);/);
});

test("desktop first image upload stays in the current draft until the list is saved", () => {
  const source = read("app/exhibit/[id]/page.tsx");

  assert.match(source, /readImageFileAsDataUrl\(file,[\s\S]{0,180}setImageProgressByItem/);
  assert.match(source, /handleDraftItem\(itemId, "imageUrl", dataUrl\)/);
  assert.doesNotMatch(source, /handleUpdateItem\(itemId, "imageUrl", dataUrl\)/);
  assert.match(source, /await saveItemDrafts\(Array\.from\(dirtyIds\)\);/);
});

test("desktop replacement image can select the same file without an early database write", () => {
  const source = read("app/exhibit/[id]/page.tsx");
  const cellHandler = source.match(/const handleChange = \(e: React\.ChangeEvent<HTMLInputElement>\)[\s\S]*?e\.target\.value = "";/)?.[0] || "";

  assert.match(cellHandler, /if \(file\) onFileSelect\(file\)/);
  assert.match(cellHandler, /e\.target\.value = ""/);
  assert.match(source, /handleDraftItem\(itemId, "imageUrl", dataUrl\)/);
});

test("page loading uses responsive skeletons instead of a loading text screen", () => {
  const home = read("app/page.tsx");
  const detail = read("app/exhibit/[id]/page.tsx");
  const skeletons = read("components/PageSkeletons.tsx");

  assert.match(home, /<HomePageSkeleton \/>/);
  assert.match(detail, /return <ExhibitPageSkeleton \/>;/);
  assert.match(skeletons, /animate-pulse/);
  assert.match(skeletons, /grid-cols-3[\s\S]*sm:grid-cols-6/);
});

test("image reader reports real percentages and every image entry point displays them", () => {
  const reader = read("lib/image-file-reader.ts");
  const detail = read("app/exhibit/[id]/page.tsx");
  const mobile = read("components/MobileTableView.tsx");
  const addDialog = read("components/AddWishItemDialog.tsx");
  const progress = read("components/ImageUploadProgress.tsx");

  assert.match(reader, /reader\.onprogress/);
  assert.match(reader, /event\.loaded \/ event\.total/);
  assert.match(reader, /onProgress\(100\)/);
  assert.match(detail, /<ImageUploadProgress percent=\{uploadProgress\} compact \/>/);
  assert.match(detail, /disabled=\{savingEdits \|\| imageProcessing\}/);
  assert.match(mobile, /<ImageUploadProgress percent=\{imageUploadProgress\} \/>/);
  assert.match(mobile, /disabled=\{imageUploadProgress !== null\}/);
  assert.match(addDialog, /<ImageUploadProgress percent=\{imageUploadProgress\} \/>/);
  assert.match(addDialog, /disabled=\{submitting \|\| imageUploadProgress !== null\}/);
  assert.match(progress, /\{percent\}%/);
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

test("mobile list highlights quantity only when it is greater than one", () => {
  const source = read("components/MobileTableView.tsx");

  assert.match(source, /\(item\.quantity \?\? 1\) > 1 &&/);
  assert.match(source, /×\{item\.quantity\}/);
  assert.doesNotMatch(source, /\(item\.quantity \?\? 1\) >= 1 &&/);
});

test("mobile list groups booths, filters pending purchase or pickup, and completes a booth", () => {
  const source = read("components/MobileTableView.tsx");
  const page = read("app/exhibit/[id]/page.tsx");

  assert.match(source, /只看未买\/取/);
  assert.match(source, /item\.status === "pending" \|\| item\.status === "待领取"/);
  assert.match(source, /const boothGroups = useMemo/);
  assert.match(source, /group\.items\.length > 1/);
  assert.match(source, /本摊完成/);
  assert.doesNotMatch(source, /本摊全部完成/);
  assert.match(source, /space-y-2 bg-slate-100 py-2/);
  assert.match(source, /mx-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm/);
  assert.match(source, /flex h-9 items-center/);
  assert.match(source, /rounded-full/);
  assert.match(source, /status: item\.type === "free" \? "已领取" : "purchased"/);
  assert.match(source, /await onSaveItem\(/);
  assert.match(page, /添加制品/);
  assert.doesNotMatch(page, />\s*添加新行\s*</);
});
