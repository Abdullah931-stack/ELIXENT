-- Migration: 0013_migrate_to_credit_ledger.sql
-- 1. Add credit_balance_micro to users with non-negative check constraint & initialize by tier
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "credit_balance_micro" BIGINT NOT NULL DEFAULT 0;

UPDATE "users"
SET "credit_balance_micro" = CASE
  WHEN "tier" = 'ultra' THEN 3500000000
  WHEN "tier" = 'pro' THEN 1000000000
  ELSE 50000000
END
WHERE "credit_balance_micro" = 0;

DO $$ BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_credit_balance_non_negative" CHECK ("credit_balance_micro" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Create Enums for Credit Ledger
DO $$ BEGIN
  CREATE TYPE "public"."ai_execution_mode" AS ENUM (
    'SINGLE_PASS_DECISION',
    'DISCRETE_THINKING',
    'STREAMING_GENERATIVE',
    'CREDIT_TOPUP'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."ledger_settlement_status" AS ENUM (
    'SETTLED',
    'ABORTED',
    'TOPUP_APPLIED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3. Create credit_ledger_transactions table & indexes
CREATE TABLE IF NOT EXISTS "credit_ledger_transactions" (
  "operation_id" TEXT PRIMARY KEY NOT NULL,
  "user_id" UUID NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "thread_id" TEXT,
  "node_name" TEXT,
  "model_id" TEXT NOT NULL,
  "execution_mode" "public"."ai_execution_mode" NOT NULL,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
  "delta_micro" BIGINT NOT NULL,
  "status" "public"."ledger_settlement_status" NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_credit_ledger_user_created"
  ON "credit_ledger_transactions" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_credit_ledger_thread"
  ON "credit_ledger_transactions" ("thread_id");

-- 4. Create project_decision_ledger table & index
CREATE TABLE IF NOT EXISTS "project_decision_ledger" (
  "project_id" TEXT NOT NULL,
  "decision_id" TEXT NOT NULL,
  "user_id" UUID NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "topic_slug" TEXT NOT NULL,
  "question_prompt" TEXT NOT NULL,
  "concept_tags" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "selected_option_key" TEXT NOT NULL,
  "selection_rationale" TEXT NOT NULL,
  "runner_up_option_key" TEXT,
  "evaluated_alternatives" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status" TEXT NOT NULL,
  "impact_tier" TEXT NOT NULL,
  "is_load_bearing" BOOLEAN NOT NULL DEFAULT false,
  "depends_on" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "depended_by" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "affected_sections" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "project_decision_ledger_project_id_decision_id_pk"
    PRIMARY KEY ("project_id", "decision_id")
);

CREATE INDEX IF NOT EXISTS "idx_project_decision_user_project"
  ON "project_decision_ledger" ("user_id", "project_id");

-- 5. Create LangGraph PostgresSaver checkpoint tables
CREATE TABLE IF NOT EXISTS "checkpoint_migrations" (
  "v" INTEGER PRIMARY KEY NOT NULL
);

CREATE TABLE IF NOT EXISTS "checkpoints" (
  "thread_id" TEXT NOT NULL,
  "checkpoint_ns" TEXT NOT NULL DEFAULT '',
  "checkpoint_id" TEXT NOT NULL,
  "parent_checkpoint_id" TEXT,
  "type" TEXT,
  "checkpoint" JSONB NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "checkpoints_pkey"
    PRIMARY KEY ("thread_id", "checkpoint_ns", "checkpoint_id")
);

CREATE TABLE IF NOT EXISTS "checkpoint_blobs" (
  "thread_id" TEXT NOT NULL,
  "checkpoint_ns" TEXT NOT NULL DEFAULT '',
  "channel" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "blob" BYTEA,
  CONSTRAINT "checkpoint_blobs_pkey"
    PRIMARY KEY ("thread_id", "checkpoint_ns", "channel", "version")
);

CREATE TABLE IF NOT EXISTS "checkpoint_writes" (
  "thread_id" TEXT NOT NULL,
  "checkpoint_ns" TEXT NOT NULL DEFAULT '',
  "checkpoint_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "idx" INTEGER NOT NULL,
  "channel" TEXT NOT NULL,
  "type" TEXT,
  "blob" BYTEA NOT NULL,
  CONSTRAINT "checkpoint_writes_pkey"
    PRIMARY KEY ("thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "idx")
);

-- 6. Drop obsolete legacy quota tables
DROP TABLE IF EXISTS "ai_reservations" CASCADE;
DROP TABLE IF EXISTS "usage" CASCADE;
