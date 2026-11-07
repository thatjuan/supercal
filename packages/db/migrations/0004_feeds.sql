CREATE TYPE "public"."publication_status" AS ENUM('ok', 'disabled-invalid');--> statement-breakpoint
ALTER TABLE "feed" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "status" "publication_status" DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "status_detail" text;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_default_unique" ON "feed" USING btree ("tenant_id","owner_user_id") WHERE is_default;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_feed_id_slug_unique" UNIQUE("feed_id","slug");--> statement-breakpoint

-- Hand-written below. Tenant transactions may read the current tenant's members and their users'
-- names and emails (feed credentials derive from the owner's handle; CalDAV serves their address).
-- Once RLS is on, supercal_control (Better Auth) needs its own policies to keep full access.
GRANT SELECT (organization_id, user_id, role) ON member TO supercal_app;
--> statement-breakpoint
ALTER TABLE member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_members ON member FOR SELECT TO supercal_app
  USING (organization_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY control_all ON member TO supercal_control USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (id, name, email) ON "user" TO supercal_app;
--> statement-breakpoint
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_users ON "user" FOR SELECT TO supercal_app
  USING (EXISTS (SELECT 1 FROM member WHERE member.user_id = "user".id));
--> statement-breakpoint
CREATE POLICY control_all ON "user" TO supercal_control USING (true) WITH CHECK (true);
