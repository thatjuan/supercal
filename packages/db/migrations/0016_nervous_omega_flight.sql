CREATE TABLE "dav_object_name" (
	"tenant_id" text NOT NULL,
	"source_calendar_id" text NOT NULL,
	"uid" text NOT NULL,
	"object_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dav_object_name_source_calendar_id_uid_pk" PRIMARY KEY("source_calendar_id","uid"),
	CONSTRAINT "dav_object_name_source_calendar_id_object_name_unique" UNIQUE("source_calendar_id","object_name")
);
--> statement-breakpoint
ALTER TABLE "source_calendar" ALTER COLUMN "capabilities" SET DEFAULT '{"incremental":"snapshot","push":false,"write":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "dav_object_name" ADD CONSTRAINT "dav_object_name_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dav_object_name" ADD CONSTRAINT "dav_object_name_source_calendar_id_source_calendar_id_fk" FOREIGN KEY ("source_calendar_id") REFERENCES "public"."source_calendar"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON dav_object_name TO supercal_app;
--> statement-breakpoint
ALTER TABLE dav_object_name ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dav_object_name FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON dav_object_name TO supercal_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
