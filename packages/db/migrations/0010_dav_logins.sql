CREATE TABLE "dav_login" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dav_login_username_unique" UNIQUE("username"),
	CONSTRAINT "dav_login_username" CHECK ("dav_login"."username" ~ '^[a-z0-9-]+$')
);
--> statement-breakpoint
ALTER TABLE "dav_login" ADD CONSTRAINT "dav_login_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dav_login" ADD CONSTRAINT "dav_login_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Hand-written below.
GRANT SELECT, INSERT, UPDATE, DELETE ON dav_login TO supercal_app;
--> statement-breakpoint
ALTER TABLE dav_login ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dav_login FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON dav_login TO supercal_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
GRANT SELECT (id, tenant_id, user_id, username, password_hash) ON dav_login TO supercal_control;
--> statement-breakpoint
CREATE POLICY control_select ON dav_login FOR SELECT TO supercal_control USING (true);
