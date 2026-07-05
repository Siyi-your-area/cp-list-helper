# CP展会List帮手 - 开发落地方案

**文档版本**：v2  
**创建日期**：2026-06-10  
**数据方案**：方案A（爬虫自动获取 CPP 展品数据）  
**文档维护人**：Siyi

---

## 一、数据获取方案（方案A）

### 核心思路

每届 CP 展会前，运行爬虫脚本自动爬取 CPP 展品数据，生成 JSON 文件，系统自动匹配填充图片。

### 数据流

```
CPP 网站 → 爬虫脚本 → 展品数据 JSON → 系统导入 → 用户上传心愿单 → 自动匹配图片
```

### 爬虫脚本功能

```bash
# 使用示例
node scripts/crawl-cpp.mjs --event=cp33 --output=./data/cp33.json
```

**爬取内容：** 摊位号、展品名称、社团名、图片 URL（CPP CDN 地址）、展会名称/场馆/日期

**输出格式：**
```json
{
  "eventId": "cp33",
  "eventName": "CP33",
  "venue": "上海国家会展中心",
  "date": "2026-10-01",
  "booths": [
    {
      "boothNumber": "A01",
      "items": [
        {
          "productName": "展品名称",
          "pic": "https://imagecdn3.allcpp.cn/xxx.jpg",
          "author": "社团名"
        }
      ]
    }
  ]
}
```

---

## 二、系统功能设计

### 用户流程

```
1. 系统内置/导入展品数据 JSON（爬虫生成）
2. 用户上传 CPP 心愿单 Excel
3. 系统自动解析 Excel，提取摊位号 + 展品名
4. 根据"摊位号+展品名"匹配展品数据 JSON
5. 自动填充图片 URL 到表格
6. 用户手动补充：价格、开摊时间、备注等
7. 展会中：搜索摊位、记录购买情况
8. 导出 Excel
```

---

## 三、技术栈

| 技术 | 选择 | 理由 |
|------|------|------|
| 前端框架 | Next.js 14 (App Router) | 快速开发、文件路由 |
| 语言 | TypeScript | 类型安全 |
| UI 组件 | Tailwind CSS + Phosphor Icons | 轻量、自定义度高 |
| Excel 解析 | SheetJS (xlsx) | 浏览器端解析/导出 Excel |
| 数据存储 | LocalStorage | 本地存储，无需后端 |
| 爬虫脚本 | Node.js + Puppeteer | 爬取 CPP 网页数据 |
| 部署 | Vercel | Next.js 原生支持，免费 |

---

## 四、页面结构

```
/                    # 首页 - 展会列表
/exhibit/[id]        # 展会详情页 - 心愿单表格
/api/cpp/match       # API - CPP 数据匹配接口
```

---

## 五、数据模型

### Exhibit（展会）
```typescript
interface Exhibit {
  id: string;
  name: string;           // 展会名称（如：CP33）
  venue: string;          // 场馆
  date: string;           // 日期
  items: WishItem[];      // 心愿单列表
  cppData?: CPPDataItem[]; // CPP 展品数据（已废弃，保留兼容）
  createdAt: number;
  updatedAt: number;
}
```

### WishItem（心愿项）
```typescript
interface WishItem {
  id: string;
  boothNumber: string;      // 摊位号
  productName: string;      // 制品名称
  author?: string;          // 作者/社团名
  imageUrl?: string;        // 图片 URL（从 CPP 数据匹配）
  status: string;           // pending/purchased/soldout/待领取/已领取
  price?: number;           // 价格
  openInfo?: string;        // 开摊信息
  priority?: Priority;      // 首摊/次摊/P1-P3/随缘
  note?: string;            // 备注
  quantity?: number;        // 计划购买数量
  purchaseLimit?: number;   // 限购量
  type?: "paid" | "free";   // 有料/无料
  actualPrice?: number;     // 实付金额
  actualQuantity?: number;  // 实购数量
  purchaseNote?: string;    // 购买备注
  matchConfidence?: MatchConfidence;  // 匹配置信度
  matchedCPPItem?: NormalizedCPPItem; // 匹配到的 CPP 数据
}
```

### NormalizedCPPItem（标准化 CPP 数据）
```typescript
interface NormalizedCPPItem {
  boothNumber: string;      // 摊位号
  boothName: string;        // 摊位名
  productName: string;      // 展品名称
  author: string;           // 作者/社团名
  imageUrl: string;         // 图片 CDN URL
  tags: string[];           // 标签
  eventName: string;        // 展会名称
  sourceUrl: string;        // CPP 详情页链接
  doujinshiId: number;      // 展品 ID
}
```

---

## 六、开发步骤与进度

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 项目初始化（Next.js + TypeScript + Tailwind） | ✅ 完成 |
| Phase 2 | 首页开发（展会列表、创建/删除） | ✅ 完成 |
| Phase 3 | CPP 数据爬取与预处理 | ✅ 完成 |
| Phase 4 | 心愿单上传与解析（Excel 解析 + 多列名兼容） | ✅ 完成 |
| Phase 5 | 可编辑表格（全部字段编辑、筛选、排序） | ✅ 完成 |
| Phase 6 | 搜索与购买记录（模糊搜索、状态切换、统计面板） | ✅ 完成 |
| Phase 7 | 导出 Excel | ✅ 完成 |
| Phase 8 | 响应式适配（手机端） | ✅ 完成 |
| Phase 9 | CPP 匹配引擎（5 级匹配策略） | ✅ 完成 |
| Phase 10 | 部署到 Vercel | ✅ 完成 |

---

## 七、风险与注意事项

1. **CPP 网页结构变化**：爬虫脚本需根据 CPP 实际网页结构调整
2. **反爬机制**：可能需要处理验证码、频率限制
3. **LocalStorage 容量**：约 5-10MB，大量图片 URL 可能超限（MVP 先存 URL，不存图片）
4. **图片防盗链**：CPP CDN 图片可能有防盗链，需测试
