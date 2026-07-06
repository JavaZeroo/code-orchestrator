CREATE TABLE "requirement_intakes" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_id" text NOT NULL,
	"forge" text NOT NULL,
	"repo" text NOT NULL,
	"issue_number" text NOT NULL,
	"title" text,
	"author" text,
	"issue_url" text,
	"run_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"forge" text NOT NULL,
	"repo" text NOT NULL,
	"def_id" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title_pattern" text,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"backfill" text DEFAULT 'no' NOT NULL,
	"enabled" text DEFAULT 'yes' NOT NULL,
	"created_by" text,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirement_intakes" ADD CONSTRAINT "requirement_intakes_trigger_id_requirement_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."requirement_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_triggers" ADD CONSTRAINT "requirement_triggers_def_id_workflow_defs_id_fk" FOREIGN KEY ("def_id") REFERENCES "public"."workflow_defs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "req_intake_trigger_issue_uniq" ON "requirement_intakes" USING btree ("trigger_id","issue_number");