-- Lets a tenant transaction read and rename its own organization row, so `PATCH /api/v1/tenant` and
-- its audit entry commit together in `withTenant`. Once RLS is on, supercal_control (Better Auth,
-- operator endpoints) needs its own policy to keep seeing every organization.
GRANT SELECT (id, name, slug), UPDATE (name, slug) ON organization TO supercal_app;
--> statement-breakpoint
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_self ON organization TO supercal_app
  USING (id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY control_all ON organization TO supercal_control USING (true) WITH CHECK (true);
