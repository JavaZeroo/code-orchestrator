-- 单次工作流运行标题：允许运营者区分同一模板的多次运行，不改共享 definition。additive only。
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "title" text;
