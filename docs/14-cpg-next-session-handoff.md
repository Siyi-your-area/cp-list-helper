# CPG08 下一会话交接

## 已上线

- CPG08 数据已写入生产 `cpp_items`，内部范围为 `event_id=cpg08`、`day_id=7829`。
- CPP 心愿单导入支持分批匹配、进度提示、导入后直接进入 list，以及空摊位名称匹配。
- CPG 同步脚本支持新增制品和已有制品字段更新；GitHub Actions 每两日执行一次，也支持人工触发。
- list 页面提供“拉取 CPP 最新数据”，仅将最新摊位号与热度同步到当前 list；CPP 空摊位不清除原值。
- 生产数据库迁移 014 已执行，生产网页版本已部署。

## 当前数据规则

- CPP 来源活动 `7073`，当前唯一 day 为 `7829`，实际类目和数量从 CPP 响应读取。
- 身份键为 `event_id + day_id + doujinshi_id`；来源暂时缺失的旧记录不删除。
- 新制品插入；已有制品按 `AGENTS.md` 中的字段有效性规则更新。
- list 条目通过 `wish_items.cpp_item_id = cpp_items.doujinshi_id` 拉取最新摊位号和热度。

## 仍需关注

- GitHub Actions 运行依赖仓库 Secrets：`CPP_COOKIE_JSON`、`SUPABASE_URL`、`SUPABASE_CPP_SYNC_KEY`。
- CPP Cookie 失效时定时同步会失败，需要人工更新 Secret。
- 摊位公布后可人工触发一次 CPG 同步，再在需要的 list 内执行“拉取 CPP 最新数据”。
- 不降低自动匹配阈值换取召回；匹配质量与数据完整性分别验收。
