-- 操作员可持久置顶顶层会话或工作流运行；时间戳同时保留置顶先后。additive only。
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "pinned_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "sessions_pinned_at_idx" ON "sessions" ("pinned_at");

ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "pinned_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "workflow_runs_pinned_at_idx" ON "workflow_runs" ("pinned_at");
