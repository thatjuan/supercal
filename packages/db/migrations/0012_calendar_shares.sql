CREATE TYPE "public"."calendar_access" AS ENUM('free-busy', 'read', 'write', 'manage');--> statement-breakpoint
CREATE TABLE "calendar_share" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"grantee_user_id" text,
	"access" "calendar_access" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_share" ADD CONSTRAINT "calendar_share_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_share" ADD CONSTRAINT "calendar_share_calendar_id_source_calendar_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."source_calendar"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_share" ADD CONSTRAINT "calendar_share_grantee_user_id_user_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_share" ADD CONSTRAINT "calendar_share_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_share_user_unique" ON "calendar_share" USING btree ("calendar_id","grantee_user_id") WHERE "calendar_share"."grantee_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_share_tenant_unique" ON "calendar_share" USING btree ("calendar_id") WHERE "calendar_share"."grantee_user_id" is null;--> statement-breakpoint
CREATE INDEX "calendar_share_grantee_idx" ON "calendar_share" USING btree ("tenant_id","grantee_user_id");--> statement-breakpoint
-- Shares are tenant data; the request role never sees another tenant's grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_share TO supercal_app;
--> statement-breakpoint
ALTER TABLE calendar_share ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_share FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendar_share TO supercal_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
