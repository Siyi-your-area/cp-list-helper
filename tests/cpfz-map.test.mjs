import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { getAppBuildVersion } from "../lib/app-build-version.mjs";

function loadTs(path, dependencies = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => dependencies[name] || {}, module, module.exports);
  return module.exports;
}

const data = loadTs("lib/cpfz-map-data.ts");
const model = loadTs("lib/cpfz-map-model.ts", { "./cpfz-map-data": data });
const layout = loadTs("lib/cpfz-marker-layout.ts");
const wish = (id, boothNumber, status = "pending") => ({ id, boothNumber, status, type: "paid", productName: id, quantity: 1 });

test("1–4 馆编号端点均有坐标，超出排号或 9 馆不猜位置", () => {
  for (const booth of ["壹A01", "壹H26", "壹N28", "贰R30", "叁H28", "叁L18", "肆N26"]) {
    const point = data.getCpfzMapPoint(booth);
    assert.ok(point, booth);
    assert.ok(point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1, booth);
  }
  for (const booth of ["玖A01", "壹Z01", "贰R31", "叁E25", "叁H29", "叁M01", "肆O01", "创12"]) assert.equal(data.getCpfzMapPoint(booth), null);
});

test("1–4 馆所有定位点均落在官方底图的摊位矩形上（允许星标遮住中心）", async () => {
  const halls = [["壹", 1], ["贰", 2], ["叁", 3], ["肆", 4]];
  let checked = 0;
  const misses = [];
  for (const [name, hall] of halls) {
    const { data: pixels, info } = await sharp(fileURLToPath(new URL(`../public/cpfz-map/hall-${hall}.png`, import.meta.url))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const letter of "ABCDEFGHIJKLMNOPQR") for (let number = 1; number <= 32; number++) {
      const booth = `${name}${letter}${String(number).padStart(2, "0")}`;
      const point = data.getCpfzMapPoint(booth);
      if (!point) continue;
      checked++;
      const x = Math.round(point.x * info.width), y = Math.round(point.y * info.height);
      // 个别摊位的中心被官方星标/文字盖住，但矩形深色边缘应仍在 11px 内。
      let dark = false;
      for (let dy = -11; dy <= 11 && !dark; dy++) for (let dx = -11; dx <= 11; dx++) {
        if (Math.hypot(dx, dy) > 11) continue;
        const i = ((y + dy) * info.width + x + dx) * info.channels;
        const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
        if (Math.max(...rgb) < 155 && Math.max(...rgb) - Math.min(...rgb) < 68) dark = true;
      }
      if (!dark) misses.push(booth);
    }
  }
  assert.equal(checked, 1532);
  assert.deepEqual(misses, []);
});

test("贰馆相邻 R23–R26 是四个独立点位，编号方向正确", () => {
  const points = [23, 24, 25, 26].map((number) => data.getCpfzMapPoint(`贰R${number}`));
  assert.equal(new Set(points.map((point) => `${point.x}:${point.y}`)).size, 4);
  assert.ok(points[0].y > points[1].y && points[1].y > points[2].y);
});

test("同一完整摊位号只标一摊，数量是制品行数而非购买数量", () => {
  const groups = model.buildCpfzBoothGroups([wish("a", "贰R24"), { ...wish("b", "贰R24"), quantity: 3 }], false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
});

test("多号摊位保持原组键，不自动合并只写单号的制品", () => {
  const groups = model.buildCpfzBoothGroups([wish("a", "叁H21叁H22"), wish("b", "叁H21")], false);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "叁H21叁H22");
});

test("跨馆、无坐标、不规范摊位只留在清单模式", () => {
  const groups = model.buildCpfzBoothGroups([wish("a", "壹A01贰R24"), wish("b", "没有摊位"), wish("c", "玖A01"), wish("d", "壹A01")], false);
  assert.deepEqual(groups.map((group) => group.items[0].id), ["d"]);
});

test("只看未买/取包含待购买、已买待取、待领取，不包含已购买等状态", () => {
  const items = [wish("a", "贰R24"), wish("b", "贰R24", "已买待取"), wish("c", "贰R24", "待领取"), wish("d", "贰R24", "purchased"), wish("e", "贰R24", "soldout")];
  const groups = model.buildCpfzBoothGroups(items, true);
  assert.deepEqual(groups[0].items.map((item) => item.id), ["a", "b", "c"]);
});

test("视窗外不显示标记；缩小时聚合，放大后拆为独立点", () => {
  const groups = model.buildCpfzBoothGroups([23, 24, 25, 26].map((n) => wish(String(n), `贰R${n}`)), false);
  const viewport = { x: -100, y: 0, imageWidth: 1000, imageHeight: 500, viewWidth: 400, viewHeight: 400 };
  const low = model.clusterCpfzBooths(groups, viewport, 1);
  assert.equal(low.length, 1);
  assert.match(low[0].label, /4摊 · 4件 · 点此放大/);
  const high = model.clusterCpfzBooths(groups, { ...viewport, x: -700, y: -700 }, 3);
  assert.equal(high.length, 4);
  assert.match(high[0].label, /^贰R\d+\(1\)$/);
  assert.equal(model.clusterCpfzBooths(groups, { ...viewport, x: -1000 }, 1).length, 0);
});

test("不同场馆的标记在任意缩放级别都有指向摊位的引线", () => {
  for (const booth of ["贰O15", "贰N17", "壹N16", "叁F24"]) {
    const group = model.buildCpfzBoothGroups([wish(booth, booth)], false)[0];
    assert.ok(group, booth);
    for (const zoom of [1, 2.4, 2.6, 5]) {
      const marker = { key: booth, groups: [group], x: group.x, y: group.y, label: `${booth}(1)` };
      const image = { width: 900, height: 700 };
      const transform = { zoom, x: 230 - group.x * image.width * zoom, y: 220 - group.y * image.height * zoom };
      const [node] = layout.layoutCpfzMarkers([marker], transform, image, { width: 390, height: 450 });
      assert.equal(node.sx, 230, booth);
      assert.equal(node.sy, 220, booth);
      assert.match(node.path, /^M 230 220 H /, booth);
      assert.ok(node.path.endsWith(`H ${node.left + node.width}`), booth);
    }
  }
});

test("所有已定位的摊位共用同一引线布局规则，没有特殊摊位补丁", () => {
  let checked = 0;
  for (const hall of ["壹", "贰", "叁", "肆"]) for (const letter of "ABCDEFGHIJKLMNOPQR") for (let number = 1; number <= 30; number++) {
    const booth = `${hall}${letter}${String(number).padStart(2, "0")}`;
    const point = data.getCpfzMapPoint(booth);
    if (!point) continue;
    const marker = { key: booth, groups: [{ key: booth }], x: point.x, y: point.y, label: `${booth}(1)` };
    const image = { width: 900, height: 700 };
    const transform = { zoom: 3, x: 230 - point.x * 2700, y: 220 - point.y * 2100 };
    const [node] = layout.layoutCpfzMarkers([marker], transform, image, { width: 390, height: 450 });
    assert.ok(Math.abs(node.sx - 230) < 1e-8 && Math.abs(node.sy - 220) < 1e-8, booth);
    assert.match(node.path, /^M .* H .* V .* H /, booth);
    assert.ok(node.sx < node.left || node.sx > node.left + node.width, booth);
    checked++;
  }
  assert.ok(checked > 700);
});

test("拖动地图跨过屏幕中线时，标签与摊位一起平移，不突然换边", () => {
  const marker = { key: "叁F24", groups: [{ key: "叁F24" }], x: .4, y: .4, label: "叁F24(1)" };
  const image = { width: 900, height: 700 };
  const view = { width: 390, height: 450 };
  const before = layout.layoutCpfzMarkers([marker], { x: -140, y: -60, zoom: 1 }, image, view)[0];
  const after = layout.layoutCpfzMarkers([marker], { x: -115, y: -60, zoom: 1 }, image, view)[0];
  assert.equal(after.sx - before.sx, 25);
  assert.equal(after.left - before.left, 25);
  assert.equal(after.top, before.top);
});

test("聚合标签在窄屏中间放不下左右两侧时改放上方，仍保留引线", () => {
  const marker = { key: "cluster", groups: [{ key: "a" }, { key: "b" }], x: .5, y: .5, label: "壹N11–N12 · 2摊 · 3件 · 点此放大" };
  const [node] = layout.layoutCpfzMarkers([marker], { x: 0, y: 0, zoom: 1 }, { width: 390, height: 450 }, { width: 390, height: 450 });
  assert.equal(node.vertical, true);
  assert.ok(node.top + 44 < node.sy);
  assert.match(node.path, /^M 195 225 V /);
});

test("地图容器宽度变化时保持当前缩放和地图中心，不重置到全馆", () => {
  const previous = { width: 390, height: 490, imageWidth: 920, imageHeight: 690 };
  const next = { width: 375, height: 490, imageWidth: 882, imageHeight: 661.5 };
  const transform = { zoom: 3.2, x: 195 - 0.4 * previous.imageWidth * 3.2, y: 245 - 0.6 * previous.imageHeight * 3.2 };
  const resized = layout.resizeCpfzMapTransform(transform, previous, next);
  assert.equal(resized.zoom, transform.zoom);
  assert.ok(Math.abs(resized.x + 0.4 * next.imageWidth * resized.zoom - next.width / 2) < 1e-8);
  assert.ok(Math.abs(resized.y + 0.6 * next.imageHeight * resized.zoom - next.height / 2) < 1e-8);
});

test("地图筛选和场馆按钮沿用清单模式的小号胶囊与标签样式", () => {
  const map = readFileSync(new URL("../components/CpfzMapView.tsx", import.meta.url), "utf8");
  assert.match(map, /rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors/);
  assert.match(map, /rounded px-2\.5 py-1 text-xs font-medium whitespace-nowrap transition-colors/);
  assert.doesNotMatch(map, /\{option\}馆<\/button>/);
});

test("地图卡直接展开整摊，状态样式与本摊完成操作复用手机清单", () => {
  const map = readFileSync(new URL("../components/CpfzMapView.tsx", import.meta.url), "utf8");
  const list = readFileSync(new URL("../components/MobileTableView.tsx", import.meta.url), "utf8");
  assert.match(map, /selected\.items\.map\(itemCard\)/);
  assert.doesNotMatch(map, /查看全部|slice\(0, 2\)|showAll/);
  assert.match(map, /item\.author/);
  assert.doesNotMatch(map, /item\.price/);
  assert.match(map, /onBoothComplete\(selected\.key, selected\.items\)/);
  assert.match(list, /onBoothComplete=\{\(key, boothItems\) => void handleCompleteBooth\(key, boothItems\)\}/);
  assert.match(map, /@\/components\/mobile-wish-style/);
  assert.match(list, /@\/components\/mobile-wish-style/);
});

test("手机模式只在 CPFZ list 内出现；地图模式不渲染旧统计和搜索", () => {
  const page = readFileSync(new URL("../app/exhibit/[id]/page.tsx", import.meta.url), "utf8");
  const mobile = readFileSync(new URL("../components/MobileTableView.tsx", import.meta.url), "utf8");
  assert.match(page, /eventInfo\?\.cppEventId === "cpfz" && <div/);
  assert.match(page, /eventInfo\?\.cppEventId !== "cpfz" \|\| mobileViewMode === "list"/);
  assert.match(mobile, /mode === "list" && <div className="border-b border-slate-200 bg-white px-3 pt-3 pb-2"/);
  assert.match(mobile, /mode === "map" && <CpfzMapView/);
});

test("版本号由源码确定，同一源码多次计算一致，不再按构建时间变化", () => {
  assert.equal(getAppBuildVersion(), getAppBuildVersion());
  assert.doesNotMatch(readFileSync(new URL("../next.config.mjs", import.meta.url), "utf8"), /new Date\(\)\.toISOString\(\)/);
});
