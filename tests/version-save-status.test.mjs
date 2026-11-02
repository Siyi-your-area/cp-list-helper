import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("版本接口不缓存，首页的版本提示不会自动刷新", () => {
  assert.match(read("app/api/version/route.ts"), /force-dynamic/);
  assert.match(read("app/api/version/route.ts"), /no-store/);
  const component = read("components/VersionUpdateNotice.tsx");
  assert.match(component, /新版本已就绪，点击刷新/);
  assert.match(component, /onClick=\{\(\) => window\.location\.reload\(\)\}/);
  assert.match(component, /manualOffline/);
});

test("手机保存提示仅在异步保存完成后确认云端或本机，失败不误报成功", () => {
  const component = read("components/MobileTableView.tsx");
  assert.match(component, /await onUpdateItem\(item\.id, "status", next\);[\s\S]*?finishSave\(offline\)/);
  assert.match(component, /await onSaveItem\(drawerItem\);\s*finishSave\(offline\)/);
  assert.match(component, /savePhase === "saving" && "正在保存/);
  assert.match(component, /savePhase === "cloud" && "✓ 已保存到云端/);
  assert.match(component, /savePhase === "local" && "✓ 仅保存在本机/);
  assert.match(component, /savePhase === "error" && `同步失败/);
});
