# CPG08 同步开发复盘

> 日期：2026-08-04；范围：本地只读扫描、冻结快照、受控 promotion 与日常 dry-run 编排。

## 本轮形成的能力

- scanner 动态冻结唯一 day 与 16 类目，以 schema v3 dirty convergence 证明完整性；provisional v4 仍需显式授权。
- promotion 只比较目标 `cpg08/<snapshot day>`，沿用身份键和 `source_hash` 处理新增/变化；来源缺失只报告，不删除。
- 版本化字段策略区分 identity、stable、volatile、detail、derived，并锁定 whitelist。
- `sync:cpg:daily` 默认用 fixture 完成 scan → validate → promotion dry-run，输出 snapshot、plan、report，零数据库写入。

## 经验教训

1. 页面展示值不能当长期常量；day、类目和总数必须来自同轮冻结证据并进入 hash。
2. “全量读取”不等于“全量写入”；每日完整扫描只需 upsert 新增与 `source_hash` 变化行。
3. 详情字段与搜索快照生命周期不同；搜索结果不得用空值覆盖 `description/exchange_type`，详情增强应独立 `fillMissing`。
4. 失败关闭要用 fixture 永久证明：scan/validate 错误不能进入 promotion，dry-run 不能 POST。
5. 真实凭据、生产读取、写入审批和恢复证据必须与离线开发验收分离。
6. 历史文档可能滞后；操作时以 validator、测试和当前输出为准。

## 尚未完成

- 未配置系统定时器，未执行真实 CPP live scan、生产数据库 dry-run 或生产写入。
- 未把 `crawl-cpp-details.mjs` 迁移到同样的 checkpoint/report 协议。
- 未建立 CPG 匹配黄金集和真实/等价规模 P50/P95 发布基线。
- 未由 Agent4 完成独立回归与发布判断。

## 下一步

1. Agent4 离线复跑 daily/snapshot tests、TypeScript 和 build。
2. 获明确授权后，在无数据库凭据环境做 live 只读 canary。
3. 使用隔离/只读数据库执行真实 promotion dry-run，人工审阅 diff。
4. 建立备份恢复演练和黄金集后，再讨论首次显式写入。
5. 稳定运行后再配置系统定时器；自动写入需另立审批。
