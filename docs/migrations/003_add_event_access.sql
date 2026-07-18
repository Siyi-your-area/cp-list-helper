-- ============================================================
-- Migration: 添加设备级 list 可见关系
-- 使用方法：复制全部内容 → Supabase Dashboard → SQL Editor → Run
-- ============================================================

CREATE TABLE IF NOT EXISTS event_access (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_event_access_client_id
  ON event_access(client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_access_event_id
  ON event_access(event_id);

COMMENT ON TABLE event_access IS '设备级 list 可见关系。owner 为创建者设备，viewer 为通过邀请码加入的设备。';
COMMENT ON COLUMN event_access.client_id IS '前端 localStorage 生成的设备 ID，不是登录用户 ID。';
COMMENT ON COLUMN event_access.role IS 'owner 删除源 list；viewer 仅从当前设备移除访问关系。';
