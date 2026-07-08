-- 定时触发器（grill 2026-07-08：每日冒烟等场景）。additive only。
ALTER TABLE "requirement_triggers" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'issue';
ALTER TABLE "requirement_triggers" ADD COLUMN IF NOT EXISTS "schedule" text;
