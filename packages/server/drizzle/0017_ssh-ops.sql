-- SSH 运维通道（design-machines-env A 期）。additive only。
ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "ssh_host" text;
ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "ssh_port" integer;
ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "ssh_user" text;
CREATE TABLE IF NOT EXISTS "instance_secrets" (
  "key" text PRIMARY KEY,
  "value_enc" text NOT NULL,
  "public_value" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
