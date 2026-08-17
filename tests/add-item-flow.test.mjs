import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseCPPProductLink, parseCPPProductReference } from "../lib/cpp-link.ts";
import { resolveCPPProductReference } from "../lib/cpp-reference-server.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("CPP 制品链接只接受 allcpp 官方详情页", () => {
  assert.equal(
    parseCPPProductLink("https://www.allcpp.cn/d/1592175.do#tabType=0"),
    1592175
  );
  assert.equal(parseCPPProductLink("http://allcpp.cn/d/123.do?from=list"), 123);
  assert.equal(parseCPPProductLink("https://www.allcpp.cn/allcpp/event/eventdoujinshi.do?event=7073"), null);
  assert.equal(parseCPPProductLink("https://allcpp.cn.evil.example/d/123.do"), null);
  assert.equal(parseCPPProductLink("ftp://www.allcpp.cn/d/123.do"), null);
  assert.equal(parseCPPProductLink("https://www.allcpp.cn/d/not-a-number.do"), null);
  assert.equal(parseCPPProductLink("https://www.allcpp.cn/d/0.do"), null);
});

test("新增制品可识别网页链接、手机短链和纯 DID", () => {
  assert.deepEqual(parseCPPProductReference("1751339"), {
    kind: "did",
    doujinshiId: 1751339,
  });
  assert.deepEqual(
    parseCPPProductReference("https://www.allcpp.cn/d/1751339.do#tabType=0"),
    { kind: "web", doujinshiId: 1751339 }
  );
  assert.deepEqual(parseCPPProductReference("https://icp.red/dN59gcZC9"), {
    kind: "short",
    url: "https://icp.red/dN59gcZC9",
  });
  assert.equal(parseCPPProductReference("https://example.com/dN59gcZC9"), null);
  assert.equal(parseCPPProductReference("-1"), null);
});

test("手机短链只沿受信任跳转解析为 DID", async () => {
  const resolved = await resolveCPPProductReference(
    "https://icp.red/dN59gcZC9",
    async () => new Response(null, {
      status: 302,
      headers: { location: "http://www.allcpp.cn/d/1751339.do" },
    })
  );
  assert.equal(resolved, 1751339);

  const rejected = await resolveCPPProductReference(
    "https://icp.red/dN59gcZC9",
    async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/d/1751339.do" },
    })
  );
  assert.equal(rejected, null);
});

test("单条链接先查当前 list 对应数据库，仅在详情为空时补读 CPP 详情", () => {
  const route = read("app/api/cpp/item-lookup/route.ts");
  assert.match(route, /authenticateRequest\(request\)/);
  assert.match(route, /getEventMembership\(eventId, client\)/);
  assert.match(route, /resolveCPPMatchScope\(eventId, client, false\)/);
  assert.match(route, /getCPPItemsByBooths\([\s\S]*?\[doujinshiId\][\s\S]*?client/);
  assert.match(route, /if \(!item\.description\)/);
  assert.match(route, /fetchCPPExternalDetail\(/);
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.upsert\(/);
});

test("编辑模式同时提供桌面和手机添加入口", () => {
  const page = read("app/exhibit/[id]/page.tsx");
  assert.match(page, /setIsAddItemDialogOpen\(true\)/);
  assert.match(page, /<AddWishItemDialog/);
  assert.match(page, /aria-label="添加制品"/);
  assert.doesNotMatch(page, /const handleAddItem = async \(\) => \{[\s\S]*?boothNumber:\s*""/);
});

test("添加弹窗支持链接自动填充、失败后手填和保存关联", () => {
  const dialog = read("components/AddWishItemDialog.tsx");
  assert.match(dialog, /useState<Priority>\("随缘"\)/);
  assert.match(dialog, /maxLength=\{NOTE_MAX_LENGTH\}/);
  assert.match(dialog, /onPaste=\{handlePasteLink\}/);
  assert.match(dialog, /CPP网页链接/);
  assert.match(dialog, /CPP手机短链/);
  assert.match(dialog, /CPP DID/);
  assert.match(dialog, /CPP 网页复制的完整制品链接，粘贴此处/);
  assert.match(dialog, /CPP制品页-分享-复制链接，粘贴此处/);
  assert.match(dialog, /CPP制品页-分享-复制DID，粘贴此处/);
  assert.match(dialog, /当前展会数据库暂未收录该制品，你仍然可以手动填写/);
  assert.match(dialog, /制品名称 \*/);
  assert.match(dialog, /matchedCPPItem:\s*linkedCPPItem \|\| undefined/);
  assert.match(dialog, /description:\s*linkedCPPItem\?\.description \|\| ""/);
  assert.match(dialog, /展品详情/);
  assert.match(dialog, /status:\s*type === "free" \? "待领取" : "pending"/);
});

test("手机版在状态之后、备注之前展示并编辑开摊信息", () => {
  const mobile = read("components/MobileTableView.tsx");
  const statusIndex = mobile.indexOf("状态切换按钮");
  const openInfoIndex = mobile.indexOf("开摊信息：位于状态之后、备注之前");
  const noteIndex = mobile.indexOf("{/* 备注 */}", openInfoIndex);
  assert.ok(statusIndex >= 0 && openInfoIndex > statusIndex && noteIndex > openInfoIndex);
  assert.match(mobile, /handleDrawerUpdate\("openInfo", value\)/);
  assert.match(mobile, /maxLength=\{OPEN_INFO_MAX_LENGTH\}/);
  assert.match(mobile, /maxLength=\{NOTE_MAX_LENGTH\}/);
  assert.match(mobile, /value\.slice\(0, OPEN_INFO_MAX_LENGTH\)/);
  assert.match(mobile, /value\.slice\(0, NOTE_MAX_LENGTH\)/);

  const service = read("lib/db-service.ts");
  const migration = read("docs/migrations/015_add_wish_item_open_info.sql");
  const conflictMigration = read("docs/migrations/016_restore_cas_conflict_after_open_info.sql");
  assert.match(service, /openInfo:\s*row\.open_info \|\| undefined/);
  assert.match(service, /row\.open_info = item\.openInfo \?\? null/);
  assert.match(migration, /add column if not exists open_info text/);
  assert.match(migration, /open_info = case when p_patch \? 'open_info'/);
  assert.match(conflictMigration, /open_info = case when p_patch \? 'open_info'/);
  assert.match(conflictMigration, /errcode = 'P0001', message = 'WISH_ITEM_CONFLICT'/);
});

test("电脑端对开摊信息和备注应用相同字数限制与换行展示", () => {
  const page = read("app/exhibit/[id]/page.tsx");
  assert.match(page, /maxLength=\{OPEN_INFO_MAX_LENGTH\}/);
  assert.match(page, /maxLength=\{NOTE_MAX_LENGTH\}/);
  assert.match(page, /value\.slice\(0, OPEN_INFO_MAX_LENGTH\)/);
  assert.match(page, /value\.slice\(0, NOTE_MAX_LENGTH\)/);
  assert.match(page, /max-w-40 whitespace-pre-wrap break-words/);
  assert.match(page, /max-w-48 whitespace-pre-wrap break-words/);
});

test("识别码读取失败时不会静默消失，并允许用户重试", () => {
  const page = read("app/exhibit/[id]/page.tsx");
  assert.match(page, /识别码加载中…/);
  assert.match(page, /识别码加载失败 · 重试/);
  assert.match(page, /onClick=\{\(\) => void loadShareCode\(\)\}/);
});

test("匹配到的 CPP 详情会写入条目并沿用现有详情弹窗", () => {
  const service = read("lib/db-service.ts");
  const page = read("app/exhibit/[id]/page.tsx");
  assert.match(service, /description:\s*item\.description \|\| null/);
  assert.match(service, /description:\s*row\.description \|\| undefined/);
  assert.match(page, /item\.description \? \(/);
  assert.match(page, /setDetailItem\(item\)/);
  assert.match(page, /\{detailItem\.description\}/);
});
