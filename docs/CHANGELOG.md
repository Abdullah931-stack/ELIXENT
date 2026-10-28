# Changelog — Elixent Platform

All notable architectural, engineering, and governance changes to the **Elixent** platform are documented in this file.

---

## [0.3.0] - 2026-10-28 (Phase 3: Lean Dynamic Model Registry, Derivation Math & Atomic Redis Lua Scripts)

### Lean Dynamic Model Registry (`src/config/models.config.json`)

- **Configured 7 Canonical Models:** Transformed `models.config.json` into a lean registry under `"models"` indexing 7 models with canonical parameters (`executionMode`, velocity $V$, `creditsPer1kInput`, `creditsPer1kCacheRead`, `creditsPer1kOutput`, and `calibrationPriors`):
  - `openai/gpt-6-luna-decisions` (`SINGLE_PASS_DECISION`, $V = 0$, priors $\{0.22, 0.42\}$)
  - `microsoft/decision-1` (`SINGLE_PASS_DECISION`, $V = 0$, priors $\{0.22, 0.42\}$)
  - `typesafe/jev-1.13` (`SINGLE_PASS_DECISION`, $V = 0$, priors $\{0.08, 0.22\}$)
  - `fastino/glide` (`DISCRETE_THINKING`, $V = 85$, priors $\{0.09, 0.24\}$)
  - `google/gemini-4-argon` (`STREAMING_GENERATIVE`, $V = 100$)
  - `google/gemini-3.8-flash` (`STREAMING_GENERATIVE`, $V = 120$)
  - `google/gemini-3.1-pro` (`STREAMING_GENERATIVE`, $V = 95$)
- **Legacy AI Client Compatibility:** Preserved all existing legacy operation blocks (`correct`, `improve`, `translate`, `summarize`, `toPrompt`, fallbacks, and temperature settings) ensuring 100% backward compatibility for `src/lib/ai/client.ts` (24/24 tests passing).

### Pure Micro-Credit Derivation Math (`src/lib/metering/derivation.ts`)

- **Micro-Credit Scale & Conversion:** Implemented `tokensToMicroCredits(tokens, creditsPer1k)` calculating $\lceil \text{Tokens} \times \text{CreditsPer1k} \times 1,000 \rceil$ in integer Micro-Credits ($10^6\text{ micro-credits} = 1\text{ credit}$).
- **Three-Mode Reservation Derivation:**
  - `SINGLE_PASS_DECISION`: Input tokens reserved only, $L_{\text{allocated}} = 0$, $\text{Trigger} = 0$, `creditsPer1kOutput = 0`, eliminating division-by-zero risks.
  - `DISCRETE_THINKING`: Reserves input plus discrete thinking ceiling ($B_{\text{discrete}} = 1500\text{ tokens}$ or node override), $\text{Trigger} = 0$.
  - `STREAMING_GENERATIVE`: Computes operational chunk $L_{\text{calc}} = \max(L_{\min}, \lceil V \times T_{\text{chunk}} \rceil)$ and runway trigger $\lceil V \times T_{\text{runway}} \rceil$.
- **Zero-Dust Drain Rule:** Waives the $L_{\min} = 500$ floor constraint when user token capacity is within $0 < \text{capacity} < L_{\min}$, setting `isZeroDustAllowed = true` and reserving the exact remaining micro-credit balance to drain user wallets down to precisely $0$ without stranding fractional dust.

### Pessimistic Tokenization Foundation (`src/lib/metering/tokenizer.ts`)

- **`js-tiktoken` Singleton:** Lazily instantiates `cl100k_base` tokenizer singleton for fast in-process token counting.
- **Pessimistic Safety Margin:** Multiplies raw token counts by $+15\%$ (`PESSIMISTIC_TOKEN_MARGIN = 1.15`) with ceiling rounding to absorb cross-provider tokenization divergence and multilingual token expansions.

### Metering Constants & Redis Key Builders (`src/lib/metering/constants.ts`)

- **Financial & Timing Constants:** Defined `MICRO_PER_CREDIT = 1_000_000n`, $T_{\text{runway}} = 3\text{s}$ ($3,000\text{ms}$), $T_{\text{chunk}} = 10\text{s}$, $L_{\min} = 500\text{ tokens}$, $B_{\text{discrete}} = 1500\text{ tokens}$, `LOCAL_HOLD_TIMEOUT_MS = 500ms`, `DIRTY_SETTLEMENT_GRACE_MS = 30_000ms`.
- **Key Lifecycles & TTLs:** `LEASE_TTL_SECONDS = 120s`, `WALLET_TTL_SECONDS = 86400s` ($24\text{h}$), `STEP_DONE_TTL_SECONDS = 3600s` ($1\text{h}$).
- **Canonical Redis Key Builders (`REDIS_KEYS`):** Centralized builders for `lugx:wallet:${userId}`, `lugx:lease:${operationId}`, `lugx:step_done:${stepKey}`, `lugx:pending_settlements:${userId}`, and `lugx:dirty_wallets`.

### Atomic Upstash Redis Lua Scripts & Execution Wrappers (`src/lib/metering/lua-scripts.ts`)

- **Pre-Flight Reservation & Chunk Extension (`RESERVE_OR_EXTEND_LUA`):** Atomic script checking idempotency via `lugx:step_done`, detecting cold wallets via `EXISTS lugx:wallet` (returning `COLD_START_REQUIRED`), applying Zero-Dust Drain logic, atomically debiting balance, and refreshing `lugx:lease:${operationId}` with 120s TTL.
- **Operation Settlement & Durability Staging (`SETTLE_OPERATION_LUA`):** Atomically refunds surplus $\max(0, \text{Reserved} - \text{Actual})$ to wallet, deletes active lease, stages pending settlement record in hash `lugx:pending_settlements:${userId}` via `HSET`, registers user in `lugx:dirty_wallets` via `SADD`, and stamps completed step receipt in `lugx:step_done:${stepKey}` with 3600s TTL.
- **Stripe Webhook Dual-Write (`STRIPE_DUAL_WRITE_LUA`):** Atomically increments live balance via `INCRBY` strictly when the wallet key exists in Redis (`EXISTS == 1`), returning `{ applied: boolean, newBalanceMicro }`.
- **Fail-Closed Policy Enforcement:** Wrapped all Lua execution in try/catch throwing `MeteringServiceUnavailableError` (`status: 503`, `code: "METERING_SERVICE_UNAVAILABLE"`) upon Redis timeout or connection failure, guaranteeing zero unmetered model execution during outages.

### Isolated Acceptance & Unit Test Verification (`src/test/metering/derivation-and-lua.unit.test.ts`)

- **High-Fidelity In-Memory Test Harness:** Authored `InMemoryRedisEvalClient` simulating Redis key mutations, multi-key TTLs, and atomic Lua execution with zero external network dependencies.
- **Verified Acceptance Criteria (22 Tests, 100% Passing):**
  - `MTR-01`: Single-pass decision input-only reservation, zero output tokens, zero trigger, boundary affordability checking.
  - `MTR-02`: Concurrency & overdraft prevention (10 concurrent requests on 3-slice balance -> exactly 3 accepted, 7 rejected, final balance precisely 0).
  - `MTR-03`: Fail-Closed policy enforcement throwing HTTP 503 `MeteringServiceUnavailableError` on connection drops or unconfigured runtime.
  - `MTR-04`: Generative streaming slice allocation and Zero-Dust Drain wallet clearing.
- **Repository Verification Baseline:** 91 unit suites (1103 tests) passing 100%, 21 live suites (118 tests), 14 E2E specs (15 journeys), clean TypeScript (`tsc --noEmit`), and synchronized SSOT documentation metrics.

---

## [0.2.0] - 2026-10-27 (Phase 2: NPM Dependencies, Database Schema Migration & Pool Export)

### Agentic & AI Orchestration Dependencies (`package.json`, `package-lock.json`)

- **Installed 7 Modern Multi-Agent & LLM Packages:** Added `@langchain/langgraph` (agent graph orchestration), `@langchain/core` (LangChain base interfaces), `@langchain/langgraph-checkpoint-postgres` (PostgreSQL state persistence for agent graphs), `ai` (Vercel AI SDK core runtime), `@ai-sdk/google` (Google Gemini provider adapter), `@ai-sdk/openai` (OpenAI provider adapter), and `js-tiktoken` (tokenization and token counting foundation).

### Database Connection Pool Reuse & Export (`src/server/db/transactional.ts`, `src/server/db/index.ts`)

- **Direct Export of `getPgPool()`:** Exported `getPgPool(): pg.Pool` from both `src/server/db/transactional.ts` and `src/server/db/index.ts`. Retained the existing `activePool` singleton instance, guaranteeing zero connection pool proliferation when instantiating `PostgresSaver` in LangGraph agent workflows while preserving strict test database isolation across TCP and Neon WebSocket protocols.

### Database Schema Evolution & Migration `0013` (`src/server/db/migrations/0013_migrate_to_credit_ledger.sql`, `src/server/db/schema/*`)

- **Micro-Credit Balance (`users.credit_balance_micro`):** Added `credit_balance_micro` (`BIGINT NOT NULL DEFAULT 0`) to `users` table protected by a database check constraint (`users_credit_balance_non_negative`: `credit_balance_micro >= 0`). Initialized existing user balances by subscription tier (`ultra`: 3,500,000,000 micro-credits, `pro`: 1,000,000,000 micro-credits, `free`/`starter`: 50,000,000 micro-credits).
- **Credit Ledger Transactions (`credit_ledger_transactions`):** Established immutable double-entry credit ledger schema (`src/server/db/schema/credit-ledger.ts`) with enums `ai_execution_mode` (`SINGLE_PASS_DECISION`, `DISCRETE_THINKING`, `STREAMING_GENERATIVE`, `CREDIT_TOPUP`) and `ledger_settlement_status` (`SETTLED`, `ABORTED`, `TOPUP_APPLIED`), indexed by `(user_id, created_at)` and `thread_id`.
- **Project Decision Architecture Ledger (`project_decision_ledger`):** Added schema (`src/server/db/schema/project-decision-ledger.ts`) recording agentic architectural decisions, evaluated alternatives, rationale, and concept tags, indexed by `(user_id, project_id)`.
- **PostgresSaver Checkpointing Tables:** Added four dedicated LangGraph persistence tables (`checkpoint_migrations`, `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`) matching `@langchain/langgraph-checkpoint-postgres` requirements for multi-turn graph checkpoints.
- **Dropped Legacy Quota Tables:** Formally dropped obsolete `usage` and `ai_reservations` tables (`CASCADE`) via migration `0013` and deleted legacy schema files (`src/server/db/schema/usage.ts`, `src/server/db/schema/ai-reservations.ts`).

### Callers, Verification Script & Transitional Compatibility Bridge

- **Zero-Breakage Compatibility Bridge (`src/server/services/ai-settlement-service.ts`):** Refactored settlement and reservation services to debit, commit, and refund against `users.creditBalanceMicro` and `creditLedgerTransactions`, preserving existing function signatures (`reserveAndUpdateUsage`, `commitAIReservation`, `refundAIReservation`, `expireStaleReservations`, `getTodayUsage`) while eliminating all dependencies on dropped legacy tables.
- **Server Actions & Test Fixtures Alignment:** Removed legacy `schema.usage` and `schema.aiReservations` inserts and queries from `auth-actions.ts`, `e2e-auth/route.ts`, `src/test/test-db.ts`, and `e2e/fixtures/test-db.ts`. Initialized `creditBalanceMicro: 50_000_000n` for newly registered users on the starter tier.
- **Migration Verification Hardening (`scripts/verify-migrations.mjs`):** Updated migration integrity assertions to check all 9 active tables, 14 canonical indexes, and verify `users.credit_balance_micro` column existence, ensuring CI Stages 3 and 4 remain fully gated.
- **Comprehensive Verification Baseline:** Verified 90 unit suites (1081 tests), 21 live database integration suites (118 tests), and 14 Playwright E2E specs (15 journeys) passing 100%, with clean TypeScript (`npx tsc --noEmit`) and ESLint checks.

---

## [0.1.0] - 2026-10-27 (Phase 1: Core Cryptographic, Sync & Server Actions Hardening)

### Cryptographic Context & AAD Standardization (`src/lib/sync/webauthn-prf.ts`, `src/hooks/*`)

- **Canonical Device Wrap AAD:** Standardized WebAuthn PRF master key envelope wrapping on `AAD.deviceWrap(userId, deviceTrustEpoch)` from `@/lib/crypto/aad` (generating `lugx:v1:device:${userId}:${epoch}`), replacing ad-hoc string formatting.
- **Dual-Try Fallback Unwrapping:** Implemented fail-safe Dual-Try unwrapping in `unwrapMasterKeyWithWebAuthnPrf` (trying `canonicalAad` first, falling back to `legacyAad`) to ensure existing trusted devices unwrap transparently without user re-authentication or data loss.
- **Centralized File AAD Standardization:** Pruned legacy uninvoked `buildFileAAD` helpers in `src/hooks/use-editor-orchestrator.ts` and `src/hooks/use-editor-conflict.ts`. Standardized all file AAD construction strictly on `@/lib/crypto/aad` via `AAD.file(userId, fileId)` (`lugx:v1:file:${userId}:${fileId}`).
- **Client-Server Encrypted ETag Parity (`src/server/actions/import-file.ts`):** Passed the structured `envelope` into `generateETagSync` on encrypted file import (`isEncrypted === true`), achieving exact parity with client-side `generateEncryptedETagSync` and eliminating spurious HTTP 412 Precondition Failed conflicts on subsequent sync polling.

### Offline-First Sync & Conflict Resolution Pruning (`src/hooks/use-sync.ts`, `src/lib/sync/conflict-resolver.ts`)

- **Root Move Null-Preservation (`src/hooks/use-sync.ts`):** Replaced falsy fallback `file.parentFolderId || existingFile?.parentFolderId || null` with explicit `file.parentFolderId !== undefined ? file.parentFolderId : (existingFile?.parentFolderId ?? null)`, strictly preserving explicit `null` moves to the root folder in local IndexedDB persistence (`saveLocal`).
- **Pruned Dead Merge Methods (`src/lib/sync/conflict-resolver.ts`):** Deleted unreferenced private merge methods (`diff2Way`, `diff3Merge`, `extractSliceForRange`) from `ConflictResolver`, consolidating Diff3 logic around `src/lib/sync/diff3.ts` while strictly preserving `computeLCS`, `areArraysEqual`, and `computeWordSpans` for visual diff rendering.

### Server Actions Hardening & Rate Limiting (`src/server/actions/*`)

- **Recursive Soft-Deleted Folder Cascade (`src/server/actions/folders.ts`, `files.ts`):** Extended `getDescendantIds` signature to accept `includeDeleted: boolean = false` and pass `includeDeleted = true` inside `restoreFile`, ensuring soft-deleted subfolders and documents are revived in an atomic transaction without leaving orphaned descendant records.
- **Fail-Closed Auth Rate Limiting (`src/server/actions/auth-actions.ts`):** Wired `authRateLimiter` (`src/lib/rate-limit.ts`) to Next.js Server Actions `signInWithGoogle` (keyed by client IP address extracted from headers) and `syncUserToDatabase` (keyed by authenticated `user.id`), enforcing fail-closed protection against brute-force attacks and abuse.

### Verification & Metrics Synchronization

- **Dedicated Rate Limit Test Suite (`src/test/auth/auth-actions-rate-limit.test.ts`):** Created 6 automated tests validating IP and user-based rate limiting, fail-closed handling, and client IP fallback behavior for authentication Server Actions.
- **Core Hardening Test Verification:** Executed full Vitest verification across `src/test/sync`, `src/test/vault`, `src/test/server`, `src/test/auth`, and `src/test/editor` with 52 test files (739 tests) passing 100%.
- **Doc Metrics Synchronization:** Confirmed full compliance with canonical SSOT test metrics via `node scripts/sync-doc-metrics.mjs --check` across living documentation.

---

## [0.0.3] - 2026-10-26 (CI Stage 7 Gating & Non-Runnable Cloud Provider Smoke Bypass)

### CI Pipeline Stage 7 Gating (`.github/workflows/ci.yml`)

- **Bypassed Stage 7 Cloud Provider Smoke from Inside CI:** Replaced the live execution of `src/test/ai/ai-live-e2e.test.ts` in Stage 7 (`live-provider-smoke`) with an explicit notice (`::notice::`) and graceful zero exit (`TEST_EXIT_CODE=0`).
- **Preserved Credential Security & Fail-Closed Gate:** Retained the mandatory fail-closed credentials verification gate in Stage 7 (`TEST_DATABASE_URL` and `GEMINI_KEY_1`) so unauthenticated releases remain strictly blocked.
- **Synchronized Tag Trigger Contract:** Normalized release tag matching syntax in `ci.yml` from double quotes to single quotes (`tags: ['v*']`), bringing static CI gating simulation (`scripts/test-ci-gating.mjs`) to 100% compliance (30/30 checks green).
- **Non-Runnable Tests Protocol Compliance:** Formally recorded `src/test/ai/ai-live-e2e.test.ts` under the repository Non-Runnable Tests Protocol due to persistent upstream Google Gemini API Free Tier 503 Overload and quota instability, pending full architectural overhaul of the AI model fallback hierarchy.

---

## [0.0.2] - 2026-10-26 (CI Stabilization & Live Provider Failover Resiliency)

### CI Multi-Key Exposure & Pool Rotation (`.github/workflows/ci.yml`)

- **Exposed Full Gemini API Key Pool to CI:** Configured the runner environment across Stage 6 (Playwright E2E) and Stage 7 (Live Provider Smoke) to pass all available keys (`GEMINI_KEY_2` through `GEMINI_KEY_8`).
- **Eliminated Rate-Limit Flakiness:** Resolved intermittent `AllKeysExhaustedError` in CI pipelines where the environment had previously been artificially constrained to only `GEMINI_KEY_1`, unblocking automatic key rotation and quota exhaustion failover in CI runs.

### Per-Attempt Timeout Watchdog & Rapid Failover (`src/lib/ai/client.ts`)

- **Watchdog Controller (`ATTEMPT_TIMEOUT_MS = 15000`):** Implemented an attempt-scoped abort controller for Google Generative AI SDK calls (`processWithAI` and `streamWithAI`) when no external `AbortSignal` is supplied by the caller.
- **Provider Stall Protection:** Automatically terminates stalled socket connections when upstream Google Gemini API hangs under 503 overload, immediately tripping the overloaded model circuit breaker in Upstash Redis and falling over to the next configured fallback model (`gemini-3.8-flash` -> `3.6-flash` -> `3.5-flash-lite` -> `3.1-flash-lite`).
- **Referential Signal Contract Preservation:** Preserved exact `{ signal: callerSignal }` propagation when an explicit `AbortSignal` is supplied by the consumer, ensuring full backward compatibility and zero unit test regressions.

### Cloud Provider Smoke Gating & Resilience (`vitest.live.config.mts`, `src/test/ai/ai-live-e2e.test.ts`)

- **Standardized Timeout Inheritance:** Removed hardcoded 30-second local timeout arguments from `src/test/ai/ai-live-e2e.test.ts`, allowing tests to inherit the canonical 60-second allowance configured in `vitest.live.config.mts`.
- **Transient Spike Absorption:** Added `retry: 1` to `vitest.live.config.mts` to prevent transient cloud provider 503 hiccups from failing gated release smoke jobs.
- **Verified Local CI Execution:** Validated end-to-end execution of Stage 1 (Quality Gate) and Stage 7 (Live Provider Smoke) inside local Docker containers via the `act` CLI runner.

---

## [0.0.1] - 2026-10-26 (Documentation & Governance Initialization)

### Platform Rebranding & Version Reset (`package.json`, `README.md`, `docs/README.md`)

- **Elixent Identity & Baseline Reset:** Transitioned platform package identity to `"name": "elixent"` at `"version": "0.0.1"`, establishing the clean-slate foundation for the Elixent Agentic Architecture & Documentation Engine.
- **Unified Living Documentation Index:** Re-indexed `README.md` and `docs/README.md` around the five living architecture specifications (`01`–`05`), active reference contracts, and operational guides while preserving canonical SSOT test metrics synchronization.

### Authoritative Living Architecture Specifications (`docs/architecture/`)

- **Published 5 Core Living Architecture Specifications:**
  - `01_architecture_vision_and_adrs.md` — Architectural vision, C4 container topology, and authoritative Architectural Decision Records (`ADR-001` to `ADR-005`).
  - `02_agent_orchestration_and_decision_engine.md` — `@langchain/langgraph` 7-stage state machine, `AgentGraphState` pure reducers, Unified Decisions API (`POST /v1/decisions`), `Conformal APS` classifier, and Justification-Driven `ATMS DAG`.
  - `03_workspace_ast_editor_and_vault_integration.md` — `IWorkspaceProvider` contract, Fence-Aware Heading Slicer, hybrid `AST + BM25` lexical search, `Multi-Hunk Ghost` CodeMirror 6 overlay, and Zero-Knowledge `vault_ref://` memory isolation.
  - `04_credit_metering_and_settlement_architecture.md` — Micro-credit (`BigInt`) token metering, atomic Upstash Redis Lua scripts, `StreamGovernor` (`500ms` hold & abort), `Flush-First Cold Start`, and asynchronous PostgreSQL settlement via `after()`.
  - `05_data_contracts_and_lugx_migration_plan.md` — Drizzle ORM schema contracts (`users`, `credit_ledger_transactions`, `project_decision_ledger`, `langgraph-checkpoints`), `getPgPool()` export, Redis keyspace contracts, and codebase transformation matrix.

### Active Execution Roadmap (`docs/Plans/`)

- **Published 12-Phase Execution Plan:** Established `docs/Plans/ELIXENT_EXECUTION_PLAN.md` defining the 12 commit-sized SRP phases and intra-phase sub-agent execution waves.

### Historical Baseline Archival & Governance Modernization (`docs/records/archive/lugx-v1/`, `docs/DOCUMENTATION_GUIDELINES.md`)

- **LUGX v1.0.0–v1.46.3 Baseline Archival:** Archived historical Day-0 founding records (`docs/records/archive/lugx-v1/foundation/`), historical release notes (`docs/records/archive/lugx-v1/CHANGELOG-LUGX-v1.md`), and historical remediation plans (`docs/records/plans/comprehensive-technical-remediation-plan-lugx-v1.md`).
- **Governance Alignment:** Updated `docs/DOCUMENTATION_GUIDELINES.md` and `scripts/sync-doc-metrics.mjs` to establish `docs/architecture/` as the authoritative living specification and ADR registry.

---

## Historical Archives

- **LUGX Legacy Baseline (v1.0.0 – v1.46.3):** For the complete historical release log prior to the Elixent v0.0.1 initialization, see [`CHANGELOG-LUGX-v1.md`](./records/archive/lugx-v1/CHANGELOG-LUGX-v1.md).