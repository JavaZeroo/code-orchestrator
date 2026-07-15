-- P0 authorization hardening: instance roles + project membership.
-- Additive only; existing project creators become owners, earliest user bootstraps admin.

BEGIN;

CREATE TABLE IF NOT EXISTS "user_roles" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member' CHECK ("role" IN ('admin', 'member')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "user_roles" ("user_id", "role")
SELECT u."id",
       CASE WHEN u."id" = (
         SELECT first_user."id" FROM "user" first_user
         ORDER BY first_user."created_at" ASC, first_user."id" ASC LIMIT 1
       ) THEN 'admin' ELSE 'member' END
FROM "user" u
ON CONFLICT ("user_id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "project_members" (
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'viewer' CHECK ("role" IN ('owner', 'editor', 'viewer')),
  "added_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("project_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "project_members_user_idx" ON "project_members" ("user_id");

-- 旧版允许 project.created_by 为空；将无主项目安全归给 bootstrap admin，确保每个项目都有 owner。
UPDATE "projects" p
SET "created_by" = (
  SELECT u."id" FROM "user" u
  ORDER BY u."created_at" ASC, u."id" ASC LIMIT 1
)
WHERE p."created_by" IS NULL;

INSERT INTO "project_members" ("project_id", "user_id", "role", "added_by")
SELECT p."id", p."created_by", 'owner', p."created_by"
FROM "projects" p
JOIN "user" u ON u."id" = p."created_by"
WHERE p."created_by" IS NOT NULL
ON CONFLICT ("project_id", "user_id") DO NOTHING;

ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "created_by" text;

UPDATE "workflow_runs" wr
SET "created_by" = COALESCE(
  (SELECT wd."created_by" FROM "workflow_defs" wd WHERE wd."id" = wr."def_id"),
  (SELECT p."created_by" FROM "projects" p WHERE p."id" = wr."project_id")
)
WHERE wr."created_by" IS NULL;

UPDATE "sessions" s
SET "project_id" = wr."project_id"
FROM "workflow_runs" wr
WHERE s."run_id" = wr."id"
  AND s."project_id" IS NULL
  AND wr."project_id" IS NOT NULL;

UPDATE "sessions" s
SET "created_by" = wr."created_by"
FROM "workflow_runs" wr
WHERE s."run_id" = wr."id"
  AND s."created_by" IS NULL
  AND wr."created_by" IS NOT NULL;

COMMIT;
