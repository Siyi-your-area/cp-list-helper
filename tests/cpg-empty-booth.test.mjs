import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  MatchIndex,
  matchEmptyBoothByExactProductAndCircle,
} from "../lib/cpp-matcher.ts";
import { parseExcelWorkbook } from "../lib/excel-parser.ts";
import {
  detectWishItemType,
  resolveImportedAuthor,
} from "../lib/cpp-item-mapping.ts";
import { matchCPPItemsInBatches } from "../lib/cpp-match-client.ts";
import {
  buildReviewNote,
  getVisibleWishNote,
  parseReviewNote,
} from "../lib/match-review.ts";

function candidate(overrides = {}) {
  return {
    boothNumber: "",
    boothName: "星屑社",
    productName: "《潮汐回声》",
    author: "作者笔名",
    imageUrl: "",
    tags: [],
    eventName: "CPG08",
    dayId: "7829",
    sourceUrl: "",
    doujinshiId: 1,
    ...overrides,
  };
}

function matchResponseFor(items) {
  return new Response(JSON.stringify({
    results: items.map((item) => ({
      matched: true,
      decision: "accepted",
      confidence: "exact",
      reason: item.productName,
    })),
    stats: { total: items.length, matched: items.length, accepted: items.length },
    timings: { serverTotalMs: 10, withinTarget: true },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("320 条按顺序拆成 16 批 20 条并报告精确进度", async () => {
  const items = Array.from({ length: 320 }, (_, index) => ({
    boothNumber: "",
    productName: `制品-${index}`,
    circleName: `社团-${index}`,
  }));
  const batches = [];
  const progress = [];
  const response = await matchCPPItemsInBatches({
    items,
    eventId: "cpg-list",
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      batches.push(body.items);
      return matchResponseFor(body.items);
    },
    onProgress: (completed, total) => progress.push([completed, total]),
  });

  assert.equal(batches.length, 16);
  assert.ok(batches.every((batch) => batch.length === 20));
  assert.equal(response.results.length, 320);
  assert.deepEqual(
    response.results.map((result) => result.reason),
    items.map((item) => item.productName)
  );
  assert.deepEqual(
    progress,
    Array.from({ length: 16 }, (_, index) => [(index + 1) * 20, 320])
  );
});

test("单批失败重试一次，结果数量仍异常时抛错而不生成默认结果", async () => {
  const items = Array.from({ length: 21 }, (_, index) => ({
    boothNumber: "",
    productName: `制品-${index}`,
  }));
  let calls = 0;
  const retried = await matchCPPItemsInBatches({
    items,
    eventId: "cpg-list",
    fetcher: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (calls === 1) return new Response("失败", { status: 503 });
      return matchResponseFor(body.items);
    },
  });
  assert.equal(calls, 3);
  assert.equal(retried.results.length, 21);

  await assert.rejects(
    () => matchCPPItemsInBatches({
      items: items.slice(0, 2),
      eventId: "cpg-list",
      fetcher: async () => matchResponseFor(items.slice(0, 1)),
    }),
    /匹配结果数量异常/
  );
});

test("CPG 详情缺少交换类型时允许 2xx accepted 并按用户规则默认有料", async () => {
  const cppItem = candidate({
    exchangeType: undefined,
    tags: [],
    productName: "普通制品",
  });
  const response = await matchCPPItemsInBatches({
    items: [{ boothNumber: "", productName: "普通制品", circleName: "星屑社" }],
    eventId: "cpg-list",
    fetcher: async () => new Response(JSON.stringify({
      results: [{
        matched: true,
        decision: "accepted",
        confidence: "exact",
        cppItem,
      }],
      stats: { total: 1, matched: 1, accepted: 1 },
      timings: { serverTotalMs: 100, withinTarget: true },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });

  assert.equal(response.results[0].decision, "accepted");
  assert.equal(response.results[0].cppItem?.exchangeType, undefined);
  assert.equal(detectWishItemType(response.results[0].cppItem), "paid");
});

for (const bookType of ["xls", "xlsx"]) {
  test(`真实三行头 CPP .${bookType} 将第三列社团名称解析到 circleName`, () => {
    const sourceWorkbook = XLSX.utils.book_new();
    const sourceSheet = XLSX.utils.aoa_to_sheet([
      ["CPP 心愿单导出"],
      ["活动", "CPG08"],
      ["社团摊位号", "展品名称", "社团名称"],
      ["", "《潮汐回声》", "星屑社"],
    ]);
    XLSX.utils.book_append_sheet(sourceWorkbook, sourceSheet, "心愿单");
    const bytes = XLSX.write(sourceWorkbook, { type: "buffer", bookType });
    const workbook = XLSX.read(bytes, { type: "buffer" });

    const [item] = parseExcelWorkbook(workbook);
    assert.equal(item.boothNumber, "");
    assert.equal(item.productName, "《潮汐回声》");
    assert.equal(item.circleName, "星屑社");
    assert.equal(item.author, undefined);
  });
}

test("作者列与社团名称列保持独立语义", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["CPP 心愿单导出"],
      ["社团摊位号", "展品名称", "社团名称", "作者"],
      ["", "《潮汐回声》", "星屑社", "米洛-"],
    ]),
    "心愿单"
  );

  assert.deepEqual(parseExcelWorkbook(workbook), [
    {
      boothNumber: "",
      productName: "《潮汐回声》",
      author: "米洛-",
      circleName: "星屑社",
    },
  ]);
});

test("导入作者优先 CPP 作者且永不把 circleName 当作者保存", () => {
  const input = {
    boothNumber: "",
    productName: "《潮汐回声》",
    author: "上传作者",
    circleName: "上传社团",
  };

  assert.equal(resolveImportedAuthor(input, candidate({ author: "CPP 作者" })), "CPP 作者");
  assert.equal(resolveImportedAuthor(input), "上传作者");
  assert.equal(resolveImportedAuthor({ ...input, author: undefined }), "");
  assert.equal(detectWishItemType(candidate({ exchangeType: "无料交换" })), "free");
});

test("空摊位 CPP 候选备注兼容旧格式并保持确认入口可解析", () => {
  const oldNote = "待确认候选： · 《潮汐回声》 [[CPP:12345]]";
  const parsedOldNote = parseReviewNote(oldNote);
  const newNote = buildReviewNote(candidate({ doujinshiId: 12345 }));

  assert.deepEqual(parsedOldNote, {
    boothNumber: "",
    productName: "《潮汐回声》",
    doujinshiId: 12345,
  });
  assert.equal(
    getVisibleWishNote(oldNote),
    "待确认候选：摊位待公布 · 《潮汐回声》"
  );
  assert.equal(
    newNote,
    "待确认候选：摊位待公布 · 《潮汐回声》 [[CPP:12345]]"
  );
  assert.deepEqual(parseReviewNote(newNote), parsedOldNote);
});

test("CPG 真实格式空摊位仅在完整名称与社团均精确且唯一时接受", () => {
  const result = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "", productName: "潮 汐回声", circleName: " 星屑社 " },
    [candidate()]
  );

  assert.equal(result.decision, "accepted");
  assert.equal(result.confidence, "exact");
  assert.equal(result.cppItem?.doujinshiId, 1);
});

test("名称唯一但输入社团缺失或不一致时不自动接受", () => {
  const missingCircle = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "", productName: "《潮汐回声》" },
    [candidate()]
  );
  const differentCircle = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "", productName: "《潮汐回声》", circleName: "另一社团" },
    [candidate()]
  );

  assert.equal(missingCircle.decision, "review");
  assert.equal(missingCircle.requiresReview, true);
  assert.equal(differentCircle.decision, "review");
  assert.equal(differentCircle.requiresReview, true);
});

test("同名候选仅由 boothName 唯一精确命中时接受", () => {
  const result = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "", productName: "《潮汐回声》", circleName: "星屑社" },
    [
      candidate({ doujinshiId: 1, boothName: "星屑社" }),
      candidate({ doujinshiId: 2, boothName: "月海社" }),
    ]
  );

  assert.equal(result.decision, "accepted");
  assert.equal(result.cppItem?.doujinshiId, 1);
});

test("同名同社团重复时必须人工复核", () => {
  const result = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "", productName: "《潮汐回声》", circleName: "星屑社" },
    [candidate({ doujinshiId: 1 }), candidate({ doujinshiId: 2 })]
  );

  assert.equal(result.decision, "review");
  assert.equal(result.requiresReview, true);
  assert.equal(result.cppItem, undefined);
});

test("candidate.author 不能兜底接受，且候选摊位号也必须为空", () => {
  const authorOnly = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "", productName: "《潮汐回声》", author: "作者笔名" },
    [candidate({ boothName: "另一社团", author: "作者笔名" })]
  );
  const nonEmptyCandidateBooth = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "", productName: "《潮汐回声》", author: "星屑社" },
    [candidate({ boothNumber: "A01" })]
  );

  assert.equal(authorOnly.decision, "review");
  assert.equal(nonEmptyCandidateBooth.decision, "unmatched");
});

test("旧客户端仍可用 author 兼容空摊位社团消歧", () => {
  const result = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "", productName: "《潮汐回声》", author: "星屑社" },
    [candidate()]
  );

  assert.equal(result.decision, "accepted");
});

test("CP32 非空摊位继续使用既有 MatchIndex 行为", () => {
  const cp32Candidate = candidate({
    boothNumber: "肆Q40",
    boothName: "既望社",
    productName: "既望",
    eventName: "CP32",
    dayId: "7040",
  });
  const existingResult = new MatchIndex([cp32Candidate]).match({
    boothNumber: "肆Q40",
    productName: "既望",
  });
  const emptyBoothOnlyResult = matchEmptyBoothByExactProductAndCircle(
    { boothNumber: "肆Q40", productName: "既望", author: "既望社" },
    [cp32Candidate]
  );

  assert.equal(existingResult.decision, "accepted");
  assert.equal(existingResult.cppItem?.doujinshiId, 1);
  assert.equal(emptyBoothOnlyResult.decision, "unmatched");
});

test("路由仅为 CPG08 空摊位执行一次批量名称查询并跳过逐条回退", () => {
  const source = readFileSync(
    new URL("../app/api/cpp/match/route.ts", import.meta.url),
    "utf8"
  );
  const calls = source.match(/getCPPItemsByNormalizedProducts\s*\(/g) || [];

  assert.equal(calls.length, 1);
  assert.match(source, /if \(eventId === "cpg08"\)/);
  assert.match(source, /hasExplicitId: Boolean\(item\.doujinshiId\)/);
  assert.match(source, /!entry\.hasExplicitId/);
  assert.match(source, /emptyBoothHandledIndices\.add\(entry\.indexValue\)/);
  assert.ok(
    source.indexOf("getCPPItemsByNormalizedProducts(") <
      source.indexOf("const dbTasks = new Map")
  );
  assert.ok(
    (source.match(/emptyBoothHandledIndices\.has\(indexValue\)/g) || []).length >= 2
  );
});

test("显式 doujinshiId 保持既有 ID 精确接受且不会进入空摊位覆盖集合", () => {
  const result = new MatchIndex([candidate({ doujinshiId: 12345 })]).match({
    boothNumber: "",
    productName: "可能不一致的旧名称",
    doujinshiId: 12345,
  });
  const routeSource = readFileSync(
    new URL("../app/api/cpp/match/route.ts", import.meta.url),
    "utf8"
  );
  const entriesStart = routeSource.indexOf("const emptyBoothEntries");
  const entriesEnd = routeSource.indexOf("for (const entry", entriesStart);
  const entrySelection = routeSource.slice(entriesStart, entriesEnd);

  assert.equal(result.decision, "accepted");
  assert.equal(result.cppItem?.doujinshiId, 12345);
  assert.match(entrySelection, /!entry\.hasExplicitId/);
});

test("数据库批量查询按 normalized_product 分块并保持 event/day scope", () => {
  const source = readFileSync(
    new URL("../lib/db-service.ts", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("export async function getCPPItemsByNormalizedProducts");
  const end = source.indexOf("\n/**", start + 1);
  const implementation = source.slice(start, end > start ? end : undefined);

  assert.match(implementation, /const chunkSize = 40/);
  assert.match(implementation, /\.eq\("event_id", eventId\)/);
  assert.match(implementation, /\.in\("normalized_product", chunk\)/);
  assert.match(implementation, /query = query\.in\("day_id", dayIds\)/);
});

test("创建导入展示阶段、计时和长等待提示，成功后进入详情", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const progressStart = source.indexOf('className="mt-3 h-1.5');
  const progressEnd = source.indexOf("</div>", progressStart);
  const progressMarkup = source.slice(progressStart, progressEnd);

  assert.match(source, /正在匹配 CPP 制品/);
  assert.match(source, /已等待 \{createElapsedSeconds\} 秒/);
  assert.match(source, /匹配通常需要1分钟以上，请耐心等待，请勿关闭页面/);
  assert.match(source, /router\.push\(`\/exhibit\/\$\{listId\}`\)/);
  assert.ok(progressStart >= 0 && progressEnd > progressStart);
  assert.match(progressMarkup, /w-full/);
  assert.match(progressMarkup, /motion-safe:animate-pulse/);
  assert.doesNotMatch(progressMarkup, /\bw-\d+\/\d+\b/);
});

test("详情页为空摊位 CPP 候选显示待公布文案", () => {
  const source = readFileSync(
    new URL("../app/exhibit/[id]/page.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /candidate\.boothNumber \|\| "摊位待公布"/);
});

test("首页和详情再次导入都通过共享 helper 匹配并保存作者", () => {
  const homeSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const detailSource = readFileSync(
    new URL("../app/exhibit/[id]/page.tsx", import.meta.url),
    "utf8"
  );

  assert.match(homeSource, /author: resolveImportedAuthor\(input, cppItem\)/);
  assert.match(detailSource, /author: resolveImportedAuthor\(input, result\?\.cppItem\)/);
  assert.match(homeSource, /matchCPPItemsInBatches\(\{/);
  assert.match(detailSource, /matchCPPItemsInBatches\(\{/);
  assert.doesNotMatch(homeSource, /authFetch\("\/api\/cpp\/match"/);
  assert.doesNotMatch(detailSource, /authFetch\("\/api\/cpp\/match"/);
  assert.match(homeSource, /已匹配 \$\{completed\}\/\$\{total\}/);
  assert.match(detailSource, /已匹配 \$\{completed\}\/\$\{total\}/);
  assert.doesNotMatch(homeSource, /author: input\.circleName/);
  assert.doesNotMatch(detailSource, /author: input\.circleName/);
});

test("CPG accepted 缺交换类型按 ID 去重并发补详情且有独立预算", () => {
  const source = readFileSync(
    new URL("../app/api/cpp/match/route.ts", import.meta.url),
    "utf8"
  );
  const detailStart = source.indexOf("const cpgDetailTargets");
  const detailEnd = source.indexOf("const accepted =", detailStart);
  const detailBlock = source.slice(detailStart, detailEnd);

  assert.match(source, /const CPG_DETAIL_CONCURRENCY = 6/);
  assert.match(source, /const CPG_DETAIL_BUDGET_MS = 25_000/);
  assert.match(source, /requestStart \+ SERVER_BUDGET_MS/);
  assert.match(source, /const cpgDetailTargets = new Map<number, number\[\]>/);
  assert.match(source, /result\.decision !== "accepted"/);
  assert.match(source, /result\.source === "external-api"/);
  assert.match(source, /cppItem\.exchangeType\?\.trim\(\)/);
  assert.match(source, /fetchCPPExternalDetail\(/);
  assert.match(source, /enrichCPPItemWithDetail\(current\.cppItem, detail\)/);
  assert.match(source, /cpgDetailExchangeTypes/);
  assert.doesNotMatch(source, /cpgDetailUnresolved/);
  assert.doesNotMatch(source, /CPG detail unresolved/);
  assert.match(detailBlock, /Array\.from\(cpgDetailTargets\.keys\(\)\)/);
  assert.doesNotMatch(detailBlock, /\.slice\(0,/);
});
