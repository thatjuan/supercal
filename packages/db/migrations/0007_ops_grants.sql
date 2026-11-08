-- Ops endpoints (architecture §12). Hand-written. `/readyz` compares the newest applied migration
-- with the embedded ones as supercal_control, which may read the migrator's journal for that.
GRANT USAGE ON SCHEMA drizzle TO supercal_control;
--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO supercal_control;
