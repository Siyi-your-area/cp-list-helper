# CP list帮手 - Cloudflare OpenNext 部署指南

**文档版本**：v3
**更新日期**：2026-07-28
**文档维护人**：Siyi

---

## 一、部署目标

当前项目采用 **Cloudflare Workers + OpenNext** 部署 Next.js 全栈应用。

| 环境 | Worker 名称 | 用途 |
|------|-------------|------|
| 生产环境 | `cp-list-helper` | 正式访问地址 |
| 预览环境 | `cp-list-helper-preview` | 功能验证、预发布测试 |

日常开发仍使用：

```bash
npm run dev
```

接近 Cloudflare 运行时的本地预览使用：

```bash
npm run preview
```

---

## 二、关键配置文件

| 文件 | 说明 |
|------|------|
| `wrangler.jsonc` | Cloudflare Worker 配置，包含生产/预览环境 |
| `open-next.config.ts` | OpenNext Cloudflare 配置 |
| `next.config.mjs` | Next.js 配置，并初始化 OpenNext 本地开发适配 |
| `.dev.vars.example` | 本地 Cloudflare preview 环境变量模板 |
| `public/_headers` | 静态资源缓存头 |

---

## 三、环境变量

### 本地开发

普通 Next.js 本地开发读取 `.env.local`：

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

Cloudflare preview 可复制 `.dev.vars.example` 为 `.dev.vars`：

```env
NEXTJS_ENV=development
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SHARE_CODE_SECRET=...
LEGACY_CLAIM_ENABLED=false
CPP_COOKIE=...
```

`.dev.vars`、`.dev.vars.*` 和 `.env.local` 不提交 Git。Service Role Key、分享密钥、Cookie 和真实用户数据也不得出现在命令参数、截图、构建日志或聊天记录中。

### Cloudflare 生产/预览

需要在 Cloudflare 中分别配置生产和预览环境变量：

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SHARE_CODE_SECRET
LEGACY_CLAIM_ENABLED=false
CPP_COOKIE
```

变量用途与边界：

| 变量 | 用途 | 安全要求 |
|------|------|----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL | 可公开，但必须指向当前环境 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 浏览器匿名/Publishable Key | 可公开，不得替代服务端 Secret |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端分享 RPC 与 CPP 同步 | 仅服务端 Secret，绝不能带 `NEXT_PUBLIC_` |
| `SHARE_CODE_SECRET` | 分享码与 IP HMAC | 至少 32 个随机字符，仅服务端 Secret |
| `LEGACY_CLAIM_ENABLED` | 是否允许旧设备身份认领 | 本轮生产固定为 `false` |
| `CPP_COOKIE` | CPP 外部请求 Cookie | 仅服务端 Secret |

`SUPABASE_SERVICE_ROLE_KEY` 接受 Supabase 的新 Secret Key（`sb_secret_...`）或旧式 Service Role JWT，但生产只配置其中一个有效值。不要把 Supabase 数据库连接密码误当成此变量。

生产值统一通过 Cloudflare Dashboard 或交互式命令输入。命令只写变量名，终端出现提示后再粘贴值；不要把值拼在命令参数里：

```bash
# 生产环境：逐条执行，按提示输入
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SHARE_CODE_SECRET
npx wrangler secret put LEGACY_CLAIM_ENABLED
npx wrangler secret put CPP_COOKIE

# 预览环境：逐条执行，按提示输入
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env preview
npx wrangler secret put SHARE_CODE_SECRET --env preview
npx wrangler secret put LEGACY_CLAIM_ENABLED --env preview
npx wrangler secret put CPP_COOKIE --env preview
```

为 `LEGACY_CLAIM_ENABLED` 输入字面值 `false`。本轮不迁移旧设备身份，不能临时改为 `true`。`NEXT_PUBLIC_*` 可在 Cloudflare 环境变量界面配置；它们虽可公开，也不能写死成另一环境的项目地址或 Key。

---

## 四、部署命令

### 预览环境

```bash
npm run deploy:preview
```

### 生产环境

```bash
npm run deploy
```

### 生成 Cloudflare 类型

```bash
npm run cf-typegen
```

---

## 五、部署前检查

```bash
npm run test:security
npx tsc --noEmit --incremental false
npm run build
npm run preview
```

核心路径：

- 首页可打开
- 匿名身份可创建 list
- 创建人和分享加入者可编辑同一份 list，并通过 Realtime 同步
- 可上传 Excel 并匹配 Supabase 数据
- API route 可访问
- editor 退出不会删除 list，owner 删除后识别码失效
- stranger 不能读取或修改非成员 list
- 浏览器角色只能读取 `cpp_items`，Service Role 可同步但不能删除

安全数据库切换还必须执行：

1. 确认生产备份或 PITR 实际可用；这是发布前人工门禁，不能因文档存在而视为完成。
2. 暂停应用写入和 CPP 同步。
3. 运行并保存 [生产切换前只读快照](sql/production-cutover-preflight.sql) 的全部结果。
4. 严格按 [安全权限与实时同步上线手册](11-security-realtime-rollout.md) 执行 006 → 008 → 009 → 010 → 011 → 新应用 → 事务内 007。若重跑 006，必须随后按顺序重跑 008、009、010、011，再继续部署或切换。
5. 运行 [生产切换后只读验收](sql/production-cutover-postflight.sql)，确认全部自动门禁为 `PASS`，并逐项比对旧业务行、全部表/字段及 CP32/CPG 内容指纹。
6. 只有前后结果一致且产品冒烟通过，才恢复应用写入和 CPP 同步。

本轮允许旧 list 因没有 `list_members` 而不再可见，但不允许删除其 `events`、`event_access`、`wish_items` 行，不允许为保留目录事件伪造 owner，也不允许修改或清空任何 CP32/CPG `cpp_items` 数据。

---

## 六、后续待办

- CPP Cookie 到期提醒与外部接口成功率监控
- 用户上传图片 URL 化：前端压缩后上传到对象存储，数据库只保存 URL
- 正式推广前补充 CPG08 原始数据并上传 Supabase
