# CP list帮手 — 项目总结（截至 2026-07-14）

> 新页面开发时，直接复制此文件内容到新会话即可。

---

## 项目概述

CP32 同人展会心愿单管理工具，帮助参展者快速匹配心愿单中的制品与 CPP 平台（allcpp.cn）的实际商品。

- **技术栈**：Next.js 14 + TypeScript + Supabase (PostgreSQL)
- **数据规模**：66,305 条 CPP 商品数据
- **部署**：本地开发 `npm run dev`，计划部署到 Vercel
- **项目路径**：`/Users/huangsiyi/playground_for_cc/cp-list-helper/`

---

## 核心功能（已完成）

1. **心愿单导入**：用户上传 Excel 文件，解析出制品列表
2. **CPP 匹配引擎**：自动匹配心愿单制品与 CPP 平台商品（按商品名+作者）
3. **展会页面**：展示匹配结果，支持编辑/删除展品
4. **分享码功能**：4 位短码，手机扫码即可访问同一展会
5. **数据库存储**：Supabase 云端存储所有数据

---

## 数据库字段（cpp_items 表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | uuid | 主键 |
| event_id | text | 展会 ID（cp32） |
| day_id | text | 活动日（7040=一期5.1-5.2, 7042=二期5.4-5.5） |
| doujinshi_id | text | CPP 平台商品 ID（去重键） |
| booth_name | text | 社团名 |
| booth_number | text | 摊位号（如"创132"） |
| author | text | 作者名 |
| product_name | text | 商品名 |
| image_url | text | 封面图 URL |
| source_url | text | CPP 详情页 URL |
| type_name | text | 分类名（本、グッズ等） |
| type_id | integer | 分类 ID |
| tags | text[] | 标签数组 |
| **hot_count** | integer | 热度（收藏数） |
| **original_work** | text | 原作/系列名（"原创"表示原创作品） |
| **exchange_type** | text | 交换状态（"有偿交换" / "无料交换"） |
| **description** | text | 展品详情文字 |

**注意**：同一商品参加两天时（doujinshi_id 相同），会有两条记录（day_id 不同，booth_number 可能不同）。

---

## 关键文件结构

```
cp-list-helper/
├── app/
│   ├── page.tsx                    # 首页：创建/加入展会 + 邀请码
│   ├── exhibit/[id]/page.tsx       # 展会详情页：心愿单匹配结果
│   ├── api/
│   │   ├── cpp/match/route.ts      # CPP 匹配 API
│   │   └── share/route.ts          # 分享码 API（GET/POST）
│   ├── layout.tsx
│   └── globals.css
├── lib/
│   ├── types.ts                    # 类型定义（NormalizedCPPItem, Exhibit, MatchResult）
│   ├── db-service.ts               # Supabase 数据操作（CRUD + 分享码）
│   ├── supabase.ts                 # Supabase 客户端
│   ├── cpp-matcher.ts              # 匹配引擎（商品名+作者匹配）
│   ├── excel-parser.ts             # Excel 解析
│   └── storage.ts                  # 本地存储（Excel 解析结果）
├── components/                     # React 组件（卡片、上传等）
├── hooks/                          # 自定义 hooks
├── scripts/                        # 爬取/验证脚本（Node.js）
│   ├── crawl-cpp-supabase.mjs      # 搜索 API 爬取（66K+ 条）
│   ├── crawl-cpp-details.mjs       # 详情页 HTML 爬取（交换状态等）
│   ├── verify_final.mjs            # 数据完整性验证
│   └── query_original_table.mjs    # 查询原创作品
└── docs/                           # 文档
```

---

## 待做：页面优化（新页面重点）

新字段已存储但未在 UI 使用，需要优化：

### 1. 热度（hot_count）— 排序/筛选
- 当前展示顺序是固定的，可以用热度做排序
- 热门商品优先展示？按热度筛选？

### 2. 原作（original_work）— 分类展示
- 当前按"商品名+作者"匹配，原作字段未使用
- 可以按原作分组展示（同 IP 的放一起）
- 区分原创/同人

### 3. 交换状态（exchange_type）— 核心优化
- 当前逻辑：通过 tags 猜测是"有偿"还是"无料"（`detectTypeFromCPP`）
- 现在有准确的 exchange_type 字段，可以直接用
- 无料交换（免费）vs 有偿交换（付费）— 对参展者很重要
- 可以按交换状态筛选/分组

### 4. 详情文字（description）— 展示优化
- 展品详情文字未使用
- 可以展示在商品卡片上，帮助用户判断是否想要

---

## 已知数据问题

- **幼猫修行**（ID 1682073）：CPP 搜索 API 带 eventId 过滤时找不到（平台限制）
- **"原创"误标**：部分商品 author 填写的 original_work 是"原创"，但实际是同人 IP（如《葬送的芙莉莲》）
- **CPP 搜索 API 限制**：4 个分类（卡片、纸胶带、COS、手办）在搜索 API 中查不到，只有 12/16 分类可搜索
- **覆盖率**：99.7% 的 66K+ 数据已有交换状态和详情字段

---

## 开发规范

- 用中文回复，称呼 Siyi
- 需求文档两部分：【需求背景】+【需求详情】
- 文件存放：`/Users/huangsiyi/playground_for_cc/`，文件名加日期后缀
- 不擅自上传外部系统，不修改已确认文档

---

## 环境说明

- Supabase URL: `https://jfmbeixamoaxodzmqzro.supabase.co`
- Node.js 环境需要 `NODE_TLS_REJECT_UNAUTHORIZED=0` 访问 Supabase
- CPP Cookie 文件：`cpp-cookies.json`（项目根目录）
- 数据库操作脚本统一放 `scripts/` 目录
