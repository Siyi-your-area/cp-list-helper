# CP展会List帮手 - 部署指南

**文档版本**：v1  
**创建日期**：2026-07-05  
**文档维护人**：Siyi

---

## 一、部署环境

| 项目 | 信息 |
|------|------|
| 平台 | Vercel |
| 线上地址 | https://cp-list-helper.vercel.app |
| 源码仓库 | https://github.com/Siyi-your-area/cp-list-helper |
| 部署分支 | main |
| 触发方式 | push 到 main 自动部署 |

---

## 二、本地开发

```bash
# 1. 克隆仓库
git clone git@github.com:Siyi-your-area/cp-list-helper.git
cd cp-list-helper

# 2. 安装依赖（需要 legacy-peer-deps）
npm install

# 3. 启动开发服务器
npm run dev

# 4. 访问 http://localhost:3000
```

---

## 三、部署流程

### 自动部署（推荐）

1. 修改代码
2. `git add && git commit && git push`
3. Vercel 自动检测 push → 构建 → 部署（约 1-2 分钟）
4. 刷新页面验证

### 手动部署

```bash
npm i -g vercel
vercel --prod
```

---

## 四、构建注意事项

### 已知问题与解决方案

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| npm install 失败 | peer dependency 版本冲突 | `.npmrc` 设置 `legacy-peer-deps=true` |
| Puppeteer 构建超时 | Puppeteer 体积大，Vercel 限制 | 已移至 devDependencies |
| 数据文件过大 | CP32 数据约 7.4MB | 按摊位拆分，API 按需加载 |

### 关键配置文件

- **`.npmrc`**：`legacy-peer-deps=true`（必须，否则构建失败）
- **`.vercelignore`**：排除不需要的文件
- **`package.json` scripts**：`build:cf` 支持 Cloudflare 部署（备用方案）

---

## 五、CPP 数据更新流程

当新展会数据需要更新时：

```bash
# 1. 登录 CPP 获取 cookie
node scripts/login-cpp.mjs

# 2. 运行爬虫
node scripts/crawl-cpp.mjs --event=cp33 --output=./data/cpp-data/cp33-total.json

# 3. 预处理数据
npm run prepare:cpp

# 4. 提交并推送
git add public/cpp/
git commit -m "feat: add CP33 data"
git push
```

---

## 六、备用部署方案（Cloudflare Pages）

```bash
npm run deploy:cf
```

此方案使用 `@cloudflare/next-on-pages` 将 Next.js 应用部署到 Cloudflare Pages，作为 Vercel 的备用方案。
