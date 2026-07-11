-- 终态工作流运行归档：保留节点、会话、事件与 forge 引用，只从默认线程列表隐藏。additive only。
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "workflow_runs_archived_at_idx" ON "workflow_runs" ("archived_at");
