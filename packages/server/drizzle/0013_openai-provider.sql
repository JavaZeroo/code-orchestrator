-- Codex 后端：补内置 openai provider，base_url NULL 表示不注入 Anthropic 兼容 env。
-- 模型名只作为 CLI model 透传；默认 NULL 表示使用 Codex CLI 自身默认模型。

INSERT INTO llm_providers (id, name, base_url, api_key_enc, models, default_model, created_by, created_at, updated_at)
VALUES
  ('openai', 'openai', NULL, NULL, '["gpt-5.5","gpt-5.4","gpt-5.3-codex-spark"]'::jsonb, NULL, NULL, now(), now())
ON CONFLICT DO NOTHING;
