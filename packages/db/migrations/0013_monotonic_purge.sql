-- Purge must see live rows' metadata (seq, changed_at, source_calendar_id) to keep
-- each calendar's newest row; column grants still exclude all event data.
GRANT SELECT (source_calendar_id) ON resource TO supercal_control;
--> statement-breakpoint
ALTER POLICY control_select ON resource TO supercal_control USING (true);
