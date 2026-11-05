CREATE TABLE "daily_spend" (
	"day" text PRIMARY KEY NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now()
);
