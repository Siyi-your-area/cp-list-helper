import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EVENT_DAYS,
  EVENT_TYPES,
  EXPECTED_TASK_KEYS,
  createCPPRequestController,
  createFixtureDatabaseTransport,
  createFixtureSourceTransport,
  cookieHeaderFromJson,
  normalizeHotCount,
  parseExactContentRange,
  parseAndValidateEventPage,
  resolveCookieHeader,
  runEvent6377Audit,
  validateSourceFixture,
} from "../scripts/event6377-scanner-core.mjs";

const sourceFixturePath = fileURLToPath(
  new URL("./fixtures/event6377-scanner-source.json", import.meta.url)
);
const databaseFixturePath = fileURLToPath(
  new URL("./fixtures/event6377-scanner-db.json", import.meta.url)
);
const scannerEntryPath = fileURLToPath(
  new URL("../scripts/scan-event6377.mjs", import.meta.url)
);
const scannerCorePath = fileURLToPath(
  new URL("../scripts/event6377-scanner-core.mjs", import.meta.url)
);
const EXPECTED_EVENT_TYPES = [
  { id: 36, name: "漫画" },
  { id: 37, name: "小说" },
  { id: 38, name: "图集" },
  { id: 39, name: "音乐" },
  { id: 40, name: "GAME" },
  { id: 43, name: "卡片" },
  { id: 44, name: "纸胶带" },
  { id: 45, name: "COS" },
  { id: 46, name: "其他" },
  { id: 48, name: "手办" },
  { id: 49, name: "亚克力" },
  { id: 50, name: "图文志" },
  { id: 51, name: "海报集" },
  { id: 52, name: "其他作品集" },
  { id: 53, name: "徽章" },
  { id: 54, name: "色纸" },
];

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function sourceItem({
  id,
  dayId = "7040",
  name = `样本 ${id}`,
  boothNumber = `A${id}`,
  boothName = `社团 ${id}`,
} = {}) {
  return {
    doujinshiId: id,
    doujinshiName: name,
    authorList: [{ authorName: `作者 ${id}` }],
    coverPicUrl: "",
    tag: "测试",
    hotCount: id,
    themeAlias: "原创",
    eventList: [
      {
        eventID: dayId,
        position: boothNumber,
        circleName: boothName,
      },
    ],
  };
}

function dbRowFromItem(item, { typeId = 36, typeName = "漫画" } = {}) {
  const event = item.eventList[0];
  return {
    event_id: "cp32",
    day_id: String(event.eventID),
    type_id: typeId,
    type_name: typeName,
    doujinshi_id: item.doujinshiId,
    product_name: item.doujinshiName,
    author: item.authorList.map((author) => author.authorName).join(", "),
    booth_number: event.position,
    booth_name: event.circleName,
    image_url: item.coverPicUrl
      ? `https://imagecdn3.allcpp.cn/upload${item.coverPicUrl}`
      : "",
    tags: item.tag ? item.tag.split("|") : [],
    source_url: `https://www.allcpp.cn/d/${item.doujinshiId}.do`,
    hot_count: item.hotCount,
    original_work: item.themeAlias,
  };
}

async function runFixture(source, database, options = {}) {
  return runEvent6377Audit({
    sourceTransport: createFixtureSourceTransport(source),
    databaseTransport: createFixtureDatabaseTransport(database),
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    ...options,
  });
}

async function runWithDatabaseTransport(databaseTransport, options = {}) {
  return runEvent6377Audit({
    sourceTransport: createFixtureSourceTransport(loadJson(sourceFixturePath)),
    databaseTransport,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    ...options,
  });
}

function createCappedDatabaseTransport(rows, serverPageCap = Infinity) {
  const calls = [];
  return {
    calls,
    async selectCppItemsPage({ offset, limit }) {
      calls.push({ offset, limit });
      const actualLimit = Math.min(limit, serverPageCap);
      return {
        rows: structuredClone(rows.slice(offset, offset + actualLimit)),
        exactTotal: rows.length,
      };
    },
  };
}

function makeDatabaseRows(count) {
  return Array.from({ length: count }, (_, index) =>
    dbRowFromItem(
      sourceItem({
        id: 7000000 + index,
        dayId: index % 2 === 0 ? "7040" : "7042",
      })
    )
  );
}

function createSingleTaskSourceTransport({
  items,
  reportedTotal,
  sentinelReportedTotal,
  effectivePageSize = 40,
}) {
  const eventPageHtml = loadJson(sourceFixturePath).eventPageHtml;
  return {
    async getEventPage() {
      return eventPageHtml;
    },
    async getSearchPage({ dayId, typeId, orderBy, pageIndex }) {
      if (dayId !== "7040" || typeId !== 36 || orderBy !== "1") {
        return {
          isSuccess: true,
          result: { total: 0, list: [] },
        };
      }
      const start = (pageIndex - 1) * effectivePageSize;
      if (start < items.length) {
        return {
          isSuccess: true,
          result: {
            total: reportedTotal,
            list: structuredClone(
              items.slice(start, start + effectivePageSize)
            ),
          },
        };
      }
      return {
        isSuccess: true,
        result: { total: sentinelReportedTotal, list: [] },
      };
    },
  };
}

test("fixture 显式声明 exact 32 tasks、合法空分类与全部页面", () => {
  const fixture = loadJson(sourceFixturePath);
  assert.equal(Object.keys(fixture.manifest.tasks).length, 32);
  assert.deepEqual(
    Object.keys(fixture.manifest.tasks).sort(),
    [...EXPECTED_TASK_KEYS].sort()
  );
  assert.equal(
    Object.values(fixture.manifest.tasks).filter((task) => task.legalEmpty)
      .length,
    30
  );
  assert.equal(validateSourceFixture(fixture), fixture);
});

test("fixture 缺 task 或缺声明页面时立即失败", () => {
  const missingTask = loadJson(sourceFixturePath);
  delete missingTask.manifest.tasks["7042:54"];
  assert.throws(
    () => validateSourceFixture(missingTask),
    /恰好声明 32 个任务/
  );

  const missingPage = loadJson(sourceFixturePath);
  delete missingPage.responses["7040:36:1:2"];
  assert.throws(
    () => validateSourceFixture(missingPage),
    /缺少已声明页面 7040:36:1:2/
  );
});

test("event6377 HTML 只接受 6377、7040/7042 与当前 16 分类", () => {
  const fixture = loadJson(sourceFixturePath);
  const parsed = parseAndValidateEventPage(fixture.eventPageHtml);
  assert.deepEqual(parsed.days, EVENT_DAYS);
  assert.deepEqual(EVENT_TYPES, EXPECTED_EVENT_TYPES);
  assert.deepEqual(parsed.types, EXPECTED_EVENT_TYPES);
  assert.deepEqual(
    parsed.types
      .filter((type) => [43, 44, 45].includes(type.id))
      .map((type) => type.name),
    ["卡片", "纸胶带", "COS"]
  );
  const dynamicHtml = [
    '<a href="/allcpp/event/eventdoujinshi.do?event=3818">推荐展会一</a>',
    '<a href="/allcpp/event/eventdoujinshi.do?event=6377">event6377</a>',
    '<a href="/allcpp/event/eventdoujinshi.do?event=4222">推荐展会二</a>',
    '<a href="/allcpp/event/eventdoujinshi.do?event=4670">推荐展会三</a>',
    ...EVENT_DAYS.map((dayId) => `<button data-day-id="${dayId}"></button>`),
    ...EVENT_TYPES.map(
      (type) =>
        `<button data-type-name="${type.name}" data-type-id="${type.id}"></button>`
    ),
  ].join("");
  assert.deepEqual(
    parseAndValidateEventPage(dynamicHtml).types,
    EVENT_TYPES.map((type) => ({ ...type }))
  );
  const realShapeHtml = [
    '<a href="/allcpp/event/eventdoujinshi.do?event=3818">推荐</a>',
    '<a href="/allcpp/event/eventdoujinshi.do?event=6377">当前</a>',
    "<script>zEids.push(7040); zEids.push(7042);</script>",
    '<span data-id="7040" class="active">第一日</span>',
    '<span class="" data-id="7042">第二日</span>',
    ...EXPECTED_EVENT_TYPES.map((type, index) =>
      index % 2 === 0
        ? `<span id="type${type.id}" data-type="0" data-id="${type.id}">${type.name}</span>`
        : `<span data-id="${type.id}" data-type="1" id="type${type.id}">${type.name}</span>`
    ),
  ].join("");
  assert.deepEqual(parseAndValidateEventPage(realShapeHtml), {
    sourceEventId: "6377",
    days: ["7040", "7042"],
    types: EXPECTED_EVENT_TYPES,
  });
  assert.throws(
    () =>
      parseAndValidateEventPage(
        realShapeHtml.replace(
          'id="type36" data-type="0" data-id="36"',
          'id="type36" data-type="0" data-id="37"'
        )
      ),
    /分类元素 ID 不一致/
  );
  assert.throws(
    () =>
      parseAndValidateEventPage(
        `<main data-current-event-id="6000">${dynamicHtml}</main>`
      ),
    /活动 ID 漂移/
  );

  assert.throws(
    () =>
      parseAndValidateEventPage(
        fixture.eventPageHtml.replace(
          '"sourceEventId":"6377"',
          '"sourceEventId":"6000"'
        )
      ),
    /活动 ID 漂移/
  );
  assert.throws(
    () =>
      parseAndValidateEventPage(
        fixture.eventPageHtml.replace('{"id":36,"name":"漫画"}', '{"id":33,"name":"卡片"}')
      ),
    /旧分类 ID 33/
  );
  assert.throws(
    () =>
      parseAndValidateEventPage(
        fixture.eventPageHtml.replace('"name":"卡片"', '"name":"亚克力"')
      ),
    /分类 43 名称漂移/
  );
});

test("完整离线 fixture 无需环境变量并生成零写 ok 报告", async () => {
  const previous = {
    cookie: process.env.CPP_COOKIE,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_READONLY_KEY,
  };
  delete process.env.CPP_COOKIE;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_READONLY_KEY;
  try {
    const report = await runFixture(
      loadJson(sourceFixturePath),
      loadJson(databaseFixturePath)
    );
    assert.equal(report.status, "ok");
    assert.equal(report.valid, true);
    assert.equal(report.readOnly, true);
    assert.equal(report.dbWritesAttempted, 0);
    assert.equal(report.totals.tasks, 32);
    assert.equal(report.days[0].sourceUnique, 1);
    assert.equal(report.days[1].databaseUnique, 1);
  } finally {
    if (previous.cookie !== undefined) process.env.CPP_COOKIE = previous.cookie;
    if (previous.url !== undefined) process.env.SUPABASE_URL = previous.url;
    if (previous.key !== undefined) {
      process.env.SUPABASE_READONLY_KEY = previous.key;
    }
  }
});

test("CPP_COOKIE_JSON 安全转换且 CPP_COOKIE 保持优先", () => {
  assert.equal(
    cookieHeaderFromJson(
      JSON.stringify([
        { name: "token", value: "fixture-token" },
        { name: "JSESSIONID", value: "fixture-session" },
      ])
    ),
    "token=fixture-token; JSESSIONID=fixture-session"
  );
  assert.equal(
    cookieHeaderFromJson(
      JSON.stringify({
        cookies: [{ name: "token", value: "wrapped-token" }],
      })
    ),
    "token=wrapped-token"
  );
  assert.equal(
    cookieHeaderFromJson(
      JSON.stringify({ token: "object-token", session: "object-session" })
    ),
    "token=object-token; session=object-session"
  );
  assert.equal(
    resolveCookieHeader({
      CPP_COOKIE: "token=preferred",
      CPP_COOKIE_JSON: JSON.stringify({ token: "fallback" }),
    }),
    "token=preferred"
  );

  const secret = "must-not-leak";
  assert.throws(
    () =>
      cookieHeaderFromJson(
        JSON.stringify({ token: `${secret};injected=true` })
      ),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );
  assert.throws(
    () =>
      cookieHeaderFromJson(
        JSON.stringify([
          { name: "token", value: "one" },
          { name: "token", value: "two" },
        ])
      ),
    /重复 name/
  );
});

test("hotCount 接受 -1 sentinel、非负安全整数及纯十进制字符串", () => {
  for (const [input, expected] of [
    [null, 0],
    [undefined, 0],
    ["", 0],
    [0, 0],
    [12, 12],
    ["0", 0],
    ["0012", 12],
    ["3411", 3411],
    [-1, -1],
    ["-1", -1],
  ]) {
    const result = normalizeHotCount(input);
    assert.equal(result, expected);
    assert.equal(typeof result, "number");
  }
});

test("source hotCount 数字字符串按 number 与数据库比较", async () => {
  const source = loadJson(sourceFixturePath);
  source.responses["7040:36:1:1"].result.list[0].hotCount = "12";
  const report = await runFixture(source, loadJson(databaseFixturePath));
  assert.equal(report.status, "ok");
  assert.deepEqual(report.days[0].changedIds, []);

  source.responses["7040:36:1:1"].result.list[0].hotCount = "-1";
  const database = loadJson(databaseFixturePath);
  database.rows[0].hot_count = -1;
  const sentinelReport = await runFixture(source, database);
  assert.equal(sentinelReport.status, "ok");
  assert.deepEqual(sentinelReport.days[0].changedIds, []);
});

test("hotCount 拒绝小于 -1、非 exact -1、小数及非安全数值", () => {
  for (const input of [
    -2,
    1.2,
    Infinity,
    -Infinity,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "-2",
    "-01",
    "-1 ",
    "1.2",
    "1e3",
    "12x",
    " 12",
    "12 ",
    "9007199254740992",
    {},
  ]) {
    assert.throws(() => normalizeHotCount(input), /hotCount 无效/);
  }
});

function mockHttpResponse(status, retryAfter = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return name.toLowerCase() === "retry-after" ? retryAfter : null;
      },
    },
  };
}

test("CPP 429 优先 Retry-After 后成功，且请求保持串行限速", async () => {
  let clock = 0;
  const sleeps = [];
  const callTimes = [];
  const retries = [];
  const statuses = [429, 200, 200];
  const controller = createCPPRequestController({
    fetchImpl: async () => {
      callTimes.push(clock);
      const status = statuses.shift();
      return mockHttpResponse(status, status === 429 ? "1" : null);
    },
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      clock += delayMs;
    },
    now: () => clock,
    random: () => 0,
    minIntervalMs: 800,
    onRetry: (event) => retries.push(event),
  });

  const first = controller.request("https://example.test/one", {}, "page-1");
  const second = controller.request("https://example.test/two", {}, "page-2");
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(callTimes, [0, 1000, 1800]);
  assert.deepEqual(sleeps, [1000, 800]);
  assert.deepEqual(retries, [
    {
      label: "page-1",
      status: 429,
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 6,
      delayMs: 1000,
    },
  ]);
});

test("CPP 可重试状态耗尽后失败，普通 4xx 不重试", async () => {
  let retryCalls = 0;
  let clock = 0;
  const exhausted = createCPPRequestController({
    fetchImpl: async () => {
      retryCalls += 1;
      return mockHttpResponse(503);
    },
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    now: () => clock,
    random: () => 0,
    minIntervalMs: 800,
    maxAttempts: 3,
  });
  await assert.rejects(
    () => exhausted.request("https://example.test", {}, "fixture-page"),
    /HTTP 503.*重试已耗尽.*3 次/
  );
  assert.equal(retryCalls, 3);

  let ordinaryCalls = 0;
  const ordinary = createCPPRequestController({
    fetchImpl: async () => {
      ordinaryCalls += 1;
      return mockHttpResponse(400);
    },
    sleep: async () => {},
    now: () => 0,
    minIntervalMs: 800,
  });
  const response = await ordinary.request(
    "https://example.test",
    {},
    "bad-request"
  );
  assert.equal(response.status, 400);
  assert.equal(ordinaryCalls, 1);
  assert.throws(
    () => createCPPRequestController({ minIntervalMs: 799 }),
    /不得低于 800ms/
  );
});

test("total 漂移、中间短页和错误 day 均被严格拒绝", async () => {
  const database = loadJson(databaseFixturePath);

  const drift = loadJson(sourceFixturePath);
  drift.responses["7040:36:1:2"].result.total = 2;
  await assert.rejects(() => runFixture(drift, database), /total 漂移/);

  const shortPage = loadJson(sourceFixturePath);
  const shortFirst = clone(
    shortPage.responses["7040:36:1:1"].result.list[0]
  );
  shortPage.responses["7040:36:1:1"].result = {
    total: 5,
    list: [shortFirst, sourceItem({ id: 6377010 })],
  };
  shortPage.responses["7040:36:1:2"].result = {
    total: 5,
    list: [sourceItem({ id: 6377011 })],
  };
  await assert.rejects(
    () => runFixture(shortPage, database, { pageSize: 2 }),
    /中间异常短页/
  );

  const wrongDay = loadJson(sourceFixturePath);
  wrongDay.responses["7040:36:1:1"].result.list[0].eventList[0].eventID =
    "7042";
  await assert.rejects(
    () => runFixture(wrongDay, database),
    /不属于请求活动日 7040/
  );
});

test("CPP 服务端把请求 100 截短为有效页宽 40 时仍扫描至 sentinel", async () => {
  const source = loadJson(sourceFixturePath);
  const database = loadJson(databaseFixturePath);
  const items = Array.from({ length: 81 }, (_, index) =>
    sourceItem({ id: 6377200 + index })
  );
  source.manifest.tasks["7040:36"].orders["1"] = [1, 2, 3, 4];
  source.responses["7040:36:1:1"] = {
    isSuccess: true,
    result: { total: 81, list: items.slice(0, 40) },
  };
  source.responses["7040:36:1:2"] = {
    isSuccess: true,
    result: { total: 81, list: items.slice(40, 80) },
  };
  source.responses["7040:36:1:3"] = {
    isSuccess: true,
    result: { total: 81, list: items.slice(80) },
  };
  source.responses["7040:36:1:4"] = {
    isSuccess: true,
    result: { total: 81, list: [] },
  };
  database.rows = [
    ...items.map((item) => dbRowFromItem(item)),
    database.rows.find((row) => row.day_id === "7042"),
  ];

  const report = await runFixture(source, database, { pageSize: 100 });
  const task = report.tasks.find(
    (entry) => entry.dayId === "7040" && entry.typeId === 36
  );
  assert.equal(report.status, "ok");
  assert.equal(task.requestedPageSize, 100);
  assert.deepEqual(task.effectivePageSizes, { "1": 40 });
  assert.equal(task.pages[0].requestedPageSize, 100);
  assert.equal(task.pages[0].effectivePageSize, 40);
  assert.equal(task.pages[0].rawRows, 81);
  assert.equal(task.pages[0].sentinelSeen, true);
});

test("exact 10000 读取 250×40 后接受 total=0 的空 sentinel", async () => {
  const items = Array.from({ length: 10000 }, (_, index) =>
    sourceItem({ id: 6400000 + index })
  );
  const databaseRows = items.map((item) => dbRowFromItem(item));
  const report = await runEvent6377Audit({
    sourceTransport: createSingleTaskSourceTransport({
      items,
      reportedTotal: 10000,
      sentinelReportedTotal: 0,
    }),
    databaseTransport: createCappedDatabaseTransport(
      databaseRows,
      1000
    ),
    pageSize: 100,
    databasePageSize: 1000,
    capThreshold: 10001,
    maxWindow: 10000,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
  });
  const task = report.tasks.find(
    (entry) => entry.dayId === "7040" && entry.typeId === 36
  );
  assert.equal(report.status, "ok");
  assert.equal(task.pages[0].rawRows, 10000);
  assert.equal(task.pages[0].pages.length, 251);
  assert.equal(task.pages[0].sentinelReportedTotal, 0);
  assert.deepEqual(task.sentinelReportedTotals, { "1": 0 });
});

test("提前空 total=0 与非空 total=0 均严格失败", async () => {
  const failIfDatabaseRead = {
    async selectCppItemsPage() {
      throw new Error("database should not be read");
    },
  };
  const firstPage = Array.from({ length: 40 }, (_, index) =>
    sourceItem({ id: 6500000 + index })
  );
  await assert.rejects(
    () =>
      runEvent6377Audit({
        sourceTransport: createSingleTaskSourceTransport({
          items: firstPage,
          reportedTotal: 10000,
          sentinelReportedTotal: 0,
        }),
        databaseTransport: failIfDatabaseRead,
      }),
    /sentinel 覆盖不完整/
  );

  await assert.rejects(
    () =>
      runEvent6377Audit({
        sourceTransport: createSingleTaskSourceTransport({
          items: [sourceItem({ id: 6600000 })],
          reportedTotal: 0,
          sentinelReportedTotal: 0,
        }),
        databaseTransport: failIfDatabaseRead,
      }),
    /非空页不能报告 total=0/
  );
});

test("跨页重复与同 ID 多摊位社团冲突进入 invalid 报告", async () => {
  const source = loadJson(sourceFixturePath);
  const database = loadJson(databaseFixturePath);
  const first = clone(source.responses["7040:36:1:1"].result.list[0]);
  const conflicting = clone(first);
  conflicting.eventList[0].position = "甲A99";
  conflicting.eventList[0].circleName = "冲突社团";
  source.manifest.tasks["7040:36"].orders["1"] = [1, 2, 3];
  source.responses["7040:36:1:1"].result = { total: 2, list: [first] };
  source.responses["7040:36:1:2"] = {
    isSuccess: true,
    result: { total: 2, list: [conflicting] },
  };
  source.responses["7040:36:1:3"] = {
    isSuccess: true,
    result: { total: 2, list: [] },
  };
  const report = await runFixture(source, database, { pageSize: 1 });
  assert.equal(report.status, "invalid");
  assert.equal(report.crossPageDuplicates.length, 1);
  assert.equal(report.crossPageDuplicates[0].id, 6377001);
  assert.equal(report.multiBoothCircleConflicts.length, 1);
  assert.equal(report.multiBoothCircleConflicts[0].boothCircles.length, 2);
});

test(">= cap 阈值按 1/0/3 多排序扫描、报告集合差异并用 union 补全", async () => {
  const source = loadJson(sourceFixturePath);
  const database = loadJson(databaseFixturePath);
  const items = [1, 2, 3, 4, 5].map((id) =>
    sourceItem({ id: 6377100 + id })
  );
  const orderIds = {
    "1": [0, 1, 2, 3],
    "0": [1, 2, 3, 4],
    "3": [0, 1, 3, 4],
  };
  source.manifest.tasks["7040:36"].orders = {
    "1": [1, 2, 3],
    "0": [1, 2, 3],
    "3": [1, 2, 3],
  };
  for (const [orderBy, indexes] of Object.entries(orderIds)) {
    source.responses[`7040:36:${orderBy}:1`] = {
      isSuccess: true,
      result: { total: 5, list: indexes.slice(0, 2).map((index) => items[index]) },
    };
    source.responses[`7040:36:${orderBy}:2`] = {
      isSuccess: true,
      result: { total: 5, list: indexes.slice(2).map((index) => items[index]) },
    };
    source.responses[`7040:36:${orderBy}:3`] = {
      isSuccess: true,
      result: { total: 5, list: [] },
    };
  }
  database.rows = [
    ...items.map((item) => dbRowFromItem(item)),
    database.rows.find((row) => row.day_id === "7042"),
  ];
  const report = await runFixture(source, database, {
    pageSize: 2,
    capThreshold: 3,
    maxWindow: 4,
  });
  const task = report.tasks.find(
    (entry) => entry.dayId === "7040" && entry.typeId === 36
  );
  assert.equal(report.status, "ok");
  assert.equal(task.capRisk, true);
  assert.deepEqual(task.ordersScanned, ["1", "0", "3"]);
  assert.equal(task.coverageComplete, true);
  assert.ok(
    task.orderSetDifferences.some(
      (difference) =>
        difference.onlyLeftIds.length || difference.onlyRightIds.length
    )
  );

  const incomplete = clone(source);
  for (const orderBy of ["0", "3"]) {
    incomplete.responses[`7040:36:${orderBy}:1`].result.list =
      orderIds["1"].slice(0, 2).map((index) => items[index]);
    incomplete.responses[`7040:36:${orderBy}:2`].result.list =
      orderIds["1"].slice(2).map((index) => items[index]);
  }
  const invalid = await runFixture(incomplete, database, {
    pageSize: 2,
    capThreshold: 3,
    maxWindow: 4,
  });
  assert.equal(invalid.status, "invalid");
  assert.equal(
    invalid.tasks.find(
      (entry) => entry.dayId === "7040" && entry.typeId === 36
    ).coverageComplete,
    false
  );
});

test("逐日报告列出完整 missing/extra/changed/misclassified ID", async () => {
  const source = loadJson(sourceFixturePath);
  const database = loadJson(databaseFixturePath);
  database.rows[0].type_id = 37;
  database.rows[0].type_name = "小说";
  database.rows[0].product_name = "被改动";
  database.rows.push({
    ...database.rows[0],
    type_id: 36,
    type_name: "漫画",
    doujinshi_id: 9999999,
    product_name: "库中多余",
    source_url: "https://www.allcpp.cn/d/9999999.do",
  });
  database.rows = database.rows.filter((row) => row.day_id !== "7042");
  const report = await runFixture(source, database);
  const firstDay = report.days.find((day) => day.dayId === "7040");
  const secondDay = report.days.find((day) => day.dayId === "7042");
  assert.deepEqual(firstDay.extraIds, [9999999]);
  assert.deepEqual(firstDay.changedIds, [6377001]);
  assert.deepEqual(firstDay.misclassifiedIds, [6377001]);
  assert.deepEqual(secondDay.missingIds, [6377002]);
  assert.equal(report.status, "invalid");
});

test("数据库历史分类名和未知旧 type ID 进入审计报告而不结构抛错", async () => {
  const source = loadJson(sourceFixturePath);
  const database = loadJson(databaseFixturePath);
  const matched = database.rows.find((row) => row.day_id === "7042");
  matched.type_name = "亚克力";
  database.rows.push(
    {
      ...matched,
      type_id: 44,
      type_name: "徽章",
      doujinshi_id: 6700044,
      source_url: "https://www.allcpp.cn/d/6700044.do",
    },
    {
      ...matched,
      type_id: 45,
      type_name: "色纸",
      doujinshi_id: 6700045,
      source_url: "https://www.allcpp.cn/d/6700045.do",
    },
    {
      ...matched,
      type_id: 33,
      type_name: "卡片",
      doujinshi_id: 6700033,
      source_url: "https://www.allcpp.cn/d/6700033.do",
    }
  );

  const report = await runFixture(source, database);
  assert.equal(report.status, "invalid");
  assert.equal(report.valid, false);
  assert.equal(report.totals.databaseTypeNameMismatches, 4);
  assert.deepEqual(report.databaseTypeNameMismatches, [
    {
      dayId: "7042",
      id: 6377002,
      typeId: 43,
      expectedName: "卡片",
      actualName: "亚克力",
    },
    {
      dayId: "7042",
      id: 6700033,
      typeId: 33,
      expectedName: null,
      actualName: "卡片",
    },
    {
      dayId: "7042",
      id: 6700044,
      typeId: 44,
      expectedName: "纸胶带",
      actualName: "徽章",
    },
    {
      dayId: "7042",
      id: 6700045,
      typeId: 45,
      expectedName: "COS",
      actualName: "色纸",
    },
  ]);
  const day = report.days.find((entry) => entry.dayId === "7042");
  assert.deepEqual(day.changedIds, [6377002]);
  assert.deepEqual(day.misclassifiedIds, [6377002]);
  assert.deepEqual(day.extraIds, [6700033, 6700044, 6700045]);
});

test("Content-Range 必须提供 exact total 并与 offset/响应行数严格一致", () => {
  assert.equal(
    parseExactContentRange("0-499/2001", { offset: 0, rowCount: 500 }),
    2001
  );
  assert.equal(
    parseExactContentRange("500-999/2001", {
      offset: 500,
      rowCount: 500,
    }),
    2001
  );
  assert.equal(
    parseExactContentRange("*/0", { offset: 0, rowCount: 0 }),
    0
  );
  assert.throws(
    () => parseExactContentRange(null, { offset: 0, rowCount: 0 }),
    /缺少 Content-Range/
  );
  assert.throws(
    () =>
      parseExactContentRange("0-499/*", { offset: 0, rowCount: 500 }),
    /不是 exact count/
  );
  assert.throws(
    () =>
      parseExactContentRange("1-500/2001", { offset: 0, rowCount: 500 }),
    /offset\/响应行数不一致/
  );
  assert.throws(
    () =>
      parseExactContentRange("0-499/2001", { offset: 0, rowCount: 499 }),
    /offset\/响应行数不一致/
  );
});

test("数据库 exact total=2001 时完整读取三页", async () => {
  const transport = createCappedDatabaseTransport(makeDatabaseRows(2001));
  const report = await runWithDatabaseTransport(transport, {
    databasePageSize: 1000,
  });
  assert.equal(report.totals.databaseExactTotal, 2001);
  assert.equal(report.totals.databaseUnique, 2001);
  assert.equal(report.totals.databasePages, 3);
  assert.deepEqual(
    transport.calls.map((call) => call.offset),
    [0, 1000, 2000]
  );
});

test("数据库 exact total 位于整页边界时不依赖短页或额外空页", async () => {
  const transport = createCappedDatabaseTransport(makeDatabaseRows(2000));
  const report = await runWithDatabaseTransport(transport, {
    databasePageSize: 1000,
  });
  assert.equal(report.totals.databaseExactTotal, 2000);
  assert.equal(report.totals.databasePages, 2);
  assert.deepEqual(
    transport.calls.map((call) => call.offset),
    [0, 1000]
  );
});

test("服务端每页截短为 500 行时按实际行数推进直至覆盖 2001", async () => {
  const transport = createCappedDatabaseTransport(
    makeDatabaseRows(2001),
    500
  );
  const report = await runWithDatabaseTransport(transport, {
    databasePageSize: 1000,
  });
  assert.equal(report.totals.databaseExactTotal, 2001);
  assert.equal(report.totals.databaseUnique, 2001);
  assert.equal(report.totals.databasePages, 5);
  assert.deepEqual(
    transport.calls.map((call) => call.offset),
    [0, 500, 1000, 1500, 2000]
  );
});

test("数据库分页无进展、total 漂移和超总数均失败", async () => {
  await assert.rejects(
    () =>
      runWithDatabaseTransport({
        async selectCppItemsPage() {
          return { rows: [], exactTotal: 1 };
        },
      }),
    /无进展/
  );

  const rows = makeDatabaseRows(3);
  let call = 0;
  await assert.rejects(
    () =>
      runWithDatabaseTransport(
        {
          async selectCppItemsPage({ offset }) {
            call += 1;
            return {
              rows: [structuredClone(rows[offset])],
              exactTotal: call === 1 ? 2 : 3,
            };
          },
        },
        { databasePageSize: 1 }
      ),
    /total 漂移/
  );

  await assert.rejects(
    () =>
      runWithDatabaseTransport({
        async selectCppItemsPage() {
          return {
            rows: structuredClone(rows.slice(0, 2)),
            exactTotal: 1,
          };
        },
      }),
    /超过 exact total/
  );
});

test("live 入口只声明 HTTP GET，且没有数据库写方法或 RPC", () => {
  const entrySource = readFileSync(scannerEntryPath, "utf8");
  const implementationSource = [
    entrySource,
    readFileSync(scannerCorePath, "utf8"),
  ].join("\n");
  assert.match(entrySource, /method:\s*"GET"/);
  assert.doesNotMatch(
    implementationSource,
    /\.(?:insert|update|upsert|delete|rpc)\s*\(/
  );
  assert.doesNotMatch(
    implementationSource,
    /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i
  );
  assert.match(entrySource, /SUPABASE_READONLY_KEY/);
  assert.match(entrySource, /Prefer:\s*"count=exact"/);
  assert.match(entrySource, /content-range/i);
  assert.doesNotMatch(entrySource, /SERVICE_ROLE/);
});
