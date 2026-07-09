-- 每机接入凭证（添加机器 UI 闭环）。additive only。
ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "enroll_token" text;
