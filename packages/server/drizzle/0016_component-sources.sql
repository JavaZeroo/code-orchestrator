-- 组件源登记表 + 机器组件缓存（design-machines-env B1）。additive only。
CREATE TABLE IF NOT EXISTS "component_sources" (
  "id" text PRIMARY KEY,
  "component" text NOT NULL,
  "version" text NOT NULL,
  "url" text NOT NULL,
  "sha256" text,
  "created_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "component_sources_comp_ver" ON "component_sources" ("component", "version");
ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "component_cache" jsonb NOT NULL DEFAULT '{}';
