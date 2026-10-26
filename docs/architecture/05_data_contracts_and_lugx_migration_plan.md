# 05. Data Contracts & LUGX Migration Plan

| Standard Field | Approved Value |
| :--- | :--- |
| **Document ID** | `ELIXENT-ARCH-05` |
| **Classification** | `LIVING DATA CONTRACT & EXECUTION PLAN` (`src/server/db/schema/*`, `src/server/db/migrations/*`, `src/**`) |
| **Version & Status** | `v3.2 (v3.0) — Accepted` |
| **SSOT Scope** | Defines the new and migrated `PostgreSQL (Drizzle ORM)` table schemas, the `getPgPool()` export for `PostgresSaver`, the `Upstash Redis` keyspace and atomic `Lua` script contracts, the complete `LUGX v1.46.3` codebase transformation matrix with exact repository paths, and the phased implementation roadmap. |
| **Suite Index** | • [01_architecture_vision_and_adrs](./01_architecture_vision_and_adrs.md)<br>• [02_agent_orchestration_and_decision_engine](./02_agent_orchestration_and_decision_engine.md)<br>• [03_workspace_ast_editor_and_vault_integration](./03_workspace_ast_editor_and_vault_integration.md)<br>• [04_credit_metering_and_settlement_architecture](./04_credit_metering_and_settlement_architecture.md) |

## 1. Relational Database Schema Specification (`PostgreSQL Drizzle ORM Contracts`)

Current schema files in the `LUGX v1.46.3` repository reside under `src/server/db/schema/` (`index.ts`, `users.ts`, `files.ts`, `subscriptions.ts`, `subscription-events.ts`, `usage.ts`, `ai-reservations.ts`, `vault.ts`), and SQL migration files reside under `src/server/db/migrations/` (per `drizzle.config.ts:10`), where existing migrations currently reach `0012_add_paused_to_subscription_status.sql`.

### 1.1. Users Table Modification (`src/server/db/schema/users.ts`)

While strictly preserving the `uuid("id").primaryKey()` primary key structure linked to `Supabase Auth`, all foreign key relationships in the `files`, `subscriptions`, `subscription_events`, and `user_vault_profiles` tables, and all existing columns (`displayName`, `avatarUrl`, `tier`, `stripeCustomerId`), the authoritative financial balance column measured in Micro-Credits (`creditBalanceMicro`) is added alongside a non-negativity check constraint (`CHECK (credit_balance_micro >= 0)`):

```typescript
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  pgEnum,
  bigint,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enums
export const tierEnum = pgEnum("tier", ["free", "pro", "ultra"]);

// Users table - linked to Supabase Auth via UUID
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(), // From Supabase Auth
    email: varchar("email", { length: 255 }).notNull().unique(),
    displayName: varchar("display_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    tier: tierEnum("tier").notNull().default("free"),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    creditBalanceMicro: bigint("credit_balance_micro", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // LUGX-141: Fast customer lookup on Stripe webhooks
    index("idx_users_stripe_customer_id").on(table.stripeCustomerId),
    check(
      "users_credit_balance_non_negative",
      sql`${table.creditBalanceMicro} >= 0`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

### 1.2. Financial Credit Ledger Table (`src/server/db/schema/credit-ledger.ts`)

This table replaces the legacy `usage` (`src/server/db/schema/usage.ts`) and `ai_reservations` (`src/server/db/schema/ai-reservations.ts`) tables, both of which are dropped in migration `src/server/db/migrations/0013_migrate_to_credit_ledger.sql` (defining `userId` as `uuid` to match `users.id`):

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const executionModeEnum = pgEnum("ai_execution_mode", [
  "SINGLE_PASS_DECISION",
  "DISCRETE_THINKING",
  "STREAMING_GENERATIVE",
  "CREDIT_TOPUP",
]);

export const ledgerSettlementStatusEnum = pgEnum("ledger_settlement_status", [
  "SETTLED",
  "ABORTED",
  "TOPUP_APPLIED",
]);

export const creditLedgerTransactions = pgTable(
  "credit_ledger_transactions",
  {
    operationId: text("operation_id").primaryKey(), // StepKey or Stripe top-up ID for idempotency (Idempotency PK)
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
    nodeName: text("node_name"),
    modelId: text("model_id").notNull(),
    executionMode: executionModeEnum("execution_mode").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    deltaMicro: bigint("delta_micro", { mode: "bigint" }).notNull(), // Negative for debit, positive for credit top-up
    status: ledgerSettlementStatusEnum("status").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_credit_ledger_user_created").on(table.userId, table.createdAt),
    index("idx_credit_ledger_thread").on(table.threadId),
  ],
);

export type CreditLedgerTransaction =
  typeof creditLedgerTransactions.$inferSelect;
export type NewCreditLedgerTransaction =
  typeof creditLedgerTransactions.$inferInsert;
```

### 1.3. Cross-Session Project Decision Ledger Table (`src/server/db/schema/project-decision-ledger.ts`)

This table persists the Justification-Driven Assumption-Based Truth Maintenance System directed acyclic graph (`Justification-Driven ATMS DAG`), including the decision prompt, the selected option and its rationale (`selectionRationale`), all evaluated alternatives and their contextual rejection reasons (`evaluatedAlternatives`), standardized concept tags imported from code constants (`conceptTags`), and dependency links (`dependsOn` and `dependedBy`) scoped at the project level (`projectId`) so they remain available across all `thread_id` sessions:

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export interface EvaluatedAlternativeRecord {
  optionKey: string;
  neutralSummary: string;
  rationaleAndPremises: string;
  normalizedProbability?: number;
}

export const projectDecisionLedger = pgTable(
  "project_decision_ledger",
  {
    projectId: text("project_id").notNull(),
    decisionId: text("decision_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    topicSlug: text("topic_slug").notNull(),
    questionPrompt: text("question_prompt").notNull(),
    // Concept tags strictly constrained to imports from the hardcoded taxonomy dictionary (PREDEFINED_CONCEPT_TAGS)
    conceptTags: jsonb("concept_tags").$type<string[]>().notNull().default([]),
    selectedOptionKey: text("selected_option_key").notNull(),
    selectionRationale: text("selection_rationale").notNull(),
    runnerUpOptionKey: text("runner_up_option_key"),
    // All alternatives evaluated at decision time along with their rationales and provisional rejection reasons for re-evaluation if premises change
    evaluatedAlternatives: jsonb("evaluated_alternatives")
      .$type<EvaluatedAlternativeRecord[]>()
      .notNull()
      .default([]),
    status: text("status")
      .$type<"APPROVED_DIRECT" | "APPROVED_CONSERVATIVE">()
      .notNull(),
    impactTier: text("impact_tier")
      .$type<"CORE_ARCHITECTURAL" | "PERIPHERAL">()
      .notNull(),
    isLoadBearing: boolean("is_load_bearing").notNull().default(false),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    dependedBy: jsonb("depended_by").$type<string[]>().notNull().default([]),
    affectedSections: jsonb("affected_sections")
      .$type<Array<{ fileId: string; headingSlug: string }>>()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.decisionId] }),
    index("idx_project_decision_user_project").on(
      table.userId,
      table.projectId,
    ),
  ],
);

export type ProjectDecisionLedgerRow =
  typeof projectDecisionLedger.$inferSelect;
export type NewProjectDecisionLedgerRow =
  typeof projectDecisionLedger.$inferInsert;
```

### 1.4. Retaining the `activePool` Reference and Exporting `getPgPool()` from `src/server/db/transactional.ts` for `PostgresSaver`

Inspecting the active implementation in `src/server/db/transactional.ts` (lines 7–52), the module lazily initializes either a `NeonPool` instance (when connected to Neon Cloud) or a `NodePgPool` instance (in standard PostgreSQL environments) inside `getTxDb()`, but only stores the resulting `instance = drizzle(pool)` wrapper without retaining a reference to the underlying `pool` object itself.
To prevent opening a second connection pool or returning `null` when `getPgPool()` is invoked prior to the first `txDb` query, a module-level `activePool: NeonPool | NodePgPool | null` reference is retained, and `getPgPool()` invokes `getTxDb()` first to ensure the active pool is initialized and synchronized with the current `DATABASE_URL` environment variable:

```typescript
let instance: ReturnType<typeof createTransactionalDb> | null = null;
let activePool: NeonPool | NodePgPool | null = null;
let initializedUrl: string | undefined = undefined;

// Inside createTransactionalDb(connectionString):
// activePool = pool;

export function getPgPool(): NeonPool | NodePgPool {
  getTxDb(); // Ensures activePool is initialized and refreshed if DATABASE_URL changes during tests
  if (!activePool) {
    throw new Error("PostgreSQL connection pool failed to initialize");
  }
  return activePool;
}
```

### 1.5. `PostgresSaver` Drizzle Schema (`src/server/db/schema/langgraph-checkpoints.ts`) and Migration `0013_migrate_to_credit_ledger.sql`

Because Stage 3 of the continuous integration pipeline (`.github/workflows/ci.yml` — `Stage 3: migration-integrity`, lines `136–142`) executes `node scripts/verify-migrations.mjs` followed by `npx drizzle-kit push --config drizzle.config.test.ts --force` (which reads `schema: "./src/server/db/schema/index.ts"`), creating the four `PostgresSaver` tables in the SQL migration file without defining them in the Drizzle schema would cause `drizzle-kit push --force` to drop them as unmanaged tables. Therefore, they **must** be defined in `src/server/db/schema/langgraph-checkpoints.ts` and exported from `src/server/db/schema/index.ts` in lockstep with migration file `0013_migrate_to_credit_ledger.sql`:

```typescript
// src/server/db/schema/langgraph-checkpoints.ts
import {
  pgTable,
  text,
  integer,
  jsonb,
  customType,
  primaryKey,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const checkpointMigrations = pgTable("checkpoint_migrations", {
  v: integer("v").primaryKey(),
});

export const checkpoints = pgTable(
  "checkpoints",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    parentCheckpointId: text("parent_checkpoint_id"),
    type: text("type"),
    checkpoint: jsonb("checkpoint").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.checkpointNs, table.checkpointId],
    }),
  ],
);

export const checkpointBlobs = pgTable(
  "checkpoint_blobs",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    channel: text("channel").notNull(),
    version: text("version").notNull(),
    type: text("type").notNull(),
    blob: bytea("blob"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.threadId,
        table.checkpointNs,
        table.channel,
        table.version,
      ],
    }),
  ],
);

export const checkpointWrites = pgTable(
  "checkpoint_writes",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    taskId: text("task_id").notNull(),
    idx: integer("idx").notNull(),
    channel: text("channel").notNull(),
    type: text("type"),
    blob: bytea("blob").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.threadId,
        table.checkpointNs,
        table.checkpointId,
        table.taskId,
        table.idx,
      ],
    }),
  ],
);
```

## 2. `Upstash Redis` Keyspace & Atomic `Lua` Script Contracts (`Redis Keyspace & Lua Contracts`)

| Redis Key Pattern | Data Type | Time-To-Live (`TTL`) | Purpose & Atomic Operations Applied |
| :--- | :--- | :--- | :--- |
| **`lugx:wallet:${userId}`** | `String (Integer)` | `86,400s` ($24$ hours, renewed on every operation) | Real-time available user balance in Micro-Credits. Modified exclusively via atomic Lua scripts or `INCRBY`. |
| **`lugx:lease:${operationId}`** | `Hash` | `120s` (renewed on every chunk extension) | Stores active lease chunk state: `userId`, `stepKey`, `reservedInputMicro`, `reservedOutputMicro`, `extensionCount`. |
| **`lugx:step_done:${stepKey}`** | `String (JSON)` | `3,600s` ($1$ hour) | Stores the settlement receipt for a completed `LangGraph` step to prevent double-charging when a node replays after `interrupt()`. |
| **`lugx:pending_settlements:${userId}`** | `Hash` | No `TTL` (drained via `after()` and `Cron`) | Maps `operationId` to its settlement payload (`JSON` containing `created_at_ms`, `delta_micro`, and token metrics) awaiting flush to PostgreSQL. |
| **`lugx:dirty_wallets`** | `Set` | No `TTL` | Set of `userId` identifiers that have pending records in `pending_settlements` awaiting asynchronous flush to PostgreSQL. |

### 2.1. Signatures of the Three Atomic `Lua` Scripts (`src/lib/metering/lua-scripts.ts`)

1. **`reserve_or_extend.lua` (`reserve_or_topup_chunk.lua`):**
   - **Inputs (`KEYS` & `ARGV`):** `KEYS[1] = lugx:wallet:${userId}`, `KEYS[2] = lugx:lease:${operationId}`, `KEYS[3] = lugx:step_done:${stepKey}`; `ARGV = [requiredInputMicro, desiredOutputMicro, minAllowedOutputMicro, isZeroDustAllowed, ttlSeconds]`.
   - **Atomic Logic:** First verifies that `KEYS[3]` does not exist (`Idempotency`). Next checks whether `KEYS[1]` exists (returning `COLD_START_REQUIRED` to trigger the `Flush-First` protocol if absent). Then computes the reservable amount (applying the `Zero-Dust Drain` rule when the remaining balance covers the input cost plus a partial output allowance), atomically deducts it from `KEYS[1]`, and creates/updates `KEYS[2]` with `EXPIRE 120`.
2. **`settle_operation.lua`:**
   - **Inputs (`KEYS` & `ARGV`):** `KEYS[1] = lugx:wallet:${userId}`, `KEYS[2] = lugx:lease:${operationId}`, `KEYS[3] = lugx:pending_settlements:${userId}`, `KEYS[4] = lugx:dirty_wallets`, `KEYS[5] = lugx:step_done:${stepKey}`; `ARGV = [operationId, actualTotalCostMicro, settlementJsonWithTimestamp]`.
   - **Atomic Logic:** Reads total reserved Micro-Credits from `KEYS[2]`, computes the difference ($\text{Refund} = \text{Reserved} - \text{Actual}$), refunds the unused surplus to `KEYS[1]` with `EXPIRE 86400`, deletes `KEYS[2]`, records the settlement entry in `KEYS[3]` via `HSET`, adds `userId` to `KEYS[4]` via `SADD`, and stamps `KEYS[5]`.
3. **`stripe_dual_write.lua`:**
   - **Atomic Logic:** Checks `redis.call('EXISTS', KEYS[1]) == 1`; if the wallet key is warm in Redis memory, executes `INCRBY KEYS[1] topupMicro` and refreshes `EXPIRE 86400`; otherwise returns `0` so the balance will be populated from PostgreSQL via `Flush-First Cold Start` on the next request.

## 3. Complete `LUGX v1.46.3` Codebase Transformation Matrix

This transformation matrix is grounded in a direct inventory of the actual file tree and source line numbers in the **LUGX (`v1.46.3`)** repository:

### 3.1. Category 1: Engineering Assets Retained & Hardened (`Retain & Harden` / `Keep & Harden`)

| Actual Path in `LUGX v1.46.3` | Current Functionality | Required Hardening Action (`Hardening Action`) |
| :--- | :--- | :--- |
| **`src/lib/sync/diff3.ts`** and **`src/lib/sync/syntax-validator.ts`** | Three-way merge engine (`diff3MergeText(local, base, remote)` using Hunt-McIlroy LCS and intra-line subsegment merging) and Markdown syntax validator. | Retain in full, adding a `diff3MergeSection` wrapper function that invokes the `Fence-Aware Slicer` and passes parameters in the strict order `(liveSectionContent, baseSectionContent, agentProposedSectionContent)`. |
| **`src/components/editor/markdown/*`** (`markdown-editor.tsx`, `editor-adapter.ts`, `markdown-extensions.ts`, `streaming-ghost.ts`) | Hybrid CodeMirror 6 editor (Live Preview + RTL/LTR Bidi + streaming ghost preview layer). | Upgrade `streaming-ghost.ts` from a single ghost preview range to a multi-hunk array (`GhostHunk[]`) with dynamic coordinate remapping via `tr.changes.mapPos` and granular per-hunk acceptance. |
| **`src/lib/crypto/*`**, **`src/lib/vault/*`**, and **`src/lib/workers/{crypto,pdf}.worker.ts`** | Client-side end-to-end encryption (`AES-256-GCM` + `PBKDF2 600k` + `BIP-39` + `AAD`). | 1. Unify the `AAD` prefix in `src/lib/sync/webauthn-prf.ts` inside `createWebAuthnPrfEnvelope` (line `275`) and `unwrapMasterKeyWithWebAuthnPrf` (line `363`) by passing `AAD.deviceWrap(userId, epoch)` (`lugx:v1:device:${userId}:${epoch}`) to `cryptoWorkerBridge.unwrapKeyRaw` with a backward-compatible fallback to the legacy string `` `trusted_device:${userId}:${epoch}` `` (matching `unwrapMasterKeyWithPin` in `src/lib/sync/encryption.ts:308-316`).<br>2. Remove the dead `buildFileAAD` helper from both `src/hooks/use-editor-orchestrator.ts:130` and `src/hooks/use-editor-conflict.ts:200`. |
| **`src/server/actions/files.ts`**, **`src/server/actions/folders.ts`**, and **`src/server/actions/import-file.ts`** | File, folder, and document import server actions. | 1. Fix `restoreFile` (`files.ts:653` and `folders.ts:12-40`) by adding an `includeDeleted?: boolean` option to `getDescendantIds` so the `isNull(schema.files.deletedAt)` filter does not exclude soft-deleted child items when restoring a parent folder.<br>2. Fix `import-file.ts:174-178` by passing `isEncrypted` and the `envelope` object constructed from `finalMetadata` and `finalContent` inside the single parameter object of `generateETagSync({ id: newFileId, content: finalContent, updatedAt: now, isEncrypted, envelope: ... })`, matching `files.ts:341-355`. |
| **`src/hooks/use-sync.ts`** | Client-to-server local synchronization hook. | Fix lines `321` and `339` to use `file.parentFolderId !== undefined ? file.parentFolderId : (existingFile?.parentFolderId ?? null)` instead of the logical `\|\|` operator, preventing failures when moving files to the root folder (`null`) or inadvertently overwriting a parent folder assignment. |
| **`src/lib/rate-limit.ts`** and **`src/lib/cron/lock.ts`** | Distributed rate limiter (`Fail-Closed` on `AI_STREAM` and `AUTH`) and distributed Cron job lock. | Wire `authRateLimiter` (defined in `src/lib/rate-limit.ts:208` with `RATE_LIMITS.AUTH` at line `61`, currently uninvoked) into the active authentication server actions (`signInWithGoogle` and `syncUserToDatabase`) in `src/server/actions/auth-actions.ts`. |
| **`src/lib/parsers/*`**, **`src/lib/export/export-service.ts`**, and **`src/lib/exporters/*`** | Document import parsers (PDF/MD/TXT) and export pipelines. | Retain in full to enable the agent to ingest imported reference documents and export architectural deliverables. |

### 3.2. Category 2: Modules Repurposed & Extended (`Refactor & Extend` / `Adapt & Repurpose`)

| Actual Path in `LUGX v1.46.3` | Legacy Philosophy in `LUGX` | New Philosophy in `Elixent` |
| :--- | :--- | :--- |
| **`src/server/db/transactional.ts`** | Exposes `txDb` behind a `Proxy` for interactive transactions without retaining a reference to the underlying Pool. | Retains the module-level `activePool` reference and exports `getPgPool()` to supply `PostgresSaver` with the active connection pool without pool duplication. |
| **`src/config/models.config.json`** and **`src/lib/ai/client.ts`** | Categorizes models by the five legacy operations (`correct`, `improve`, ...) and invokes `@google/generative-ai` directly. | Transforms `models.config.json` into a `Lean Dynamic Model Registry` indexed by `modelId` supporting `executionMode`, `V`, and `calibrationPriors`, and refactors `client.ts` into a `Vercel AI SDK v6` provider (`streamText`, `generateObject`). |
| **`src/lib/ai/key-rotation.ts`** | Reads `GEMINI_KEY_1..20` exclusively and manages key rotation and circuit breaking. | Retains the full Redis key rotation and circuit-breaker logic while adding support for reading `GEMINI_API_KEY` as a fallback aligned with `README.md`. |
| **`src/server/services/ai-settlement-service.ts`** | Reserves and settles word quotas via `SELECT ... FOR UPDATE` in PostgreSQL. | Refactored into the `Micro-Credits` financial flush and settlement service (`flushPendingSettlementsToPostgres` + `Flush-First Cold Start` + `getUserCreditBalance` query). |
| **`src/config/tiers.config.ts`** and **`src/server/services/billing-service.ts`** | Subscription plans based on daily and weekly word quotas. | Credit allocation tiers (`Credits Allocation`) denominated in Micro-Credits with the atomic Dual-Write protocol in `/api/stripe/webhook`. |
| **`src/app/api/cron/expire-reservations/route.ts`** | Cleans up expired word quota reservations in the PostgreSQL `ai_reservations` table. | Refactored into the `Ghost Leases & Dirty Wallets Sweeper` using a `Batch-Draining Loop` that cleans up expired Redis leases and flushes `pending_settlements` records older than $30,000\text{ ms}$. |
| **`src/server/actions/auth-actions.ts`**, **`src/app/api/test/e2e-auth/route.ts`**, **`src/test/test-db.ts`**, **`e2e/fixtures/test-db.ts`**, and **`scripts/verify-migrations.mjs`** | Inserts, deletes, and inspects rows and indexes in `schema.usage` and `schema.aiReservations` during login, test setup, and migration verification. | Removes `schema.usage` inserts from `auth-actions.ts:97-102`, `e2e-auth/route.ts:86-93`, and `e2e/fixtures/test-db.ts:50-55`; updates `src/test/test-db.ts:107-109`, `e2e/fixtures/test-db.ts:64-65,100-114`, `src/test/auth/auth-signout.test.ts:56`, all `src/test/ai/*` suites, and `e2e/specs/06..08` to clean and query `creditLedgerTransactions` and `projectDecisionLedger`; updates `scripts/verify-migrations.mjs:117-208` to verify the new tables and indexes instead of the two dropped tables. |
| **`src/app/dashboard/page.tsx`**, **`src/app/account/page.tsx`**, and **`src/app/workspace/editor/[fileId]/page.tsx`** | Calls `getRemainingQuota()` from `ai-ops.ts` to display remaining word and summary counters. | Updated to display the user's balance in Micro-Credits/Standard Credits (`creditBalanceMicro`) and architectural agent session consumption. |
| **`src/hooks/use-editor-orchestrator.ts`**, **`src/hooks/use-ai-stream.ts`**, **`src/lib/ai/{stream-handler,stream-session}.ts`**, **`src/components/editor/ai-stream-status.tsx`**, and **`src/types/ai-contracts.ts`** | Runs a single operation from the five legacy operations on selected text and monitors its status. | Connects to `/api/agent/stream`, decouples `stream-session.ts:1` from the deleted `prompts.ts` file, manages `thread_id` lifecycle, passes `ephemeralVaultPayloads` and `liveDocumentSnapshots`, renders agent phase progress and structured `HITL` questions, manages `Multi-Hunk Ghost` state and granular acceptance, and updates `ai-contracts.ts` for Micro-Credits. |

### 3.3. Category 3: Modules Pruned & Deleted Permanently (`Prune / Delete` / `Prune & Delete`)

| Actual Path to Delete | Reason for Permanent Deletion |
| :--- | :--- |
| **`src/lib/ai/prompts.ts`** | Contains static prompt templates for the five abandoned legacy operations (`correct`, `improve`, `summarize`, `translate`, `toPrompt`). |
| **Five-operation buttons in `src/components/editor/ai-toolbar.tsx`** | Replaced by the architectural agent chat panel and the granular ghost hunk control bar (`Accept Hunk / Reject Hunk / Accept All`). |
| **`src/server/db/schema/usage.ts`** and **`src/server/db/schema/ai-reservations.ts`** | Legacy word counter and quota reservation tables; dropped in migration `src/server/db/migrations/0013_migrate_to_credit_ledger.sql` and removed from exports in `src/server/db/schema/index.ts`. |
| **`src/server/actions/ai-ops.ts`**, **`src/server/actions/ai-commit.ts`**, **`src/lib/ai/pending-operation-store.ts`**, **`src/lib/ai/quota-settlement-reducer.ts`**, **`src/lib/ai/preview-buffer.ts`**, and **`src/app/api/ai/stream/route.ts`** | Legacy word-reservation actions, `QuotaSettlementReducer`, single-range preview buffer, and legacy stream route; replaced by direct atomic Redis reservation inside the node gate wrapper, `/api/agent/stream`, `MultiHunkGhostState`, and granular editor synchronization. |
| **`src/app/api/billing/webhook/route.ts`** and **`src/app/api/webhooks/stripe/route.ts`** | Redundant webhook re-export routes; Stripe webhook handling is consolidated exclusively under `src/app/api/stripe/webhook/route.ts`. |
| **Lines `481–646` inside `src/lib/sync/conflict-resolver.ts`** | Dead, unreferenced private methods (`diff2Way`, `diff3Merge`, `extractSliceForRange`) left behind in the class after three-way merging in `mergeContentThreeWay` (line `354`) was migrated to call `diff3MergeText` from `src/lib/sync/diff3.ts`, while strictly preserving `computeLCS` (lines `401–479`), `areArraysEqual` (lines `651–657`), and `computeWordSpans` (line `662`) which `computeVisualDiff` depends on. |

### 3.4. Category 4: New Modules Built & Added (`Create New` / `Build & Add`)

| Newly Created Path | Functional Role & Reference Specification |
| :--- | :--- |
| **`src/core/agent/taxonomy/predefined-tags.ts`** | Hardcoded architectural taxonomy and concept tag dictionary (`PREDEFINED_CONCEPT_TAGS`) from which the model selects decision tags without free-form invention (Reference: [02_agent_orchestration_and_decision_engine](./02_agent_orchestration_and_decision_engine.md) §4.1). |
| **`src/core/agent/{graph,state,reducers,nodes/*}.ts`** | `@langchain/langgraph` state machine, `AgentGraphState` channels, and the seven orchestration stage nodes including `atms_relational_linker_node` (Reference: [02_agent_orchestration_and_decision_engine](./02_agent_orchestration_and_decision_engine.md)). |
| **`src/core/agent/atms/{dag,candidate-retriever,relational-linker,invalidation}.ts`** | Justification-Driven Assumption-Based Truth Maintenance System (`Justification-Driven ATMS DAG`), deterministic local candidate retriever, relational linker adjudication, and `resolveATMSCascadeBFS` algorithm (Reference: [02_agent_orchestration_and_decision_engine](./02_agent_orchestration_and_decision_engine.md) §5). |
| **`src/lib/jev/{client,conformal-classifier,calibration-store}.ts`** | Unified decision client (`POST /v1/decisions`), two-tier model cascade, and `Conformal APS` prediction set classifier (Reference: [02_agent_orchestration_and_decision_engine](./02_agent_orchestration_and_decision_engine.md) §4). |
| **`src/core/ast/heading-slicer.ts`** and **`src/core/workspace/{provider,cloud-provider,lexical-bm25}.ts`** | Code-fence-aware Markdown heading slicer, workspace provider abstraction, and hybrid `AST + BM25` lexical search engine (Reference: [03_workspace_ast_editor_and_vault_integration](./03_workspace_ast_editor_and_vault_integration.md) §1–2). |
| **`src/lib/vault/ephemeral-memory-map.ts`** and **`src/core/agent/checkpoint-serializer.ts`** | Request-scoped ephemeral memory map for `vault_ref://` pointers and `EncryptedCheckpointSerializer` (Reference: [03_workspace_ast_editor_and_vault_integration](./03_workspace_ast_editor_and_vault_integration.md) §5). |
| **`src/lib/metering/{stream-governor,node-gate,lua-scripts,cold-start}.ts`** | Real-time stream governor, pre-node gate wrapper, atomic Lua scripts, and `Flush-First Cold Start` protocol (Reference: [04_credit_metering_and_settlement_architecture](./04_credit_metering_and_settlement_architecture.md)). |
| **`src/app/api/agent/stream/route.ts`** and **`src/components/agent/{chat-panel,hitl-question-card}.tsx`** | Agent streaming route (`maxDuration = 300`), interactive agent chat panel, and structured `HITL` question cards. |

## 4. Phased Implementation Roadmap

To guarantee a safe transition without breaking builds, user authentication, or existing repository test suites (`1,077 unit tests` and `117 live tests`) between phases, the transformation is executed across five sequential, cohesive phases:

1. **Phase 1 (`Core Hardening & Non-Breaking Schema Migration`):**
   - Execute the six Category 1 hardening fixes (`webauthn-prf.ts:275,363`, removing `buildFileAAD` from `use-editor-orchestrator.ts:130` and `use-editor-conflict.ts:200`, fixing `restoreFile` in `files.ts:653` and `folders.ts:23`, fixing `import-file.ts:174`, fixing `use-sync.ts:321,339`, wiring `authRateLimiter` in `auth-actions.ts`, and deleting the three dead methods in `conflict-resolver.ts:481-646`).
   - Retain `activePool` and export `getPgPool()` from `src/server/db/transactional.ts`, create migration `src/server/db/migrations/0013_migrate_to_credit_ledger.sql` adding `users.credit_balance_micro`, the `credit_ledger_transactions` and `project_decision_ledger` tables (including rationale, evaluated alternatives, and concept tag columns), and the four `PostgresSaver` checkpoint tables, while dropping `usage` and `ai_reservations` **simultaneously in the same step** alongside updating `scripts/verify-migrations.mjs`, removing `schema.usage` and `schema.aiReservations` references from `auth-actions.ts:97`, `e2e-auth/route.ts:86`, `src/test/test-db.ts:107`, `e2e/fixtures/test-db.ts`, `src/test/auth/auth-signout.test.ts:56`, and all test suites under `src/test/**` and `e2e/specs/**`, and providing the new credit balance reader for the `dashboard` and `account` pages.
2. **Phase 2 (`Metering & Settlement Subsystem`):**
   - Build `src/lib/metering/*` and the three atomic Lua scripts, update `src/config/models.config.json`, `/api/stripe/webhook`, and `/api/cron/expire-reservations`, and verify acceptance criteria `MTR-01` through `MTR-06`.
3. **Phase 3 (`Workspace, AST & Vault Boundary`):**
   - Build the `Fence-Aware Heading Slicer`, `CloudPostgresWorkspaceProvider` (with ordered parameters `diff3MergeText(live, base, proposed)` and hybrid `AST + BM25` search), `EphemeralVaultMemoryMap` (`vault_ref://` backed by `ephemeralVaultPayloads` and `liveDocumentSnapshots`), and `EncryptedCheckpointSerializer`.
4. **Phase 4 (`Taxonomy, Agent & Decision Core`):**
   - Define the comprehensive hardcoded architectural taxonomy in `src/core/agent/taxonomy/predefined-tags.ts` (`PREDEFINED_CONCEPT_TAGS`).
   - Build `AgentGraphState` and pure state reducers, the `POST /v1/decisions` client with `Conformal APS` and foundational calibration protocol, the `Justification-Driven ATMS DAG` with deterministic local candidate retrieval, the relational adjudication node (`atms_relational_linker_node`), the `resolveATMSCascadeBFS` invalidation cascade algorithm, and `pure_interrupt_node`.
5. **Phase 5 (`UI Integration & Legacy Purge`):**
   - Upgrade `streaming-ghost.ts` to support `GhostHunk[]` and granular acceptance synchronized with `useEditorAutosave`, upgrade `stream-handler.ts`, `stream-session.ts`, `ai-stream-status.tsx`, and `ai-contracts.ts`, build `/api/agent/stream` and the `HITL` UI components, delete the legacy five-operation files (`prompts.ts`, `ai-ops.ts`, `ai-commit.ts`, `pending-operation-store.ts`, `quota-settlement-reducer.ts`, `preview-buffer.ts`, `api/ai/stream/route.ts`, and duplicate webhook routes), update `vitest.constants.mts`, and synchronize `docs/METRICS.json` via `node scripts/sync-doc-metrics.mjs --update-docs`.
