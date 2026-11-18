# AI Atomic Commit & Transactional Settlement Architecture

> [!NOTE]
> **Elixent Phase 11 & Phase 12 Migration Note (`v0.11.0` – `v0.12.0`):** In Phase 11 (`v0.11.0`) and Phase 12 (`v0.12.0`), the legacy server action `src/server/actions/ai-commit.ts` (`commitAIFileOperation`) was deprecated and permanently deleted from the repository. Document persistence after accepting AI hunk replacements now flows exclusively through incremental editor autosave (`useEditorAutosave` in `src/hooks/use-editor-autosave.ts` -> `PUT /api/files/:id` via `handleFileByIdPut` in `src/server/routes/files-api.routes.ts`, or Hono RPC `updateFileContent` in `src/server/actions/files.ts`) after atomic CodeMirror transactions (`acceptGhostHunk`, `acceptAllGhostHunks` in `src/components/editor/markdown/streaming-ghost.ts`, backed by `MultiHunkGhostState` in `src/components/editor/markdown/types.ts`), while micro-credit reservation and settlement execute server-side in `src/server/services/ai-settlement-service.ts` and `src/server/routes/agent.routes.ts` (mounted at `/api/agent/stream`).

## 1. Overview & Technical Objective

This document defines the architecture, invariant guarantees, and operational hardening for **Phase 8: AI Atomic Commit Inside File**.
The goal is to ensure a strictly verified, single-transaction atomic commit mechanism that binds the AI generation result to the file state, quota reservation settlement, and expected optimistic version/ETag without allowing partial document mutations, connection leaks, or quota desynchronization.

---

## 2. Invariant Guarantees

1. **Transactional Atomicity & Production Enforcement**:
   - File content update (`files` table), version increment, ETag generation, and reservation settlement (`aiReservations` table -> `committed`) execute inside a single transactional boundary (`txDb.transaction`).
   - If reservation settlement or file update fails, the entire transaction is rolled back.
   - In production (`NODE_ENV !== "test"`), transactional support via `txDb.transaction` is strictly required; any missing transaction driver triggers a hard exception rather than silently slipping into non-atomic fallbacks.

2. **Strict Ownership & File Association**:
   - The committing user must own both the target file and the AI reservation record.
   - The reservation record's `fileId` must match the target `fileId`.

3. **Optimistic Version, ETag Preconditions & Self-Session Healing**:
   - Optimistic concurrency control is enforced both at the initial validation check and atomically inside the update statement (`WHERE version = baseVersion`).
   - **Self-Session Healing (v1.14.0)**: If `currentFile.version !== expectedVersion` (due to an in-flight background auto-save before AI launch), but the server's `currentFile.content` matches the baseline `originalContent` from which the AI stream originated, the server safely adopts the current version (`baseVersion = fileCurrentVersion`) and increments atomically, preventing false 412 conflicts.
   - **Normalized ETag Verification**: ETag comparisons normalize quotation marks and weak prefixes (`W/`) to eliminate false serialization mismatches.
   - If a true concurrent write from another session occurs, the update yields zero rows, rolling back the transaction and triggering an explicit `412 conflict` response.
   - Conflict responses return minimal metadata (`version`, `etag`, `updatedAt`) without leaking full document payloads across the network.

4. **Adaptive Multi-Driver Transaction Client & Connection Pool Bounds**:
   - The transactional client (`src/server/db/transactional.ts`) adaptively selects the appropriate driver based on the target `DATABASE_URL`:
     - **Neon Cloud (`neon.tech`)**: Uses `@neondatabase/serverless` WebSocket Pool with bounded resource limits (`max: 5`, `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`) to prevent orphaned transactions under cloud network latency.
     - **Local & CI PostgreSQL**: Uses `pg.Pool` (`node-postgres`) to execute native ACID transactions without WebSocket overhead or artificial mocks.
   - Evaluated dynamically via a lazy proxy singleton to support test-environment binding (`TEST_DATABASE_URL`).

5. **Idempotency & Decoupled File Commit (Phase 11)**:
   - In Phase 11, the server marks the quota reservation as `committed` during stream execution (prior to the terminal `{ type: "done" }` frame or upon post-TTFT completion).
   - Document persistence is decoupled from the AI quota reservation lifecycle: once the user accepts ghost hunks locally, `useEditorAutosave` (`src/hooks/use-editor-autosave.ts`) dispatches `PUT /api/files/:id` (`handleFileByIdPut` in `src/server/routes/files-api.routes.ts`) with `If-Match` / `expectedVersion`. If `If-Match` and `expectedVersion` are missing, `handleFileByIdPut` rejects with `428 Precondition Required`; if the version or ETag has diverged, it returns `412 Conflict` with the authoritative server state.
   - When the version and ETag preconditions match (`WHERE version = currentVersion`), `handleFileByIdPut` (and Hono RPC `updateFileContent` in `src/server/actions/files.ts`) executes an optimistic-locking `UPDATE` incrementing `version` and recomputing `etag` in PostgreSQL, guaranteeing consistent document persistence independently of prior AI credit settlement.

6. **Server-First Commit & Markdown Source of Truth**:
   - The client editor maintains ephemeral preview buffers during generation using pure Markdown.
   - Stream completion does NOT commit: the validated Markdown output is parked in `preview_ready` until an explicit user decision.
   - On user **Accept** (`acceptGhostHunk` or `acceptAllGhostHunks` in `src/components/editor/markdown/streaming-ghost.ts`), the editor applies an isolated atomic CodeMirror replacement (`Transaction.userEvent` + `isolateHistory.of("full")`) so Ctrl+Z reverts the edit in a single undo step, and marks the buffer dirty so `useEditorAutosave` persists the raw (or client-encrypted) Markdown via `PUT /api/files/:id`.
   - In case of network failure or 412 conflict, the ephemeral preview is dismantled and the document remains in its pristine state.
   - On user **Reject** or **Retry**, no document mutation occurs at all; the quota reservation is settled as consumed per the Explicit Settlement Policy ([`ai-quota-reservation-lifecycle.md`](./ai-quota-reservation-lifecycle.md) §4-D).

7. **Autosave Debounce Cancellation & Sync Isolation**:
   - Starting an AI operation immediately cancels any pending background auto-save timers (`debouncedAutoSave.cancel()`) to prevent version collisions.
   - Background autosave and cross-tab sync broadcasts are suppressed while `aiStream.isLoading` / `aiStream.isCommitting` is active **or while the session rests in `preview_ready` awaiting the user's decision**, and resume only after the editor generation and file version are updated with the server's response.

8. **Zero-Knowledge Encrypted AI Commit Invariant (`src/hooks/use-ai-stream.ts`, `src/server/routes/files-api.routes.ts`, `src/server/actions/files.ts`)**:
   - **Client-Side Envelope Encryption**: When the targeted file is encrypted (`isEncrypted === true`), the client editor intercepts the accepted AI markdown text in `useAIStream`. The content is encrypted locally via the Web Worker using the volatile Master Key, a fresh random 12-byte IV, and AAD (`vault:file:${userId}:${fileId}`).
   - **Fail-Closed Server Gate**: `PUT /api/files/:id` (`handleFileByIdPut` in `src/server/routes/files-api.routes.ts`) and the Hono RPC handlers in `src/server/actions/files.ts` (`updateFileContent` / `toggleFileEncryption` via `src/server/routes/rpc.routes.ts`) enforce a strict defense-in-depth gatekeeper: if `currentFile.isEncrypted` is true and `encryptionMetadata?.iv` is missing, the server strictly rejects the write with HTTP 400 (`"Cannot update content of an encrypted file without valid encryption metadata"` / `"Encrypted files require valid encryptionMetadata with an IV"`), completely preventing plaintext data leaks to the database.
   - **Atomic Ciphertext & Metadata Persistence**: The encrypted ciphertext payload and the structured `encryptionMetadata` envelope are updated atomically alongside the version increment, ETag generation, and reservation settlement inside `txDb.transaction`.

---

## 3. Component Reference & Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Editor as Editor (MarkdownEditor / EditorAdapter)
    participant Hook as useAIStream / useEditorAutosave
    participant Server as Hono Server (/api/agent/stream & PUT /api/files/:id)
    participant DB as Neon Database (txDb)

    User->>Editor: Trigger AI Action (e.g. improve/summarize)
    Editor->>Hook: Start stream (Selection: [from, to])
    Hook->>Editor: Attach Ghost / Ephemeral Preview (Zero doc mutation)
    Hook->>Server: POST /api/agent/stream & StreamGovernor Reserve
    Server-->>Hook: Stream tokens -> MultiHunkGhostState & Credit Settlement
    Hook->>Editor: Accept Hunk (acceptGhostHunk / acceptAllGhostHunks, 1 History Step)
    Hook->>Server: PUT /api/files/:id (useEditorAutosave, If-Match / expectedVersion)
    
    rect rgb(240, 248, 255)
        Note over Server,DB: Transactional Boundary
        Server->>DB: Check Ownership, Version & ETag (handleFileByIdPut)
        alt Precondition Failed (Version / ETag mismatch)
            Server-->>Hook: 412 Conflict (currentVersion, serverEtag, updatedAt)
            Hook->>Editor: Trigger Conflict Resolution / Sync Rebase
        else Precondition Valid
            Server->>DB: BEGIN TRANSACTION
            Server->>DB: UPDATE files SET content, version+1, etag WHERE id AND userId AND version = currentVersion
            Note right of Server: AI credits settled via ai-settlement-service.ts & credit_ledger_transactions
            Server->>DB: COMMIT TRANSACTION
            Server-->>Hook: 200 OK { version, etag, updatedAt }
            Hook->>Editor: Update Synced Version & ETag Metadata
        end
    end
```

---

## 4. Verification & Test Evidence

The atomic commit guarantees are verified across the following automated test suites:
- `src/test/ai/ai-atomic-commit.integration.test.ts`: **Real PostgreSQL Integration Test** executing the actual production functions (`updateFileContent` in `src/server/actions/files.ts`, and `flushPendingSettlementsToPostgres` / `getUserCreditBalance` in `src/server/services/ai-settlement-service.ts`) against real PostgreSQL tables, enforcing foreign keys, live interactive transactions, and rollback verification.
- `src/test/ai/ai-server-atomic-commit.test.ts`: Covers auth verification, parameter validation, file-reservation association, idempotent retries, ETag/version conflict guards, production transaction requirement, and transactional execution/rollback.
- `src/test/editor/editor-atomic-commit.test.ts`: Verifies partial and full replacement single undo invariants, conflict rollbacks, ephemeral ghost preview isolation, and pristine document preservation upon server failure.
- `src/test/ai/ai-quota-idempotency.test.ts` & `src/test/ai/ai-ops.refund.test.ts` & `src/test/ai/ai-ops.integrity.test.ts`: Verifies quota reservation state machine, cross-midnight resilience, and concurrency idempotency.

---

## 5. Technical Debt & Future Considerations

1. **Transaction Pool Scaling**:
   - The current `max: 5` Pool configuration in `src/server/db/transactional.ts` is sized for serverless container instances. Under future horizontal serverless scaling with high concurrency per instance, connection pooling may need PgBouncer / Neon connection pooling proxy integration.
2. **Conflict UI Differentiation**:
   - The conflict response intentionally omits `content` to optimize network bandwidth and prevent data leaks. If a three-way merge dialog is designed specifically for AI conflicts in the future (similar to `useSync` conflict modal), a dedicated comparison endpoint should be created rather than transmitting document payloads in all conflict error states.
3. **Driver-Level Unit Test Mocking**:
   - In `NODE_ENV === "test"`, a sequential fallback path remains to accommodate mock DB environments where interactive transactions are simulated. Full end-to-end integration tests run against real Postgres to ensure real transactional semantics.
