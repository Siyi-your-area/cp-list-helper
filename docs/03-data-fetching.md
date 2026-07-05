# CP展会数据获取方案分析

**文档版本**：v1  
**创建日期**：2026-06-11  
**文档维护人**：Siyi

---

## 一、cp32map 实现方式分析

### 数据来源

cp32map 的数据存储在 Cloudflare Pages 的静态 JSON 文件中：
- URL 格式：`https://cp32map.pages.dev/data/Phase2/booths/肆P07.json`
- 目录结构：`/data/Phase2/booths/` + 摊位号.json

### 数据结构

```json
{
  "eventId": "7042",
  "booth": "肆P07",
  "circles": [
    {
      "circleId": 107907,
      "name": "路过吃一口",
      "scname": "苏丹的游戏",
      "positionname": "双子好吃",
      "pic": "https://imagecdn3.allcpp.cn/xxx.jpg",
      "sectionId": 896,
      "rawPosition": "肆P07",
      "positions": ["肆P07"],
      "isMultiBooth": false,
      "members": [...]
    }
  ]
}
```

### 关键发现

1. **图片 URL 来自 CPP CDN**：`https://imagecdn3.allcpp.cn/`
2. **数据是静态文件**：提前爬取好，部署到 Cloudflare Pages
3. **每个摊位一个 JSON 文件**：按摊位号组织

---

## 二、我们的实现方案

### 方案：爬取 CPP → 生成 JSON → 本地使用

#### 步骤 1：分析 CPP 网页结构

CPP 展品页面 URL 格式：
- 列表页：`https://allcpp.cn/allcpp/doSearchExhibitionList.do?exhibition=cp32`
- 详情页：`https://allcpp.cn/d/展品ID.do`

#### 步骤 2：编写爬虫脚本

使用 Node.js + Puppeteer 爬取 CPP 数据（详见 `scripts/crawl-cpp.mjs`）。

#### 步骤 3：数据预处理

运行 `scripts/prepare-cpp-data.js` 将爬虫产出转换为应用可用格式：

| 输出文件 | 说明 |
|---------|------|
| `public/cpp/cp32/manifest.json` | 展会元数据 + 统计 |
| `public/cpp/cp32/items.json` | 标准化后的全量扁平数据（约 20,000 条） |
| `public/cpp/cp32/booths/{摊位号}.json` | 按摊位拆分（5,428 个文件） |
| `public/cpp/index.json` | 展会索引 |

#### 步骤 4：集成到系统

用户上传心愿单时，API 路由 `/api/cpp/match` 加载 CPP 数据，通过 MatchIndex 引擎进行多级匹配。

---

## 三、推荐实现方案

### 方案 A：本地 JSON 文件（已采用）

**适用场景**：数据量不大（< 1000 个摊位）

**优点**：简单，不需要额外部署，速度快  
**缺点**：每个展会需要一个 JSON 文件，文件较大

### 方案 B：云存储 + API（推荐 v2 使用）

**适用场景**：数据量大，或需要多展会复用

**优点**：按需加载，速度快，支持多展会，可分享给其他用户  
**缺点**：需要额外部署，需处理跨域

---

## 四、下一步行动（v2）

1. **完善爬虫脚本**：支持 CP33 及后续展会
2. **多展会支持**：自动按展会 ID 切换数据集
3. **增量更新**：只爬取新增/变更的摊位数据
4. **数据验证**：爬取后自动校验数据完整性
