import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculateListSummary } from "../lib/list-summary.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const item = (id, status, price, quantity) => ({
  id,
  boothNumber: "壹A01",
  productName: id,
  status,
  price,
  quantity,
});

test("list 统计按六种状态形成总数、有料和无料", () => {
  const summary = calculateListSummary([
    item("pending", "pending", 30, 2),
    item("paid-awaiting-pickup", "已买待取", 35, 2),
    item("purchased", "purchased", 45, 2),
    item("soldout", "soldout", 20, 1),
    item("pickup", "待领取", undefined, 1),
    item("received", "已领取", 0, 1),
  ]);

  assert.equal(summary.pending, 1);
  assert.equal(summary.paidAwaitingPickup, 1);
  assert.equal(summary.purchased, 1);
  assert.equal(summary.soldout, 1);
  assert.equal(summary.pendingPickup, 1);
  assert.equal(summary.received, 1);
  assert.equal(summary.paid, 4);
  assert.equal(summary.free, 2);
  assert.equal(summary.total, 6);
});

test("预计花费统计全部制品，实际花费统计已购买和已买待取", () => {
  const summary = calculateListSummary([
    item("pending", "pending", 30, 2),
    item("paid-awaiting-pickup", "已买待取", 35, 2),
    item("purchased", "purchased", 45, 2),
    item("soldout", "soldout", 20, 1),
    item("pickup", "待领取", undefined, 1),
    item("zero", "已领取", 50, 0),
  ]);

  assert.equal(summary.estimatedCost, 240);
  assert.equal(summary.actualCost, 160);
});

test("电脑和手机共用一套统计条，并支持悬停或点击展开明细", () => {
  const page = read("app/exhibit/[id]/page.tsx");
  const component = read("components/ListSummaryBar.tsx");

  assert.equal((page.match(/<ListSummaryBar items=\{items\}/g) || []).length, 2);
  assert.match(component, /onMouseEnter=\{\(\) => setActiveKind\(kind\)\}/);
  assert.match(component, /onClick=\{\(\) => setActiveKind\(kind\)\}/);
  assert.match(component, /activeKind === "paid"[\s\S]*?待购买[\s\S]*?已买待取[\s\S]*?已购买[\s\S]*?已售罄/);
  assert.match(component, /activeKind === "free"[\s\S]*?待领取[\s\S]*?已领取/);
  assert.match(component, /activeKind === "cost"[\s\S]*?预计花费/);
});
