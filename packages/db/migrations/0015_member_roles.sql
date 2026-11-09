-- REST role changes lock and address members by Better Auth's member id.
GRANT SELECT (id), UPDATE (role) ON member TO supercal_app;
--> statement-breakpoint
CREATE POLICY tenant_members_update ON member FOR UPDATE TO supercal_app
  USING (organization_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.tenant_id', true), ''));
