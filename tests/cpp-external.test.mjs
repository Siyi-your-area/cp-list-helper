import test from "node:test";
import assert from "node:assert/strict";
import {
  cookieHeaderFromJson,
  enrichCPPItemWithDetail,
  extractCookieHeaderFromCurl,
  extractCoreProductName,
  isCPPExternalFallbackEligible,
  matchCPPExternalCandidates,
  parseCPPDetailHTML,
} from "../lib/cpp-external.ts";

function candidate(overrides = {}) {
  return {
    boothNumber: "肆Q40",
    boothName: "葵花的温室",
    productName: "【图奈】葵记炒货小铺",
    author: "Sonne431",
    imageUrl: "https://example.test/cover.png",
    tags: ["苏丹的游戏"],
    eventName: "CP32-二期",
    dayId: "7042",
    sourceUrl: "https://www.allcpp.cn/d/1626497.do",
    doujinshiId: 1626497,
    hotCount: 121,
    originalWork: "苏丹的游戏",
    ...overrides,
  };
}

test("核心名称会移除方括号标签和宣发词", () => {
  assert.equal(
    extractCoreProductName("【图奈】【CP32首发】葵记炒货小铺"),
    "葵记炒货小铺"
  );
});

test("外部兜底仅允许摊位号和制品名称均有值的输入", () => {
  assert.equal(
    isCPPExternalFallbackEligible({
      boothNumber: "肆Q40",
      productName: "葵记炒货小铺",
    }),
    true
  );
  assert.equal(
    isCPPExternalFallbackEligible({
      boothNumber: "",
      productName: "葵记炒货小铺",
    }),
    false
  );
  assert.equal(
    isCPPExternalFallbackEligible({
      boothNumber: "肆Q40",
      productName: "  ",
    }),
    false
  );
});

test("只从 allcpp 官方 cURL 中提取并规范化 Cookie", () => {
  const raw = [
    "curl 'https://www.allcpp.cn/api/doujinshi/search.do?keyword=test' \\",
    "  -b 'token=test-token; JSESSIONID=test-session'",
  ].join("\n");
  assert.equal(
    extractCookieHeaderFromCurl(raw),
    "token=test-token; JSESSIONID=test-session"
  );
  assert.equal(
    extractCookieHeaderFromCurl(
      raw.replace("www.allcpp.cn", "malicious.example")
    ),
    ""
  );
  assert.equal(
    extractCookieHeaderFromCurl(
      "curl 'https://www.allcpp.cn/api/doujinshi/search.do' " +
      "-b 'token=test-token\r\nInjected=yes'"
    ),
    ""
  );
});

test("Cookie JSON 同时兼容数组、对象和 cookies 包装", () => {
  assert.equal(
    cookieHeaderFromJson([
      { name: "token", value: "test-token" },
      { name: "JSESSIONID", value: "test-session" },
    ]),
    "token=test-token; JSESSIONID=test-session"
  );
  assert.equal(
    cookieHeaderFromJson({
      token: "test-token",
      JSESSIONID: "test-session",
    }),
    "token=test-token; JSESSIONID=test-session"
  );
  assert.equal(
    cookieHeaderFromJson({
      cookies: [{ name: "token", value: "test-token" }],
    }),
    "token=test-token"
  );
});

test("目标活动内唯一核心名称和摊位一致时自动接受", () => {
  const result = matchCPPExternalCandidates(
    {
      boothNumber: "肆Q40",
      productName: "【图奈】葵记炒货小铺",
    },
    [candidate()],
    ["7042"]
  );
  assert.equal(result.decision, "accepted");
  assert.equal(result.confidence, "exact");
  assert.equal(result.cppItem?.doujinshiId, 1626497);
  assert.match(result.reason || "", /名称 100%（权重 80%）/);
});

test("没有填写摊位时，评分层也拒绝执行外部兜底", () => {
  const result = matchCPPExternalCandidates(
    {
      boothNumber: "",
      productName: "【图奈】葵记炒货小铺",
    },
    [candidate()],
    ["7042"]
  );
  assert.equal(result.decision, "unmatched");
  assert.equal(result.cppItem, undefined);
  assert.match(result.reason || "", /摊位号或制品名称为空/);
});

test("名称完全一致但已填写的摊位冲突时进入待确认", () => {
  const result = matchCPPExternalCandidates(
    {
      boothNumber: "测A01",
      productName: "【图奈】葵记炒货小铺",
    },
    [candidate()],
    ["7042"]
  );
  assert.equal(result.decision, "review");
  assert.equal(result.requiresReview, true);
  assert.match(result.reason || "", /摊位冲突/);
});

test("目标活动中存在两个同名制品时不强行自动匹配", () => {
  const result = matchCPPExternalCandidates(
    {
      boothNumber: "肆Q40",
      productName: "葵记炒货小铺",
    },
    [
      candidate(),
      candidate({
        boothNumber: "肆Q41",
        doujinshiId: 1626498,
        sourceUrl: "https://www.allcpp.cn/d/1626498.do",
      }),
    ],
    ["7042"]
  );
  assert.equal(result.decision, "review");
  assert.equal(result.requiresReview, true);
  assert.match(result.reason || "", /存在同名制品/);
});

test("其他活动的同名结果不会被接受", () => {
  const result = matchCPPExternalCandidates(
    {
      boothNumber: "肆Q40",
      productName: "葵记炒货小铺",
    },
    [candidate({ dayId: "7040", eventName: "CP32-一期" })],
    ["7042"]
  );
  assert.equal(result.decision, "unmatched");
});

test("名称相似度过低时不返回待确认候选", () => {
  const result = matchCPPExternalCandidates(
    {
      boothNumber: "肆Q40",
      productName: "完全不同的作品",
    },
    [candidate()],
    ["7042"]
  );
  assert.equal(result.decision, "unmatched");
  assert.equal(result.candidate, undefined);
});

test("详情 HTML 可提取交换类型、原作、热度和描述", () => {
  const html = `
    <section class="djs-info">
      <div class="djs-info-hot"><span>121</span></div>
      <p>原作：苏丹的游戏</p>
      <p>交换：有偿交换</p>
      <div class="djs-tab-box info textEllipsis">
        一套关于葵花的&nbsp;<strong>亚克力制品</strong>
      </div>
    </section>
  `;
  assert.deepEqual(parseCPPDetailHTML(html), {
    hotCount: 121,
    originalWork: "苏丹的游戏",
    exchangeType: "有偿交换",
    description: "一套关于葵花的 亚克力制品",
  });
});

test("详情字段只补充搜索结果中缺少的数据", () => {
  const enriched = enrichCPPItemWithDetail(candidate(), {
    hotCount: 122,
    exchangeType: "有偿交换",
    description: "详情",
  });
  assert.equal(enriched.hotCount, 122);
  assert.equal(enriched.originalWork, "苏丹的游戏");
  assert.equal(enriched.exchangeType, "有偿交换");
  assert.equal(enriched.description, "详情");
});
