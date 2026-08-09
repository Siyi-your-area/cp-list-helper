import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  CPG_DATABASE_EVENT_ID,
  CPG_SOURCE_EVENT_ID,
  calculateDefinitionHash,
  calculateSnapshotHash,
  createCPPRequestController,
  createGeneratedFixtureTransport,
  parseCPGEventPage,
  runCPGProvisionalSnapshot,
  runCPGSnapshot,
  snapshotDefinition,
  validateFrozenSnapshot,
} from "../scripts/cpp-snapshot-core.mjs";
import { createLiveTransport } from "../scripts/scan-cpg.mjs";

const fixturePath = new URL("./fixtures/cpg-snapshot-source.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

function clone(value) { return structuredClone(value); }

test("真实 HTML 无总数字段，parser 只冻结 event/day/16 类 topology", () => {
  const definition = parseCPGEventPage(fixture.eventPageHtml);
  assert.equal(definition.sourceEventId, CPG_SOURCE_EVENT_ID);
  assert.equal(definition.internalEventId, CPG_DATABASE_EVENT_ID);
  assert.deepEqual(definition.dayIds, ["7829"]);
  assert.equal(definition.types.length, 16);
  assert.equal(Object.hasOwn(definition, "declaredTotal"), false);
  const misleadingHtmlTotal = fixture.eventPageHtml.replace("</body>", '<div data-declared-total="1"></div></body>');
  assert.equal(Object.hasOwn(parseCPGEventPage(misleadingHtmlTotal), "declaredTotal"), false);
});

test("source event、day、分类数 topology 门禁保留", () => {
  for (const [from, to, pattern] of [
    ['"sourceEventId":"7073"', '"sourceEventId":"7074"', /source event/],
    ['"dayIds":["7829"]', '"dayIds":["7829","7830"]', /day 门禁/],
    [',{"id":116,"name":"分类十六"}', '', /分类门禁/],
  ]) assert.throws(() => parseCPGEventPage(fixture.eventPageHtml.replace(from, to)), pattern);
});

test("fallback 只把 canonical/current/selected 当当前活动，忽略推荐活动链接", () => {
  const typeHtml = Array.from({ length: 16 }, (_, index) => `<span id="type${101 + index}" data-id="${101 + index}">分类${index + 1}</span>`).join("");
  const common = `<script>zEids.push(7829)</script>${typeHtml}`;
  const positive = `<link rel="canonical" href="/allcpp/event/eventdoujinshi.do?event=7073"><a href="?event=6377">推荐 CP32</a>${common}`;
  assert.equal(parseCPGEventPage(positive).sourceEventId, "7073");
  const negative = `<link rel="canonical" href="/allcpp/event/eventdoujinshi.do?event=6377"><a href="?event=7073">推荐 CPG</a>${common}`;
  assert.throws(() => parseCPGEventPage(negative), /source event 门禁/);
});

test("完整历史 fixture 经过 A/B 双扫描生成自洽 snapshot 与稳定 hash", async () => {
  const baseTransport = createGeneratedFixtureTransport(fixture);
  const categoryOrders = [];
  const snapshot = await runCPGSnapshot({
    sourceTransport: {
      getEventPage: (...args) => baseTransport.getEventPage(...args),
      getDeclaredTotal: (...args) => baseTransport.getDeclaredTotal(...args),
      getSearchPage: (args) => {
        categoryOrders.push(args.orderBy);
        return baseTransport.getSearchPage(args);
      },
    },
    pageSize: 1000,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  assert.equal(snapshot.state, "snapshot_ready");
  assert.equal(snapshot.tasksCompleted, 16);
  assert.equal(snapshot.tasksExpected, 16);
  assert.equal(snapshot.scanPasses, 32);
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.declaredTotalSource, "cpp-unfiltered-search");
  assert.equal(snapshot.categoryOrderBy, "0");
  assert.deepEqual([...new Set(categoryOrders)], ["0"]);
  assert.deepEqual(snapshot.topologyChecks, ["initial"]);
  assert.equal(snapshot.finalBarriers.length, 2);
  assert.ok(snapshot.finalBarriers.every((barrier) => barrier.global.orderBy === "0" && barrier.global.total === 38188 && barrier.typeTotals.length === 16 && /^[a-f0-9]{64}$/.test(barrier.barrierHash)));
  assert.equal(snapshot.totals.declared, 38188);
  assert.equal(snapshot.totals.uniqueRows, 38188);
  assert.equal(snapshot.rows.length, 38188);
  assert.ok(snapshot.tasks.every((task) => task.stableAcrossScans && task.stableEpochs.length === 2 && task.stableEpochs[0].canonicalHash === task.stableEpochs[1].canonicalHash));
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.dbWritesAttempted, 0);
  assert.equal(snapshot.rows[0].event_id, "cpg08");
  assert.equal(snapshot.rows[0].day_id, "7829");
  assert.equal(snapshot.definitionHash, calculateDefinitionHash(snapshotDefinition(snapshot)));
  const changedDiscoveryTime = clone(snapshot);
  changedDiscoveryTime.discoveredAt = "2099-01-01T00:00:00.000Z";
  assert.equal(calculateDefinitionHash(snapshotDefinition(changedDiscoveryTime)), snapshot.definitionHash);
  assert.equal(calculateSnapshotHash(changedDiscoveryTime), snapshot.snapshotHash);
  validateFrozenSnapshot(snapshot);
  const tampered = clone(snapshot);
  tampered.rows[0].product_name = "被篡改";
  assert.throws(() => validateFrozenSnapshot(tampered), /snapshotHash 无效/);
  const tamperedProof = clone(snapshot);
  tamperedProof.tasks[0].stableEpochs[1].idsHash = "0".repeat(64);
  assert.throws(() => validateFrozenSnapshot(tamperedProof), /snapshotHash 无效|双 epoch 证明无效/);
  const legacyHtmlTotalSnapshot = clone(snapshot);
  legacyHtmlTotalSnapshot.schemaVersion = 1;
  legacyHtmlTotalSnapshot.declaredTotalSource = "event-html";
  assert.throws(() => validateFrozenSnapshot(legacyHtmlTotalSnapshot), /v3 dirty-convergence/);

  const probeMutations = [
    (probe) => { probe.total += 1; },
    (probe) => { probe.checkpoint = "tampered"; },
    (probe) => { probe.dayId = "9999"; },
    (probe) => { probe.requestSemanticsVersion = "tampered-source"; },
    (probe) => { probe.orderBy = "1"; },
    (probe) => { probe.resultShape.listIsArray = false; },
    (probe) => { probe.probeHash = "0".repeat(64); },
  ];
  for (const mutate of probeMutations) {
    const tamperedProbe = clone(snapshot);
    mutate(tamperedProbe.finalBarriers[0].global);
    tamperedProbe.snapshotHash = calculateSnapshotHash(tamperedProbe);
    assert.throws(() => validateFrozenSnapshot(tamperedProbe), /snapshot barrier 无效/);
  }
  const changedProbe = clone(snapshot);
  changedProbe.finalBarriers[0].global.probeHash = "0".repeat(64);
  assert.notEqual(calculateSnapshotHash(changedProbe), snapshot.snapshotHash);
  const tamperedCategoryOrder = clone(snapshot);
  tamperedCategoryOrder.categoryOrderBy = "1";
  tamperedCategoryOrder.definitionHash = calculateDefinitionHash(snapshotDefinition(tamperedCategoryOrder));
  tamperedCategoryOrder.snapshotHash = calculateSnapshotHash(tamperedCategoryOrder);
  assert.throws(() => validateFrozenSnapshot(tamperedCategoryOrder), /分类排序必须为 orderBy=0/);
});

function fixtureWithDeclaredTotal(total) {
  const dynamic = clone(fixture);
  dynamic.declaredTotal = total;
  dynamic.taskTotals[116] += total - 38188;
  return dynamic;
}

test("38204 与第三个动态正整数均可生成并验证冻结快照", async () => {
  for (const total of [38204, 40001]) {
    const dynamic = fixtureWithDeclaredTotal(total);
    if (total === 38204) dynamic.eventPageHtml = dynamic.eventPageHtml.replace('"dayIds":["7829"]', '"dayIds":["7830"]');
    const snapshot = await runCPGSnapshot({ sourceTransport: createGeneratedFixtureTransport(dynamic), pageSize: 1000 });
    assert.equal(snapshot.declaredTotal, total);
    assert.deepEqual(snapshot.totals, { declared: total, rawRows: total, uniqueRows: total });
    assert.equal(snapshot.rows.length, total);
    assert.equal(snapshot.rows[0].day_id, total === 38204 ? "7830" : "7829");
    validateFrozenSnapshot(snapshot);
  }
});

test("fixture taskTotals 必须恰好覆盖动态发现的 16 类", () => {
  const broken = clone(fixture);
  delete broken.taskTotals[116];
  assert.throws(() => createGeneratedFixtureTransport(broken), /恰好覆盖 16 类/);
});

test("任一分类 total>=9500 时没有二级分区证明即 blocked", async () => {
  const capped = clone(fixture);
  capped.taskTotals[101] = 9500;
  await assert.rejects(() => runCPGSnapshot({ sourceTransport: createGeneratedFixtureTransport(capped), pageSize: 1000 }), /达到二级分区门禁/);
});

function wrappedGeneratedTransport(mutate) {
  const base = createGeneratedFixtureTransport(fixture);
  return {
    getEventPage: (...args) => base.getEventPage(...args),
    getDeclaredTotal: (...args) => base.getDeclaredTotal(...args),
    async getSearchPage(args) {
      const response = await base.getSearchPage(args);
      return mutate(args, structuredClone(response)) ?? response;
    },
  };
}

function transportWithEventPages(pages) {
  const base = createGeneratedFixtureTransport(fixture);
  let call = 0;
  return {
    async getEventPage() {
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return page;
    },
    getDeclaredTotal: (...args) => base.getDeclaredTotal(...args),
    getSearchPage: (...args) => base.getSearchPage(...args),
  };
}

test("A/B 扫描前后 topology 漂移立即失败", async () => {
  const topologyDrift = fixture.eventPageHtml.replace('"name":"分类一"', '"name":"分类一变更"');
  await assert.rejects(
    () => runCPGSnapshot({ sourceTransport: transportWithEventPages([fixture.eventPageHtml, fixture.eventPageHtml, topologyDrift]), pageSize: 1000 }),
    /topology 漂移/
  );
  const dayDrift = fixture.eventPageHtml.replace('"dayIds":["7829"]', '"dayIds":["7830"]');
  await assert.rejects(
    () => runCPGSnapshot({ sourceTransport: transportWithEventPages([fixture.eventPageHtml, fixture.eventPageHtml, fixture.eventPageHtml, dayDrift]), pageSize: 1000 }),
    /topology 漂移/
  );
});

test("barrier global/type sum 持续不符时预算耗尽且不生成 snapshot", async () => {
  const base = createGeneratedFixtureTransport(fixture);
  await assert.rejects(
    () => runCPGSnapshot({
      sourceTransport: {
        getEventPage: (...args) => base.getEventPage(...args),
        getSearchPage: (...args) => base.getSearchPage(...args),
        async getDeclaredTotal({ checkpoint }) {
          const envelope = await base.getDeclaredTotal();
          if (checkpoint !== "A-before") envelope.result.total += 16;
          return envelope;
        },
      },
      pageSize: 1000,
    }),
    /barrier budget 耗尽/
  );

  const mismatched = clone(fixture);
  mismatched.declaredTotal += 1;
  await assert.rejects(
    () => runCPGSnapshot({ sourceTransport: createGeneratedFixtureTransport(mismatched), pageSize: 1000 }),
    /barrier budget 耗尽/
  );
});

test("global count envelope 必须为成功、正安全整数和数组 list", async () => {
  const invalidEnvelopes = [
    { isSuccess: false, result: { total: 38188, list: [] } },
    { isSuccess: true, result: { total: 0, list: [] } },
    { isSuccess: true, result: { total: 1.5, list: [] } },
    { isSuccess: true, result: { total: 38188, list: null } },
  ];
  for (const envelope of invalidEnvelopes) {
    const base = createGeneratedFixtureTransport(fixture);
    await assert.rejects(
      () => runCPGSnapshot({
        sourceTransport: {
          getEventPage: (...args) => base.getEventPage(...args),
          getSearchPage: (...args) => base.getSearchPage(...args),
          async getDeclaredTotal() { return structuredClone(envelope); },
        },
        pageSize: 1000,
      }),
      /无 type 总数/
    );
  }
});

function mockCountResponse({ status = 200, contentType = "application/json; charset=utf-8", body }) {
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    async json() { return body; },
  };
}

test("live global count 使用官方无 type GET 参数并严格接受 JSON envelope", async () => {
  let request;
  const transport = createLiveTransport({
    timeoutMs: 1000,
    minIntervalMs: 800,
    cookie: "fixture=yes",
    requester: {
      async request(url, init, label) {
        request = { url: new URL(url), init, label };
        return mockCountResponse({ body: { isSuccess: true, result: { total: 38188, list: [] } } });
      },
    },
  });
  const envelope = await transport.getDeclaredTotal({ dayId: "7829", checkpoint: "provisional-final" });
  assert.equal(envelope.result.total, 38188);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.url.pathname, "/api/doujinshi/search.do");
  assert.equal(request.url.searchParams.get("eventId"), "7829");
  assert.equal(request.url.searchParams.get("typeIds"), "");
  assert.equal(request.url.searchParams.get("orderBy"), "0");
  assert.equal(request.url.searchParams.get("pageIndex"), "1");
  assert.equal(request.url.searchParams.get("pageSize"), "1");
  assert.equal(request.label, "provisional-final global count");
});

test("live global count 对登录 redirect、200 HTML、401/403 fail closed", async () => {
  for (const response of [
    mockCountResponse({ status: 200, contentType: "text/html", body: {} }),
    mockCountResponse({ status: 401, body: {} }),
    mockCountResponse({ status: 403, body: {} }),
  ]) {
    const transport = createLiveTransport({ timeoutMs: 1000, minIntervalMs: 800, cookie: "fixture=yes", requester: { async request() { return response; } } });
    await assert.rejects(() => transport.getDeclaredTotal({ dayId: "7829", checkpoint: "A-before" }), /鉴权失败|不是 JSON/);
  }
  const redirected = createLiveTransport({ timeoutMs: 1000, minIntervalMs: 800, cookie: "fixture=yes", requester: { async request(_url, init) { assert.equal(init.redirect, "error"); throw new TypeError("redirect blocked"); } } });
  await assert.rejects(() => redirected.getDeclaredTotal({ dayId: "7829", checkpoint: "A-before" }), /redirect blocked/);
});

function epochAwareTransport(sourceFixture, mutate = () => {}) {
  const base = createGeneratedFixtureTransport(sourceFixture);
  const fullEpochs = new Map();
  let barrierRemaining = 0;
  let barrierCheckpoint = null;
  return {
    fullEpochs,
    getEventPage: (...args) => base.getEventPage(...args),
    getRequestMetrics: () => base.getRequestMetrics(),
    getDeclaredTotal(args) {
      if (args.checkpoint !== "A-before") {
        barrierRemaining = 16;
        barrierCheckpoint = args.checkpoint;
      }
      return base.getDeclaredTotal(args);
    },
    async getSearchPage(args) {
      const response = await base.getSearchPage(args);
      let kind = "full";
      if (args.pageIndex === 1 && barrierRemaining > 0) {
        barrierRemaining -= 1;
        kind = "barrier";
      } else if (args.pageIndex === 1) {
        fullEpochs.set(args.typeId, (fullEpochs.get(args.typeId) || 0) + 1);
      }
      return mutate({ args, response, kind, epoch: fullEpochs.get(args.typeId) || 0, barrierCheckpoint }) ?? response;
    },
  };
}

test("单类中途增长只废弃并重扫该类，其他分类不重扫", async () => {
  const small = smallConcurrencyFixture();
  const transport = epochAwareTransport(small, ({ args, response, kind, epoch }) => {
    if (kind === "full" && args.typeId === 114 && epoch === 1 && args.pageIndex === 2) response.result.total = 2;
  });
  const snapshot = await runCPGSnapshot({ sourceTransport: transport, pageSize: 1 });
  assert.equal(transport.fullEpochs.get(114), 3);
  assert.ok([...transport.fullEpochs].filter(([typeId]) => typeId !== 114).every(([, epochs]) => epochs === 2));
  assert.equal(snapshot.tasks.find((task) => task.typeId === 114).dirtyRetries, 1);
  validateFrozenSnapshot(snapshot);
});

test("validation 等量替换只收敛 dirty hash，并保留两个匹配 full epoch", async () => {
  const small = smallConcurrencyFixture();
  const replacementId = 888000001;
  const transport = epochAwareTransport(small, ({ args, response, kind, epoch }) => {
    if (kind === "full" && args.typeId === 101 && epoch >= 2 && args.pageIndex === 1) response.result.list[0].doujinshiId = replacementId;
  });
  const snapshot = await runCPGSnapshot({ sourceTransport: transport, pageSize: 1 });
  const task = snapshot.tasks.find((item) => item.typeId === 101);
  assert.equal(transport.fullEpochs.get(101), 3);
  assert.equal(task.dirtyRetries, 1);
  assert.equal(task.stableEpochs[0].idsHash, task.stableEpochs[1].idsHash);
  assert.ok(snapshot.rows.some((row) => row.doujinshi_id === replacementId));
  validateFrozenSnapshot(snapshot);
});

test("同一 type 第四次 outer dirty 重扫请求发出前 blocked 且不生成 snapshot", async () => {
  const small = smallConcurrencyFixture();
  const transport = epochAwareTransport(small, ({ args, response, kind, epoch }) => {
    if (kind === "full" && args.typeId === 101 && epoch >= 2 && args.pageIndex === 1) response.result.list[0].doujinshiId = 888000000 + epoch;
  });
  await assert.rejects(() => runCPGSnapshot({ sourceTransport: transport, pageSize: 1 }), /outer extra rescan budget 耗尽/);
  assert.equal(transport.fullEpochs.get(101), 5);
});

test("barrier 发现单类 dirty total 时只重扫该类并重新取得连续双 barrier", async () => {
  const small = smallConcurrencyFixture();
  let injected = false;
  const transport = epochAwareTransport(small, ({ args, response, kind }) => {
    if (!injected && kind === "barrier" && args.typeId === 116 && args.pageIndex === 1) {
      response.result.total = 2;
      injected = true;
    }
  });
  const snapshot = await runCPGSnapshot({ sourceTransport: transport, pageSize: 1 });
  assert.equal(transport.fullEpochs.get(116), 3);
  assert.ok([...transport.fullEpochs].filter(([typeId]) => typeId !== 116).every(([, epochs]) => epochs === 2));
  assert.equal(snapshot.tasks.find((task) => task.typeId === 116).dirtyRetries, 1);
  assert.equal(snapshot.finalBarriers.length, 2);
  assert.deepEqual(snapshot.finalBarriers[0].typeTotals, snapshot.finalBarriers[1].typeTotals);
  validateFrozenSnapshot(snapshot);
});

test("不同 type 在多轮 outer convergence 中 dirty 可在全局第 8 轮收敛", async () => {
  const small = smallConcurrencyFixture();
  const dirtyByRound = new Map(Array.from({ length: 7 }, (_, index) => [index + 1, 101 + index]));
  const transport = epochAwareTransport(small, ({ args, response, kind, barrierCheckpoint }) => {
    const match = /^final-(\d+)-barrier-1$/.exec(barrierCheckpoint || "");
    const round = match ? Number(match[1]) : 0;
    if (kind === "barrier" && dirtyByRound.get(round) === args.typeId) response.result.total = 2;
  });
  const snapshot = await runCPGSnapshot({ sourceTransport: transport, pageSize: 1 });
  assert.equal(snapshot.convergenceRounds, 8);
  for (const typeId of dirtyByRound.values()) assert.equal(snapshot.tasks.find((task) => task.typeId === typeId).dirtyRetries, 1);
  validateFrozenSnapshot(snapshot);
});

test("validator 拒绝伪造 rounds>8、单类 dirtyRetries>3 与汇总不自洽", async () => {
  const snapshot = await runCPGSnapshot({ sourceTransport: createGeneratedFixtureTransport(smallConcurrencyFixture()), pageSize: 1 });
  const excessiveRounds = clone(snapshot);
  excessiveRounds.convergenceRounds = 9;
  excessiveRounds.snapshotHash = calculateSnapshotHash(excessiveRounds);
  assert.throws(() => validateFrozenSnapshot(excessiveRounds), /convergence 指标无效/);

  const excessiveTypeRetries = clone(snapshot);
  excessiveTypeRetries.tasks[0].dirtyRetries = 4;
  excessiveTypeRetries.dirtyRetries = 4;
  excessiveTypeRetries.snapshotHash = calculateSnapshotHash(excessiveTypeRetries);
  assert.throws(() => validateFrozenSnapshot(excessiveTypeRetries), /双 epoch 证明无效/);

  const inconsistentRetries = clone(snapshot);
  inconsistentRetries.dirtyRetries = 1;
  inconsistentRetries.snapshotHash = calculateSnapshotHash(inconsistentRetries);
  assert.throws(() => validateFrozenSnapshot(inconsistentRetries), /dirtyRetries 不自洽/);
});

test("total 漂移、中间短页与提前 sentinel 均 fail closed", async () => {
  const cases = [
    {
      mutate: (args, response) => { if (args.typeId === 101 && args.pageIndex === 2) response.result.total += 1; return response; },
      pattern: /total 漂移/,
    },
    {
      mutate: (args, response) => { if (args.typeId === 101 && args.pageIndex === 2) response.result.list.pop(); return response; },
      pattern: /页宽异常/,
    },
    {
      mutate: (args, response) => { if (args.typeId === 101 && args.pageIndex === 2) response.result.list = []; return response; },
      pattern: /sentinel 覆盖不完整/,
    },
  ];
  for (const entry of cases) await assert.rejects(() => runCPGSnapshot({ sourceTransport: wrappedGeneratedTransport(entry.mutate), pageSize: 1000 }), entry.pattern);
});

test("跨页重复与跨分类重复 ID 均 fail closed", async () => {
  await assert.rejects(
    () => runCPGSnapshot({
      sourceTransport: wrappedGeneratedTransport((args, response) => {
        if (args.typeId === 101 && args.pageIndex === 2) response.result.list[0].doujinshiId = 707300001;
        return response;
      }),
      pageSize: 1000,
    }),
    /跨页重复 ID/
  );
  await assert.rejects(
    () => runCPGSnapshot({
      sourceTransport: wrappedGeneratedTransport((args, response) => {
        if (args.typeId === 102 && args.pageIndex === 1) response.result.list[0].doujinshiId = 707300001;
        return response;
      }),
      pageSize: 1000,
    }),
    /跨分类重复 ID/
  );
});

function smallConcurrencyFixture() {
  const small = clone(fixture);
  small.declaredTotal = 16;
  for (const typeId of Object.keys(small.taskTotals)) small.taskTotals[typeId] = 1;
  return small;
}

test("显式 provisionalSinglePass 只扫一轮并签名小误差证据", async () => {
  const small = smallConcurrencyFixture();
  const base = createGeneratedFixtureTransport(small);
  const pagesByType = new Map();
  let finalProbe = false;
  let firstType101Item;
  const snapshot = await runCPGProvisionalSnapshot({
    pageSize: 1,
    sourceTransport: {
      getEventPage: (...args) => base.getEventPage(...args),
      getRequestMetrics: () => base.getRequestMetrics(),
      getDeclaredTotal(...args) { finalProbe = true; return base.getDeclaredTotal(...args); },
      async getSearchPage(args) {
        pagesByType.set(args.typeId, [...(pagesByType.get(args.typeId) || []), args.pageIndex]);
        const response = await base.getSearchPage(args);
        if (!finalProbe && args.typeId === 101 && args.pageIndex === 1) firstType101Item = clone(response.result.list[0]);
        if (!finalProbe && args.typeId === 101 && args.pageIndex === 2) {
          response.result.total = 2;
          response.result.list = [clone(firstType101Item)];
        }
        return response;
      },
    },
  });
  assert.equal(snapshot.schemaVersion, 4);
  assert.equal(snapshot.state, "snapshot_ready_provisional");
  assert.equal(snapshot.scanPasses, 1);
  assert.equal(snapshot.provisionalEvidence.observedGlobal, 16);
  assert.equal(snapshot.provisionalEvidence.sumTypeTotals, 16);
  assert.equal(snapshot.provisionalEvidence.uniqueRows, 16);
  assert.equal(snapshot.provisionalEvidence.duplicates, 1);
  assert.equal(snapshot.provisionalEvidence.lag, 0);
  assert.deepEqual(pagesByType.get(101), [1, 2, 3, 1]);
  assert.ok([...pagesByType].filter(([typeId]) => typeId !== 101).every(([, pages]) => pages.join(",") === "1,2,1"));
  validateFrozenSnapshot(snapshot);
  const cli = readFileSync(new URL("../scripts/scan-cpg.mjs", import.meta.url), "utf8");
  assert.match(cli, /provisionalSinglePass:\s*\{\s*type:\s*"boolean"/);
});

test("provisional final 对 unfiltered 10000 cap 签名并以 16 类 totals 作为 observed total", async () => {
  const large = clone(fixture);
  large.declaredTotal = 38014;
  large.taskTotals[116] -= 174;
  const base = createGeneratedFixtureTransport(large);
  const globalCalls = [];
  const eventCheckpoints = [];
  const snapshot = await runCPGProvisionalSnapshot({
    pageSize: 1000,
    sourceTransport: {
      getEventPage(args) { eventCheckpoints.push(args); return base.getEventPage(args); },
      async getDeclaredTotal(args) {
        globalCalls.push(args);
        const envelope = await base.getDeclaredTotal(args);
        envelope.result.total = 10000;
        return envelope;
      },
      getSearchPage: (...args) => base.getSearchPage(...args),
      getRequestMetrics: () => base.getRequestMetrics(),
    },
  });
  assert.equal(snapshot.provisionalEvidence.observedGlobal, 38014);
  assert.equal(snapshot.provisionalEvidence.sumTypeTotals, 38014);
  assert.equal(snapshot.provisionalEvidence.uniqueRows, 38014);
  assert.equal(snapshot.provisionalEvidence.globalCountCapped, true);
  assert.equal(snapshot.provisionalEvidence.globalProbeTotal, 10000);
  assert.equal(snapshot.provisionalEvidence.observedTotalSource, "sum-type-totals");
  assert.deepEqual(globalCalls, [{ dayId: "7829", checkpoint: "provisional-final" }]);
  assert.deepEqual(eventCheckpoints.map((call) => call.checkpoint), ["provisional-initial", "provisional-final"]);
  assert.equal(snapshot.provisionalEvidence.global.typeIds, "");
  assert.equal(snapshot.provisionalEvidence.global.orderBy, "0");
  assert.equal(snapshot.provisionalEvidence.global.requestSemanticsVersion, "cpp-unfiltered-search-v1");
  validateFrozenSnapshot(snapshot);
  const tampered = clone(snapshot);
  tampered.provisionalEvidence.globalCountCapped = false;
  tampered.snapshotHash = calculateSnapshotHash(tampered);
  assert.throws(() => validateFrozenSnapshot(tampered), /provisional 误差证据无效/);
});

test("provisional 非 10000 cap 的 global/type mismatch 仍 fail closed", async () => {
  const small = smallConcurrencyFixture();
  const base = createGeneratedFixtureTransport(small);
  await assert.rejects(() => runCPGProvisionalSnapshot({
    pageSize: 1,
    sourceTransport: {
      getEventPage: (...args) => base.getEventPage(...args),
      getSearchPage: (...args) => base.getSearchPage(...args),
      async getDeclaredTotal(...args) {
        const envelope = await base.getDeclaredTotal(...args);
        envelope.result.total = 15;
        return envelope;
      },
    },
  }), /sumTypeTotals 16 != globalProbeTotal 15/);
});

test("provisional final topology await/校验完成前不启动 global 或 16 类 totals", async () => {
  async function scenario(finalEventPage) {
    const small = smallConcurrencyFixture();
    const base = createGeneratedFixtureTransport(small);
    let eventCalls = 0;
    let finalRequested = false;
    let finalPhase = false;
    let resolveFinal;
    const finalPagePromise = new Promise((resolve) => { resolveFinal = resolve; });
    let finalGlobalCalls = 0;
    let finalTypeCalls = 0;
    const running = runCPGProvisionalSnapshot({
      pageSize: 1,
      sourceTransport: {
        getEventPage(args) {
          eventCalls += 1;
          if (args.checkpoint === "provisional-initial") return base.getEventPage(args);
          finalPhase = true;
          finalRequested = true;
          return finalPagePromise;
        },
        getDeclaredTotal(...args) { if (finalPhase) finalGlobalCalls += 1; return base.getDeclaredTotal(...args); },
        getSearchPage(...args) { if (finalPhase) finalTypeCalls += 1; return base.getSearchPage(...args); },
      },
    });
    while (!finalRequested) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(eventCalls, 2);
    assert.equal(finalGlobalCalls, 0);
    assert.equal(finalTypeCalls, 0);
    resolveFinal(finalEventPage);
    return { running, calls: () => ({ finalGlobalCalls, finalTypeCalls }) };
  }

  const valid = await scenario(fixture.eventPageHtml);
  await valid.running;
  assert.deepEqual(valid.calls(), { finalGlobalCalls: 1, finalTypeCalls: 16 });

  const invalid = await scenario(fixture.eventPageHtml.replace('"dayIds":["7829"]', '"dayIds":["7830"]'));
  await assert.rejects(() => invalid.running, /topology 漂移/);
  assert.deepEqual(invalid.calls(), { finalGlobalCalls: 0, finalTypeCalls: 0 });
});

test("provisional 仍拒绝跨分类同 ID 冲突", async () => {
  const small = smallConcurrencyFixture();
  const base = createGeneratedFixtureTransport(small);
  let firstId;
  await assert.rejects(() => runCPGProvisionalSnapshot({
    pageSize: 1,
    sourceTransport: {
      getEventPage: (...args) => base.getEventPage(...args),
      getDeclaredTotal: (...args) => base.getDeclaredTotal(...args),
      async getSearchPage(args) {
        const response = await base.getSearchPage(args);
        if (args.typeId === 101 && args.pageIndex === 1) firstId = response.result.list[0].doujinshiId;
        if (args.typeId === 102 && args.pageIndex === 1) response.result.list[0].doujinshiId = firstId;
        return response;
      },
    },
  }), /跨分类同 ID 冲突/);
});

test("分类 worker pool 限制并发、同类分页串行且 concurrency 1/4 结果一致", async () => {
  const small = smallConcurrencyFixture();
  const base = createGeneratedFixtureTransport(small);
  let active = 0;
  let maxActive = 0;
  let activeFullScanPages = 0;
  let maxActiveFullScanPages = 0;
  const activeTypes = new Set();
  const pagesByType = new Map();
  const transport = {
    getEventPage: (...args) => base.getEventPage(...args),
    getDeclaredTotal: (...args) => base.getDeclaredTotal(...args),
    getRequestMetrics: () => base.getRequestMetrics(),
    async getSearchPage(args) {
      assert.equal(activeTypes.has(args.typeId), false, `type ${args.typeId} page 不得并发`);
      activeTypes.add(args.typeId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (args.pageIndex > 1) {
        activeFullScanPages += 1;
        maxActiveFullScanPages = Math.max(maxActiveFullScanPages, activeFullScanPages);
      }
      pagesByType.set(args.typeId, [...(pagesByType.get(args.typeId) || []), args.pageIndex]);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const response = await base.getSearchPage(args);
      if (args.pageIndex > 1) activeFullScanPages -= 1;
      active -= 1;
      activeTypes.delete(args.typeId);
      return response;
    },
  };
  const concurrent = await runCPGSnapshot({ sourceTransport: transport, pageSize: 1, categoryWorkers: 4 });
  const serial = await runCPGSnapshot({ sourceTransport: createGeneratedFixtureTransport(small), pageSize: 1, categoryWorkers: 1 });
  assert.ok(maxActive > 4, "barrier 应并发发出 16 类 page1，由共享请求 semaphore 限流");
  assert.ok(maxActiveFullScanPages > 1 && maxActiveFullScanPages <= 4);
  assert.ok([...pagesByType.values()].every((pages) => pages.join(",") === "1,2,1,1,1,2,1,1"));
  assert.equal(concurrent.snapshotHash, serial.snapshotHash);
  assert.deepEqual(concurrent.rows, serial.rows);
  await assert.rejects(() => runCPGSnapshot({ sourceTransport: base, categoryWorkers: 7 }), /categoryWorkers 必须在 1\.\.6/);
});

test("任一 worker 失败后停止调度新分类且不生成 snapshot", async () => {
  const small = smallConcurrencyFixture();
  const base = createGeneratedFixtureTransport(small);
  const startedTypes = new Set();
  await assert.rejects(() => runCPGSnapshot({
    sourceTransport: {
      getEventPage: (...args) => base.getEventPage(...args),
      getDeclaredTotal: (...args) => base.getDeclaredTotal(...args),
      getRequestMetrics: () => base.getRequestMetrics(),
      async getSearchPage(args) {
        startedTypes.add(args.typeId);
        if (args.typeId === 101) throw new Error("fixture worker failure");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return base.getSearchPage(args);
      },
    },
    pageSize: 1,
    categoryWorkers: 4,
  }), /fixture worker failure/);
  assert.ok(startedTypes.size <= 4);
});

test("CPP 全局 limiter 遵守 Retry-After、429 全局降速并重试同一页", async () => {
  let clock = 0;
  const calls = [];
  const statuses = [429, 200, 200];
  const controller = createCPPRequestController({
    fetchImpl: async (url) => {
      calls.push({ url: String(url), at: clock });
      const status = statuses.shift();
      return { status, headers: { get: () => status === 429 ? "1" : null } };
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    minIntervalMs: 250,
    maxInFlight: 4,
  });
  const first = await controller.request("https://fixture.test/type101-page1", { method: "GET" }, "type101-page1");
  const second = await controller.request("https://fixture.test/type102-page1", { method: "GET" }, "type102-page1");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://fixture.test/type101-page1",
    "https://fixture.test/type101-page1",
    "https://fixture.test/type102-page1",
  ]);
  assert.deepEqual(calls.map((call) => call.at), [0, 1000, 1500]);
  assert.deepEqual(controller.getMetrics(), {
    requestStarts: 3,
    retries: 1,
    status429: 1,
    maxInFlight: 1,
    effectiveMinInterval: 500,
    elapsedMs: 1500,
  });
  assert.throws(() => createCPPRequestController({ minIntervalMs: 249 }), /不得低于 250ms/);
  assert.throws(() => createCPPRequestController({ maxInFlight: 7 }), /maxInFlight 必须在 1\.\.6/);
});

test("CPP 全局 limiter 限制 max in-flight 且跨请求启动至少间隔 250ms", async () => {
  let clock = 0;
  const starts = [];
  const pending = [];
  const controller = createCPPRequestController({
    fetchImpl: (url) => new Promise((resolve) => {
      starts.push({ url: String(url), at: clock });
      pending.push(() => resolve({ status: 200, headers: { get: () => null } }));
    }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    minIntervalMs: 250,
    maxInFlight: 2,
  });
  const requests = [1, 2, 3].map((id) => controller.request(`https://fixture.test/${id}`, { method: "GET" }, String(id)));
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts.map((entry) => entry.at), [0, 250]);
  pending[0]();
  while (pending.length < 3) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts.map((entry) => entry.at), [0, 250, 500]);
  pending[1]();
  pending[2]();
  await Promise.all(requests);
  assert.equal(controller.getMetrics().maxInFlight, 2);
});

test("CPG 新建 preset 使用真实 day，历史 7073 查询兼容保持极窄", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /id:\s*"cpg08"[\s\S]*?cppEventId:\s*"cpg08"[\s\S]*?days:\s*\[\{\s*id:\s*"7829"/);

  const service = readFileSync(new URL("../lib/db-service.ts", import.meta.url), "utf8");
  const helper = service.match(/export function normalizeCPPMatchDayIds[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(helper, /cppEventId === "cpg08"/);
  assert.match(helper, /dayIds\?\.length === 1/);
  assert.match(helper, /dayIds\[0\] === "7073"/);
  assert.match(helper, /return \["7829"\]/);
  assert.match(service, /const dayIds = normalizeCPPMatchDayIds\(cppEventId, data\.days\)/);
  assert.doesNotMatch(helper, /startsWith|includes/);

  const compiled = ts.transpileModule(helper, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^export\s+/m, "");
  const normalizeDays = Function(`${compiled}\nreturn normalizeCPPMatchDayIds;`)();
  assert.deepEqual(normalizeDays("cpg08", [{ id: "7073" }]), ["7829"]);
  assert.deepEqual(normalizeDays("cpg08", [{ id: "7829" }]), ["7829"]);
  assert.deepEqual(normalizeDays("cpg08", [{ id: "7073" }, { id: "7829" }]), ["7073", "7829"]);
  assert.deepEqual(normalizeDays("cp32", [{ id: "7073" }]), ["7073"]);
  assert.equal(normalizeDays("cpg08", null), undefined);
});
