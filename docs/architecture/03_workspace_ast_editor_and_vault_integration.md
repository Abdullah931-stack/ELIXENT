# 03. Workspace, AST, Editor & Zero-Knowledge Vault Integration Architecture

| Standard Field | Approved Value |
| :--- | :--- |
| **Document ID** | `ELIXENT-ARCH-03` |
| **Classification** | `LIVING SUBSYSTEM SPEC` (`src/core/workspace/*`, `src/core/ast/*`, `src/components/editor/markdown/*`, `src/lib/vault/*`) |
| **Version & Status** | `v3.2 — Accepted for Implementation (Accepted)` |
| **SSOT Scope** | Unified Workspace Provider contract (`IWorkspaceProvider`), Hybrid AST and Lexical Search Engine (`Hybrid AST + Lexical/BM25 Search`), Fence-Aware Heading Slicer (`Fence-Aware Slicer`), Multi-Hunk Ghost Preview protocol (`Multi-Hunk Ghost`) and Incremental Sync with `Diff3` and `ETag`, and Zero-Knowledge Vault boundaries (`vault_ref://` and `EphemeralVaultMemoryMap`). |
| **Suite Index** | • [01_architecture_vision_and_adrs](./01_architecture_vision_and_adrs.md)<br>• [02_agent_orchestration_and_decision_engine](./02_agent_orchestration_and_decision_engine.md)<br>• [04_credit_metering_and_settlement_architecture](./04_credit_metering_and_settlement_architecture.md)<br>• [05_data_contracts_and_lugx_migration_plan](./05_data_contracts_and_lugx_migration_plan.md) |

## 1. Unified Workspace Provider Contract (`IWorkspaceProvider Contract`)

To decouple the architectural agent core (`src/core/agent/*`) from underlying storage medium details and enable executing the exact same state graph on **Vercel Serverless** (backed by PostgreSQL) and on **Electron Desktop** (backed by the local filesystem), agent nodes communicate exclusively through the standardized `IWorkspaceProvider` interface (`src/core/workspace/provider.ts`):

```typescript
export interface HeadingNode {
  headingSlug: string;
  title: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  breadcrumb: string; // Example: "1. General Architecture > 1.2. Data Layer"
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  contentHash: string;
}

export interface LexicalMatchResult {
  fileId: string;
  fileName: string;
  headingSlug: string;
  headingBreadcrumb: string;
  matchedExcerpt: string; // Paragraph text, table content, or vault_ref:// pointer for encrypted files
  lineRange: [number, number];
  bm25Score: number;
}

export interface SectionMergeOutcome {
  status: "clean" | "conflict_quarantined" | "syntax_invalid";
  mergedDocumentContent: string;
  hunkRange: { from: number; to: number; replacementText: string };
  diagnostics?: string[];
}

export interface IWorkspaceProvider {
  /** Return the complete heading tree for target files without loading full document bodies */
  listHeadingsTree(fileIds: string[]): Promise<Record<string, HeadingNode[]>>;

  /** Read the body of a specific section via file ID and heading slug (respecting vault isolation and recording the base ancestor snapshot for 3-way merge) */
  readSectionByHeading(
    fileId: string,
    headingSlug: string,
  ): Promise<{
    breadcrumb: string;
    contentOrVaultRef: string;
    isVaultRef: boolean;
  }>;

  /** Hybrid search (lexical BM25 / Regex) within paragraphs and tables with parent heading breadcrumb attached */
  searchLexicalWithASTBreadcrumb(params: {
    fileIds: string[];
    query: string;
    maxResults?: number;
  }): Promise<LexicalMatchResult[]>;

  /** 3-way merge (Diff3) of a specific section modification with structural syntax integrity validation */
  mergeSectionThreeWay(params: {
    fileId: string;
    headingSlug: string;
    baseSectionContent: string;
    agentProposedSectionContent: string;
    liveDocumentContent: string;
  }): Promise<SectionMergeOutcome>;
}
```

### 1.1. Interface Implementations (`Cloud vs. Desktop Implementations`)

| Operational Dimension | Cloud Implementation (`CloudPostgresWorkspaceProvider`) | Desktop Implementation (`DesktopLocalFsWorkspaceProvider`) |
| :--- | :--- | :--- |
| **File Source** | PostgreSQL `files` table (`src/server/db/schema/files.ts`) for standard plaintext files + transient memory map (`EphemeralVaultMemoryMap`) passed in the request for encrypted files and live editor snapshots (`liveDocumentSnapshots`). | Local filesystem (`node:fs/promises`) + local `SQLite` index in Electron. |
| **Permission Verification** | Verification of `files.userId === session.userId` and verification of `userVaultProfiles.allowAIOnEncryptedFiles`. | Local OS permissions for the open workspace directory. |
| **Lexical Search Engine** | Fast in-memory `BM25 / Regex` scanner over the targeted files (`targetFileIds`). | `SQLite FTS5` index + `Tree-sitter` AST for large code repositories. |

## 2. Hybrid AST and Lexical Search Engine (`Hybrid AST + Lexical/BM25 Engine`)

### 2.1. Fence-Aware Heading Slicer (`Fence-Aware Heading Slicer`)

Naive Regex slicing (`/^#{1,6}\s+/m`) suffers from a critical vulnerability: it captures `# comment` lines inside code blocks (` ```python ` or ` ```bash `) as section headings, corrupting section boundaries during merge operations.
Therefore, `src/core/ast/heading-slicer.ts` is built directly upon the fence-tracking state machine (`Fence State Machine`) already implemented in `src/lib/sync/syntax-validator.ts`:

1. **Ignoring Lines Inside Closed Fences:** While scanning document lines, the slicer tracks the opening and closing state of code fences (` ``` ` or `~~~`) and `YAML Frontmatter` at the beginning of the file, registering a line starting with `#` as a heading only when the code fence state is closed (`inCodeFence === false`).
2. **Section Span Calculation (`Section Span Calculation`):** The span of each heading $H_k$ (at level $L \in [1, 6]$) extends from its starting line up to the line immediately preceding the next heading with a level **less than or equal to $L$** ($L_{\text{next}} \le L$), guaranteeing that the section encapsulates all of its paragraphs and sub-headings (`Sub-headings`) as a cohesive structural unit.
3. **Parent Heading Breadcrumb Generation (`Heading Breadcrumb`):** The slicer maintains a hierarchical stack (`Heading Stack`) during scanning to generate the full structural path for every section and sub-heading (e.g., `"3. Economic Model > 3.4. Derivation Equations"`).

### 2.2. Hybrid Search Coupled with Structural Breadcrumb (`Lexical BM25 + AST Breadcrumb`)

When the agent searches for a technical term, variable name, or value inside a table via `searchLexicalWithASTBreadcrumb`:

1. The engine partitions each target document into paragraphs and tables categorized under their nearest enclosing parent heading node (`Nearest Enclosing HeadingNode`).
2. It computes the lexical relevance score (`BM25 + Exact Token Boost`) for matching paragraphs.
3. It returns the matching paragraph attached with its `headingSlug` and `headingBreadcrumb`, enabling the `assumption_analyzer_node` and the local candidate retriever (`Candidate Retriever`) to pinpoint the structural neighborhood of the affected section with $100\%$ precision and pass it to the relational arbitration node (`atms_relational_linker_node`).

## 3. Section-Scoped 3-Way Merge and Syntax Integrity Validation (`Section-Scoped Diff3 & Syntax Validation`)

The `document_writer_node` relies on the existing engineering assets in `src/lib/sync/diff3.ts` and `src/lib/sync/syntax-validator.ts` to update sections listed in `state.invalidation_map`:

1. **Identifying Base Ancestor Reference (`baseSectionContent`) and Live Version (`liveSectionContent`):**
   - When any section is read via `readSectionByHeading` during the exploration phase, the original section text at read time is recorded as the base ancestor reference (`Base Snapshot`) — either in a contextual map for standard files or retrieved from `EphemeralVaultMemoryMap` for encrypted files — while `liveSectionContent` is extracted from the latest live editor snapshot (`liveDocumentSnapshots[fileId]`) via the `Fence-Aware Heading Slicer` to determine its exact coordinates `(startOffset, endOffset)`.
2. **Section-Level and Sub-Line 3-Way Merge (`diff3MergeSection`):**
   - The exported function in `src/lib/sync/diff3.ts:463` is invoked in the exact order matching its actual signature `(localContent, baseContent, remoteContent)`, where the middle argument (`baseSectionContent`) represents the common ancestor (`o`):
     `diff3MergeText(liveSectionContent, baseSectionContent, agentProposedSectionContent)`
     (which applies the `Hunt-McIlroy LCS` algorithm and intra-line partial merge `trySubLineMerge` to resolve adjacent edits without false-positive conflicts).
3. **Pre-Stream Syntax Integrity Gate (`Pre-Stream Syntax Integrity Gate`):**
   - The merged text is passed through `validateMarkdownSyntaxIntegrity` in `src/lib/sync/syntax-validator.ts` to verify that there are no unclosed code fences, broken Markdown tables, or truncated math delimiters before streaming the ghost hunk to the user's editor.

## 4. Multi-Hunk Ghost Preview Architecture and Incremental Sync Contract (`Multi-Hunk Ghost & Incremental Sync Contract`)

### 4.1. Upgrading `streaming-ghost.ts` from Single Hunk to Hunk Array (`Multi-Hunk Ghost Decorations`)

The current file `src/components/editor/markdown/streaming-ghost.ts` (lines 20–31) in `LUGX v1.46.3` supports only a single preview hunk (`from: number`, `to: number`, `text: string`). To enable the agent to modify multiple non-contiguous sections across a document in a single cycle, the state is upgraded to the following structure:

```typescript
export interface GhostHunk {
  hunkId: string;
  decisionIds: string[]; // Architectural decisions that produced this modification
  headingSlug: string;
  from: number;
  to: number;
  originalSlice: string;
  replacementText: string;
  status: "streaming" | "preview_ready";
}

export interface MultiHunkGhostState {
  sessionId: string | null;
  hunks: GhostHunk[];
}
```

- **Automatic Coordinate Mapping via `tr.changes.mapPos`:** Whenever the user types elsewhere in the document or accepts one of the ghost hunks, `StateField.update` in CodeMirror 6 maps the coordinates of all remaining hunks through:
  ```typescript
  hunk.from = tr.changes.mapPos(hunk.from, 1);
  hunk.to = tr.changes.mapPos(hunk.to, -1);
  ```
  preserving the exact positioning of all remaining ghost hunks without any offset drift.

### 4.2. Incremental Hunk Sync Contract for Partial Acceptance and `412` Conflict Prevention (`Incremental Hunk Sync Contract`)

In the legacy architecture (`src/server/actions/ai-commit.ts`), accepting an AI result triggered an immediate, direct server save request. If that pattern were applied literally with `Multi-Hunk Ghost` and a user clicked "Accept" on three consecutive hunks within one second, 3 concurrent save requests carrying the same stale `expectedVersion` would be dispatched in parallel, triggering self-inflicted `412 Precondition Failed` errors.

Therefore, the system adopts the **Immediate Local Transaction + Debounced Sequential Server Sync (`Immediate Local Transaction + Debounced Sequential Server Sync`)** contract:

```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant CM6 as CodeMirror 6 Editor (MultiHunkGhost)
    participant IDB as Local Store (IndexedDB Queue)
    participant Autosave as Sync Coordinator (useEditorAutosave)
    participant Server as Server (PUT /api/files/:id)

    User->>CM6: Clicks "Accept" on Hunk #1
    CM6->>CM6: Apply range replacement [h1.from, h1.to] in a single transaction (Undoable)<br/>Remove Hunk #1 and shift coordinates of Hunk #2 & #3 via mapPos
    CM6->>IDB: Write updated local content immediately (localRevision += 1)
    CM6->>Autosave: Schedule sync request (Debounce 800ms)

    User->>CM6: Clicks "Accept" on Hunk #2 after 300ms
    CM6->>CM6: Apply updated range replacement [h2.from', h2.to'] and remove Hunk #2
    CM6->>IDB: Update merged local content (localRevision += 1)
    CM6->>Autosave: Reset debounce timer (Debounce Reset)

    Note over Autosave,Server: After acceptance stabilizes (800ms) or "Accept All" is clicked
    Autosave->>Server: Dispatch single save request with merged content + expectedVersion + expectedETag
    Server-->>Autosave: 200 OK (newVersion = v+1, newETag)
    Autosave->>IDB: Commit newVersion and newETag in IndexedDB
```

1. **Independence of Financial Settlement from Editor Acceptance:** As established in `Phase 11` of `LUGX v1.46.3`, token costs are settled server-side upon generation; consequently, user acceptance or rejection of a ghost hunk is a **pure file editing and synchronization operation** that never re-invokes the billing engine.
2. **Per-Hunk Atomic Undo (`Per-Hunk Atomic Undo`):** Accepting each `GhostHunk` is recorded as an independent CodeMirror transaction tagged with `Transaction.userEvent.of("ai.accept.hunk")`, so pressing `Ctrl+Z` cleanly reverts the last accepted hunk, whereas clicking **"Accept All Hunks (`Accept All Hunks`)"** applies all hunks in a single atomic CodeMirror transaction (`changes: hunks.map(...)`) that can be reverted all at once with a single `Ctrl+Z`.

## 5. Zero-Knowledge Vault Boundary and Isolated Ephemeral References (`Zero-Knowledge Vault Boundary & Ephemeral References`)

To preserve the end-to-end encryption (`Zero-Knowledge`) guarantees implemented in `src/lib/crypto/*`, `src/lib/vault/*`, and `src/server/db/schema/vault.ts`:

### 5.1. Server-Side Vault Consent Gate and Transient Transport Contract (`Server-Side Vault Consent Gate & Transient Transport Contract`)

1. Every request to `/api/agent/stream` (whether initiating a session or resuming via `Command({ resume })`) adheres to the following programmatic contract separating persistent state data from transient in-memory payloads:
   ```typescript
   export interface AgentStreamRequestPayload {
     threadId: string;
     projectId: string;
     prompt?: string;
     targetFileIds: string[];
     resumePayload?: unknown; // Validated user responses when resuming after interrupt()
     /**
      * Plaintext of encrypted files decrypted locally in the browser (when the vault is unlocked and allowAIOnEncryptedFiles === true).
      * Used exclusively to populate EphemeralVaultMemoryMap within the scope of the current HTTP request and never enters AgentGraphState.
      */
     ephemeralVaultPayloads?: Record<string, string>;
     /**
      * Latest live snapshots of open editor documents to ensure accurate computation of baseSectionContent and liveDocumentContent in Diff3.
      */
     liveDocumentSnapshots?: Record<string, string>;
   }
   ```
2. Prior to starting or resuming `LangGraph`, the security guard layer and `orchestrator_node` query the target file attributes in the `files` table and the user's vault settings in the `user_vault_profiles` table (`schema.userVaultProfiles` in `src/server/db/schema/vault.ts`):
   - If any file in `targetFileIds` (or in `ephemeralVaultPayloads`) has `isEncrypted === true` while the user's setting in `user_vault_profiles` is `allowAIOnEncryptedFiles === false`, the request is immediately rejected with status `403 VAULT_AI_ACCESS_DENIED` without processing or consuming any credits.

### 5.2. Ephemeral Memory Map and `vault_ref://` Pointers (`EphemeralVaultMemoryMap`)

Because the `files.content` column in PostgreSQL stores `AES-256-GCM` ciphertext for which the server holds no decryption key, processing encrypted files (when `allowAIOnEncryptedFiles === true`) follows this strict protocol:

1. **Transient Per-Request Hydration (Including `Resume` Requests):**
   - The client browser decrypts target files locally via `SyncCryptoGateway` and passes their plaintext in the transient `ephemeralVaultPayloads` field within the `POST /api/agent/stream` request (both on the initial request and on any resume request following an `interrupt`, because the initial request's memory is completely wiped upon suspension).
   - Upon receiving the request on the server, `CloudPostgresWorkspaceProvider` slices the texts in `ephemeralVaultPayloads` in memory via the `Fence-Aware Heading Slicer` and stores each section as a `Uint8Array` inside the `EphemeralVaultMemoryMap` (`Map<VaultRefUri, Uint8Array>`) scoped strictly to the active request context (`AsyncLocalStorage` / `RequestContext`).
2. **Prohibition of Storage in `AgentGraphState`:** Inserting decrypted plaintext into `state.search_report` or any other channel in `AgentGraphState` is strictly prohibited, because `PostgresSaver` automatically persists a checkpoint snapshot after every node (`Super-step`).
3. **Just-In-Time Prompt Resolution (`Just-In-Time Prompt Resolution`) and Deterministic Zeroization:**
   - Only a non-disclosing reference pointer is written into `state.search_report` in the format:
     `vault_ref://${fileId}#${headingSlug}`
   - When `assumption_analyzer_node` or `document_writer_node` needs to pass evidence to the LLM or retrieve `baseSectionContent` for 3-way merge, the prompt builder (`Prompt Resolver`) dereferences the `vault_ref://` pointer from `EphemeralVaultMemoryMap` in transient memory at the exact moment of dispatch without mutating the `state` object.
   - In the `finally` block of the `/api/agent/stream` route (whether the request concludes by completing the cycle, pausing at an `interrupt`, or throwing an error), deterministic zeroization (`Buffer.fill(0)`) is executed across all `EphemeralVaultMemoryMap` values in memory, followed by encrypting the session checkpoints themselves via `EncryptedCheckpointSerializer` as a second line of defense.
