-- design-v2 M1：项目升为一等工作区 + 容器化执行 + 资源模型（全部 additive，手写直接 apply）
-- 纪律：drizzle journal 与库不同步，不跑 drizzle-kit generate；这里只加列/加表，不动存量。

-- machines：数据盘根 + 加速器清单
ALTER TABLE machines ADD COLUMN IF NOT EXISTS data_root text;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS resources jsonb NOT NULL DEFAULT '[]'::jsonb;

-- projects：薄镜像 / 加速器需求 / 组件默认版本 / memory 仓
ALTER TABLE projects ADD COLUMN IF NOT EXISTS base_image text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS accel jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS components jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS memory_repo text;

-- sessions：归属项目 + 容器 + 预留
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS container_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reservation_id text;

-- 项目物化记录（黏性调度 + 冷/热）
CREATE TABLE IF NOT EXISTS project_materializations (
  project_id text NOT NULL,
  machine_id text NOT NULL,
  base_path text NOT NULL,
  status text NOT NULL DEFAULT 'materializing',
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, machine_id)
);

-- 资源预留账本（v1 机器粒度：一机一 active）
CREATE TABLE IF NOT EXISTS resource_reservations (
  id text PRIMARY KEY,
  machine_id text NOT NULL,
  session_id text,
  kind text,
  status text NOT NULL DEFAULT 'reserved',
  acquired_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS reservations_machine_idx ON resource_reservations (machine_id);
CREATE INDEX IF NOT EXISTS reservations_status_idx ON resource_reservations (status);

-- 任务排队（没机排队、有机自动派）
CREATE TABLE IF NOT EXISTS task_queue (
  id text PRIMARY KEY,
  project_id text,
  kind text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  enqueued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_queue_status_idx ON task_queue (status);
