-- 已结束手动会话归档：保留 transcript，只从默认会话列表隐藏。additive only。
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "sessions_archived_at_idx" ON "sessions" ("archived_at");
