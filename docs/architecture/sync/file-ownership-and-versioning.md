# File Ownership Enforcement, Hierarchy Safety, and Concurrency Control

## 1. Overview & Objectives

Phase 3 and Phase 8 establish end-to-end server-side ownership enforcement, hierarchy validity (unbounded cycle and descendant protections), and optimistic version-locking semantics across all file operations in LUGX.

### Key Guarantees
1. **Server-Derived Identity & Resource Guards (`src/server/auth/session.ts`):** All file operations derive user identity directly from `requireAuthenticatedUser()` on the server. Resource ownership is validated via `requireOwnedFile(fileId, userId)` with UUID validation, returning uniform `404 Not Found` for unowned or missing files to prevent resource enumeration attacks. Client-provided `userId` parameters are strictly rejected or stripped.
2. **Multi-Workspace Isolation & Default Resolution (`src/server/actions/workspaces.ts`):** Every file and folder belongs to a user-owned `workspaceId` (`workspaces` table). `createFile`, `copyFile`, `getUserFiles`, `getRootFiles`, `getFolderChildren`, and `importFile` accept an optional `workspaceId` and resolve via `resolveOrEnsureWorkspaceId(userId, workspaceId, parentFolderId)` (explicit owned workspace -> parent folder workspace inheritance -> deterministic `'Default Workspace'`). Cross-workspace parent folder assignments in `createFile`, `copyFile`, `importFile`, and `moveFile` fail closed with HTTP `403 CROSS_WORKSPACE_ACCESS_FORBIDDEN`. `deleteWorkspace` forbids deleting `deriveDefaultWorkspaceId(userId)` or any `'Default Workspace'` row (`403`).
3. **Workspace-Wide Zero-Knowledge Encryption Governance (`400 WORKSPACE_ENCRYPTION_REQUIRED`):** Inside an encrypted workspace (`workspace.isEncrypted === true`), `createFile` (non-folder), `copyFile` (non-folder), `importFile`, `toggleFileEncryption(false)`, and `PUT /api/files/:id` reject unencrypted writes or missing `encryptionMetadata.iv` with HTTP `400 WORKSPACE_ENCRYPTION_REQUIRED`. Removing encryption requires all-or-nothing atomic decryption via `decryptEntireWorkspace(workspaceId, decryptedFilesPayload)` with `expectedVersion` / `expectedETag` OCC (`409` rollback).
4. **Parent Ownership & Tree Integrity:** Creating, moving, copying, or importing files requires validating that the target parent folder exists, is owned by the authenticated user, is not soft-deleted, is a valid directory (`isFolder === true`), and belongs to the target `workspaceId`.
5. **Unbounded Cycle & Descendant Protection:** The system detects and rejects cycles (e.g. moving a folder into itself, circular directory loops, or moving into any descendant) with HTTP `409 Conflict`.
6. **Mandatory Preconditions (`If-Match` / `expectedVersion`):** Mutating or deleting a file requires an `If-Match` ETag header or `expectedVersion` in the payload. Missing preconditions return HTTP `428 Precondition Required`, while version mismatches return HTTP `412 Precondition Failed` with current `serverVersion` payload.
7. **Atomic Concurrency & ETag Mutation:** Comparison of version/ETag and version increment are executed in a single atomic SQL transaction.

---

## 2. API & Response Semantics

| Status Code | Reason | Behavior |
| :--- | :--- | :--- |
| `400 Bad Request` | Invalid payload or unencrypted write in encrypted workspace | Returns `WORKSPACE_ENCRYPTION_REQUIRED` when writing plaintext or disabling per-file encryption inside an encrypted workspace. |
| `401 Unauthorized` | Missing/expired server session | Fails closed before executing database queries via `requireAuthenticatedUser()`. |
| `403 Forbidden` | Cross-workspace access or protected default workspace | Returned on cross-workspace `moveFile` / parent folder mismatch (`CROSS_WORKSPACE_ACCESS_FORBIDDEN`) or attempting to delete the default workspace. |
| `404 Not Found` | Target file/folder/workspace does not exist, is soft-deleted, or belongs to another user | Unified anti-enumeration response preventing discovery of foreign resources via `requireOwnedFile()` or `WorkspaceNotFoundError`. |
| `409 Conflict` | Semantic collision or cycle | Triggered when moving a folder into itself, into a descendant, detecting circular folder loops, duplicate workspace name, or `decryptEntireWorkspace` version mismatch. |
| `412 Precondition Failed` | Stale ETag or version mismatch | Returns `412` with current `serverVersion` data for conflict resolution (applies to `PUT` and `DELETE`). |
| `428 Precondition Required` | Missing `If-Match` and `expectedVersion` | Enforces optimistic locking protocol on all mutations and deletions. |
| `429 Too Many Requests` | Rate limit threshold exceeded | Protected by `fileApiRateLimiter`. |
| `500 Internal Server Error` | Database/runtime exception | Logged securely on server; generic error returned to client. |

---

## 3. Implementation Details

### A. Unbounded Cycle Detection Algorithm (`moveFile` - LUGX-073)
When moving a folder (`target.isFolder === true`) to `newParentFolderId`:
```typescript
let currentAncestorId: string | null = parent.parentFolderId;
const visited = new Set<string>([newParentFolderId]);

while (currentAncestorId) {
    if (currentAncestorId === fileId) {
        return {
            success: false,
            status: "conflict",
            error: "Cannot move a folder into one of its descendants",
        };
    }
    if (visited.has(currentAncestorId)) {
        return {
            success: false,
            status: "conflict",
            error: "Circular hierarchy detected in folder structure",
        };
    }
    visited.add(currentAncestorId);

    const ancestor = await db.query.files.findFirst({
        where: and(
            eq(schema.files.id, currentAncestorId),
            eq(schema.files.userId, user.id),
            isNull(schema.files.deletedAt)
        ),
        columns: { parentFolderId: true },
    });
    currentAncestorId = ancestor?.parentFolderId ?? null;
}
```

### B. Title Collision Resolution on Restore (`restoreFile` - ADV-01)
When restoring a soft-deleted file or folder, if an active live file with the same title exists in the target destination, the restored file is automatically renamed by appending `(Restored)` or `(Restored N)` before the extension (e.g. `Report (Restored).md`), preventing Postgres `23505` unique index crashes.

### C. Unique Copy Naming, Length Clamping & Recursion Depth Guard (`copyFile` - LUGX-072 & LUGX-138)
- When creating copies of documents or folders, duplicate collisions are resolved by appending ` (Copy)` or ` (Copy N)` before the file extension.
- **PostgreSQL Varchar Bounds (LUGX-138):** Generated titles are clamped to `<= 500` characters (`MAX_TITLE_LENGTH = 500`) in `src/lib/utils/file-naming.ts` by truncating the base name prior to suffix/extension concatenation, preventing database column overflow errors.
- **Copy Depth Clamping (LUGX-072):** The recursive depth is clamped using `Math.max(0, depth)` with a maximum depth limit (`MAX_DEPTH = 20`), and copying a folder into itself or its descendants is strictly prohibited.

### D. Single-Step Atomic ETag Generation & Client-Side Extraction (`createFile` / `copyFile` / `importFile` - CRIT-01)
Pre-generates UUIDs and computes strong SHA-256 ETags in-memory before issuing the database `INSERT`. This eliminates the intermediate window where files were momentarily persisted with `etag = null`, preventing transient 412 conflicts during concurrent sync polling.

`importFile` receives UTF-8 extracted plain text strings (`textContent: string`) or client-encrypted AES-GCM ciphertext (`isEncrypted: true`) directly from the browser runtime, completely bypassing binary PDF handling and removing heavy `pdf-parse` processing from the server runtime:
- **Client-Side Web Worker Isolation (`pdf.worker.ts` / `pdf-worker-bridge.ts`):** PDF text extraction runs inside a dedicated Web Worker via `pdfjs-dist` with per-page memory cleanup (`page.cleanup()`) and document destruction (`pdfDoc.destroy()`).
- **2D Spatial Markdown Table Extractor (`pdf-table-extractor.ts`):** Geometrically clusters text coordinates into lines and columns, reorders RTL columns for Arabic, and formats tabular data into GitHub-Flavored Markdown tables with user toggle capability (`pdf-settings.ts`).
- **Arabic Unicode Normalizer (`arabic-normalizer.ts`):** Performs lookahead de-spacing on disjointed Arabic characters, NFKC presentation forms un-shaping, and BiDi directionality preservation.
- **On-Demand Bilingual OCR & Font Corruption Detector:** Detects Private Use Area (PUA) glyphs in corrupted embedded fonts (`pdf-corruption-detector.ts`) and triggers an on-demand bilingual OCR engine (`pdf-ocr-engine.ts` with `tesseract.js`).
- **Direct Vault Encrypted Import:** Encrypts content directly on the client with AES-GCM-256 using deterministic canonical AAD via `AAD.file(userId, fileId)` (`zk:v1:file:${userId}:${fileId}`) and optimistic IndexedDB cache persistence before server dispatch.
- **Client-Server Encrypted ETag Parity:** For encrypted files (`isEncrypted === true`), `importFile` passes the structured `envelope` into `generateETagSync` matching `generateEncryptedETagSync`, guaranteeing client-server ETag parity and preventing spurious 412 Precondition Failed conflicts during subsequent sync polling.
- **Server Ingestion Safeguards & Adversarial Defense:** Enforces a strict 10MB UTF-8 byte limit, checks magic bytes for disguised binaries (`isDisguisedBinary`), strips directory traversal patterns and invalid OS characters (`sanitizeFilename`), eliminates PostgreSQL null bytes (`\0`), counts words via an $O(1)$ memory streaming regex, and prevents infinite loops with a title deduplication circuit breaker (`counter <= 100`).

### E. Cascading Soft-Delete with Precondition Locking (`deleteFile` & `DELETE /api/files/:id` - LUGX-074)
- **Precondition Requirement:** File deletions require either `expectedVersion` in the parameters or an `If-Match` ETag header. Missing preconditions return `428 Precondition Required`, and version mismatches return `412 Precondition Failed` with current `serverVersion` state.
- **Atomic Deletion & Cascade:** Upon successful version comparison, the target file is marked with `deletedAt: now` and its version incremented atomically. If the entity is a folder, `getDescendantIds` traverses all subfolders and documents, cascading the tombstone in a single operation.

### F. Optimistic Locking & Atomic Mutation (`PUT /api/files/:id`)
```typescript
const [updatedFile] = await db.update(schema.files)
    .set({
        content: newContent,
        title: newTitle,
        etag: newEtag,
        version: newVersion,
        updatedAt: now,
    })
    .where(and(
        eq(schema.files.id, fileId),
        eq(schema.files.userId, user.id),
        eq(schema.files.version, currentVersion),
        isNull(schema.files.deletedAt)
    ))
    .returning();
```

### G. Domain Utility Separation
All pure synchronous utilities (such as `generateRestoredTitle` and `generateCopyTitle`) reside in `src/lib/utils/file-naming.ts` as pure domain utilities decoupled from server and RPC boundaries.

### I. BFS Hierarchy Traversal Cycle Guards & Cascade Restoration (`getDescendantIds` & `restoreFile`)
When recursively collecting descendant file/folder IDs for cascading deletion or tree restoration, BFS queue traversals maintain a `visited = new Set<string>()` guard. If corrupt or cyclic parent pointers exist in the database, the traversal terminates safely without infinite loops or memory exhaustion.
The signature `getDescendantIds(folderId: string, userId: string, includeDeleted: boolean = false)` defaults to active files for deletion cascade and cycle checks, while `restoreFile` explicitly specifies `includeDeleted = true` to collect and revive all soft-deleted children (documents and subfolders) in an atomic batch restoration.

### J. Zero-Knowledge Encryption Toggle Invariants (`toggleFileEncryption`)
- **Strict Non-Folder Invariant**: Folders cannot be encrypted (`isFolder === false`); attempting to toggle encryption on a folder immediately returns an error.
- **Optimistic Concurrency Guard**: Validates `expectedVersion` and `expectedETag` against live database state. On mismatch, returns 412 Conflict with the current `serverVersion` including `isEncrypted` and `encryptionMetadata`.
- **Atomic Metadata & ETag Update**: Inverts `isEncrypted`, sets/clears structured `encryptionMetadata`, updates normalized content, computes strong SHA-256 ETag, and increments version atomically in a single SQL operation.

### L. Modular Action Architecture & Domain Separation (`src/server/actions/*`)
To guarantee high cohesion and single-responsibility isolation, file, folder, and workspace operations are divided into dedicated domain action modules:
- **`src/server/actions/workspaces.ts`:** Governs workspace ownership and lifecycle (`resolveOrEnsureWorkspaceId`, `isWorkspaceEncrypted`, `listUserWorkspaces`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace`, `decryptEntireWorkspace`).
- **`src/server/actions/files.ts`:** Governs individual file life cycles (`createFile`, `updateFileContent`, `toggleFileEncryption`, `renameFile`, `deleteFile`, `restoreFile`, `copyFile`, `getFile`, `getUserFiles`, `getRootFiles`, `getDeletedFiles`).
- **`src/server/actions/folders.ts`:** Governs folder hierarchy graph logic (`moveFile`, `getFolderChildren`, `getDescendantIds`, `isDescendantOf`).
- **Direct Domain Imports:** Hono RPC handlers (`src/server/routes/rpc.routes.ts`) and internal server routes import domain operations directly from `@/server/actions/files`, `@/server/actions/folders`, and `@/server/actions/workspaces`. The legacy `src/server/actions/file-ops.ts` facade was permanently purged.

---

## 4. Verification & Testing Evidence
 
 - `src/test/workspace/multi-workspace-isolation.test.ts`: Unit and cross-contract tests verifying `deriveDefaultWorkspaceId`, `resolveOrEnsureWorkspaceId`, `deleteWorkspace` protection, `decryptEntireWorkspace` atomic rollback/commit, `CloudPostgresWorkspaceProvider` (`403 CrossWorkspaceAccessForbiddenError`, `409 DecisionLedgerConflictError`, `403 DECISION_LEDGER_DELETE_FORBIDDEN`, `mergeSectionThreeWay` closed-file OCC), `400 WORKSPACE_ENCRYPTION_REQUIRED` across actions/REST/RPC, and `exportWorkspaceAsZip`.
 - `src/test/workspace/multi-workspace-isolation.live.test.ts`: Real PostgreSQL live integration suite on the isolated Neon test branch verifying `idx_files_workspace_parent_title_live`, `agent_checkpoints` cascade delete, `user_vault_profiles.allow_ai_on_encrypted_files` DB default (`true`), `decryptEntireWorkspace` SQL transaction rollback, cross-workspace `403`, and `400 WORKSPACE_ENCRYPTION_REQUIRED`.
 - `src/test/server/phase-08-ownership-and-cycles.test.ts`: 18 tests verifying server session enforcement, UUID validation, cross-tenant 404 shielding, cycle detection, copy depth bounds, 412 deletion preconditions, and test route isolation.
 - `src/test/server/cross-user-ownership.test.ts`: 11 integration tests verifying cross-user isolation across `createFile`, `copyFile`, `moveFile`, `getFile`, `updateFileContent`, `deleteFile`, `importFile`, AI reservations, streaming, and atomic UPSERT user sync.
 - `src/test/server/file-ops.ownership.test.ts`: Covers cross-user parent validation, cycle detection across arbitrary hierarchy depth, and precondition enforcement (428/412) in `src/server/actions/files.ts` and `src/server/actions/folders.ts`.
 - `src/test/api/api-files-putguard.live.test.ts`: Verifies lost-update mitigation and atomic ETag/version updates.
 - `src/test/server/file-ops.lostupdate.test.ts`: Validates concurrent write isolation and monotonic version increments in `src/server/actions/files.ts`.
 - `src/test/server/file-ops.softdelete.test.ts`: Verifies tombstone lifecycle, unique title index handling, and bounded purge job across `src/server/actions/files.ts` and `src/server/actions/folders.ts`.
 - `src/test/vault/file-ops-vault.unit.test.ts`: 10 unit tests covering `toggleFileEncryption` optimistic locking, folder rejection, and `copyFile` zero-knowledge encrypted overrides in `src/server/actions/files.ts`.
 - `src/test/server/import-file.test.ts`: Tests text import, 10MB payload size ceiling, title deduplication, and null-byte sanitization.
 - `src/test/parsers/parser-pdf-settings.test.ts`: Unit tests verifying local preference toggling for spatial table extraction.
 - `src/test/vault/vault-import.integration.test.ts`: Integration test verifying direct client-encrypted vault import pipeline.

<!-- BEGIN:SSOT_TEST_METRICS_INLINE -->
**Active Verification Baseline:** 155 unit suites (3151 tests) · 22 live suites (101 tests) · 14 E2E specs (15 journeys) — 100% Passing.
<!-- END:SSOT_TEST_METRICS_INLINE -->

---

## 5. Storage Engine Decisions & Trade-offs

### Decision TR-11: PostgreSQL Direct BYTEA/TEXT Storage vs. External Object Storage (S3 / Cloudflare R2)

- **Context:** Storing user Markdown notes and encrypted zero-knowledge ciphertexts in the cloud backend.
- **Chosen Architecture:** Direct persistence in the primary PostgreSQL `files` table (`src/server/db/schema/files.ts`) using the `content` column (`text` / binary-safe string), co-located with version metadata, ETag, and encryption parameters.
- **Rejected Alternatives:**
  1. **External S3 / Cloudflare R2 Object Storage:** Storing content blobs in S3 buckets and referencing URLs in Postgres.
  2. **Supabase Storage:** Third-party storage abstraction (formally evaluated and dropped; see [`docs/foundation/DESIGN_VS_REALITY.md`](../../records/archive/lugx-v1/foundation/DESIGN_VS_REALITY.md)).
- **Trade-off Analysis:**
  | Evaluation Criteria | Chosen Solution (Postgres Direct Storage) | Alternative (External S3 / R2) |
  | :--- | :--- | :--- |
  | **Transaction Atomicity (ACID)** | **100% Atomic**: File metadata, folder hierarchy, version counter, ETag, and encrypted payload mutate within a single database transaction. | **Dual-State Vulnerability**: Requires two-phase commits between DB and S3. Network crashes leave orphaned S3 objects or dangling DB pointers. |
  | **Latency & Round-Trips** | **Single Round-Trip**: One SQL query saves/retrieves complete note state. | **Multi-Step Overhead**: Presigned URL generation, client upload to S3, followed by DB confirmation write. |
  | **Zero-Knowledge Security** | **Unified Security Boundary**: Client-encrypted ciphertext is stored directly in DB; no external third-party storage credentials or bucket access policies to leak. | **Complex Policy Management**: S3 bucket policies, CORS configuration, and presigned URL token expiration. |
  | **Storage Cost at Scale** | **Higher per Gigabyte**: Database NVMe block storage costs more than S3 object storage ($0.12/GB vs $0.015/GB). | **Lowest Cost**: S3/R2 is orders of magnitude cheaper for massive media archives. |

- **Migration Trigger (When to Switch to Object Storage):**
  Migrating document content payloads to external object storage (e.g., Cloudflare R2 / AWS S3) is triggered **if the application expands to support large multimedia attachments or arbitrary file uploads exceeding 5MB–10MB per document**, at which point database row bloat and Neon write IOPS outweigh the architectural benefits of single-transaction ACID co-location. Text and code notes remain optimal in Postgres.
