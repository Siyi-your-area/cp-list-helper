# CP展会List帮手 - 技术架构说明

**文档版本**：v1  
**创建日期**：2026-07-05  
**文档维护人**：Siyi

---

## 一、项目概述

CP List Helper 是一个面向同人展会参展者的心愿单管理 Web 应用。核心功能是上传 CPP 心愿单 Excel 后，自动匹配摊位信息、作者和图片，并提供可编辑表格、搜索筛选、购买记录、Excel 导出等功能。

**线上地址**：https://cp-list-helper.vercel.app  
**源码仓库**：https://github.com/Siyi-your-area/cp-list-helper

---

## 二、技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 框架 | Next.js (App Router) | 14.2.5 |
| 语言 | TypeScript | latest |
| UI | Tailwind CSS + Phosphor Icons | 3.4.17 / 2.1.10 |
| Excel | SheetJS (xlsx) | 0.18.5 |
| 爬虫 | Puppeteer | 25.1.0 |
| 部署 | Vercel | - |
| 数据存储 | LocalStorage（浏览器端） | - |

---

## 三、项目结构

```
cp-list-helper/
├── app/
│   ├── page.tsx                    # 首页 - 展会列表
│   ├── layout.tsx                  # 根布局
│   ├── globals.css                 # 全局样式
│   ├── exhibit/
│   │   └── [id]/
│   │       └── page.tsx            # 展会详情页（核心页面）
│   └── api/
│       └── cpp/
│           └── match/
│               └── route.ts        # CPP 匹配 API
├── lib/
│   ├── types.ts                    # 共享类型定义
│   ├── storage.ts                  # LocalStorage CRUD
│   ├── excel-parser.ts             # Excel 解析器
│   ── cpp-matcher.ts              # CPP 匹配引擎（MatchIndex）
├── data/
│   └── cpp-data/
│       ├── cp32-total.json         # 爬虫原始数据
│       └── index.json              # 摊位索引（27,150 行）
├── public/
│   └── cpp/
│       ├── index.json              # 展会索引
│       └── cp32/
│           ├── manifest.json       # CP32 元数据
│           ├── items.json          # 全量标准化数据（7.4MB，~20,000 条）
│           └── booths/             # 按摊位拆分（5,428 个文件）
── scripts/
│   ├── crawl-cpp.mjs              # CPP 爬虫主脚本
│   ├── prepare-cpp-data.js        # 数据预处理脚本
│   ├── login-cpp.mjs              # CPP 登录（获取 cookie）
│   ├── qa-test.mjs                # QA 自动化测试
│   └── debug-*.mjs                # 爬虫调试脚本集
├── docs/                           # 项目文档
├── .npmrc                          # npm 配置（legacy-peer-deps）
├── package.json
└── README.md
```

---

## 四、核心模块说明

### 4.1 CPP 匹配引擎（`lib/cpp-matcher.ts`）

核心匹配逻辑，支持 5 级匹配策略：

| 级别 | 策略 | 说明 |
|------|------|------|
| Level 1 | 精确匹配 | 摊位号 + 展品名称完全一致 |
| Level 2 | 标准化匹配 | 全角→半角、去空格后匹配 |
| Level 3 | 包含匹配 | 摊位号匹配 + 名称互相包含 |
| Level 4 | 作者匹配 | 摊位号匹配 + 作者一致 |
| Level 5 | 模糊匹配 | 摊位号匹配 + 名称相似度 > 60% |

使用 MatchIndex 类构建索引（exactMap + boothMap），实现 O(1) 查找加速。

### 4.2 Excel 解析器（`lib/excel-parser.ts`）

解析 CPP 导出的心愿单 Excel 文件，支持多种列名别名（"社团摊位号"/"摊位号"/"booth" 等），自动定位列位置。

### 4.3 匹配 API（`app/api/cpp/match/route.ts`）

POST 接口，接收批量匹配请求：
```json
{
  "eventId": "cp32",
  "items": [
    { "boothNumber": "伍A01", "productName": "xxx", "author": "xxx" }
  ]
}
```
返回匹配结果（含置信度和匹配到的 CPP 数据）。

### 4.4 数据预处理（`scripts/prepare-cpp-data.js`）

将爬虫原始数据转换为应用可用格式：
- 提取参展信息（participationInfo）
- 按摊位号分组
- 生成 manifest / items / booths 文件

---

## 五、数据流

```
用户上传 Excel
    ↓
excel-parser.ts 解析 → MatchInput[]
    ↓
POST /api/cpp/match
    ↓
cpp-matcher.ts MatchIndex 匹配 → MatchResult[]
    ↓
前端展示匹配结果（图片、作者、摊位名自动填充）
    ↓
用户编辑补充（价格、备注等）
    ↓
storage.ts → LocalStorage 持久化
    ↓
用户导出 Excel（xlsx 库）
```

---

## 六、部署架构

```
GitHub (main 分支)
    ↓ push 触发
Vercel 自动构建部署
    ↓
https://cp-list-helper.vercel.app
```

**构建注意事项：**
- 需要 `.npmrc` 设置 `legacy-peer-deps=true`（解决 peer dependency 冲突）
- Puppeteer 已移至 devDependencies（不影响 Vercel 生产构建）
- `public/cpp/` 目录包含静态 CPP 数据，构建后自动部署

---

## 七、已知限制

| 限制 | 说明 | v2 改进方向 |
|------|------|------------|
| 数据存储 | LocalStorage，约 5-10MB 上限 | 云存储/账号体系 |
| 单展会 | 目前仅内置 CP32 数据 | 多展会动态加载 |
| 爬虫 | 需手动运行，非自动化 | CI/CD 自动爬取 |
| 地图 | 无场馆地图可视化 | 地图集成 |
| 多用户 | 无协作功能 | 实时协作 |
