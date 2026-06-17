# CP展会List帮手

同人展会心愿单管理工具，帮助参展者高效管理心愿单、记录购买情况。

## 功能特性

- ✅ 上传CPP心愿单Excel，自动解析展品信息
- ✅ 导入CPP展品数据JSON，自动匹配填充图片
- ✅ 可编辑表格，支持所有字段修改
- ✅ 筛选排序（按摊位号、状态、类型、价格）
- ✅ 搜索功能（模糊匹配摊位号/制品名）
- ✅ 购买记录（实付金额、数量、备注）
- ✅ 导出Excel
- ✅ 响应式设计，支持手机端

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

### 构建生产版本

```bash
npm run build
npm start
```

## 使用流程

1. **创建展会**：输入展会名称、场馆、日期
2. **导入展品数据**：上传CPP展品数据JSON（可选，用于自动匹配图片）
3. **上传心愿单**：上传CPP导出的Excel文件
4. **编辑完善**：补充价格、开摊时间、备注等信息
5. **展会中记录**：搜索摊位、记录购买情况
6. **导出备份**：下载Excel文件

## 数据格式

### CPP展品数据JSON格式

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

## 技术栈

- Next.js 14
- React 18
- TypeScript
- Ant Design
- Tailwind CSS
- SheetJS (xlsx)

## 部署

### Vercel 部署

```bash
npm i -g vercel
vercel --prod
```

## 开发计划

- [ ] 爬虫脚本完善（自动爬取CPP数据）
- [ ] 场馆地图功能
- [ ] 路径规划推荐
- [ ] 云同步/账号体系

## License

MIT
