-- design-ui-ia ① 任务中心:work_items 加 project_id(additive),支撑任务树按项目过滤
-- 纪律:不跑 drizzle-kit generate、不改 journal;只加列/索引,人工 apply。
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS project_id text;
CREATE INDEX IF NOT EXISTS work_items_project_idx ON work_items (project_id);
