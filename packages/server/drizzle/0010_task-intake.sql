-- 任务中心③期:projects 加 default_workflow、workflow_defs 加 archived
-- 纪律:不跑 drizzle-kit generate、不改 journal;只加列,人工 apply。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_workflow text;
ALTER TABLE workflow_defs ADD COLUMN IF NOT EXISTS archived text NOT NULL DEFAULT 'no';
ALTER TABLE workflow_defs DROP CONSTRAINT IF EXISTS workflow_defs_archived_check;
ALTER TABLE workflow_defs ADD CONSTRAINT workflow_defs_archived_check CHECK (archived IN ('yes', 'no'));
