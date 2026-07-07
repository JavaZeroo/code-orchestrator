-- 会话列表 P2:sessions 加 title(语义化标题)
-- 纪律:不跑 drizzle-kit generate、不改 journal;只加列,人工 apply。
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title text;
