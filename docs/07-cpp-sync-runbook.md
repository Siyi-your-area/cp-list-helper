# CPP 数据同步运行手册

> 目标：CPG 数据开放后，以可重复、可恢复、并发、增量且可校验的方式快速完整落库。

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
