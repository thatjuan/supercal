ALTER TYPE "public"."account_provider" ADD VALUE 'hosted';--> statement-breakpoint
ALTER TABLE "source_calendar" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "source_calendar" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_calendar" ADD COLUMN "sync_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_calendar" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "source_calendar" ADD COLUMN "gone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "object_name" text;