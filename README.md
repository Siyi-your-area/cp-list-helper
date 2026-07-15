# CP List Helper

CP 展会心愿单管理工具，帮助参展者导入 Excel 心愿单，并自动匹配 CPP / allcpp.cn 的展品信息，生成可在电脑和手机端同步查看的 list。

## 功能特性

- 上传心愿单 Excel，自动解析摊位号、制品名称、作者等字段
- 基于 Supabase 中的 CPP 原始展品数据自动匹配图片、作者、热度、详情
- 支持 CP32 一期、CP32 二期等 list，CP32 原始数据通过 `event_id=cp32` + `day_id` 区分一期/二期
- 每份 list 自动生成 4 位邀请码，可在手机端和 PC 端访问同一份数据
- 支持编辑、单行删除、多选批量删除
- 支持按摊位号默认排序、按优先级排序、按热度排序
- 详情字段通过弹窗查看，避免长文本撑乱表格
- 支持导出 Excel，并尽量将可访问图片嵌入为真实图片
- 响应式界面，桌面端表格视图，手机端卡片/抽屉视图

## 技术栈

- Next.js 14
- React 18
- TypeScript
- Supabase
- Tailwind CSS
- SheetJS / ExcelJS

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

在项目根目录创建 `.env.local`：

```env
NEXT_PUBLIC_SUPABASE_URL=https://jfmbeixamoaxodzmqzro.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 3. 启动开发服务

```bash
npm run dev
```

访问：

```text
http://localhost:3000
```

Windows PowerShell 如果遇到脚本执行策略限制，可以使用：

```powershell
npm.cmd run dev
```

## 数据库说明

主要表：

- `events`：用户创建的 list / 展会入口，包含 `share_code` 和 `cpp_event_id`
- `wish_items`：用户心愿单条目
- `cpp_items`：CPP 原始展品数据，不随用户删除 list 而删除

CP32 数据规则：

- `cpp_items.event_id = "cp32"`
- 一期：`day_id = "7040"`，时间 5.1-5.2
- 二期：`day_id = "7042"`，时间 5.4-5.5

已用到的字段包括：

- `hot_count`：热度/收藏数
- `original_work`：原作/IP
- `exchange_type`：有偿交换 / 无料交换
- `description`：展品详情

## 图片策略

当前 CPP 匹配图片通常是远程 URL，导出 Excel 时会尝试将可读取的图片嵌入为真实图片；如果远程图片因跨域等原因无法读取，会保留图片链接作为兜底。

后续推荐将用户手动上传图片迁移到 Supabase Storage：

1. 前端压缩图片
2. 上传到 Storage bucket
3. 数据库只保存图片 URL

这样可以避免把 base64 图片塞进数据库，节省数据库空间。

## 测试

类型检查：

```bash
npx tsc --noEmit --incremental false
```

用户旅程测试清单见：

```text
docs/test-plan-user-journey-2026-07-15.md
```

## 部署建议

项目当前可以考虑两条路线：

### Cloudflare Pages

仓库中已有 Cloudflare 相关依赖和脚本：

```bash
npm run build:cf
```

适合希望使用 Cloudflare Pages + OpenNext 体系的部署方式。部署前需要在 Cloudflare Pages 中配置 Supabase 环境变量。

### Vercel

Next.js 原生支持最好，配置相对简单，也适合先做 MVP 验证。

部署前都需要确认：

- Supabase 环境变量已配置
- Supabase 表结构 migration 已执行
- 生产环境可以访问 Supabase
- 邀请码和 list 数据使用同一个 Supabase 项目

## 常用脚本

```bash
npm run dev       # 本地开发
npm run build     # 生产构建
npm run start     # 启动生产服务
npm run build:cf  # Cloudflare Pages 构建
```

## License

MIT
