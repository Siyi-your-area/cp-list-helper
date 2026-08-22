-- CP list帮手：迁移 Base64 图片后的空间回收脚本。
-- 在 Supabase SQL Editor 中单独运行本文件，不要和 SELECT、SET、
-- begin/commit 或其他语句一起提交，否则会被包装进事务而失败。
-- 执行期间会独占锁定 wish_items，请选择低流量维护窗口。
vacuum (full, analyze) public.wish_items;
