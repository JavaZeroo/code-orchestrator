-- #61 M1：llm_providers 表（provider→model 两级模型注册表）
-- 纪律：手写、不跑 drizzle-kit generate、不改 meta/_journal.json。
-- 全部 additive（建表 + seed + 数据迁移），无 target 的 ON CONFLICT DO NOTHING 保证幂等。

CREATE TABLE IF NOT EXISTS llm_providers (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  base_url text,
  api_key_enc text,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_model text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- seed 内置三 provider
INSERT INTO llm_providers (id, name, base_url, api_key_enc, models, default_model, created_by, created_at)
VALUES
  ('anthropic', 'anthropic', NULL, NULL, '["claude-opus-4-8","claude-sonnet-5","claude-haiku-4-5"]'::jsonb, NULL, NULL, now()),
  ('deepseek', 'deepseek', 'https://api.deepseek.com/anthropic', NULL, '["deepseek-chat","deepseek-reasoner"]'::jsonb, 'deepseek-chat', NULL, now()),
  ('glm', 'glm', 'https://open.bigmodel.cn/api/anthropic', NULL, '["glm-4.6"]'::jsonb, 'glm-4.6', NULL, now())
ON CONFLICT DO NOTHING;

-- 数据迁移：llm_endpoints → llm_providers（name=label, models=[原model], default_model=原model）
INSERT INTO llm_providers (id, name, base_url, api_key_enc, models, default_model, created_by, created_at)
SELECT id, label, base_url, api_key_enc, jsonb_build_array(model), model, created_by, created_at
FROM llm_endpoints
ON CONFLICT DO NOTHING;

-- 旧表保留不删
