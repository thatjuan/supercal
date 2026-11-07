CREATE TYPE "public"."account_provider" AS ENUM('google', 'microsoft', 'icloud', 'caldav', 'ics');--> statement-breakpoint
CREATE TYPE "public"."calendar_state" AS ENUM('active', 'gone');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'reauth_required', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."push_target" AS ENUM('account', 'calendar', 'calendar-list');--> statement-breakpoint
CREATE TYPE "public"."completeness" AS ENUM('complete', 'incomplete');--> statement-breakpoint
CREATE TYPE "public"."source_format" AS ENUM('ical', 'google', 'graph');--> statement-breakpoint
CREATE TYPE "public"."privacy" AS ENUM('full', 'title-only', 'busy-only');--> statement-breakpoint
CREATE TYPE "public"."publication_kind" AS ENUM('passthrough', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."sync_kind" AS ENUM('discover', 'events', 'push_renew', 'sink');--> statement-breakpoint
CREATE SEQUENCE "public"."change_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_tenant" (
	"api_key_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_account" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"provider" "account_provider" NOT NULL,
	"display_name" text NOT NULL,
	"provider_subject" text,
	"email" text,
	"server_url" text,
	"credentials" text,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"status_detail" text,
	"auto_publish" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_lease" (
	"provider_channel_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"target" "push_target" NOT NULL,
	"target_id" text NOT NULL,
	"provider_resource_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"secret_hash" text NOT NULL,
	"provider_state" jsonb
);
--> statement-breakpoint
CREATE TABLE "source_calendar" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_calendar_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"timezone" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "calendar_state" DEFAULT 'active' NOT NULL,
	"freshness" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "source_calendar_account_id_provider_calendar_id_unique" UNIQUE("account_id","provider_calendar_id")
);
--> statement-breakpoint
CREATE TABLE "graph_occurrence" (
	"tenant_id" text NOT NULL,
	"source_calendar_id" text NOT NULL,
	"master_id" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"original_start" text NOT NULL,
	CONSTRAINT "graph_occurrence_source_calendar_id_master_id_occurrence_id_pk" PRIMARY KEY("source_calendar_id","master_id","occurrence_id")
);
--> statement-breakpoint
CREATE TABLE "resource" (
	"tenant_id" text NOT NULL,
	"source_calendar_id" text NOT NULL,
	"uid" text NOT NULL,
	"data" jsonb NOT NULL,
	"revision" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"last_modified" timestamp with time zone,
	"organizer" text,
	"span" "tstzrange",
	"completeness" "completeness" DEFAULT 'complete' NOT NULL,
	"completeness_reason" text,
	"deleted" boolean DEFAULT false NOT NULL,
	"seq" bigint NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_source_calendar_id_uid_pk" PRIMARY KEY("source_calendar_id","uid")
);
--> statement-breakpoint
CREATE TABLE "source_object" (
	"tenant_id" text NOT NULL,
	"source_calendar_id" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"format" "source_format" NOT NULL,
	"payload" text NOT NULL,
	"etag" text,
	"group_uid" text NOT NULL,
	"original_start" text,
	"seen_generation" bigint DEFAULT 0 NOT NULL,
	"dirty" boolean DEFAULT true NOT NULL,
	"normalizer_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "source_object_source_calendar_id_provider_object_id_pk" PRIMARY KEY("source_calendar_id","provider_object_id")
);
--> statement-breakpoint
CREATE TABLE "feed" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"caldav_username" text NOT NULL,
	"caldav_password_hash" text,
	"ics_token_hash" text,
	"uid_secret" text NOT NULL,
	CONSTRAINT "feed_caldav_username_unique" UNIQUE("caldav_username"),
	CONSTRAINT "feed_ics_token_hash_unique" UNIQUE("ics_token_hash")
);
--> statement-breakpoint
CREATE TABLE "publication" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"feed_id" text NOT NULL,
	"kind" "publication_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"privacy" "privacy" DEFAULT 'full' NOT NULL,
	"filters" jsonb DEFAULT '{"hideDeclined":false,"hideCancelled":false,"hideAllDay":false}'::jsonb NOT NULL,
	"keep_alarms" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"config_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_source" (
	"tenant_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"source_calendar_id" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "publication_source_publication_id_source_calendar_id_pk" PRIMARY KEY("publication_id","source_calendar_id")
);
--> statement-breakpoint
CREATE TABLE "sink" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider" "account_provider" NOT NULL,
	"provider_subject" text,
	"provider_calendar_id" text NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sink_event" (
	"tenant_id" text NOT NULL,
	"sink_id" text NOT NULL,
	"uid" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"applied_revision" text NOT NULL,
	CONSTRAINT "sink_event_sink_id_uid_pk" PRIMARY KEY("sink_id","uid")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_target" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "sync_kind" NOT NULL,
	"target_id" text NOT NULL,
	"cursor" jsonb,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_owner" text,
	"lease_version" bigint DEFAULT 0 NOT NULL,
	"wake_generation" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"retry_after" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	CONSTRAINT "sync_target_kind_target_id_unique" UNIQUE("kind","target_id")
);
--> statement-breakpoint
CREATE TABLE "system_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_tenant" ADD CONSTRAINT "api_key_tenant_api_key_id_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_tenant" ADD CONSTRAINT "api_key_tenant_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_tenant" ADD CONSTRAINT "api_key_tenant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_account" ADD CONSTRAINT "calendar_account_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_account" ADD CONSTRAINT "calendar_account_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lease" ADD CONSTRAINT "push_lease_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lease" ADD CONSTRAINT "push_lease_account_id_calendar_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."calendar_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_calendar" ADD CONSTRAINT "source_calendar_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_calendar" ADD CONSTRAINT "source_calendar_account_id_calendar_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."calendar_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_occurrence" ADD CONSTRAINT "graph_occurrence_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_occurrence" ADD CONSTRAINT "graph_occurrence_source_calendar_id_source_calendar_id_fk" FOREIGN KEY ("source_calendar_id") REFERENCES "public"."source_calendar"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_source_calendar_id_source_calendar_id_fk" FOREIGN KEY ("source_calendar_id") REFERENCES "public"."source_calendar"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_object" ADD CONSTRAINT "source_object_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_object" ADD CONSTRAINT "source_object_source_calendar_id_source_calendar_id_fk" FOREIGN KEY ("source_calendar_id") REFERENCES "public"."source_calendar"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed" ADD CONSTRAINT "feed_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed" ADD CONSTRAINT "feed_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_feed_id_feed_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_source" ADD CONSTRAINT "publication_source_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_source" ADD CONSTRAINT "publication_source_publication_id_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publication"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_source" ADD CONSTRAINT "publication_source_source_calendar_id_source_calendar_id_fk" FOREIGN KEY ("source_calendar_id") REFERENCES "public"."source_calendar"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sink" ADD CONSTRAINT "sink_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sink" ADD CONSTRAINT "sink_publication_id_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publication"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sink" ADD CONSTRAINT "sink_account_id_calendar_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."calendar_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sink_event" ADD CONSTRAINT "sink_event_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sink_event" ADD CONSTRAINT "sink_event_sink_id_sink_id_fk" FOREIGN KEY ("sink_id") REFERENCES "public"."sink"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_target" ADD CONSTRAINT "sync_target_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "resource_seq_idx" ON "resource" USING btree ("source_calendar_id","seq");--> statement-breakpoint
CREATE INDEX "resource_span_idx" ON "resource" USING gist ("span");--> statement-breakpoint
CREATE INDEX "source_object_group_idx" ON "source_object" USING btree ("source_calendar_id","group_uid");--> statement-breakpoint
CREATE INDEX "source_object_dirty_idx" ON "source_object" USING btree ("source_calendar_id") WHERE "source_object"."dirty";--> statement-breakpoint
CREATE INDEX "sync_target_next_run_idx" ON "sync_target" USING btree ("next_run_at");