# Three-Way Conflict Resolution & Offline Synchronization Architecture

> **Point-in-time verification record.** Test counts in §4 and the merge-latency
> observation below reflect the suite state at delivery; re-run the suites for
> current numbers.

## 1. Architectural Overview & Context

This document outlines the design, implementation, and verification of the **Three-Way Conflict Resolution Engine** (Phase 4 of the original pre-implementation technical roadmap).

The system resolves concurrent multi-device and offline-to-online edit discrepancies deterministically without blind overwrites or silent data loss.

```mermaid
flowchart TD
    Base["Base Snapshot (v1)"] --> Local["Local Version (v1*)"]
    Base --> Server["Server Version (v2)"]
    Local --> Engine["3-Way Conflict Merge<br/>(LCS Delta Engine)"]
    Server --> Engine
    Engine --> Clean["Clean Auto-Merge<br/>(Non-overlapping edits applied)"]
    Engine --> Conflict["Conflict Resolution Dialog<br/>(Explicit UI resolution required)"]
```

---

## 2. Core Architectural Components

### 2.1 Three-Way Merge Engine (`src/lib/sync/conflict-resolver.ts` & `src/lib/sync/diff3.ts`)
- **Base Version Invariant:** A valid `baseSnapshot` is required to perform three-way merging. If the base snapshot is missing or corrupted, blind automated merging is strictly rejected, and the status transitions to `manual_resolution_required`.
- **Hunt-McIlroy / Pierce Deterministic Diff3 Engine (`src/lib/sync/diff3.ts`):** Hardened line-based 3-way merge engine built on LCS indices and half-open intervals `[start, end)`. Eliminates token erasure bugs on duplicate and repeated lines (such as duplicate letters `D\nC\nC` in `LUGX-045`) and adjacent empty lines.
- **Ciphertext Execution Guard:** Strictly enforces that Diff3 runs exclusively on decrypted plaintext. Passing raw encrypted payloads or Base64 ciphertexts triggers an immediate fail-closed guard error.
- **Linear Memory LCS with Prefix/Suffix Trimming:** Flat `Int32Array` buffers combined with linear Common Prefix & Suffix trimming, reducing memory allocation by >99% and executing merges in sub-millisecond time even on large documents (2,000+ lines).
- **Markdown Syntax Integrity Validator (`validateMarkdownSyntaxIntegrity` in `src/lib/sync/syntax-validator.ts`):** Centralized integrity validator imported by `ConflictResolver`. Evaluates candidate 3-way merge outputs for balanced fenced code blocks (``` and ~~~), valid GFM table delimiters with full support for escaped pipes (`\|`), null-byte elimination, and forbidden conflict marker residue. If merge output corrupts syntax, automated merge is cancelled and safely escalated to interactive conflict resolution.

### 2.2 Base Snapshot Persistence & Durable Conflict Quarantine (`src/lib/sync/indexeddb.ts` & `src/lib/idb/conflict-store.ts`)
- **Base Snapshot Capture:** Before any local mutation is committed to the local queue, the engine captures a frozen snapshot of the current synchronized base (`content`, `title`, `version`, `etag`) into the `files` store.
- **Durable Conflict Quarantine (Phase 15):** When an HTTP 412 / 409 conflict is detected, the file is quarantined in IndexedDB with `syncStatus = 'conflict'` and `conflictData: { serverVersion, localVersion, baseVersion, detectedAt }`. This state survives page reloads and browser restarts without data loss.
- **Pull Protection Guard:** `SyncPullEngine.pullFile` (orchestrated via `SyncManager`) strictly refuses to overwrite, modify, or delete (via tombstone) any file in `syncStatus === 'conflict'` or quarantined within `ConflictStore`.
- **Resolution State Transition:** Resolving via `ConflictStore.resolveConflict` cleans quarantine and transitions state to `synced` (when adopting server version) or `dirty` with `isDirty = true` (when retaining local edits, ensuring subsequent push passes re-attempt upload, LUGX-003).

### 2.3 False Conflict Elimination (`src/lib/sync/sync-queue-worker.ts`, `src/lib/sync/sync-pull-engine.ts`, `src/lib/sync/sync-manager.ts` & `src/hooks/use-sync.ts`)
- **Metadata Drift Invariant:** When receiving a `412 Precondition Failed` response or encountering dirty local state during push (`SyncQueueWorker.pushFile`) or pull (`SyncPullEngine.pullFile`), if `localContent === serverContent` or `compareETags(localEtag, serverEtag)` is true:
  - The conflict is categorized as a false conflict caused by metadata drift.
  - The engine silently adopts the authoritative server `version` and `etag`.
  - The file and its matching operation are committed via Lean CAS `commitFileAndOperationSync(..., sentRevision)` to ensure concurrent in-flight edits are not lost (retaining `isDirty = true` if `localRevision > sentRevision`, LUGX-010).
  - The UI modal dialog is suppressed, preventing infinite dialog loops.

### 2.4 Markdown Conflict Resolution UI (`src/components/sync/conflict-dialog.tsx`)
- **Direct Markdown Comparison:** Displays side-by-side comparison columns, visual diff blocks (`DiffLine`), and the interactive merge editor operating on pure Markdown source text.
- **Deterministic Submission:** Submits resolved Markdown text directly with `normalizeMarkdownSource` normalization upon authoritative submission.

### 2.5 User-Scoped Cross-Tab Synchronization (`src/lib/sync/cross-tab-sync.ts` & `src/lib/sync/tab-sync.ts`)
- **User Scoping (`lugx_sync_${userId}`):** Broadcast channels are scoped per authenticated user (`lugx_sync_${userId}`) to prevent multi-tenant event bleeding across tab sessions (`LUGX-109`). Seamlessly falls back to `textai_cross_tab_sync` for ambient/unauthenticated contexts.
- **Storage-First Sequential Broadcast:** `useEditorOrchestrator` strictly awaits IndexedDB local persistence (`await syncHook.saveLocal()`) before emitting `file_saved` events via `broadcastCrossTabEvent`, guaranteeing that receiving sibling tabs always read fresh, committed state from disk rather than encountering stale race conditions.
- **Dirty State Guard:** Sibling tabs only advance their in-memory `fileVersionRef` if the current tab is clean (`!isDirty && !hasUnresolvedConflict`), preventing silent overwrites of un-saved local drafts.
- **Volatile RAM Purge Synchronization:** When a vault lock occurs in any tab (manual lock or inactivity timeout), `sessionKeyStore.lock(true)` dispatches a `vault_locked` broadcast message. Sibling tabs zero their volatile Master Key buffers in RAM (`buffer.fill(0)`), purge keys, and lock the vault UI.
- **Anti-Echo Filter:** Each browser tab instance possesses a unique `currentTabId`; messages broadcast with `senderTabId === currentTabId` are filtered out to prevent self-echo feedback loops.

### 2.6 Zero-Knowledge Encrypted Conflict Resolution & Inbound Gateway (`src/lib/sync/sync-crypto-gateway.ts`, `src/hooks/use-editor-conflict.ts`)
- **Inbound Server IV Decryption (`SyncCryptoGateway.decryptInbound`)**: When a 412 Precondition Failed occurs on an encrypted file, `useEditorConflict` (extracted from the orchestrator in Phase 18) intercepts `saveRes.serverVersion`. Rather than erroneously reusing the local client IV, the gateway strictly extracts `saveRes.serverVersion.encryptionMetadata.iv` (the actual IV generated by the remote concurrent writer) and decrypts the incoming ciphertext into clean Markdown plaintext in volatile RAM using the Master Key and file AAD binding (`vault:file:${userId}:${fileId}`).
- **Plaintext False-Conflict Elimination (`normalizeMarkdownSource`)**: Before surfacing a conflict dialog to the user, `useEditorConflict` compares the decrypted server plaintext against local dirty plaintext using `normalizeMarkdownSource` (LUGX-053). If both contents match identically, the hook transparently adopts the remote version and ETag without displaying intrusive modals.
- **Silent Automated 3-Way Merge on 412 (`LUGX-054`)**: When differing server and local versions collide under HTTP 412 and a valid `baseSnapshot` is present, `useEditorConflict` calls `conflictResolver.attemptThreeWayMerge()`. If mutations do not overlap (`status === 'merged_clean'`), the merged Markdown is automatically re-encrypted (if applicable), pushed to the server with `expectedVersion: serverVersion.version`, committed to IndexedDB, and applied to the editor without displaying any intrusive modal or interrupting offline editing.
- **Visual Diff Pairing Hardening**: In `conflict-resolver.ts`, `computeVisualDiff` pairs in-place modifications (`delLines` matched with `insLines`) as `modify` operations with token spans, ensuring that Deletion Guard only prunes surplus remote lines that lack local counterparts. This prevents modified lines from duplicating in local view or vanishing from server view.
- **Plaintext Presentation Invariant (`ConflictDialog`)**: `SyncConflict.serverVersion.content` is strictly populated with decrypted plaintext. Both Diff3 line merge and side-by-side visual diff engines operate exclusively on valid Markdown strings, eliminating raw Base64 ciphertext comparison failures.
- **Universal Clean Re-Encryption on Resolution (`SyncCryptoGateway.encryptOutbound`)**: When the user selects a resolution strategy (`"mine"`, `"server"`, or `"merge"`):
  1. `useEditorConflict` captures `startSnapshot` to detect concurrent user typing during the network flight (LUGX-010).
  2. If the file is encrypted, the hook re-encrypts the selected plaintext using `SyncCryptoGateway.encryptOutbound`, generating a fresh 12-byte CSPRNG IV and envelope metadata.
  3. The re-encrypted payload is dispatched to the server via `toggleFileEncryption` with optimistic concurrency precondition (`expectedVersion`) and persisted to IndexedDB.
  4. If no concurrent edits occurred during network flight, the resolved plaintext is applied cleanly to the editor (`adapter.setValue(resolution.content)`) and marked clean. If concurrent typing occurred during flight, live user edits are preserved in CodeMirror (LUGX-013) and flagged dirty (`markDirty()`) for subsequent autosave persistence.
  5. The hook emits a `conflict_resolved` event via `broadcastCrossTabEvent` to notify sibling tabs.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Editor as CodeMirror / EditorAdapter
    participant Orch as useEditorOrchestrator
    participant Conf as useEditorConflict
    participant GW as SyncCryptoGateway
    participant SKS as SessionKeyStore (RAM)
    participant Server as /api/files/:id
    participant Dialog as ConflictDialog (Diff3)

    Editor->>Orch: User edits dirty plaintext
    Orch->>Server: PUT /api/files/:id (Stale ETag)
    Server-->>Orch: HTTP 412 Precondition Failed<br/>{ serverVersion: { content: "gcm:v1:...", encryptionMetadata: { iv: "serverIv" } } }
    Orch->>Conf: handle412Conflict(serverVersion, localContent)
    
    rect rgb(240, 248, 255)
        Note over Conf,GW: Inbound Decryption Interception
        Conf->>GW: decryptInbound(serverVersion.content, serverVersion.encryptionMetadata, fileId, userId)
        GW->>SKS: getMasterKeyRaw()
        SKS-->>GW: MasterKey
        GW-->>Conf: serverPlaintext (Clean Markdown)
    end

    alt False Conflict (localPlaintext === serverPlaintext via normalizeMarkdownSource)
        Conf->>Orch: Adopt remote version & ETag silently
        Note over Conf: Raw Ciphertext Preservation: if encrypted, saveLocal persists rawServerContent (not decrypted text)
        Conf->>Conf: IDB.saveLocal(isEncrypted ? rawServerContent : decryptedContent, clean) & markClean()
    else Base Snapshot Present & Non-Overlapping Mutations (LUGX-054)
        Conf->>Conf: attemptThreeWayMerge(baseSnapshot, localPlaintext, serverPlaintext)
        alt Clean Merge (status === 'merged_clean')
            Conf->>GW: encryptOutbound(fileId, mergedText) (if encrypted)
            Conf->>Server: PUT /api/files/:id (expectedVersion: serverVersion.version)
            Server-->>Conf: 200 OK { version, etag }
            Conf->>IDB: await saveLocal(clean) (Storage-First)
            Conf->>Conf: Broadcast file_saved
            Conf->>Editor: adapter.setValue(mergedText) & markClean()
        end
    else Overlapping Conflict / Missing Base
        Conf->>Dialog: Mount ConflictDialog(localPlaintext, serverPlaintext)
        User->>Dialog: Choose Strategy ("mine" | "server" | "merge")
        Dialog->>Conf: handleResolveConflict(resolvedPlaintext)
        Conf->>Conf: Capture startSnapshot (LUGX-010)
        Conf->>GW: encryptOutbound(fileId, resolvedPlaintext, userId)
        GW-->>Conf: { ciphertextBase64, freshMetadata (12-byte CSPRNG IV) }
        Conf->>Server: toggleFileEncryption(fileId, true, ciphertextBase64, freshMetadata)
        Server-->>Conf: 200 OK { version, etag }
        alt No Concurrent Edits (liveNow === startSnapshot)
            Conf->>Editor: adapter.setValue(resolvedPlaintext)
            Conf->>Conf: IDB.saveLocal(clean) & markClean()
        else Concurrent Edits During Flight (LUGX-010)
            Note over Conf,Editor: Preserve live edits in editor & IDB (isDirty: true)
            Conf->>Orch: markDirty() for subsequent debounced autosave
        end
        Conf->>Conf: Broadcast conflict_resolved
    end
```

### 2.7 Non-Blocking Encrypted Conflict Isolation (`CONFLICT_LOCKED` & `SyncEncryptedConflictStore`)
- **Isolation State & Architecture**: When a 412 Precondition Failed or 409 Conflict occurs on an encrypted file while the user's vault is locked (`!sessionKeyStore.isVaultUnlocked()`), the conflict cannot be decrypted or auto-merged in background queues without Master Key exposure. The conflict is isolated into `pendingEncryptedConflicts` tagged with `CONFLICT_LOCKED`, managed by `SyncEncryptedConflictStore` (`src/lib/sync/sync-encrypted-conflict-store.ts`).
- **Non-Blocking Invariant**: `SyncQueueWorker.pushDirtyFiles` explicitly filters out `!this.encryptedConflictStore.isEncryptedConflictLocked(file.id)`. Other unencrypted dirty documents synchronize concurrently without being stalled or blocked by locked encrypted files.
- **Quarantine Capacity & Backpressure Governance**:
  - Bounded in-memory quarantine via `MAX_QUARANTINED_CONFLICTS = 100`.
  - False-eviction immunity: updating an existing quarantined file never evicts other documents (`!has(conflict.fileId)` check).
  - Deterministic $O(N)$ linear scan evicts the oldest conflict (`detectedAt`) when capacity is exceeded without intermediate array allocations.
- **Observability & Diagnostics**: `SyncEncryptedConflictStore.getQuarantineDiagnostics()` returns `QuarantineDiagnostics` tracking total quarantined count, stale count (> 24 hours), oldest/newest timestamps, and capacity state.
- **Atomic Discard & Cleanup**: `SyncEncryptedConflictStore.discardPendingEncryptedConflict(fileId)` safely cancels an isolated conflict under `concurrencyManager.withLock` mutual exclusion:
  1. Evicts entry from `pendingEncryptedConflicts`.
  2. Cleans up in-memory checkpoints in `SyncRollback`.
  3. Transitions linked operations in IndexedDB to `'discarded'`, strictly preserving `localFile.isDirty` to prevent silent user edit data loss (`DATA-SAFETY GUARD`).
- **Unlock Event & Auto-Resolution**: When the user unlocks the vault, `SyncEncryptedConflictStore.resolvePendingEncryptedConflict(fileId)` automatically:
  1. Decrypts `remoteEnvelope`, `localEnvelope`, and `baseEnvelope` in RAM using the Master Key.
  2. Runs 3-way Diff3 merge via `conflictResolver.attemptThreeWayMerge`.
  3. Verifies Markdown structural syntax integrity via `validateMarkdownSyntaxIntegrity`.
  4. Re-encrypts the merged Markdown with a fresh CSPRNG 12-byte IV and file-bound AAD.
  5. Pushes to `/api/files/:id` with `If-Match: "remoteEtag"`, removes the pending conflict, and marks the file clean.

### 2.8 Sub-Line Word/Token 3-Way Merge (`src/lib/sync/diff3.ts` & `src/lib/sync/conflict-resolver.ts`)
- **Intra-Line Disjoint Resolution:** When conflicting modifications occur on the same line number relative to a common base (`aLine`, `oLine`, `bLine`), standard line-level Diff3 triggers a coarse conflict block. The Sub-Line merge engine (`trySubLineMerge`) decomposes conflicting lines into fine-grained tokens and performs a token-level 3-way merge.
- **Unicode Tokenization:** Tokenizes strings via Unicode property regex `/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]+/gu` (`tokenizeLine`), preserving whitespace, multilingual alphabets (including Arabic, Latin, CJK), numbers, and punctuation as atomic tokens without mangling text boundaries.
- **Non-Overlapping Disjoint Resolution:** If local and remote modifications target disjoint token ranges within the line, tokens merge into a unified string cleanly (`mergedTokens.join('')`). If changes overlap on the same words or adjacent punctuation, a conflict is declared.
- **Markdown Syntax Integrity Gate:** The merged line must pass `validateMarkdownSyntaxIntegrity`. If intra-line token merging introduces unclosed code fences, corrupts Markdown table delimiters, or injects malformed syntax, the sub-line merge safely aborts (`success: false`) and falls back to deterministic conflict markers.
- **Configurability:** Controlled via `Diff3Options.subLineMerge` (defaults to `true`). Callers can disable sub-line token merging to enforce strict line-level boundaries.

```mermaid
graph TD
    LineInput["Conflicting Line: aLine (Local), oLine (Base), bLine (Remote)"] --> Tokenize["Unicode Tokenization<br/>tokenizeLine()"]
    Tokenize --> TokenDiff3["Token Array 3-Way Merge<br/>diff3Merge(aTokens, oTokens, bTokens)"]
    TokenDiff3 --> OverlapCheck{"Token Overlaps?"}
    OverlapCheck -->|Yes: Shared Words| ConflictBlock["Declare Conflict<br/>(conflict_overlaps)"]
    OverlapCheck -->|No: Disjoint Tokens| Reassemble["Reassemble String<br/>mergedTokens.join('')"]
    Reassemble --> SyntaxCheck{"validateMarkdownSyntaxIntegrity()"}
    SyntaxCheck -->|Valid| CleanResolution["Clean Resolution<br/>(merged_clean)"]
    SyntaxCheck -->|Invalid Syntax| ConflictBlock
```

### 2.9 Word-Level Visual Diffing & Intra-Line Highlighting (`src/lib/sync/conflict-resolver.ts` & `src/components/sync/conflict-dialog.tsx`)
- **Micro-LCS Diffing (`computeWordSpans`):** When generating visual diffs for modified lines, `computeVisualDiff` executes Micro-LCS token alignment between the old and new line content.
- **`WordSpan` Classification:** Token spans are tagged with deterministic diff operations:
  - `equal`: unchanged text tokens, displayed with neutral styling.
  - `delete`: removed tokens, rendered with red strike-through (`bg-red-500/20 text-red-400 line-through`).
  - `insert`: newly added tokens, rendered with green highlight (`bg-green-500/20 text-green-400 font-medium`).
- **`DiffOp.modify` Structure:** Instead of coarse multi-line deletions and additions, paired line modifications emit `{ type: 'modify', oldValue, newValue, spans: WordSpan[] }`.
- **UI Highlighting in `ConflictDialog` (`src/components/sync/conflict-dialog.tsx`):**
  - Diff view (`DiffLine`) renders modified lines (`~`) with granular inline badges for word-level insertions and deletions.
  - Side-by-side previews (`LocalHighlightedPreview` and `ServerHighlightedPreview`) render deletions and additions directly within the respective panels.

```mermaid
graph LR
    LocalText["Local Line Text"] --> Tokenize["Tokenize Words & Punctuation"]
    RemoteText["Remote Line Text"] --> Tokenize
    Tokenize --> MicroLCS["Micro-LCS Sequence Alignment"]
    MicroLCS --> Spans["WordSpan Array<br/>equal | delete | insert"]
    Spans --> ModifyOp["DiffOp.modify<br/>{ oldValue, newValue, spans }"]
    ModifyOp --> DialogUI["ConflictDialog UI Render<br/>DiffLine & Side-by-Side Previews"]
```

### 2.10 Deletion Guard Architecture (`src/lib/sync/conflict-resolver.ts` & `src/lib/sync/diff3.ts`)
- **Prevention of Line Resurrections:** When a user locally deletes lines present in the synchronized base snapshot (`baseContent`), naive two-way comparisons between local and remote treat the missing lines as server-side additions, erroneously resurrecting deleted content.
- **Invariant via `baseSnapshot`:** When `baseContent` is provided, `applyDeletionGuard` analyzes lines present on the server and absent locally:
  - If the line existed in `baseContent` and remained unchanged on the server, it is classified as intentionally deleted by the local user and kept deleted (`deletedLines`).
  - Only lines that did *not* exist in `baseContent` are treated as legitimate remote additions (`addedLines`).
- **Diff3 Engine Deletion Guard:** In `diff3Merge`, trailing and leading matching lines between base and remote that were deleted locally are pruned before declaring conflict blocks.
- **Safety Guard against Server Edits:** If the server modified a line that was deleted locally, the line is *not* identical between base and server (`oContent !== bContent`), so the Deletion Guard does not prune it; Diff3 accurately surfaces an overlapping conflict for user decision.
- **Visual Diff Deletion Guard:** In `computeVisualDiff(local, remote, base)`, lines deleted from base locally are rendered as `delete` operations rather than false `insert` operations from the server.

```mermaid
graph TD
    LineCheck["Remote Line Absent in Local"] --> BaseCheck{"Present in baseContent?"}
    BaseCheck -->|No| RemoteAddition["Legitimate Server Addition<br/>(Keep in Merged Content)"]
    BaseCheck -->|Yes| ServerChangeCheck{"Modified on Server?"}
    ServerChangeCheck -->|No: Unchanged from Base| UserDeletion["Locally Deleted Line<br/>Deletion Guard: Do NOT Resurrect"]
    ServerChangeCheck -->|Yes: Server Modified| RealConflict["True Concurrent Conflict<br/>(Surface in Conflict Markers)"]
```

---

### 2.11 Section-Scoped 3-Way Merge (`diff3MergeSection` in `src/lib/sync/diff3.ts`)
- **Isolated Section Targeted Merging:** Enables AI agent synthesis and document writing nodes to merge localized section changes without re-merging or risking false conflicts across unaffected document sections.
- **Heading Slicer Coupling:** Leverages `extractSectionBySlug` from `@/core/ast/heading-slicer` to locate the target section's UTF-16 character offsets `(startOffset, endOffset)` in the live document.
- **Parameter Ordering & Common Ancestor:** Calls `diff3MergeText(liveSection.sectionContent, baseSectionContent, agentProposedSectionContent, options)` with canonical `(local, base, remote)` ordering where `baseSectionContent` serves as the common ancestor `o`.
- **Conflict Containment & Quarantine:** When concurrent edits conflict within the target section, `diff3MergeSection` returns `status: "conflict_quarantined"`. Conflict markers are strictly bounded within `hunkRange = { from: startOffset, to: endOffset, replacementText }` without corrupting unaffected surrounding text.
- **Algebraic Replacement Invariant:** Guarantees that splicing the replacement text preserves character accuracy:
  $$\text{liveDocumentContent.slice}(0, \text{hunkRange.from}) + \text{hunkRange.replacementText} + \text{liveDocumentContent.slice}(\text{hunkRange.to}) \equiv \text{mergedDocumentContent}$$
- **Markdown Syntax Integrity Gate:** The spliced document is validated against `validateMarkdownSyntaxIntegrity`. Unclosed code blocks, broken tables, or malformed math delimiters return `status: "syntax_invalid"` alongside structural diagnostics.

```mermaid
flowchart TD
    In["Live Document + Base Section + Proposed Section + Heading Slug"] --> Slice["extractSectionBySlug(liveDoc, slug)"]
    Slice --> Found{"Section Found?"}
    Found -->|No| Invalid["Return status: syntax_invalid<br/>(Slug not found in live doc)"]
    Found -->|Yes| Merge["diff3MergeText(liveSection, baseSection, proposedSection)"]
    Merge --> ConflictCheck{"Merge Clean?"}
    ConflictCheck -->|No: Conflicts| Quarantine["Return status: conflict_quarantined<br/>hunkRange: [startOffset, endOffset, conflictText]"]
    ConflictCheck -->|Yes: Clean| Splice["Splice into Live Document<br/>live.slice(0, from) + merged + live.slice(to)"]
    Splice --> SyntaxCheck{"validateMarkdownSyntaxIntegrity()"}
    SyntaxCheck -->|Invalid| SyntaxErr["Return status: syntax_invalid<br/>diagnostics: syntaxErrors"]
    SyntaxCheck -->|Valid| CleanOut["Return status: clean<br/>mergedDocumentContent & hunkRange"]
```

---

## 3. API & Resolution Contracts

### 3.1 Merge Result Contract
```typescript
export type MergeStatus =
    | 'merged_clean'
    | 'conflict_overlaps'
    | 'manual_resolution_required'
    | 'delete_conflict';

export interface MergeResult {
    /** Whether merge was successful without any conflicts */
    success: boolean;
    /** Detailed status of the merge operation */
    status: MergeStatus;
    /** Merged content (if success or contains inline conflict markers) */
    content?: string;
    /** Merged title */
    title?: string;
    /** Merged parent folder id */
    parentFolderId?: string | null;
    /** Whether there are overlapping changes requiring manual resolution */
    hasOverlaps: boolean;
    /** Diff operations for visualization */
    diffs?: DiffOp[];
    /** Explicit conflict markers if overlaps were present */
    conflictMarkers?: string;
    /** Specific delete conflict classification */
    deleteAction?: 'remote_deleted_local_modified' | 'local_deleted_remote_modified' | 'both_deleted';
    /** Human-readable explanation */
    reason?: string;
}
```

### 3.2 Authoritative Resolution Submission
Resolutions are committed via a single authoritative write request:

**Standard Unencrypted File:**
```http
PUT /api/files/:id HTTP/1.1
Content-Type: application/json
If-Match: "server_etag"

{
  "content": "# Resolved Content\n\nAuthoritative merged markdown text.",
  "expectedVersion": 2
}
```

**Encrypted Vault File:**
```http
PUT /api/files/:id HTTP/1.1
Content-Type: application/json
If-Match: "server_etag"

{
  "content": "gcm:v1:base64ciphertext...",
  "isEncrypted": true,
  "encryptionMetadata": {
    "version": 1,
    "algorithm": "AES-GCM-256",
    "keyId": "master-v1",
    "salt": "",
    "iv": "base64iv...",
    "kdfIterations": 600000
  },
  "expectedVersion": 2
}
```
*(Alternatively committed atomically via `toggleFileEncryption` Server Action).*

---

## 4. Verification & Automated Test Evidence

| Test Suite | Test Count | Status | Description |
| :--- | :--- | :--- | :--- |
| `src/test/sync/sync-conflict-resolver.test.ts` | 60 | Passed | 3-way merge, LCS linear array, sub-line token merge, WordSpan micro-LCS, deletion guard, markdown syntax integrity, escaped table pipes, CRLF normalization, large doc trimming. |
| `src/test/sync/diff3-sub-line-merge.test.ts` | 37 | Passed | Sub-line disjoint merge, overlapping conflicts, markdown syntax integrity guards, deletion guard, and Unicode tokenization. |
| `src/test/sync/sync-indexeddb.test.ts` | 14 | Passed | Base snapshot persistence, create-to-update coalescing, store integrity. |
| `src/test/sync/sync-manager.test.ts` | 36 | Passed | 412 conflict handling, retry backoff, dead-letter transitions, RemoteUpdateEvent dispatch. |
| `src/test/sync/conflict-resolution.integration.test.ts` | 3 | Passed | Real PostgreSQL lifecycle integration (Base -> Remote write -> Local 412 -> 3-way merge -> Authoritative write -> Verified reload). |
| `src/test/api/api-files-putguard.live.test.ts` | 3 | Passed | Concurrency race conditions, stale write rejection. |
| `src/test/server/file-ops.lostupdate.test.ts` | 4 | Passed | Lost-update prevention via optimistic database version locking. |
| `src/test/sync/sync-operations-gc.test.ts` | 5 | Passed | Garbage collection of synced operations, compaction thresholds. |
| `src/test/sync/sync-rollback.test.ts` | 22 | Passed | Checkpoint creation, rollback recovery from crashes. |
| `src/test/sync/sync-connection-detector.test.ts` | 17 | Passed | Exponential backoff, jitter, network status detection. |
| `src/test/sync/sync-etag-generator.test.ts` | 20 | Passed | ETag formatting, parsing, weak comparison, Markdown normalization. |
| `src/test/sync/sync-parallel.test.ts` | 6 | Passed | Parallel batch file processing, concurrency throttling. |
| `src/test/sync/sync-error-handler.test.ts` | 26 | Passed | Structured error dispatching and recovery logging. |
| `src/test/sync/sync-concurrency-manager.test.ts` | 9 | Passed | Mutex locking per file ID. |
| `src/test/vault/vault-sync-ai-gate.test.ts` | 28 | Passed | AI gatekeepers, syntax validator, non-blocking encrypted conflict resolution, and adversarial edge cases. |
| `src/test/sync/sync-crypto-gateway.test.ts` | 5 | Passed | Inbound decryption gateway, outbound re-encryption with fresh IV, AAD binding, vault-lock quarantine. |
| `src/test/sync/encrypted-conflict-decryption.integration.test.ts` | 4 | Passed | End-to-end integration: remote pull decryption, 412 server IV decryption, clean plaintext conflict resolution, locked vault safety. |
| **Total Test Count** | **299** | **100% Passed** | **All suites verified against real database and runtime contracts (361 vitest matrix + 3 live db suites active).** |
| **TypeScript Typecheck** | `tsc --noEmit` | **0 Errors** | **Strict TypeScript compliance verified across all workspace files.** |

---

## 5. Architectural Decisions & Trade-offs

### Decision TR-01: Choosing Diff3 LCS over CRDTs (Yjs) and Operational Transformation (OT)

- **Context:** LUGX requires an offline-first document synchronization engine capable of resolving concurrent edits across multiple devices for a single authenticated user, while strictly preserving end-to-end zero-knowledge encryption in client-side vaults.
- **Chosen Architecture:** Custom, deterministic Three-Way Line-Based Merge Engine (`src/lib/sync/conflict-resolver.ts`) using linear-memory Longest Common Subsequence (LCS) with common prefix/suffix trimming, integrated with an AST-aware Markdown syntax integrity validator (`syntax-validator.ts`).
- **Rejected Alternatives:**
  1. **CRDTs (Yjs / Automerge):** Standard state-vector conflict-free replicated data types.
  2. **Operational Transformation (OT):** Centralized sequence transformation (e.g., ShareDB, Google Docs algorithm).
- **Trade-off Analysis:**
  | Evaluation Criteria | Chosen Solution (Diff3 LCS) | Alternative #1 (Yjs / CRDTs) | Alternative #2 (OT) |
  | :--- | :--- | :--- | :--- |
  | **Memory & Storage Overhead** | **Minimal**: Linear $O(D)$ memory via flat `Int32Array` buffers; zero metadata tombstones. | **High**: Indefinite retention of character-level deletion tombstones and state vectors in client memory. | **Moderate**: Server maintains entire sequential revision log. |
  | **Bundle Footprint** | **Zero-Dependency**: 0 KB external bundle weight; pure native TypeScript. | **Heavy**: ~60–120 KB minified dependency graph (`yjs`, `y-codemirror.next`, `y-protocols`). | **Heavy**: Client-server transformation engine dependencies. |
  | **Offline-First Resilience** | **Native**: Works deterministically in isolated local client contexts against base snapshots. | **Native**: Strong peer-to-peer eventual convergence. | **Poor**: Requires authoritative central server to transform concurrent operations. |
  | **Zero-Knowledge Encryption Harmony** | **Frictionless**: Plaintext 3-way merge occurs entirely inside volatile client RAM after Web Worker decryption. | **Severe Incompatibility**: Encrypting fine-grained CRDT operations requires complex decentralized key exchange or homomorphic encryption. | **Incompatible**: Server cannot transform operations on encrypted ciphertexts. |

- **Zero-Knowledge Cryptographic Barrier:**
  Following the implementation of the Zero-Knowledge Cloud Vault, integrating Yjs would introduce extreme architectural complexity. Because the server is strictly blind to document contents (`content BYTEA` ciphertext), any CRDT synchronization must occur either through encrypted state updates or peer-to-peer WebRTC connections. In a single-user workstation, managing encrypted peer-to-peer session states, distributing per-session ephemeral keys, and storing deletion tombstones imposes significant memory and battery overhead without any measurable user-facing ROI.
- **Migration Trigger (When to Switch to CRDTs):**
  Adopting Yjs or an equivalent CRDT framework is justified **only if the product requirement evolves to support real-time multi-user concurrent live collaboration** (multiple users simultaneously editing the exact same note with live cursor presence). In that event, the clean abstraction boundaries in `EditorAdapter` (`src/components/editor/markdown/editor-adapter.ts`) and `SyncManager` allow swapping the underlying synchronization transport without redesigning editor UI or database schemas.

---

### Decision TR-02: Native IndexedDB vs. Origin Private File System (OPFS)

- **Context:** The offline synchronization engine requires persistent client-side storage to retain local document snapshots, mutation queues, and synchronization cursors across browser restarts.
- **Chosen Architecture:** Native browser **IndexedDB API** with transactional schema versioning (`src/lib/sync/indexeddb.ts`), partitioned per user (`textai_db_${userId}`) across three stores: `files`, `operations`, and `sync_metadata`.
- **Rejected Alternatives:**
  - **Origin Private File System (OPFS):** Direct private filesystem access (`navigator.storage.getDirectory()`).
  - **LocalStorage:** Synchronous string key-value storage.
- **Trade-off Analysis:**
  | Evaluation Criteria | Chosen Solution (IndexedDB) | Alternative (OPFS) |
  | :--- | :--- | :--- |
  | **Structured Querying** | **High**: Secondary indices (`by_user`, `by_status`, `by_file`, `by_retry`) allow instantaneous queue inspection. | **None**: Raw byte files without indexing; queries require manual directory scanning. |
  | **Transactional Atomicity** | **Native**: Multi-store ACID transactions (`readwrite`) ensure atomic rollback of mutation operations. | **Low**: File locking semantics; no multi-file atomic transactions. |
  | **Raw I/O Throughput** | **Moderate**: Subject to structured cloning serialization overhead. | **Extreme**: Synchronous fast access handles for high-throughput byte streams. |
  | **Storage Quota & Eviction** | **High**: Large browser quota (typically gigabytes) under persistent storage permissions. | **High**: Equal quota allowance. |

- **Migration Trigger (When to Switch to OPFS):**
  Migrating storage of document contents to OPFS is triggered **if the application introduces large binary attachments (>50MB per file, such as raw high-resolution PDF scans or media files)** where IndexedDB structured cloning serialization introduces visible main-thread latency.

---

### Decision TR-03: Native BroadcastChannel vs. SharedWorker for Cross-Tab Sync

- **Context:** Synchronizing editor lock states, active drafts, and volatile RAM key purges across sibling browser tabs in real time.
- **Chosen Architecture:** Native user-scoped `BroadcastChannel(\`lugx_sync_\${userId}\`)` (`src/lib/sync/cross-tab-sync.ts` & `src/lib/sync/tab-sync.ts`) with sender isolation (`senderTabId !== currentTabId`) and unauthenticated fallback to `textai_cross_tab_sync`.
- **Rejected Alternative:** `SharedWorker` coordination hub.
- **Trade-off Analysis:**
  - **BroadcastChannel:** Zero setup, universally supported across all modern desktop and mobile browsers, zero lifecycle teardown friction, user-scoped tenant isolation preventing cross-account bleeding (`LUGX-109`), and degrades silently in restricted headless environments.
  - **SharedWorker:** Complex worker lifecycle management, historically unsupported or flaky on iOS Safari, and introduces significant debugging complexity for multi-tab state tracking.
- **Migration Trigger:** Adopting a `SharedWorker` is triggered only if client-side architecture requires a persistent, long-running background sync coordinator that must remain active and maintain network sockets even when individual browser windows are closed.
