ALTER TYPE "public"."sync_kind" ADD VALUE 'maintenance';--> statement-breakpoint
ALTER TABLE "source_calendar" ALTER COLUMN "capabilities" SET DEFAULT '{"incremental":"snapshot","push":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "source_calendar" ALTER COLUMN "freshness" SET DEFAULT '{"lastSuccessAt":null,"lastChangeAt":null,"pushActive":false,"expectedLatencyMs":null,"stale":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "sync_target" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_account" ADD COLUMN "sync_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_account" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- Hand-written below. The scheduler claims, renews and completes jobs as supercal_control across
-- tenants, and registers the tenantless maintenance jobs. It still never sees cursors or credentials.
GRANT SELECT (attempts), UPDATE (attempts, last_error, retry_after, last_success_at) ON sync_target TO supercal_control;
--> statement-breakpoint
GRANT INSERT (id, kind, target_id, next_run_at) ON sync_target TO supercal_control;
--> statement-breakpoint
-- `kind::text`: the new enum value cannot be named as a literal in the transaction that adds it.
CREATE POLICY control_insert ON sync_target FOR INSERT TO supercal_control WITH CHECK (tenant_id IS NULL AND kind::text = 'maintenance');
