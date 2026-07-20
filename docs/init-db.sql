-- ============================================================
-- CP list帮手 — 数据库初始化脚本
-- 使用方法：复制全部内容 → Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- 1. 展会表
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  days JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'active',
  cpp_event_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. CPP 展品表（爬取数据）
CREATE TABLE IF NOT EXISTS cpp_items (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  day_id TEXT NOT NULL,
  type_id INT NOT NULL,
  type_name TEXT,
  doujinshi_id BIGINT NOT NULL,
  product_name TEXT NOT NULL,
  author TEXT,
  booth_number TEXT,
  booth_name TEXT,
  image_url TEXT,
  tags JSONB DEFAULT '[]'::jsonb,
  source_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, day_id, doujinshi_id)
);

-- 3. 用户心愿单
CREATE TABLE IF NOT EXISTS wish_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL,
  cpp_item_id BIGINT,
  booth_number TEXT NOT NULL,
  product_name TEXT NOT NULL,
  author TEXT,
  image_url TEXT,
  item_type TEXT DEFAULT 'paid',
  status TEXT DEFAULT 'pending',
  priority TEXT,
  note TEXT,
  price NUMERIC,
  quantity INT DEFAULT 1,
  purchase_limit INT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_cpp_items_event ON cpp_items(event_id, day_id);
CREATE INDEX IF NOT EXISTS idx_cpp_items_booth ON cpp_items(event_id, booth_number);
CREATE INDEX IF NOT EXISTS idx_cpp_items_type ON cpp_items(event_id, type_id);
CREATE INDEX IF NOT EXISTS idx_wish_items_event ON wish_items(event_id);

-- updated_at 自动更新触发器
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wish_items_updated_at
  BEFORE UPDATE ON wish_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- 插入预设展会
INSERT INTO events (id, name, days, cpp_event_id) VALUES
  ('cp32', 'COMICUP 32', '[{"id":"7040","name":"一期"},{"id":"7042","name":"二期"}]', '6377')
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (id, name, days, cpp_event_id) VALUES
  ('cpgz', 'CP 广州', '[{"id":"7073","name":"展会"}]', '7073')
ON CONFLICT (id) DO NOTHING;
