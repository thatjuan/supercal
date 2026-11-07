-- Roles, grants and row-level security (architecture §7). Hand-written; tables added by later
-- migrations need their own grants and, for tenant tables, the same RLS block.

-- Roles are cluster-wide, so another database may have created them already (or concurrently).
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['supercal_app', 'supercal_control'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS', role_name);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
      END;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name AND (rolsuper OR rolbypassrls)) THEN
      RAISE EXCEPTION 'role % must be NOSUPERUSER NOBYPASSRLS', role_name;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
GRANT supercal_app, supercal_control TO current_user;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO supercal_app, supercal_control;
--> statement-breakpoint

-- supercal_app: all tenant data, bound to app.tenant_id by the tenant_isolation policy.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'api_key_tenant', 'calendar_account', 'source_calendar', 'push_lease', 'source_object', 'resource',
    'graph_occurrence', 'feed', 'publication', 'publication_source', 'sink', 'sink_event', 'sync_target', 'audit_log'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO supercal_app', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format($policy$
      CREATE POLICY tenant_isolation ON %I TO supercal_app
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, table_name);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE change_seq TO supercal_app;
--> statement-breakpoint
GRANT SELECT ON system_setting TO supercal_app;
--> statement-breakpoint

-- supercal_control: work before a tenant is known. Column-limited, cross-tenant, never event data or credentials.
GRANT SELECT (id, tenant_id, kind, target_id, next_run_at, lease_until, lease_owner, lease_version, wake_generation, retry_after),
  UPDATE (next_run_at, lease_until, lease_owner, lease_version, wake_generation)
  ON sync_target TO supercal_control;
--> statement-breakpoint
CREATE POLICY control_select ON sync_target FOR SELECT TO supercal_control USING (true);
--> statement-breakpoint
CREATE POLICY control_update ON sync_target FOR UPDATE TO supercal_control USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (provider_channel_id, tenant_id, account_id, target, target_id, expires_at, secret_hash) ON push_lease TO supercal_control;
--> statement-breakpoint
CREATE POLICY control_select ON push_lease FOR SELECT TO supercal_control USING (true);
--> statement-breakpoint
GRANT SELECT (id, tenant_id, owner_user_id, caldav_username, caldav_password_hash, ics_token_hash) ON feed TO supercal_control;
--> statement-breakpoint
CREATE POLICY control_select ON feed FOR SELECT TO supercal_control USING (true);
--> statement-breakpoint
GRANT SELECT ON api_key_tenant TO supercal_control;
--> statement-breakpoint
CREATE POLICY control_select ON api_key_tenant FOR SELECT TO supercal_control USING (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", session, account, verification, organization, member, invitation, apikey TO supercal_control;
--> statement-breakpoint

INSERT INTO system_setting (key, value) VALUES ('tombstone_floor', '0') ON CONFLICT DO NOTHING;
