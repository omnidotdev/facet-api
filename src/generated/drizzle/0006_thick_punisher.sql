CREATE TABLE "generation_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"prompt" text NOT NULL,
	"prior_code" text,
	"prior_error" text,
	"suggestion" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"is_paying_customer" boolean NOT NULL,
	"result_code" text,
	"error_code" text,
	"error_message" text,
	"error_status" integer,
	"worker_id" text,
	"heartbeat_at" timestamp(6) with time zone,
	"started_at" timestamp(6) with time zone,
	"finished_at" timestamp(6) with time zone,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now(),
	"updated_at" timestamp(6) with time zone DEFAULT now(),
	CONSTRAINT "generation_job_kind_check" CHECK ("generation_job"."kind" in ('draft', 'repair', 'refine')),
	CONSTRAINT "generation_job_status_check" CHECK ("generation_job"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "generation_job_user_id_created_at_index" ON "generation_job" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_job_status_created_at_index" ON "generation_job" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "generation_job_expires_at_index" ON "generation_job" USING btree ("expires_at");