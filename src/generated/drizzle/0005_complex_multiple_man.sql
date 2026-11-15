CREATE TABLE "generation_sample" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" text NOT NULL,
	"identity_provider_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"code" text NOT NULL,
	"model" text,
	"created_at" timestamp(6) with time zone DEFAULT now(),
	"updated_at" timestamp(6) with time zone DEFAULT now(),
	CONSTRAINT "generation_sample_generationId_unique" UNIQUE("generation_id")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ai_training_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ai_training_consent_at" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ai_training_consent_version" text;--> statement-breakpoint
CREATE INDEX "generation_sample_identity_provider_id_index" ON "generation_sample" USING btree ("identity_provider_id");