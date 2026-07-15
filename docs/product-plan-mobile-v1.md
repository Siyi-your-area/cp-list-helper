# CP List Helper — 产品方案 v2

> 版本：v2  
> 日期：2026-07-12  
> 状态：待确认后启动开发

---

## 一、产品定位

CP 同人展会的**心愿单管理工具**，覆盖从展前准备到现场执行的全流程。

| 阶段 | 设备 | 核心操作 |
|------|------|---------|
| 展前准备 | 电脑端 | 导入 Excel、整理优先级、编辑商品信息 |
| 展会现场 | 手机端 | 浏览商品、确认购买、记录状态、临时备注 |
| 展后整理 | 电脑端 | 统计花费、导出总结 |

**目标展会**：CP 广州（CP32 为历史数据 / 开发调试用）

---

## 二、数据源：CPP 全量爬取

### 2.1 问题

之前爬取只用了 8 个大类的 typeId，漏掉了卡片/纸胶带/COS/手办/亚克力/徽章/色纸/其他共 8 个小类。且搜索 API 单次上限 10,000 条，无法覆盖全部展品。

### 2.2 方案：按分类逐个爬取

遍历 16 个分类，每个分类独立翻页，确保不遗漏：

| 分类 | typeId | | 分类 | typeId |
|------|--------|-|------|--------|
| 漫画 | 36 | | 卡片 | 33 |
| 小说 | 37 | | 纸胶带 | 34 |
| 图集 | 38 | | COS | 41 |
| 音乐 | 39 | | 手办 | 42 |
| GAME | 40 | | 亚克力 | 43 |
| 图文志 | 50 | | 徽章 | 44 |
| 海报集 | 51 | | 色纸 | 45 |
| 其他作品集 | 52 | | 其他 | 46 |

每个展会日（dayId）× 16 个分类 = 32 次爬取任务，每次翻页直到无更多数据。

预估数据量：10-16 万条（CP32 两期合计）

### 2.3 图片策略

**只存 CPP 图片 URL，不下载图片到服务器。**

- 数据库存原始 URL（如 `https://imagecdn3.allcpp.cn/upload/xxx.jpg`）
- 手机端通过浏览器缓存（Service Worker）缓存首次加载过的图片
- 展会现场已浏览过的图片可以离线查看
- 新图片实时加载（展会现场一般有信号）

**成本：$0**（不占 Supabase Storage 额度）

### 2.4 自动更新机制

- **频率**：每天一次
- **方式**：增量爬取（upsert，重复的不覆盖）
- **Cookie 过期**：不影响核心功能，匹配继续使用数据库里最近一次成功的数据。用户发现匹配率下降时手动更新 Cookie 即可，无需告警
- **事件生命周期**：展会开始前每天更新 → 展会当天停止更新 → 归档为历史数据

### 2.5 小批量验证策略

**不要一次性爬全量数据。** 先选 1-2 个分类做试点：

```
第 1 步：只爬「漫画」+「卡片」两个分类（覆盖大类和小类）
         ↓
第 2 步：验证匹配率、数据完整性、存储方案
         ↓
第 3 步：确认没问题后，跑剩余 14 个分类的全量爬取
```

---

## 三、技术架构

### 3.1 整体架构

```
┌──────────┐         ┌──────────────┐         ┌──────────┐
│  电脑端   │ ←────→ │  Supabase    │ ←────→ │  手机端   │
│  Next.js │  读写   │  PostgreSQL  │  读写   │  Next.js │
│          │         │  (数据库)     │         │  (PWA)   │
──────────┘         └──────────────┘         └──────────┘
                              ↑
                     爬虫脚本（每日更新）
```

- 两端共用同一个 Next.js 应用（响应式适配）
- 数据统一存 Supabase，不再依赖 localStorage
- 同一个展会 ID，两端看到的数据完全一致

### 3.2 数据库设计

```sql
-- 展会表
CREATE TABLE events (
  id TEXT PRIMARY KEY,         -- 'cp32', 'cpgz'
  name TEXT,                   -- 'COMICUP 32'
  days JSONB,                  -- [{"id":"7040","name":"一期"},{"id":"7042","name":"二期"}]
  status TEXT DEFAULT 'active',-- 'active' | 'ended'
  cpp_event_id TEXT,           -- CPP 系统的 eventId (如 '6377')
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- CPP 展品表（爬取数据）
CREATE TABLE cpp_items (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,      -- 关联展会
  day_id TEXT NOT NULL,        -- '7040' / '7042'
  type_id INT NOT NULL,        -- 分类 ID
  type_name TEXT,              -- '漫画' / '卡片' ...
  doujinshi_id BIGINT NOT NULL,-- CPP 原始 ID
  product_name TEXT NOT NULL,  -- 展品名称
  author TEXT,                 -- 作者
  booth_number TEXT,           -- 摊位号
  booth_name TEXT,             -- 社团名
  image_url TEXT,              -- CPP 图片 URL（不下载）
  tags JSONB,                  -- 标签数组
  source_url TEXT,             -- CPP 详情页链接
  UNIQUE(event_id, day_id, doujinshi_id)
);

-- 用户心愿单（用户在 App 里操作的数据）
CREATE TABLE wish_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL,      -- 关联展会
  cpp_item_id BIGINT,          -- 关联 CPP 展品（可空，手动添加的没有）
  booth_number TEXT NOT NULL,
  product_name TEXT NOT NULL,
  author TEXT,
  image_url TEXT,
  item_type TEXT DEFAULT 'paid',    -- 'paid'（有料）| 'free'（无料）
  status TEXT DEFAULT 'pending',    -- 有料: pending/purchased/soldout
                                    -- 无料: pending_collected/collected
  priority TEXT,                     -- 首摊/次摊/P1/P2/P3/随缘
  note TEXT,
  price NUMERIC,
  quantity INT DEFAULT 1,
  purchase_limit INT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_cpp_items_event ON cpp_items(event_id, day_id);
CREATE INDEX idx_cpp_items_booth ON cpp_items(event_id, booth_number);
CREATE INDEX idx_wish_items_event ON wish_items(event_id);
CREATE INDEX idx_cpp_items_search ON cpp_items USING GIN(product_name, booth_number);
```

### 3.3 状态设计

| 物品性质 | 可选状态 | 内部值 | 显示 |
|---------|---------|--------|------|
| **有料** | 待购买 | `pending` | 🟡 |
| **有料** | 已购买 | `purchased` |  |
| **有料** | 已售罄 | `soldout` | 🔴 |
| **无料** | 待领取 | `pending_collected` | 🔵 |
| **无料** | 已领取 | `collected` |  |

选择物品性质后，状态选项自动匹配。表格内点击状态循环切换。

---

## 四、手机端 UI 方案

### 4.1 表格布局

保留表格形式，单屏 5-6 行。

| 列 | 宽度 | 说明 |
|----|------|------|
| 图片 | 48px 固定 | CPP 缩略图，点击可放大 |
| 摊位号 | 56px 固定 | 加粗，如 `肆P29` |
| 商品名 | 自适应 | 截断，点击展开详情 |
| 状态 | 44px 固定 | 彩色胶囊按钮，点击循环切换 |

```
┌─────────────────────────────────────┐
│  搜索摊位号或商品名...             │
│ [只看未买 ▾]  [优先级 ▾]             │
──────┬──────┬──────────┬──────┤
│ [图] │ 肆P29 │ 五等分的… │ 🟢已购 │
│ [图] │ 肆P30 │ 罗小黑…   │ 🟡待购 │
│ [图] │ 伍A01 │ 东方project│ 🔴售罄 │
│ [图] │ 伍A01 │ 车万周边   │ 🟡待购 │
│ [图] │ 伍A02 │ 原神立牌   │ 🔵待领 │
└──────┴──────┴──────────┴──────┘
```

### 4.2 行详情（底部抽屉）

点击某行后底部弹出：

```
┌─────────────────────────────────────
│  [大图 — 可双指缩放]                 │
│  肆P29 · 上火茶楼                     │
│  （明信片套装）五等分的政敌            │
│  作者：xxx  |  ¥35                   │
│ ─────────────────────────────────── │
│  [待购买]  [已购买]  [已售罄]          │  ← 有料三态
│  (当前: 已购买 ✅)                    │
│ ────────────────────────────────── │
│   备注：____________________       │  ← 可直接编辑
│ ─────────────────────────────────── │
│  ✏️ 编辑商品信息                      │  ← 可编辑摊位号/名称等
│ ─────────────────────────────────── │
│  [关闭]                               │
─────────────────────────────────────┘
```

**手机端支持全功能编辑**：状态、备注、商品名、摊位号、作者、价格等都能改，修改后自动同步到 Supabase。

### 4.3 导航与筛选

- **搜索**：输入摊位号或商品名，实时过滤
- **筛选**：只看未买 / 按优先级排序 / 按摊位号排序
- **区域快跳**：顶部横向标签 `[全部] [壹] [贰] [叁] [肆] [伍] [陆] ...`
- **回到顶部**：长列表下滑后出现浮动按钮

---

## 五、PWA 方案

### 5.1 配置

- `manifest.json`：应用名称「CP List」、图标、全屏启动
- Service Worker：缓存 JS/CSS/字体 + 已访问图片
- 支持「添加到主屏幕」

### 5.2 离线策略

| 资源 | 策略 |
|------|------|
| 应用框架 | Cache First（SW 缓存） |
| 展会数据 | 联网时从 Supabase 拉取 → 缓存到本地 |
| 商品图片 | Cache First（首次加载后 SW 缓存） |
| 用户修改 | 先写本地 → 联网后同步到 Supabase |

---

## 六、多端同步

### 6.1 核心逻辑

- 每个展会有一个唯一 ID（如 `cp32`、`cpgz`）
- 电脑端和手机端通过同一个展会 ID 访问同一份数据
- 任意一端修改，另一端刷新即可看到最新数据
- 离线时操作暂存本地，联网后自动同步

### 6.2 同步方式

| 操作 | 同步行为 |
|------|---------|
| 两端加载页面 | 从 Supabase 拉取最新数据 |
| 任意端编辑保存 | 立即写入 Supabase |
| 冲突处理 | 最后写入优先（一期够用） |

---

## 七、成本

| 项目 | 用量 | 免费额度 | 费用 |
|------|------|---------|------|
| Supabase 数据库 | ~100MB | 500MB | $0 |
| Supabase 带宽 | <1GB/月 | 2GB/月 | $0 |
| 图片存储 | 0（只存 URL） | 1GB | $0 |
| Vercel 部署 | Next.js 托管 | 免费套餐 | $0 |
| **总计** | | | **$0/月** |

---

## 八、实施计划

### Phase 0：基础设施 + 小批量验证（先做这个）

> 目标：搭建 Supabase + 验证爬取方案可行性

| 任务 | 说明 |
|------|------|
| Supabase 项目创建 | 建表、配置 API Key、设置 RLS |
| 爬取脚本改造 | 按分类爬取，先只爬「漫画」+「卡片」2 个分类 |
| 数据写入 Supabase | 验证 upsert 逻辑 |
| Next.js 接入 Supabase | 基础 CRUD |
| **验证标准** | 匹配率比之前高、数据完整、无性能问题 |

### Phase 1：手机端表格适配

> 目标：手机端能正常浏览和操作

| 任务 | 说明 |
|------|------|
| 响应式表格改造 | 4 列紧凑布局，56px 行高 |
| 行展开详情面板 | 底部抽屉（大图 + 状态切换 + 备注） |
| 状态交互 | 有料/无料自动匹配状态，循环切换 |
| 搜索 + 筛选 | 搜索 + 只看未买 + 优先级排序 |
| 区域快跳 | 顶部摊位区域标签 |
| 手机端编辑 | 详情面板内可编辑所有字段 |

### Phase 2：PWA 支持

| 任务 | 说明 |
|------|------|
| manifest.json | 图标、名称、全屏启动 |
| Service Worker | 静态资源 + 图片缓存 |
| 离线支持 | 本地缓存 + 离线操作暂存 |

### Phase 3：全量数据 + 自动更新

> Phase 0 验证通过后执行

| 任务 | 说明 |
|------|------|
| 全量爬取 | 跑剩余 14 个分类 |
| 每日更新脚本 | 定时任务 + 增量 upsert |
| 多展会支持 | CP32 归档 + CP 广州上线 |

### Phase 4：部署上线

| 任务 | 说明 |
|------|------|
| Vercel 部署 | 生产环境 |
| 自定义域名（可选） | 如果有域名的话 |

---

## 九、待确认

- [ ] 以上方案是否准确？
- [ ] Phase 0 的验证标准还有要补充的吗？
- [ ] CP 广州的 CPP eventId 是否已知？还是需要等官方公布？
