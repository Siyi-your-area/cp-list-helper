# CPP 数据同步运行手册

> 目标：CPG 数据开放后，以可重复、可恢复、并发、增量且可校验的方式快速完整落库。

> 2026-08-02 契约说明：产品实际目标是数据库 `event_id=cpg08`、
> `day_id=7829`、CPP source event `7073`。下文旧 `sync:cpp --event=cpg`
> 示例属于历史草案，不得用于 CPG08 promotion；当前安全流程见本文第 11 节和
> `docs/12-cpg-sync-strategy.md`。

## 1. 现状与改造结论

旧脚本 `crawl-cpp-supabase.mjs` 按活动日和分类串行执行，先将整个分类下载到内存，再分批写入。任意页面失败会终止整个任务；没有页面级断点、失败页重跑、源数据校验和或变更检测。`crawl-cpp-details.mjs` 有详情页断点和并发，但数据库仍逐条更新。

新入口为：

```bash
npm run sync:cpp -- --event=cpg --days=<CPP_DAY_ID>
```

`scripts/sync-cpp-data.mjs` 以 `活动日 × 分类` 为独立任务，每个任务内部按页顺序执行，不同任务并发。

## 2. 前置条件

1. 先执行数据库迁移：

```text
docs/migrations/005_cpp_sync_metadata.sql
```

2. 配置 Supabase：

```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxx
```

脚本也兼容现有 `NEXT_PUBLIC_SUPABASE_*`，但生产批量同步推荐使用只在本机/CI 保存的 service role key。

3. 配置 CPP Cookie，二选一：

```env
CPP_COOKIE=name=value; name2=value2
```

或项目根目录的 `cpp-cookies.json`。Cookie 文件不得提交到 Git。

## 3. 常用命令

首次全量扫描：

```bash
npm run sync:cpp -- \
  --event=cpg \
  --days=<DAY_ID_1,DAY_ID_2> \
  --mode=full \
  --concurrency=6
```

每日增量扫描：

```bash
npm run sync:cpp -- \
  --event=cpg \
  --days=<DAY_ID_1,DAY_ID_2> \
  --mode=incremental \
  --concurrency=6
```

中断后续传：

```bash
npm run sync:cpp -- --event=cpg --days=<DAY_IDS> --resume
```

只重跑部分分类：

```bash
npm run sync:cpp -- \
  --event=cpg \
  --days=<DAY_IDS> \
  --types=33,36,43,44
```

小规模演练：

```bash
npm run sync:cpp -- \
  --event=cpg \
  --days=<DAY_IDS> \
  --types=36 \
  --maxPages=2 \
  --dryRun
```

仅核对数据库结果：

```bash
npm run sync:cpp -- \
  --event=cpg \
  --days=<DAY_IDS> \
  --verifyOnly
```

## 4. 断点与重试语义

- checkpoint 默认保存在 `.cpp-sync/<event>.checkpoint.json`。
- 每个页面完成数据库写入后，才将 `nextPage` 向前推进。
- 进程被关闭、网络中断或某个分类失败时，已完成页面不会重复下载。
- 请求和写入均使用指数退避重试，默认 4 次，单请求超时 12 秒。
- 某任务超过重试上限后标记为 `failed`，其他任务继续运行。
- 下次使用相同参数运行会从失败页面继续。
- 一个 checkpoint 中所有任务完成后，再次运行会自动开始新的增量扫描，而不是永久跳过。

## 5. 增量更新

每条源记录对以下字段计算 SHA-256：

- 展会、活动日、分类、CPP 唯一 ID；
- 商品名、作者、摊位、社团；
- 图片、标签、来源地址；
- 热度、原作。

`incremental` 模式先读取已有 `source_hash`：

- 不存在：计为 `inserted`；
- hash 改变：计为 `updated`；
- hash 相同：计为 `unchanged`，跳过数据库写入。

数据库唯一键仍为：

```text
event_id + day_id + doujinshi_id
```

所以脚本可安全重复运行。

## 6. 并发模型

- 默认并发数：6；
- 并发单位：`day_id × type_id`；
- 同一分类内页面串行，避免翻页乱序和断点不一致；
- 每页立即去重、比较 hash 和落库，不在内存积累完整分类；
- 可用 `--concurrency` 根据 CPP 限流和本地网络调整。

建议初次 CPG 同步从 4–6 开始。如果出现大量 429/5xx，降低到 2–3；如果响应稳定，可逐步提高到 8。

## 7. 完整性校验

每次运行生成：

```text
.cpp-sync/<run-id>.report.json
```

报告包括：

- 各任务 CPP API 声明数量、实际下载数量、标准化数量；
- 数据库对应活动日/分类的行数；
- 新增、更新、未变化数量；
- 失败页面与错误；
- 每页 SHA-256 和任务总校验和；
- `sourceComplete`、`databaseCovered`、`valid`；
- 总耗时和最终状态。

状态含义：

| 状态 | 含义 | 是否允许正式切换 |
|---|---|---|
| `ok` | 全部任务完成且源/库核对通过 | 是 |
| `limited` | 使用了 `--maxPages` 的演练 | 否 |
| `partial` | 有失败任务 | 否 |
| `invalid` | 下载完成但数量核对失败 | 否 |

正式启用 CPG 数据前必须满足：

1. `status = ok`；
2. `failedTasks = 0`；
3. 所有任务 `sourceComplete = true`；
4. 所有任务 `databaseCovered = true`；
5. 同参数再次增量运行以 `unchanged` 为主；
6. 匹配黄金集加入 CPG 样本后评测通过。

## 8. 详情字段

搜索 API 同步完成后，`exchange_type` 和 `description` 仍由 `crawl-cpp-details.mjs` 补齐。基础数据完整落库不依赖详情抓取；详情增强可以异步执行，不阻塞心愿单匹配。

后续建议将详情抓取也迁移到相同的任务/checkpoint/report 协议，并把逐条数据库更新改为 RPC 或批量 upsert。

## 9. CPG 开放后的操作顺序

1. 获取 CPG 内部 `event_id` 与所有 `day_id`；
2. 更新首页展会预设；
3. 先跑单分类、两页 dry-run；
4. 验证 Cookie、字段结构和 report；
5. 全量运行 16 分类；
6. 对失败任务续跑直至 `ok`；
7. 再跑一次 incremental，核对幂等；
8. 运行 CPG 黄金集匹配评测；
9. 开放用户创建 CPG 心愿单；
10. 展前每日增量更新，展会开始后归档 checkpoint 和最终 report。

## 10. event6377 只读完整性扫描

event6377（数据库展会 ID `cp32`）使用独立只读扫描器核对 CPP 源数据与
`cpp_items`，不复用任何同步写入入口。扫描器会先动态解析 event6377 页面，
并严格确认活动 ID `6377`、活动日 `7040/7042` 与以下 16 个分类：

```text
36 漫画       37 小说       38 图集       39 音乐
40 GAME       50 图文志     51 海报集     52 其他作品集
43 卡片       44 纸胶带     45 COS        48 手办
49 亚克力     53 徽章       54 色纸       46 其他
```

页面仍包含旧分类 ID（33/34/41/42）、活动日或分类发生漂移时，扫描立即失败。
当前展会 ID 优先取页面显式状态、canonical 或选中项；若页面只提供展会链接，
则必须包含 event6377，其他推荐展会链接仅作为非当前引用忽略。
活动日专门从页面的 `zEids.push(<day_id>)` 状态读取；分类专门从
`id="type<ID>"` 元素读取并核对同一元素的 `data-id` 与文本名称，不把页面其他
普通 `data-id` 当作活动日或分类。
每个 `day_id × type_id` 任务冻结第一页 `total`，拒绝 total 漂移、中间短页、
缺少 sentinel、错误活动日和结构不完整的响应。`total >= 9500` 时自动按
`orderBy=1/0/3` 分别扫描，报告排序集合差异与 `capRisk`；只有多排序 union
覆盖冻结 total 才算完整。

CPP 搜索接口可能把请求页宽截短。扫描器不会把请求上限写死为服务端页宽：
`total > 0` 时冻结首个非空页的实际长度为 `effectivePageSize`，后续非末页必须
保持该宽度，末页只允许等于剩余条目数，并在精确读取
`min(total, maxWindow)` 后继续验证空 sentinel。报告同时记录
`requestedPageSize`、各排序的 `effectivePageSize` 与
`sentinelReportedTotal`。所有非空页的 total 必须等于冻结值；只有已精确读取
目标条目数后的空 sentinel 才允许报告冻结 total 或 0，提前空页仍视为失败。
`hotCount` 接受非负安全整数、仅含十进制数字的字符串，以及 CPP 表示“未知热度”
的 exact `-1`（number 或字符串），并统一写入报告为 number，`-1` 不转为 0。
小于 `-1`、非 exact `-1`、小数、科学计数、混杂字符、Infinity 与超安全整数
都会使扫描失败。

真实 CPP 请求全部经过同一个串行限速器，默认最小间隔 900ms；如需调慢可使用
`--cppMinInterval=<毫秒>`，安全下限为 800ms。只有 HTTP 429、502、503、504
会重试，优先遵守 `Retry-After`，否则使用指数退避与 jitter；单次等待最多
30 秒、总尝试最多 6 次。其他 4xx 与网络错误立即失败。重试日志只包含任务、
状态码、尝试次数和等待时间；每个 day/type 完成后输出一行无凭据进度。

离线验收不需要 Cookie、Supabase 环境变量或网络：

```bash
npm run scan:event6377 -- --fixture
npm run test:event6377-scanner
```

fixture manifest 必须显式声明全部 32 个任务、允许为空的分类和每个排序的连续
页面；缺任务、缺页或出现未声明页都会失败。默认 fixture 位于：

```text
tests/fixtures/event6377-scanner-source.json
tests/fixtures/event6377-scanner-db.json
```

真实只读扫描仅在明确获准后运行。凭据只允许通过进程环境或 `.dev.vars` 提供：

```env
CPP_COOKIE=name=value; name2=value2
# 或 JSON 数组、{"cookies":[...]} 包装、name/value 键值对象：
CPP_COOKIE_JSON=[{"name":"name","value":"value"}]
SUPABASE_URL=https://example.supabase.co
SUPABASE_READONLY_KEY=<仅具备 SELECT 权限的 key>
```

`CPP_COOKIE` 非空时优先于 `CPP_COOKIE_JSON`。JSON 只从进程环境或 `.dev.vars`
读取；扫描器不读取 Cookie 文件，也不会把 Cookie 内容写入日志或报告。

也可使用 `NEXT_PUBLIC_SUPABASE_URL` 与 `NEXT_PUBLIC_SUPABASE_ANON_KEY`。入口只发
HTTP GET；数据库只访问 PostgREST `SELECT`，不调用写方法或 RPC。输出写入本地
`.cpp-audit/`（已忽略），报告固定包含：

数据库每页请求均带 `Prefer: count=exact` 和明确 `Range`。扫描器严格校验
`Content-Range`，冻结第一页 exact total，并按服务端实际返回行数推进 offset；
只有累计行数达到 exact total 才结束。服务端单页截短不会被当成扫描完成，
total 漂移、未覆盖前空页、无进展或累计行数超过 total 都会立即失败。

- `readOnly: true` 与 `dbWritesAttempted: 0`；
- 32 个任务的分页、sentinel、total、cap 风险与排序集合差异；
- 按 `day_id + doujinshi_id` union 后的逐日 `sourceUnique/dbUnique`；
- 完整 `missingIds/extraIds/changedIds/misclassifiedIds`；
- 数据库历史或未知分类映射 `databaseTypeNameMismatches`，包含 day、制品 ID、
  type ID、当前期望名与数据库实际名；
- 跨页、跨分类、数据库重复和同 ID 多摊位/社团冲突。

任何任务不完整、源/库覆盖不一致、字段变化、误分类、重复或冲突都会令报告
`status = invalid`。该报告只用于审计，不执行回填、修复或生产迁移。
数据库 `type_id` 只做正整数结构校验，`type_name` 只做字符串结构校验；历史错误
名称及未知旧 type ID 不会中止 SELECT，而会完整进入 mismatch 报告并令结果
invalid，确保 DB extra 也不会遗漏。

## 11. CPG08 快照与 promotion（当前有效流程）

当前 CPG08 不再用旧 `sync:cpp` 命令边抓取边写库。抓取和 promotion 是两个
独立进程：

```bash
# 完全离线验收
npm run scan:cpg -- --fixture --pageSize=1000
npm run test:cpg-snapshot

# live 只读扫描（仅在明确授权后，CPP_COOKIE 只放进程环境）
npm run scan:cpg
```

扫描器动态发现且必须恰好接受 16 类，固定检查 source event `7073`，并动态
冻结活动页唯一正整数 day（当前 `7829`）。event HTML 不含总数字段；scanner
复用官方页面脚本的无 type 搜索 GET，以 `result.total` 作为动态 global total；历史观测
`38188/38204` 都不是行为常量。任一分类 `total >= 9500` 时，在可靠二级
分区尚未冻结前直接 blocked。成功快照位于 `.cpp-snapshots/`，包含 canonical
rows、稳定 definition/snapshot hash 和零数据库写入证据。

每个分类先生成完整 candidate epoch。可归因于源站写入中的 total/sentinel 漂移、
短页或跨页重复只废弃当前分类并从 page 1 重扫，单次最多 3 epochs；结构、认证、
cap 与非法 row 仍立即失败。16 类 candidate 完成后，连续两次并发读取 global count
与 16 类 page 1 total；只有 `global = sum(type totals) = union unique` 且两次结果
一致才进入反向完整 validation。validation 不一致的分类以新结果为 candidate，
仅重扫 dirty 分类取得第二个匹配 full epoch；全局最多 8 个 convergence rounds，
但每个 type 最多只允许 3 次外层额外重扫，第四次请求发出前即 blocked。

快照 schema v3 签名保存最终双 barrier、每类两个连续匹配 full epoch、
`dirtyRetries` 与 `convergenceRounds`。旧 v2、HTML 总数或缺少收敛证明的快照均被
validator 和 promotion 拒绝。登录重定向、401/403、200 HTML 或非法 JSON
envelope 仍 fail closed。

CPG08 正式分类扫描和无 type count probe 统一固定 `orderBy=0`。真实 canary 中，
type 36 的 `orderBy=1` 在 page 88 出现跨页重复，而相同数据用 `orderBy=0`
严格完成 4111/4111、页宽 40、103 页且零重复；未经同等证明的 `orderBy=3`
不作为替代。排序进入 snapshot/probe 签名，不改变任何重复或分页完整性门禁。

CPG 分类使用默认 4、最多 6 个 worker 跨类并发，同类分页严格串行。所有分类、
barrier global probe 与 16 类 page 1 probe 共用默认 250ms（硬下限 250ms）的
dispatch limiter 和默认 4、最多 6 的 in-flight semaphore。429 会按
`Retry-After` 全局暂停、至少翻倍间隔，连续 100 次成功后才缓慢恢复。输出仅含
无敏感 request metrics；任何 worker 失败都停止调度新分类且不生成快照。

promotion 先执行不带 `--write` 的 dry-run，审批其 snapshotHash 和 planHash 后，
才可增加 `--write`、完整确认串与 `CPG_RECOVERY_KEY`。正式写入前必须先生成并
验证 AES-256-GCM before-image/delta；失败则零写入。完整命令和参数见
`docs/12-cpg-sync-strategy.md` 第 11 节。该流程只 SELECT/增量 upsert
`cpp_items` 中 `cpg08/<snapshot day>`，来源缺失项仅报告，不移除，不调用 RPC，不访问
用户表或其他 event。

真实 day 确认前创建且存储单日 `7073` 的 `cpg08` list 不执行迁移；仅在 CPP
匹配查询范围解析时映射到 `7829`。新建 CPG08 list 直接存储 `7829`。promotion
的 `targetDay` 必须等于已批准 snapshot 的唯一 day，旧 `7073` 参数会在首次
数据库读取前失败。

## 12. CPG08 自动更新入口

```powershell
npm.cmd run sync:cpg
npm.cmd run sync:cpg -- --dryRun
npm.cmd run sync:cpg -- --fullDetails
```

无参数执行一次完整的 16 类目扫描，并直接对 `cpp_items` 做增量 upsert；`--dryRun`
只计算变化，不写数据库；每两日自动任务必须抓取全部新增制品的详情与交换类型，
详情阶段使用独立的 8 路并发和 200ms 请求启动间隔，不受搜索分页的 600ms
全局间隔影响。完成类目和成功详情会在 `.tmp/cpg-sync/` 保存最长 6 小时的本轮
断点；失败重跑只读取未完成内容，成功写库后自动删除断点。`--fullDetails`
用于人工刷新所有已有制品的 description/exchange_type；有效非空新值覆盖旧值。

字段规则：新 ID 插入；已有 ID 直接比较字段，不使用 hash。作者、摊位、图片和
description 只有非空时覆盖；exchange_type 只有明确识别为有偿或无料时覆盖；
hot_count 的有效非负数字（包括 0）直接更新；来源暂时未出现的旧记录不删除。

`.github/workflows/sync-cpg.yml` 在北京时间约 03:00 每两日运行，并支持 GitHub
Actions 手动触发。需要仓库 Secrets：`CPP_COOKIE_JSON`、`SUPABASE_URL`、
`SUPABASE_CPP_SYNC_KEY`。本地运行会读取已忽略的 `.dev.vars`、`.env.local` 和
`cpp-cookies.json`，但不会输出这些内容。
