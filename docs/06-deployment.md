# CP List Helper - Cloudflare OpenNext 部署指南

**文档版本**：v2  
**更新日期**：2026-07-19
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
CPP_COOKIE=...
```

`.dev.vars` 不提交 Git。

### Cloudflare 生产/预览

需要在 Cloudflare 中分别配置生产和预览环境变量：

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
CPP_COOKIE
```

`CPP_COOKIE` 是完整的 Cookie 请求头值，必须作为服务端 Secret 保存，不能写入前端代码、`wrangler.jsonc`、Git 或构建日志。交互式写入命令：

```bash
# 生产环境
npx wrangler secret put CPP_COOKIE

# 预览环境
npx wrangler secret put CPP_COOKIE --env preview
```

命令会在终端中安全提示输入值，不要把 Cookie 拼在命令参数中。

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
npx tsc --noEmit --incremental false
npm run preview
```

核心路径：

- 首页可打开
- 可创建心愿单
- 可输入邀请码进入同一份 list
- 可上传 Excel 并匹配 Supabase 数据
- API route 可访问
- 删除 list 后邀请码失效

---

## 六、后续待办

- CPP Cookie 到期提醒与外部接口成功率监控
- 用户上传图片 URL 化：前端压缩后上传到对象存储，数据库只保存 URL
- 正式推广前补充 CPG08 原始数据并上传 Supabase
