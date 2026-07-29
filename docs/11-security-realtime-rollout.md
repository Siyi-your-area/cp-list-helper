# 匿名身份、成员权限与实时同步上线手册

## 目标与契约

迁移 006/008/009/010/011/007 分阶段将访问控制从浏览器 `clientId` 升级为 Supabase 匿名 Auth 的 JWT。所有持续授权都由 `auth.uid()` 与 `list_members` 决定。008、009、010、011 是 006 后必须执行的前向修复，不得通过改写已经执行的迁移替代。若因排障或恢复重跑 006，必须随后按顺序重跑 008、009、010、011，再继续应用部署或 007 切换。

本轮生产决策是“安全切换后新 list 从零开始”，不迁移旧设备身份：

- `LEGACY_CLAIM_ENABLED=false`，不得运行旧设备认领或人工 owner 回填。
- 旧 `events`、`event_access`、`wish_items` 行全部物理保留；因没有对应 `list_members`，切换后它们对匿名用户不可见。
- 作为目录使用的旧 `events` 行也保留，不能为了让它们可见而创建虚假 owner。
- 全部 CP32/CPG `cpp_items` 行及所有既有表、字段、约束和索引都必须保留。安全迁移只允许新增结构或改变访问控制，不允许删表、删字段、清空或重写 CPP/CPG 内容。

- `owner` 与 `editor` 均可查看、导入导出及增删改 `wish_items`，也可读取并继续分享四位识别码。
- 只有 `owner` 可以删除整份 list；`editor` 的首页删除操作仅退出自己的成员关系。
- 非成员不能读取 event、wish items 或调用对应 list 的匹配范围。
- `cpp_items` 对 anon/authenticated 只开放 SELECT。
- 分享码不落明文。服务端由随机 seed 派生四位码，数据库只保存服务端 HMAC；`CF-Connecting-IP` 也只保存 HMAC。失败响应不区分不存在与限流。
- `wish_items.version` 用于 CAS 保存；多条草稿由单个事务 RPC 原子保存，任一版本冲突会整体回滚。Realtime 普通变更自动合并，本地草稿发生更新冲突时由用户选择最新数据或保留草稿；远端删除只能确认删除，不允许重建条目。
- 匿名 session 建立后必须在创建 Realtime channel 前显式调用 `realtime.setAuth(access_token)`。SDK 的登录与刷新事件仍负责后续 token 轮换，但不能把 channel 的 `SUBSCRIBED` 状态单独视为已通过 RLS 授权。

## 部署顺序

1. 在 Supabase 确认生产备份或 PITR 实际可用，并记录可恢复时间点。不同套餐能力不同；未在控制台核实、未保存恢复信息时，备份门禁就是“未完成”。
2. 暂停生产应用写入和 `sync:cpp`，记录维护窗口开始时间。维护期间不得创建 list、加入、编辑、删除或运行 CPP 写入同步。
3. 在 SQL Editor 运行 [production-cutover-preflight.sql](sql/production-cutover-preflight.sql)，逐个保存全部结果集。CP32 门禁必须为 `PASS`；保存 public 全表/列/约束/索引/policy、旧业务数量、每个 list 数量，以及 CPP 全局和 `event_id/day_id/type_id` 分组指纹。
4. 确认生产已开启 Supabase Anonymous Sign-Ins，并按 [部署指南](06-deployment.md) 交互式配置 `SUPABASE_SERVICE_ROLE_KEY`、至少 32 个随机字符的 `SHARE_CODE_SECRET`、`LEGACY_CLAIM_ENABLED=false` 及现有 `CPP_COOKIE`。Secret 不能进入 Git、`wrangler.jsonc`、命令参数或日志。
5. 依次执行 prepare 迁移 `006_auth_rls_realtime.sql`、修复迁移 `008_redeem_share_service_role_grants.sql`、`009_cas_conflict_sqlstate.sql`、`010_service_role_least_privilege.sql`、`011_service_rpc_execute_acl.sql`。006 增加身份、成员、版本、RPC 和 Realtime 结构，并为旧 `events` 补随机 `share_seed`；008 修复分享兑换；009 将 CAS 冲突 SQLSTATE 改为 `P0001`；010 撤销 Service Role 对业务表的直接权限，仅保留 CPP 同步所需的 `cpp_items` SELECT/INSERT/UPDATE 与其 ID 序列 USAGE；011 撤销四个服务 RPC 对 PUBLIC、anon 和 authenticated 的 EXECUTE，并仅向 service_role 授予 EXECUTE。五者都不修改 CP32/CPG `cpp_items` 内容，不删除旧业务行或既有表/字段。若重跑 006，必须按 008 → 009 → 010 → 011 重新收敛函数和权限。
6. 执行静态门禁：`npm.cmd run test:security`、`npx.cmd tsc --noEmit --incremental false`、`npm.cmd run build`，然后部署新应用。此时继续保持维护窗口，不开放写入。
7. 在 Supabase SQL Editor 新建一个查询，把 `begin;`、`007_auth_rls_cutover.sql` 全文、`commit;` 按顺序放进同一个查询，并且只点击一次 **Run**。三部分必须由同一次 Run 发送，不能分三次运行，因为不同 Run 不保证使用同一数据库连接或同一事务。若其中任一语句报错，PostgreSQL 会将该事务标记为 aborted；确认该次 Run 没有成功执行 `commit`，不要再单独运行 `commit;`。必要时新建查询检查 RLS、policy 和旧 `share_code` 状态，确认没有部分提交后再修复并整段重跑。
8. 运行 [production-cutover-postflight.sql](sql/production-cutover-postflight.sql)。全部自动门禁必须为 `PASS`；旧业务行数、每个旧 list 的行数、旧表和字段必须与 preflight 对齐；CP32/CPG 的总数、distinct doujinshi、ID 范围和内容指纹必须完全相同。
9. 用独立匿名账号验证 owner/editor/stranger、重复兑换、editor 退出后重加、owner 删除、旧码失效、CAS 整批回滚、断网重连和 Realtime insert/update/delete。全部通过后才恢复应用写入，再恢复 CPP 同步。

007 在迁移执行时唯一会修改的业务数据，是把旧 `events.share_code` 明文置空；它还会替换 policy、开启 RLS 和调整权限，但不会删除旧 `events`、`event_access`、`wish_items` 或 `cpp_items` 行，也不会删除表或字段。006/008 中能看到的 `DELETE` 位于新建的函数体内：迁移只保存函数定义，不会在迁移时调用这些函数，因此不会因此删除 list、条目或限流记录。运行时只有经过权限检查实际调用对应 RPC，函数体才可能执行。

旧四位识别码会因 007 清空明文而失效。由于本轮不认领旧身份，旧 list 不会生成新识别码，也不会出现在任何新匿名身份的“我的 list”里；数据仍保留在原表中，供恢复或后续经单独批准的处理使用。新建 list 会正常产生 owner membership，分享加入者为 editor，两端编辑同一数据并通过 Realtime 同步。

## 生产数据保护门禁

preflight 和 postflight 都以 `begin transaction read only` 开始并以 `rollback` 结束，只做查询。必须把两次结果作为同一发布记录保存，不能只截图最后一个结果集。

严格比对规则：

- preflight 的 CP32 `item_count` 必须大于 0，否则立即停止。
- postflight 的 CP32/CPG 全局及每个 `event_id/day_id/type_id` 分组，其行数、distinct doujinshi、最小/最大 ID 和内容指纹必须与 preflight 完全一致。
- 所有 preflight 已存在的 public 表和列在 postflight 仍存在；006 新增的结构可以造成指纹变化，但不允许旧列消失或类型改变。
- `events`、`event_access`、`wish_items` 总数和每个旧 event 的 access/item 数必须一致。`list_members` 与 `legacy_device_claims` 不得由旧数据回填。
- event id 与 `cpp_items.event_id` 重合的保留目录事件，其 `member_count` 和 `owner_count` 必须为 0。
- postflight 自动安全门禁任一为 `BLOCK`，都继续维护窗口并进入前滚修复，不恢复写入。

## 权限与同步验证

检查所有保护表已启用 RLS、`wish_items` 已加入 `supabase_realtime` publication，并按完整签名确认认领、分享 material 和兑换共四个服务 RPC 仅允许 `service_role` 有效执行；anon/authenticated 通过 PUBLIC 间接获得 EXECUTE 也必须判为失败。Service Role 的直接表权限只应覆盖 `cpp_items` 的 SELECT/INSERT/UPDATE，另有 `public` schema USAGE 与 `cpp_items.id` 序列 USAGE；分享、认领和成员表通过 SECURITY DEFINER RPC 访问，不应增加直接表权限。postflight 必须与 010 使用同一数据库执行角色，以核验该 owner 的全局与 `public` schema 默认 ACL 不会向 PUBLIC 或 Service Role 授予未来表、序列权限。CAS 需分别验证：单条 stale version 快速返回 `P0001` 且 message 包含 `WISH_ITEM_CONFLICT`；批量第二项 stale 时整批快速失败，并确认第一项没有持久化；全 fresh 批量则全部成功且每项版本只增加一次。Realtime 需用两个 editor/owner 客户端验证：接收方先显式注入自己的 JWT 再订阅，另一方 UPDATE 后应收到完整 payload；还要覆盖 token 刷新后和断网重连，不得只检查 `SUBSCRIBED` 回调。用三个独立匿名账号分别验证 owner、editor 与 stranger，不能使用 Service Role 客户端代替浏览器权限测试。

## 失败处理与回滚边界

- **006 之前失败**：没有数据库改动，保持维护窗口，修复备份、配置或 preflight 的 `BLOCK` 项后重试。
- **006/008/009/010/011 后、007 前失败**：保留这五个向前兼容迁移，回滚应用版本或继续修复新应用。不要执行破坏性 down，不要撤销最小 Service Role 权限，也不要删除新增表/列。若重跑 006，必须随后重跑 008、009、010、011。
- **007 事务内失败**：执行 `rollback;`。由于 007 必须放在一个事务中，失败不会留下半套 RLS/policy，也不会部分清空分享码。
- **007 已提交后失败**：不能直接切回依赖 `event_access` 和明文 `share_code` 的旧应用，因为旧分享码已清空。保持写入关闭、保留 007 的 RLS，向前修复应用或 policy 后重新跑 postflight。只有确有恢复演练和负责人批准时才使用生产备份/PITR。
- 不支持恢复旧分享码；新 list 使用新的 HMAC 分享机制。任何数据恢复都不能覆盖或丢失 preflight 时保存的 CP32/CPG 数据。

## 当前未验证项

生产备份/PITR、生产迁移、生产数据前后比对和生产冒烟都必须在实际发布时人工完成；文档和测试通过不代表这些步骤已经完成。未获明确授权不得在生产执行迁移或部署。
