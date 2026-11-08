CREATE TABLE "oauth_flow" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" "account_provider" NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_lease" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_flow" ADD CONSTRAINT "oauth_flow_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flow" ADD CONSTRAINT "oauth_flow_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Hand-written below. Pending OAuth flows are tenant data like any other.
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_flow TO supercal_app;
--> statement-breakpoint
ALTER TABLE oauth_flow ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_flow FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON oauth_flow TO supercal_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
