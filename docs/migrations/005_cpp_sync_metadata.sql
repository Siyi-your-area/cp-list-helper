-- CPP 可重复增量同步所需元数据与查询索引

ALTER TABLE cpp_items
  ADD COLUMN IF NOT EXISTS normalized_booth TEXT,
  ADD COLUMN IF NOT EXISTS normalized_product TEXT,
  ADD COLUMN IF NOT EXISTS normalized_author TEXT,
  ADD COLUMN IF NOT EXISTS booth_aliases TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS product_aliases TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS crawl_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cpp_items_normalized_booth
  ON cpp_items(event_id, day_id, normalized_booth);

CREATE INDEX IF NOT EXISTS idx_cpp_items_normalized_product
  ON cpp_items(event_id, day_id, normalized_product);

CREATE INDEX IF NOT EXISTS idx_cpp_items_source_hash
  ON cpp_items(event_id, day_id, source_hash);

CREATE INDEX IF NOT EXISTS idx_cpp_items_booth_aliases
  ON cpp_items USING GIN(booth_aliases);

COMMENT ON COLUMN cpp_items.source_hash IS 'CPP 源字段的 SHA-256，用于增量同步跳过未变化记录';
COMMENT ON COLUMN cpp_items.crawl_run_id IS '最后一次写入该记录的同步运行 ID';
