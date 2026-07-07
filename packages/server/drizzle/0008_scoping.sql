-- design-v2 #36 scoping：给关键实体加 project_id（additive）
ALTER TABLE workflow_defs ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE requirement_intakes ADD COLUMN IF NOT EXISTS project_id text;
