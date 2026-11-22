# UI Streaming Architecture & Implementation Specification

## 1. Executive Overview

This document specifies the architecture and implementation of the **Hybrid Streaming & Snapshot Architecture** in the LUGX platform, restoring real-time perceived UI streaming while guaranteeing absolute data integrity, single-action atomic undo, idempotent quota accounting, and optimistic version protection.

### Primary System Invariant:
> **No network chunk is ever written directly to the active document state, the local IndexedDB database, or the remote database.**
> Streaming tokens update an isolated in-memory ephemeral buffer and view-layer preview overlay. The document is committed in exactly one atomic transaction only after stream completion and server version validation.

---

## 2. Readiness Gates Compliance Matrix (G1 - G13)

| Gate | Specification | Implementation File(s) | Status |
| :--- | :--- | :--- | :--- |
| **G1** | Idempotent transaction record (`credit_ledger_transactions`, replacing legacy `ai_reservations`) with unique `operationId` constraint and conditional state transitions (`RESERVED`, `SETTLED`, `ABORTED_REFUNDED`, `EXPIRED_RELEASED`). | `src/server/db/schema/credit-ledger.ts`<br>`src/server/db/migrations/0013_migrate_to_credit_ledger.sql`<br>`src/server/services/ai-settlement-service.ts` | **Implemented & Consolidated (v0.12.0)** |
| **G2** | Atomic hunk acceptance (`acceptGhostHunk`, `acceptAllGhostHunks` with `MultiHunkGhostState`) and incremental debounced document sync (`useEditorAutosave` -> `PUT /api/files/:id`), replacing legacy single-range server commits. | `src/components/editor/markdown/streaming-ghost.ts`<br>`src/components/editor/markdown/types.ts`<br>`src/hooks/use-editor-autosave.ts`<br>`src/server/routes/files-api.routes.ts` | **Implemented & Consolidated (v0.12.0)** |
| **G3** | Dual-Side Inversion Stop Protocol (TD-05): Instant client abort (< 50ms), reader cleanup, server-side pre-TTFT refund and post-TTFT autonomous commit. | `src/hooks/use-ai-stream.ts`<br>`src/lib/ai/stream-handler.ts`<br>`src/server/routes/agent.routes.ts`<br>`src/test/ai/ai-stream-abort-latency.test.ts` | **Implemented & Hardened (v0.12.0)** |
| **G4** | Deterministic reservation and settlement lifecycle governed by `ai-settlement-service.ts` and Redis metering (`stream-governor.ts`, `lua-scripts.ts`, `cold-start.ts`), superseding the deleted `src/server/actions/ai-ops.ts`. | `src/server/services/ai-settlement-service.ts`<br>`src/lib/metering/stream-governor.ts`<br>`src/lib/metering/lua-scripts.ts`<br>`src/lib/metering/cold-start.ts` | **Implemented & Consolidated (v0.12.0)** |
| **G5** | Auto-save and sync suspension invariants during active streaming, committing, and conflict states. | `src/hooks/use-editor-orchestrator.ts`<br>`src/client/routes/editor-page.tsx` | **Implemented** |
| **G6** | Stale session and generation guard (`editorGeneration`) preventing old callbacks from applying to new state. | `src/lib/ai/stream-session.ts`<br>`src/hooks/use-ai-stream.ts` | **Implemented** |
| **G7** | Production path integration tests calling real settlement services and schema entities. | `src/test/ai/ai-quota-idempotency.test.ts`<br>`src/test/ai/ai-server-atomic-commit.test.ts`<br>`src/test/metering/ai-settlement-service.unit.test.ts` | **Implemented** |
| **G8** | Multi-byte UTF-8 split boundary tests, NDJSON line framing tests, and 412 conflict tests. | `src/test/ai/ai-stream-parser.test.ts`<br>`src/test/ai/ai-stream-session.test.ts`<br>`src/test/editor/editor-atomic-commit.test.ts` | **Implemented** |
| **G9** | Editor orchestration and authoritative write integration tests with zero regression. | `src/test/editor/editor-orchestration.integration.test.ts`<br>[`docs/architecture/sync/editor-sync-orchestration.md`](../architecture/sync/editor-sync-orchestration.md) | **Validated** |
| **G10** | Feature Flag gating (`AI_STREAMING_ENABLED`) with zero sensitive prompt leakage in server logs. | `src/config/features.config.ts`<br>`src/server/routes/agent.routes.ts` | **Implemented & Enforced** |
| **G11** | Zero-Knowledge AI Safety Gatekeeper: Mandatory non-empty `fileId` with HTTP 400 (`MISSING_FILE_ID`), database ownership check, amber UI badge (`ai-encrypted-badge`), and server-side check against `userVaultProfiles.allowAIOnEncryptedFiles` (default `true` since migration `0014`) rejecting encrypted files with HTTP 403 (`AI_PROHIBITED_ON_ENCRYPTED_FILES`) when disabled or profile missing. | `src/components/editor/ai-toolbar.tsx`<br>`src/hooks/use-editor-orchestrator.ts`<br>`src/server/routes/agent.routes.ts`<br>`src/test/ai/ai-stream-fileid-governance.test.ts` | **Implemented & Hardened (v0.12.0)** |
| **G12** | Architectural Agent Presentation & Incremental Sync: Integration of `AgentChatPanel`, `HITLQuestionCard`, and debounced incremental autosave via `useEditorAutosave` (800ms–1000ms), purging legacy 5-operation UI references from `src/components` and `src/hooks` (with legacy `src/app` routes replaced by `src/server/routes/` and `src/client/routes/`). | `src/components/agent/chat-panel.tsx`<br>`src/components/agent/hitl-question-card.tsx`<br>`src/components/editor/ai-toolbar.tsx`<br>`src/hooks/use-ai-stream.ts`<br>`src/hooks/use-editor-orchestrator.ts` | **Implemented & Verified (v0.11.0 / Phase 11)** |
| **G13** | Final Purge of Legacy 5-Operation Modules & Full Test Suite Migration: Permanent deletion of the 7 legacy 5-operation modules (`api/ai/stream/route.ts`, `pending-operation-store.ts`, `preview-buffer.ts`, `prompts.ts`, `quota-settlement-reducer.ts`, `ai-commit.ts`, `ai-ops.ts`), cleanup of `models.config.json`, `tiers.config.ts`, `ai/client.ts`, and `ai-contracts.ts`, and migration of all unit, live, and E2E test suites. | `src/config/models.config.json`<br>`src/config/tiers.config.ts`<br>`src/lib/ai/client.ts`<br>`src/server/services/ai-settlement-service.ts`<br>`src/types/ai-contracts.ts`<br>`e2e/specs/06`–`09`, `12` | **Implemented & Verified (v0.12.0 / Phase 12)** |

---

## 3. Dual Atomicity & Incremental Sync Model

To prevent distributed transaction failure modes, the system decouples server quota settlement from client document persistence:

```mermaid
flowchart TD
    Client["Client Session: streaming_hunks -> preview_ready (Parked)"] --> UserChoice{"User Decision Trigger"}
    UserChoice -->|"Accept Hunk(s) (acceptGhostHunk / acceptAllGhostHunks)"| Step1["Step 1: Local Atomic CodeMirror Transaction"]
    UserChoice -->|"Reject Hunk(s) (rejectGhostHunk / rejectAllGhostHunks)"| SettleConsumed["Quota Settled Server-Side as Consumed<br/>Dismantle Ghost Hunk(s) (Doc Pristine, No Refund)"]
    
    Step1 --> Dismantle["Dismantle Accepted Ghost Hunk Decoration"]
    Step1 --> Undo["Push 1 Isolated History Entry (Undoable with single Ctrl+Z)"]
    Step1 --> IDBSync["Write Updated Markdown to IndexedDB (localRevision += 1)"]
    
    IDBSync --> Step2["Step 2: Debounced Incremental Sync (useEditorAutosave 800-1000ms)"]
    Step2 --> VerifyVer["PUT /api/files/:id with expectedVersion & If-Match ETag"]
    VerifyVer -->|Success (200 OK)| CleanState["Adopt Server ETag & Version (Lean CAS)"]
    VerifyVer -->|Version Conflict (412)| ThreeWay["Automated Diff3 3-Way Merge or Conflict Resolution"]
```

---

## 4. Session Finite State Machine (FSM)

The agent session transitions through 9 deterministic states governed by `src/lib/ai/stream-session.ts`:

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> running_graph: startAgentSession() (POST /api/agent/stream)
    running_graph --> awaiting_hitl: interrupt frame received (question_queue populated)
    awaiting_hitl --> running_graph: resumeAgentInterrupt() (POST /api/agent/stream resumePayload)
    running_graph --> paused_insufficient_credits: interrupt frame (INSUFFICIENT_CREDITS)
    paused_insufficient_credits --> running_graph: resumeInsufficientCreditsTask() (checkpoint resume)
    running_graph --> streaming_hunks: section synthesis active (ghost hunks rendered)
    streaming_hunks --> preview_ready: graph execution complete (all hunks parked)
    
    preview_ready --> completed: acceptAllGhostHunks() or all hunks accepted
    preview_ready --> aborted: rejectAllGhostHunks() or all hunks rejected

    running_graph --> aborted: stopAIOperation() (client abort)
    awaiting_hitl --> aborted: stopAIOperation() (client abort)
    paused_insufficient_credits --> aborted: stopAIOperation() (client abort)
    streaming_hunks --> aborted: stopAIOperation() (client abort)

    running_graph --> failed: Stream error / rate limit / runtime failure
    awaiting_hitl --> failed: Network or validation failure
    paused_insufficient_credits --> failed: Resume validation or network failure
    streaming_hunks --> failed: Stream connection dropped

    completed --> idle: resetAI() / recycled
    aborted --> idle: resetAI() / recycled
    failed --> idle: resetAI() / recycled
    paused_insufficient_credits --> idle: resetAI() / recycled
```

---

## 5. NDJSON & Stream Framing Protocol Specification

The `/api/agent/stream` endpoint (`src/server/routes/agent.routes.ts`) streams framed events over an HTTP response:

### 5.0 Request Contract & Gatekeeper Validation
Requests to `/api/agent/stream` validate the JSON payload against `agentStreamRequestSchema`:
- `prompt` (string, required on new turns): The user instruction text (max 100,000 characters).
- `operationId` (string, optional/generated): Unique identifier for the reservation and ledger idempotency.
- `fileId` / `targetFileIds` (required): Target document UUID(s). Missing or empty values fail closed with HTTP `400 Bad Request` (`MISSING_FILE_ID`).
- `threadId` / `projectId`: LangGraph thread and project workspace identifiers.

#### Server-Side Validation Pipeline:
1. **Authentication:** Validates server session with `getUser()`. Returns HTTP 401 if unauthenticated.
2. **Mandatory fileId Check (LUGX-085):** Rejects missing/empty `fileId` with HTTP 400 (`MISSING_FILE_ID`).
3. **Database Ownership & State:** Queries `schema.files` for `id = fileId` AND `userId = user.id` AND `deletedAt IS NULL`. Missing files return HTTP 404.
4. **Zero-Knowledge Gatekeeper:** If `targetFile.isEncrypted`, queries `schema.userVaultProfiles`. If `allowAIOnEncryptedFiles` is not explicitly `true`, rejects with HTTP 403 (`AI_PROHIBITED_ON_ENCRYPTED_FILES`) before token consumption or quota reservation.
5. **Credit Lease Initialization:** Initializes the Redis lease via `StreamGovernor.initializeLease` / `executeReserveOrExtend`.

### 5.1 Meta Event
Emitted immediately upon successful quota reservation before AI generation starts:
```json
{"type":"meta","sessionId":"session_abc123","reservationId":"res_def456","operationId":"op_ghi789"}
```

### 5.2 Delta Event
Emitted for each incoming token or text chunk from Gemini:
```json
{"type":"delta","text":"Partial generated text..."}
```

### 5.3 Done Event
Emitted on clean EOF stream termination:
```json
{"type":"done"}
```

### 5.4 Error Event
Emitted if an error occurs during stream transmission:
```json
{"type":"error","code":"STREAM_FAILED","message":"Connection timed out","retryable":true}
```

---

## 6. Failure Recovery & Quota Idempotency

### 6.1 Server-Authoritative Credit Settlement
Client financial authority is revoked: `src/client/rpc-client.ts` exposes zero credit reservation or settlement functions, and legacy word-quota helpers (`reserveAIQuota`, `commitAIReservation`, `refundAIReservation`, `refundUsage`, `expireStaleReservations`, `getAIReservationStatus`, `reserveAndUpdateUsage`) were permanently removed from `src/server/services/ai-settlement-service.ts`. Settlement is driven authoritatively by `/api/agent/stream` (`StreamGovernor` in `src/lib/metering/stream-governor.ts`), `src/lib/metering/lua-scripts.ts`, and `src/server/services/ai-settlement-service.ts`:
- **Pre-TTFT System Failure / Disconnect (`ttftMs === null`):** Server triggers `StreamGovernor.settle("ABORTED")` (`executeSettleOperation`):
  - **Idempotency:** `StreamGovernor.settle` caches `this.settleResult`, while `flushPendingSettlementsToPostgres` uses `INSERT ... ON CONFLICT (operation_id) DO NOTHING`, eliminating double-refund risks.
  - **Micro-Credit Restoration:** Refunds the unused reserved micro-credit hold back to the Redis wallet (`credit:wallet:${userId}`) and reconciles `users.credit_balance_micro` via `flushPendingSettlementsToPostgres`.
- **Post-TTFT Disconnect / Stream Completion (`ttftMs !== null`):** Server autonomously executes `StreamGovernor.settle("SETTLED")` (`executeSettleOperation`) and `flushPendingSettlementsToPostgres`, settling consumed tokens and refunding any unconsumed surplus.
- **Decoupled Incremental Document Sync (`useEditorAutosave`):** User acceptance applies hunks locally and syncs the updated document via `PUT /api/files/:id` independently of server-side quota settlement.

### 6.2 Pending Settlement Sweeper (30s Grace Window)
`handleExpireReservationsCron` in `src/server/routes/cron.routes.ts` scans `credit:dirty_wallets` in Redis under distributed lock (`acquireCronLock`) and drains pending settlement entries in `credit:pending_settlements:${userId}` older than `DIRTY_SETTLEMENT_GRACE_MS` (`30_000` ms) into PostgreSQL via `flushPendingSettlementsToPostgres`, while ephemeral leases (`credit:lease:${operationId}`) expire automatically via Redis TTL (`LEASE_TTL_SECONDS`). Authorized via `CRON_SECRET` on `/api/cron/expire-reservations`.

### 6.3 Streaming Terminality & Watchdogs (v1.5.0 Amendment)

Runtime remediation closed four compounding defects that produced an invisible ghost
preview and a perceived infinite send/receive deadlock (full root-cause matrix in
`AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md` §5a):

- **Single terminal callback, absolutely:** rejections inside the async atomic-commit
  pipeline are routed back into `onError` instead of becoming unhandled promise
  rejections — the ghost is always dismantled, the reservation refunded, and the in-flight
  trigger mutex released.
- **Provider-side cancellation:** the `AbortSignal` is forwarded into Gemini SDK request
  options, so aborts and disconnects terminate the upstream socket.
- **Watchdogs:** first-chunk (`20s`) and absolute-duration (`120s`) ceilings fail closed
  with structured errors (`AI_STREAM_FIRST_CHUNK_TIMEOUT`, `AI_STREAM_DURATION_EXCEEDED`).
- **Preview buffer integrity:** only the latest delta is appended to
  `EphemeralPreviewBuffer` (previously the accumulated text was re-appended per chunk,
  growing it quadratically).

New verification suites: `src/test/ai/ai-stream-completion-terminality.test.ts` (terminality,
watchdog fail-closed) and `src/test/ai/ai-client.test.ts` (signal reaches
SDK request options).

---

## 7. Configuration & Feature Flags

Feature flags are centralized in `src/config/features.config.ts`:
```typescript
export const FEATURES = {
    AI_STREAMING_ENABLED: (import.meta.env?.VITE_AI_STREAMING_ENABLED ?? process.env.VITE_AI_STREAMING_ENABLED) === "true",
    RESERVATION_TTL_MS: 5 * 60 * 1000,
    PREVIEW_BUFFER_MAX_CHARS: 500_000,
};
```
`AI_STREAMING_ENABLED` defaults to `false`; as of v1.5.0 the route handler actively
branches on it — when disabled, generation runs through the `processWithAI` buffered
accumulator path and is framed to the client as a single NDJSON chunk (identical wire
protocol, non-incremental delivery). All modules, schema migrations, and contracts remain
tested and ready for progressive canary activation by setting the flag to `true`.


---

## 8. Unified Agent SSE Stream Protocol (`/api/agent/stream`)

As part of the Elixent autonomous agent architecture (`ELIXENT-ARCH-03` §5.1, `ELIXENT-ARCH-02` & `SRS-01`), the unified route `POST /api/agent/stream` serves server-authoritative Server-Sent Events (SSE) for `ElixentNativeGraphRunner` state machine execution:

### 8.1 Route Handler & Stream Execution Invariants
- **Hono SSE Route Handler (`agentRoutes` / `handleAgentStreamPost`):** Served as a persistent Web-standard Hono `ReadableStream<Uint8Array>` handler (`POST /api/agent/stream` in `src/server/routes/agent.routes.ts`) with `AbortController` cancellation bound to `req.signal` and `ReadableStream.cancel()`, single-layer open-ceiling metering inside graph nodes (`withMeteredNodeGate`; outer route-level `StreamGovernor` purged in Phase 4 / `v0.27.0`), `CloudPostgresWorkspaceProvider` injection, and background PostgreSQL settlement flush via `scheduleAfterResponse()` (ADR-007 ALS).
- **Pre-Execution Auth Guard:** Invokes `requireAuthenticatedUser()` prior to reading the request body; unauthenticated requests fail immediately with RFC 7807 `401 Unauthorized` (`urn:problem-type:unauthorized`).
- **Fail-Closed Stream Rate Limiting:** Enforces `aiStreamRateLimiter.limit(user.id)`; returns RFC 7807 `429 Too Many Requests` if the user exceeds limits or Redis is unavailable.
- **Strict Payload Schema (`src/core/agent/stream-payload.ts`):** Validated via `parseAgentStreamPayload`:
  - `threadId`: string (max 256 chars, required).
  - `workspaceId`: string (max 256 chars, optional; required if `projectId` is omitted).
  - `projectId`: string (max 256 chars, optional legacy alias for `workspaceId`).
  - `turnId`: string (max 256 chars, optional; defaults to route `operationId`).
  - `prompt`: string (max 100,000 chars, optional).
  - `targetFileIds`: string array (max 100 files, required).
  - `permissionMode`: `"safe" | "semi_auto" | "full_auto"` (optional, defaults to `"safe"`).
  - `selectedSystem2ModelId`: string (max 256 chars, optional, defaults to `"google/gemini-3.8-flash"`).
  - `resumePayload`: unknown (optional, passed to `elixentAgentGraph.stream({ resumeFromCheckpoint: true, stateOverrides: { clarification_answers: resumePayload } }, runtimeContext)`).
  - `ephemeralVaultPayloads`: Record<string, string> (max 100 keys, max 2MB per document, optional).
  - `liveDocumentSnapshots`: Record<string, string> (max 100 keys, max 2MB per document, optional).
  Schema violations return RFC 7807 `400 Bad Request` with `invalidParams` details.

### 8.2 SSE Event Framing (`text/event-stream`)
The route returns an SSE stream with headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, and `X-Accel-Buffering: no`, decoded client-side by `consumeAgentStream` (`src/lib/ai/stream-handler.ts`):

| Event | Frame Structure | Trigger / Semantics |
| :--- | :--- | :--- |
| `start` | `event: start\ndata: {"type":"start","sessionId":"...","threadId":"...","operationId":"...","correlationId":"..."}\n\n` | Emitted immediately upon successful connection and stream initialization. |
| `update` | `event: update\ndata: {"type":"update","chunk":{...}}\n\n` | Emitted for intermediate graph execution steps, messages, and state transitions (and direct `direct_response_node` updates via `emitSseEvent`). |
| `ghost_hunk_proposed` | `event: ghost_hunk_proposed\ndata: {"type":"ghost_hunk_proposed","fileId":"...","headingSlug":"...","hunks":[...]}\n\n` | Emitted via `emitSseEvent` by `workspace_mutator_node` in `safe` mode; decoded by `onGhostHunkProposed` in `stream-handler.ts` and consumed by `useAIStream`, upserting into the active editor or persisting cross-file hunks (preserving raw offsets via `preserveRawOffsets = true`) in `ghostHunksByFileId` (`pending_ghost_hunks_${workspaceId}`). |
| `file_mutated` | `event: file_mutated\ndata: {"type":"file_mutated","fileId":"...","relativePath":"...","action":"created"\|"deleted"\|"updated"}\n\n` | Emitted via `emitSseEvent` on autonomous file creation, deletion, or unencrypted update; decoded by `onFileMutated` in `stream-handler.ts`, recording turn-linked `IDBOperation` snapshots (`workspaceId`, `threadId`, `turnId`, `postTurnEtag`), updating `mutatedTurns`, and resyncing the active editor buffer when applicable. |
| `vault_file_commit_required` | `event: vault_file_commit_required\ndata: {"type":"vault_file_commit_required","fileId":"...","relativePath":"...","mergedContent":"..."}\n\n` | Emitted via `emitSseEvent` when an encrypted document or `decisions.ledger.json` requires client-side re-encryption; decoded by `onVaultFileCommitRequired` in `stream-handler.ts`, recording the pre-turn `IDBOperation`, encrypting `mergedContent` via `SyncCryptoGateway.encryptOutbound`, and committing via `toggleFileEncryption`. |
| `interrupt` | `event: interrupt\ndata: {"type":"interrupt","threadId":"...","operationId":"...","nodeId":"...","stepIndex":0,"interruptReason":"...","interruptPayload":{...},"interrupts":[...]}\n\n` | Emitted when `ElixentNativeGraphRunner` yields `status: "INTERRUPTED"` for HITL clarification, Anti-Domino confirmation, file deletion approval, or `INSUFFICIENT_CREDITS` pause. |
| `error` | `event: error\ndata: {"type":"error","code":"STREAM_EXECUTION_ERROR"\|"STREAM_RUNTIME_ERROR","message":"..."}\n\n` | Emitted on unhandled graph or runtime exceptions; aborts the stream. |
| `done` | `event: done\ndata: {"type":"done","threadId":"...","operationId":"..."}\n\n` | Emitted upon clean graph completion (suppressed when interrupted or aborted) to signal EOF to the client. |

### 8.3 Metering & Memory Hygiene
- **Single-Layer Open-Ceiling Node Metering (`SRS-04 §3.2 REQ-METER-02`):** Route-level `StreamGovernor` framing was purged from `src/server/routes/agent.routes.ts` and `AgentRuntimeContext` in Phase 4 (`v0.27.0`) so SSE state frames are never double-billed; all model-consuming graph nodes meter strictly once via `withMeteredNodeGate` using `ctx.selectedSystem2ModelId` (for System 2 nodes) and emit native `INSUFFICIENT_CREDITS` interrupts upon wallet depletion.
- **Background Settlement via `scheduleAfterResponse`:** Asynchronous credit settlement persistence is queued via `scheduleAfterResponse(async () => { await flushPendingSettlementsToPostgres(user.id); })`, decoupling database write latency from client stream closure.
- **Zero-Knowledge Buffer Cleansing:** Decrypted file plaintexts loaded into `EphemeralVaultMemoryMap` via `runWithEphemeralVaultScope` are deterministically wiped (`Buffer.fill(0)`) in both normal completion and stream abort/cancel handlers via `zeroOutEphemeralVaultMemory()`.

---

## 9. Architectural Agent Chat Panel, Multi-Tab Ghost Review, Decision Graph UI & Two-Tier Undo (Phases 11, 4 & 5)

Phases 11, 4, and 5 (`v0.28.0`) complete the interactive presentation, System 2 model controls, permission modes, credit-exhaustion recovery, multi-tab ghost review, interactive decision graph, and turn-linked undo surfaces:

### 9.1 Agent Chat Panel (`src/components/agent/chat-panel.tsx`)
- **Graph Execution Progress:** Ephemeral visual indicator displaying active graph stages and status (`idle`, `running_graph`, `awaiting_hitl`, `paused_insufficient_credits`, `streaming_hunks`, `preview_ready`, `completed`, `aborted`, `failed`).
- **System 2 Model Selector & Permission Modes (Phase 4 / `v0.27.0`):** Populates `agent-system2-model-select` dynamically from `src/config/models.config.json` entries where `executionMode === "STREAMING_GENERATIVE"` (displaying input/output credits per 1K tokens), renders the 3-mode permission selector (`safe`, `semi_auto`, `full_auto` via `agent-permission-mode-*`), and displays the `INSUFFICIENT_CREDITS` recovery banner (`agent-insufficient-credits-card` + `agent-resume-task-button`) to resume from the saved checkpoint via `resumeInsufficientCreditsTask`.
- **Two-Tier Rollback & ZK Notice Controls (Phase 5 / `v0.28.0`):** Displays `Turn Mutations` cards (`agent-turn-mutations`) with per-turn **`Revert Turn`** (`agent-revert-turn-${turnId}`), header **`Revert Session`** (`agent-revert-session-button`), and the one-time transient ZK decryption notice (`agent-zk-ai-notice`, persisted under `elixent_zk_ai_notice_shown`).
- **ATMS Decision Ledger (`master_ledger`):** Live viewer rendering committed architectural decisions, rationale summaries, and evaluated alternatives with exclusion reasons.
- **Prompt Composer & Lifecycle Controls:** Provides session initiation, abort (`stopAIOperation`), reset (`resetAI`), and vault lock status badges with automatic dark-theme styling.

### 9.2 Human-in-the-Loop Clarification Gate (`src/components/agent/hitl-question-card.tsx`)
- **Diagnostic Clarification Batches:** Renders clarifying question batches emitted by `hitl_clarification_node` upon native `INTERRUPTED` suspension.
- **Contractual Response Validation:** Validates answers in real time against `ClarificationResponseSchema` before enabling the submit action.
- **Stateless Resumption:** Submits validated user responses to `/api/agent/stream` passing `resumePayload`, resuming the graph execution thread with zero duplicate billing.

### 9.3 Client Hook Orchestration, Multi-Tab Review & Decision Graph (`useAIStream`, `useEditorOrchestrator`, `WorkspaceTabBar`, `DecisionGraphExplorer`)
- **Decoupled Hook Orchestration (`src/hooks/use-ai-stream.ts` & `src/hooks/use-editor-orchestrator.ts`):** Purged legacy client-side `synthesizeAgentSectionContent` (`BUG-03`); `useAIStream` handles workspace-scoped pre-stream vault hydration (`hydrateWorkspaceVaultPayloads`), cross-file `ghostHunksByFileId` persistence (`pending_ghost_hunks_${workspaceId}`), `onGhostHunkProposed`, `onFileMutated`, and `onVaultFileCommitRequired`. `useEditorOrchestrator` integrates with `WorkspaceTabsProvider` (`openTab`, `updateTabState`, `registerSaveFlushHandler`, `registerDiscardFlushHandler`), `hydrateGhostHunksForFile`, and `INV-UNDO-SYNC` (`handleRevertTurn`, `handleRevertSession` via `syncRollback.rollbackAgentTurn`).
- **Multi-Tab Workspace Shell & Exit Guard (`workspace-tab-bar.tsx`, `unresolved-edits-tracker.tsx`, `pending-edits-exit-modal.tsx`, `workspace-layout.tsx`):** Persists unresolved ghost hunks across tab closures, surfaces `"N Unresolved Edits in M Files"` in both `WorkspaceTabBar` and `Sidebar`, and blocks workspace exits with `Save & Leave`, `Discard & Leave`, and `Stay` via TanStack Router `useBlocker` (zero `src/client/router.tsx` import per `DEF-13`) + `beforeunload`.
- **Interactive Decision Graph & Workspace ZK Guard (`decision-graph-explorer.tsx`, `sidebar.tsx`, `workspace-decryption-warning-modal.tsx`, `file-context-menu.tsx`):** Native SVG topological DAG explorer with clickable Bézier edges, Inspector Drawer, depth filtering (`1 Hop`, `2 Hops`, `Full Chain`), `#headingSlug` jump scrolling (`adapter.scrollToHeading`), workspace ZIP export, and all-or-nothing encrypted workspace decryption confirmation (`decryptEntireWorkspaceRpc`).
- **Programmatic Transaction Isolation:** Dispatches all ghost hunk applications inside `onProgrammaticTransaction`, raising `isProgrammaticUpdateRef` in `useEditorOrchestrator` to prevent false classification as manual user edits.
- **Incremental Sync Contract (412 Elimination):** Ghost hunk acceptance writes directly to local IndexedDB (`localRevision += 1`) and notifies `useEditorAutosave`, coalescing multiple rapid hunk acceptances into a single debounced server save (800ms–1000ms) with matching `expectedVersion`, permanently eliminating self-inflicted 412 Precondition Failed conflicts.

### 9.4 Real-Time Micro-Credit Balance Presentation
- **Server-Authoritative Ledger:** Dashboard (`src/client/routes/dashboard-page.tsx`) and Account (`src/client/routes/account-page.tsx`) pages read live balances via `getCreditBalance()` from `@/client/rpc-client`, invoking `GET /api/rpc/billing/credit-balance` backed server-side by `getUserCreditBalance(user.id)` in `src/server/services/ai-settlement-service.ts`.
- **Percentage Available Indicator:** Renders visual progress bar comparing `currentCredits` against `TIER_LIMITS[tier].creditsDisplay`.
