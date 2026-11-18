-- Migration: 0014_multi_workspace_and_native_engine.sql
-- 1. Create workspaces table & indexes
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" UUID NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "is_encrypted" BOOLEAN NOT NULL DEFAULT false,
  "default_permission_mode" VARCHAR(32) NOT NULL DEFAULT 'safe',
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_workspaces_user_name"
  ON "workspaces" ("user_id", "name");
CREATE INDEX IF NOT EXISTS "idx_workspaces_user_updated"
  ON "workspaces" ("user_id", "updated_at");

-- 2. Backfill default workspace for every distinct user_id in files
INSERT INTO "workspaces" ("id", "user_id", "name")
SELECT gen_random_uuid(), f."user_id", 'Default Workspace'
FROM (SELECT DISTINCT "user_id" FROM "files") f
ON CONFLICT ("user_id", "name") DO NOTHING;

-- 3. Add workspace & AI governance columns to files
ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "workspace_id" UUID REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS "is_ai_excluded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "artifact_role" VARCHAR(32) NOT NULL DEFAULT 'document';

-- 4. Populate files.workspace_id from Default Workspace and enforce NOT NULL
UPDATE "files" f
SET "workspace_id" = w."id"
FROM "workspaces" w
WHERE w."user_id" = f."user_id"
  AND w."name" = 'Default Workspace'
  AND f."workspace_id" IS NULL;

ALTER TABLE "files"
  ALTER COLUMN "workspace_id" SET NOT NULL;

-- 5. Swap partial unique index to workspace scope & add workspace deleted index
DROP INDEX IF EXISTS "idx_files_user_parent_title_live";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_files_workspace_parent_title_live"
  ON "files" ("workspace_id", COALESCE("parent_folder_id", '00000000-0000-0000-0000-000000000000'::uuid), "title")
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_files_workspace_deleted"
  ON "files" ("workspace_id", "deleted_at");

-- 6. Create native engine agent_checkpoints table & index
CREATE TABLE IF NOT EXISTS "agent_checkpoints" (
  "thread_id" TEXT NOT NULL,
  "step_index" INTEGER NOT NULL,
  "workspace_id" UUID NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "node_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "next_node_id" TEXT,
  "interrupt_reason" TEXT,
  "encrypted_state_blob" BYTEA NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "agent_checkpoints_thread_id_step_index_pk"
    PRIMARY KEY ("thread_id", "step_index")
);

CREATE INDEX IF NOT EXISTS "idx_agent_checkpoints_workspace_thread"
  ON "agent_checkpoints" ("workspace_id", "thread_id");

-- 7. Enable AI on encrypted files by default in user_vault_profiles
ALTER TABLE "user_vault_profiles"
  ALTER COLUMN "allow_ai_on_encrypted_files" SET DEFAULT true;
