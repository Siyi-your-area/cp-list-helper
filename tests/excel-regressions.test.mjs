import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as XLSX from "xlsx";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function loadExcelParser() {
  const compiled = ts.transpileModule(read("lib/excel-parser.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replace(/^import .*$/gm, "")
    .replace(/^export\s+/gm, "");
  return Function("XLSX", `${compiled}\nreturn { parseExcelWorkbook };`)(XLSX);
}

function loadImagePool() {
  const compiled = ts.transpileModule(read("lib/excel-image-loader.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^export\s+/gm, "");
  return Function(`${compiled}\nreturn { loadExcelImagesConcurrently };`)();
}

function workbookFromRows(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "list");
  return workbook;
}

test("product export with a first-row header can be imported again", () => {
  const { parseExcelWorkbook } = loadExcelParser();
  const parsed = parseExcelWorkbook(workbookFromRows([
    ["场馆", "摊位号", "制品名称", "作者", "图片", "类型"],
    ["壹", "壹A01", "测试制品", "测试作者", "见图", "有料"],
  ]));
  assert.deepEqual(parsed, [{ boothNumber: "壹A01", productName: "测试制品", author: "测试作者", circleName: undefined }]);
});

test("CPP third-row headers are still supported", () => {
  const { parseExcelWorkbook } = loadExcelParser();
  const parsed = parseExcelWorkbook(workbookFromRows([
    ["CPG08 潭洲国际会展中心 2026-08-23"],
    ["共1件展品"],
    ["社团摊位号", "展品名称", "社团名称"],
    ["肆P12", "CPP 制品", "CPP 社团"],
  ]));
  assert.deepEqual(parsed, [{ boothNumber: "肆P12", productName: "CPP 制品", author: undefined, circleName: "CPP 社团" }]);
});

test("creator booth numbers are preserved during Excel import", () => {
  const { parseExcelWorkbook } = loadExcelParser();
  const parsed = parseExcelWorkbook(workbookFromRows([
    ["社团摊位号", "展品名称", "社团名称"],
    ["创064", "创摊测试制品", "创作者社团"],
  ]));
  assert.equal(parsed[0].boothNumber, "创064");
  assert.equal(parsed[0].productName, "创摊测试制品");
});

test("image downloads run concurrently, preserve order, and isolate failures", async () => {
  const { loadExcelImagesConcurrently } = loadImagePool();
  let active = 0;
  let maxActive = 0;
  const progress = [];
  const values = await loadExcelImagesConcurrently(
    ["a", "b", "bad", "c", "", "d"],
    async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      if (value === "bad") throw new Error("image failed");
      return `image:${value}`;
    },
    3,
    15_000,
    (completed, total) => progress.push([completed, total])
  );
  assert.ok(maxActive > 1 && maxActive <= 3);
  assert.deepEqual(values, ["image:a", "image:b", null, "image:c", null, "image:d"]);
  assert.deepEqual(progress.at(-1), [6, 6]);
});

test("export uses total-price wording, shows progress, and appends list summary", () => {
  const source = read("app/exhibit/[id]/page.tsx");
  assert.match(source, /header: "总价", key: "total"/);
  assert.match(source, /因导出内容含有图片，导出时间较长，请耐心等待/);
  assert.match(source, /calculateListSummary\(items\)/);
  for (const label of ["总展品", "待购买", "已买待取", "已购买", "已售罄", "待领取", "已领取", "实际花费"]) {
    assert.match(source, new RegExp(`\\["${label}", summary\\.`));
  }
});

test("a stalled image times out without blocking the complete export", async () => {
  const { loadExcelImagesConcurrently } = loadImagePool();
  const startedAt = Date.now();
  const values = await loadExcelImagesConcurrently(
    ["ok", "stalled", "also-ok"],
    async (value) => {
      if (value === "stalled") return new Promise(() => {});
      return `image:${value}`;
    },
    2,
    20
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(values, ["image:ok", null, "image:also-ok"]);
});
