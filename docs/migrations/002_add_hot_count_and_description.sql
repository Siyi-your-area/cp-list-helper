-- ============================================================
-- 为 wish_items 表添加热度和详情字段
-- 使用方法：复制全部内容 → Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- 添加 hot_count 字段（热度/收藏数）
ALTER TABLE wish_items
ADD COLUMN IF NOT EXISTS hot_count INTEGER DEFAULT 0;

-- 添加 description 字段（展品详情文字）
ALTER TABLE wish_items
ADD COLUMN IF NOT EXISTS description TEXT;

-- 为 hot_count 添加索引（用于按热度排序）
CREATE INDEX IF NOT EXISTS idx_wish_items_hot_count ON wish_items(event_id, hot_count DESC);

COMMENT ON COLUMN wish_items.hot_count IS '热度（收藏数），从 CPP 匹配数据同步';
COMMENT ON COLUMN wish_items.description IS '展品详情文字，从 CPP 匹配数据同步';
