import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as XLSX from "xlsx";
import { MatchIndex } from "../lib/cpp-matcher.ts";
import { parseExcelWorkbook } from "../lib/excel-parser.ts";
import { parseCPPEventPage } from "../scripts/cpp-snapshot-core.mjs";

const types = [
  [36, "漫画"], [37, "小说"], [38, "图集"], [39, "音乐"], [40, "GAME"],
  [43, "卡片"], [44, "纸胶带"], [45, "COS"], [46, "其他"], [48, "手办"],
  [49, "亚克力"], [50, "图文志"], [51, "海报集"], [52, "其他作品集"],
  [53, "徽章"], [54, "色纸"],
];

function page({ event = "7166", day = "7940", categories = types } = {}) {
  return `<a rel="canonical" href="/allcpp/event/eventdoujinshi.do?event=${event}"></a>
    <script>zEids.push('${day}')</script>
    ${categories.map(([id, name]) => `<span id="type${id}" data-id="${id}">${name}</span>`).join("")}`;
}

test("CPFZ 只接受活动 7166、日期 7940 和完整 16 类目", () => {
  const target = { sourceEventId: "7166", databaseEventId: "cpfz" };
  assert.deepEqual(parseCPPEventPage(page(), target), {
    internalEventId: "cpfz",
    sourceEventId: "7166",
    dayIds: ["7940"],
    types: types.map(([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id),
  });
  assert.throws(() => parseCPPEventPage(page({ event: "7073" }), target));
  assert.throws(() => parseCPPEventPage(page({ categories: types.slice(1) }), target));
});

test("新增 list 默认 CPFZ，CP33 不可选，CP32 不再提供入口", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /useState\("cpfz"\)/);
  assert.match(source, /id: "cpfz"[\s\S]*?id: "7940", name: "11\.7-11\.8"/);
  assert.match(source, /id: "cp33"[\s\S]*?disabled: true/);
  assert.match(source, /disabled=\{p\.disabled\}/);
  assert.doesNotMatch(source, /id: "cp32-day[12]"/);
});

test("CPFZ 心愿单 Excel 的摊位与名称可精确匹配官方制品", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["CPP 心愿单导出"],
    ["活动", "CPFZ"],
    ["社团摊位号", "展品名称", "社团名称"],
    ["壹G09", "星月间远航 -Lunar Voyage-", "bunny rhyTHm"],
  ]), "心愿单");
  const [input] = parseExcelWorkbook(workbook);
  const result = new MatchIndex([{
    boothNumber: "壹G09", boothName: "bunny rhyTHm",
    productName: "星月间远航 -Lunar Voyage-", author: "bunny_rhyTHm",
    imageUrl: "", tags: [], eventName: "CPFZ", dayId: "7940",
    sourceUrl: "https://www.allcpp.cn/d/1845933.do", doujinshiId: 1845933,
  }]).match(input);
  assert.equal(result.decision, "accepted");
  assert.equal(result.cppItem?.doujinshiId, 1845933);
  assert.equal(new MatchIndex([]).match(input).decision, "unmatched");
});
