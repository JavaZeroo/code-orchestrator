CREATE TABLE "forge_tokens" (
	"user_id" text NOT NULL,
	"forge" text NOT NULL,
	"token_enc" text NOT NULL,
	"login" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_tokens_user_id_forge_pk" PRIMARY KEY("user_id","forge")
);
--> statement-breakpoint
ALTER TABLE "forge_refs" ADD COLUMN "forge" text DEFAULT 'gitcode' NOT NULL;--> statement-breakpoint
ALTER TABLE "forge_tokens" ADD CONSTRAINT "forge_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;