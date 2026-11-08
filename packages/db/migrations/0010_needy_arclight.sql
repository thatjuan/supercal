CREATE TABLE "calendar_link" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"name" text,
	"token_hash" text NOT NULL,
	"privacy" "privacy" NOT NULL,
	"uid_secret" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_link_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "calendar_link" ADD CONSTRAINT "calendar_link_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_link" ADD CONSTRAINT "calendar_link_calendar_id_source_calendar_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."source_calendar"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_link" ADD CONSTRAINT "calendar_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Hand-written below.
GRANT SELECT, INSERT, DELETE ON calendar_link TO supercal_app;
--> statement-breakpoint
GRANT UPDATE (name, expires_at, uid_secret) ON calendar_link TO supercal_app;
--> statement-breakpoint
ALTER TABLE calendar_link ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_link FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendar_link TO supercal_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT (id, tenant_id, token_hash, expires_at) ON calendar_link TO supercal_control;
--> statement-breakpoint
CREATE POLICY control_select ON calendar_link FOR SELECT TO supercal_control USING (true);
