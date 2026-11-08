CREATE TYPE "public"."sink_status" AS ENUM('active', 'calendar_missing');--> statement-breakpoint
ALTER TABLE "sink" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sink" ALTER COLUMN "status" SET DATA TYPE "public"."sink_status" USING "status"::text::"public"."sink_status";--> statement-breakpoint
ALTER TABLE "sink" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "sink" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "sink" ADD COLUMN "last_write_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sink" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sink_event" ADD COLUMN "event_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "sink" ADD CONSTRAINT "sink_publication_id_account_id_unique" UNIQUE("publication_id","account_id");