ALTER TABLE "resource" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint

-- Tombstone purge (changes.ts `purgeTombstones`) runs as supercal_control across tenants. It sees
-- only tombstones, which hold no event data, and only the columns the purge needs.
GRANT SELECT (deleted, seq, changed_at), DELETE ON resource TO supercal_control;
--> statement-breakpoint
CREATE POLICY control_select ON resource FOR SELECT TO supercal_control USING (deleted);
--> statement-breakpoint
CREATE POLICY control_delete ON resource FOR DELETE TO supercal_control USING (deleted);
--> statement-breakpoint
GRANT SELECT, UPDATE ON system_setting TO supercal_control;
