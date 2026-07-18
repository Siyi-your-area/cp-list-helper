-- ============================================================
-- Maintenance: 将迁移前已存在的 list 绑定到当前设备
-- 使用场景：
--   执行 003_add_event_access.sql 后，旧 list 没有 owner 关系，会从首页消失。
--   复制浏览器 localStorage 里的 cp_list_client_id，替换下面的 YOUR_CLIENT_ID_HERE 后运行。
--
-- 使用方法：
--   1. 在已打开项目的浏览器 Console 运行：
--      localStorage.getItem("cp_list_client_id")
--   2. 复制输出值。
--   3. 替换本文件中的 YOUR_CLIENT_ID_HERE。
--   4. Supabase Dashboard → SQL Editor → Run。
-- ============================================================

INSERT INTO event_access (event_id, client_id, role)
SELECT id, 'YOUR_CLIENT_ID_HERE', 'owner'
FROM events
ON CONFLICT (event_id, client_id) DO UPDATE
SET role = 'owner';
