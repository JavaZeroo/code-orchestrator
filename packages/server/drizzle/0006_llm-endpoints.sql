CREATE TABLE "llm_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_endpoints_label_unique" UNIQUE("label")
);
--> statement-breakpoint
ALTER TABLE "llm_endpoints" ADD CONSTRAINT "llm_endpoints_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
