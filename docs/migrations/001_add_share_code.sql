-- ============================================================
-- Migration: 添加 share_code 字段到 events 表
-- 使用方法：复制以下内容 → Supabase Dashboard → SQL Editor → Run
-- ============================================================

ALTER TABLE events ADD COLUMN IF NOT EXISTS share_code TEXT UNIQUE;

-- 为已有的展会生成分享码（可选，也可以等用户访问时自动生成）
-- 注意：以下函数需要在应用层调用 generateShareCode() 来实现
