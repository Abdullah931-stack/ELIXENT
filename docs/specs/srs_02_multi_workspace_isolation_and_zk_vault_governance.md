# Software Requirements Specification (SRS-02): Multi-Workspace Isolation, File Lifecycle Management, and Zero-Knowledge Vault Governance

| Standard Field              | Approved Value                                                                                                                                                                                                                                                                                                                                                       |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document ID**             | `ELIXENT-SRS-02-WORKSPACE-VAULT-v1.1`                                                                                                                                                                                                                                                                                                                                |
| **Classification**          | `SOFTWARE REQUIREMENTS SPECIFICATION (SUBSYSTEM 2 OF 4)`                                                                                                                                                                                                                                                                                                             |
| **Governing ADRs**          | [`ADR-011`](../architecture/adrs/adr_011_multi_workspace_data_isolation_model.md), [`ADR-012`](../architecture/adrs/adr_012_json_decision_ledger_and_graph_traversal.md), [`ADR-016`](../architecture/adrs/adr_016_zk_encryption_granularity_and_ephemeral_ai_bridge.md)                                                                                             |
| **Reference Baseline**      | `Elixent v0.22.0` (`Vite 6 SPA + TanStack Router + Hono RPC`)                                                                                                                                                                                                                                                                                                        |
| **Target Repository Scope** | `../../src/server/db/schema/workspaces.ts`, `../../src/server/db/schema/files.ts`, `../../src/server/db/schema/vault.ts`, `../../src/core/workspace/**`, `../../src/lib/vault/**`, `../../src/lib/crypto/aad.ts`, `../../src/lib/export/workspace-zip-exporter.ts`, `../../src/lib/sync/**`, `../../src/server/routes/rpc.routes.ts` |
| **Status**                  | `IMPLEMENTED & VERIFIED — Phases 1, 2, 4, 5 & 6 E2E Release Gate Closed (v0.29.0)` |

## 1. Purpose, Scope & Architectural Traceability

This Software Requirements Specification (**SRS-02**) defines the database schemas, `IWorkspaceProvider` contracts, file lifecycle tools (`createWorkspaceFile`, `deleteWorkspaceFile`, full-workspace `.zip` export), hierarchical Zero-Knowledge (`ZK`) encryption invariants, ephemeral client-server decryption bridge, and brand-agnostic domain prefix standards.

| Requirement Group         | Governing ADR                                                                                  | Target Source Modules                                                                                                                                                                                                                                     | Core Engineering Objective                                                                                                                                                                                                                                                |
| :------------------------ | :--------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`REQ-WS-01 .. 06`**     | [`ADR-011`](../architecture/adrs/adr_011_multi_workspace_data_isolation_model.md)              | `../../src/server/db/schema/workspaces.ts`, `../../src/server/db/schema/files.ts`, `../../src/core/workspace/provider.ts`, `../../src/core/workspace/cloud-provider.ts`, `../../src/lib/export/workspace-zip-exporter.ts` | Enforce multi-workspace data isolation, workspace-scoped filename uniqueness, full-workspace agent access (open + closed files), file creation/deletion tools, and hierarchical `.zip` archive export.                                                                    |
| **`REQ-ZK-01 .. 05`**     | [`ADR-016`](../architecture/adrs/adr_016_zk_encryption_granularity_and_ephemeral_ai_bridge.md) | `../../src/server/db/schema/vault.ts`, `../../src/lib/sync/sync-crypto-gateway.ts`, `../../src/lib/vault/ephemeral-memory-map.ts`, `../../src/server/routes/agent.routes.ts`                                                                              | Enforce mandatory total encryption inside encrypted workspaces with all-or-nothing decryption confirmation, enable AI on encrypted files by default (`allowAIOnEncryptedFiles = true`), and implement the `ephemeralVaultPayloads` / `vault_file_commit_required` bridge. |
| **`REQ-PREFIX-01 .. 03`** | Direct Engineering Requirement                                                                 | `../../src/lib/crypto/aad.ts`, `../../src/lib/sync/session-key-store.ts`, `../../src/lib/sync/cross-tab-sync.ts`, `../../src/lib/sync/idb-types.ts`                                                                                                       | Replace legacy project-named prefixes (`lugx:v1:*`, `lugx_vault_session_v1`, `lugx_sync_*`) with permanent, brand-agnostic functional prefixes (`zk:v1:*`, `vault_session_v1`, `workspace_sync_*`).                                                                       |

## 2. Multi-Workspace Database Schema & Tenancy Isolation (`ADR-011`)

### 2.1. Sovereign `workspaces` Table Schema (`REQ-WS-01`)

File: `../../src/server/db/schema/workspaces.ts`

```typescript
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    isEncrypted: boolean("is_encrypted").notNull().default(false),
    defaultPermissionMode: varchar("default_permission_mode", { length: 32 })
      .$type<"safe" | "semi_auto" | "full_auto">()
      .notNull()
      .default("safe"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_workspaces_user_name").on(table.userId, table.name),
    index("idx_workspaces_user_updated").on(table.userId, table.updatedAt),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
```

### 2.2. Workspace-Scoped `files` Schema & Uniqueness Invariant (`REQ-WS-02`)

File: `../../src/server/db/schema/files.ts`

1. Add mandatory column `workspaceId`:
   ```typescript
   workspaceId: uuid("workspace_id")
     .notNull()
     .references(() => workspaces.id, { onDelete: "cascade" }),
   ```
2. Add architectural exclusion column `isAiExcluded`:
   ```typescript
   isAiExcluded: boolean("is_ai_excluded").notNull().default(false),
   ```
3. Add system artifact classification column `artifactRole`:
   ```typescript
   artifactRole: varchar("artifact_role", { length: 32 })
     .$type<"document" | "decision_ledger">()
     .notNull()
     .default("document"),
   ```
4. Replace `idx_files_user_parent_title_live` with the workspace-scoped partial unique index:
   ```sql
   CREATE UNIQUE INDEX idx_files_workspace_parent_title_live
   ON files (workspace_id, COALESCE(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid), title)
   WHERE deleted_at IS NULL;
   ```
   ```typescript
   uniqueIndex("idx_files_workspace_parent_title_live")
     .on(
       table.workspaceId,
       sql`COALESCE(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
       table.title,
     )
     .where(sql`deleted_at IS NULL`),
   index("idx_files_workspace_deleted").on(table.workspaceId, table.deletedAt),
   ```

## 3. Expanded `IWorkspaceProvider` & Full-Workspace Agent Operations (`REQ-WS-03 .. 06`)

### 3.1. Expanded `IWorkspaceProvider` Contract

File: `../../src/core/workspace/provider.ts`

```typescript
export interface WorkspaceTreeEntry {
  readonly fileId: string;
  readonly parentFolderId: string | null;
  readonly title: string;
  readonly relativePath: string;
  readonly isFolder: boolean;
  readonly isEncrypted: boolean;
  readonly isAiExcluded: boolean;
  readonly artifactRole: "document" | "decision_ledger";
  readonly etag: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface SectionReadResult {
  readonly fileId: string;
  readonly headingSlug: string;
  readonly breadcrumb: string;
  readonly contentOrVaultRef: string;
  readonly isVaultRef: boolean;
  readonly sectionHash: string;
  readonly fileEtag: string;
  readonly fileVersion: number;
}

export interface IWorkspaceProvider {
  readonly workspaceId: string;
  readonly userId: string;

  /** Lists all non-deleted, non-AI-excluded files and folders in the active workspace */
  listWorkspaceTree(): Promise<WorkspaceTreeEntry[]>;

  /** Extracts AST heading hierarchies; if fileIds is omitted/empty, inspects all markdown files in workspaceId */
  listHeadingsTree(fileIds?: string[]): Promise<Record<string, HeadingNode[]>>;

  /** Reads a specific heading section and returns fileId, headingSlug, breadcrumb, and content/vault_ref */
  readSectionByHeading(
    fileId: string,
    headingSlug: string,
  ): Promise<SectionReadResult>;

  /** Runs path-coupled BM25 lexical search across specified fileIds or all markdown files in workspaceId */
  searchLexicalWithASTBreadcrumb(params: {
    fileIds?: string[];
    query: string;
    maxResults?: number;
  }): Promise<LexicalMatchResult[]>;

  /** Executes 3-way AST section merge and persists to open/closed file targets according to permissionMode */
  mergeSectionThreeWay(params: {
    fileId: string;
    headingSlug: string;
    baseSectionContent: string;
    agentProposedSectionContent: string;
    liveDocumentContent: string;
  }): Promise<SectionMergeOutcome>;

  /** Creates a new Markdown file (and any missing parent folders) inside the active workspaceId */
  createWorkspaceFile(params: {
    relativePath: string;
    initialContent: string;
  }): Promise<WorkspaceTreeEntry>;

  /** Soft-deletes a document file (deletedAt = now()) inside workspaceId; blocks deleting decisions.ledger.json */
  deleteWorkspaceFile(params: {
    fileId: string;
  }): Promise<{ fileId: string; deletedAt: string }>;

  /** Reads the workspace's canonical decisions.ledger.json document (initializing v2.0 if absent) */
  readDecisionLedger(): Promise<DecisionLedgerDocument>;

  /** Atomically writes the updated decisions.ledger.json document with optional OCC checks */
  writeDecisionLedger(
    document: DecisionLedgerDocument,
    options?: { expectedVersion?: number; expectedEtag?: string },
  ): Promise<{ etag: string; version: number }>;
}
```

### 3.2. Open & Closed File Visibility and Hermetic Workspace Guard (`REQ-WS-04`)

In `CloudPostgresWorkspaceProvider` (`../../src/core/workspace/cloud-provider.ts`):

1. Every database query filters by `and(eq(schema.files.workspaceId, this.workspaceId), eq(schema.files.userId, this.userId), isNull(schema.files.deletedAt), eq(schema.files.isAiExcluded, false))`.
2. If a caller supplies a `fileId` that belongs to another `workspaceId` (even if owned by the same `userId`), `loadAndValidateFiles` MUST throw `CrossWorkspaceAccessForbiddenError` (`status = 403`, `code = "CROSS_WORKSPACE_ACCESS_FORBIDDEN"`).
3. When reading or mutating a file:
   - If `this.liveDocumentSnapshots[fileId]` is present (an open editor tab with unsaved changes), use it as `liveDocumentContent`.
   - If the file is **closed** in the editor (`liveDocumentSnapshots[fileId]` is undefined):
     - If `r.isEncrypted === false`: read `r.content` directly from PostgreSQL and persist merged modifications directly to PostgreSQL (`version = version + 1`, recomputed SHA-256 `etag`).
     - If `r.isEncrypted === true`: resolve plaintext from `this.ephemeralVaultPayloads[fileId]` and emit `vault_file_commit_required` for client-side re-encryption (Section 4.3).

### 3.3. Full-Workspace `.zip` Archive Export (`REQ-WS-06`)

File: `../../src/lib/export/workspace-zip-exporter.ts`

- Exposes `exportWorkspaceAsZip(workspaceId: string, options?: WorkspaceZipExportOptions): Promise<Blob>`:
  1. Reconstructs the full folder hierarchy (`parentFolderId` tree) inside the `.zip` archive using each file's `relativePath`.
  2. Fails closed with `WorkspaceZipExportError('ENCRYPTED_EXPORT_UNCONFIRMED')` if any active file has `isEncrypted === true` and `options.confirmedPlaintextExport !== true`, then decrypts content locally via `SyncCryptoGateway` (`../../src/lib/sync/sync-crypto-gateway.ts`) when the vault is unlocked (after displaying `ExportWarningModal` in `../../src/components/export/export-warning-modal.tsx`).
  3. Includes `decisions.ledger.json` at the root of the `.zip` archive with every `affectedSections` entry containing `{ fileId, relativePath, headingSlug }`.

## 4. Zero-Knowledge Encryption Governance & Ephemeral AI Bridge (`ADR-016`)

### 4.1. Hierarchical Workspace-Wide vs. Per-File Encryption Invariants (`REQ-ZK-01 .. 02`)

1. **Enforcing Total Encryption Inside Encrypted Workspaces (`workspace.isEncrypted === true`):**
   - When a user enables encryption on a workspace (or creates an encrypted workspace):
     - All existing unencrypted files in `workspaceId` (including `decisions.ledger.json`) are encrypted client-side via `SyncCryptoGateway` in a single batch and pushed with `isEncrypted = true` and `encryptionMetadata`.
     - Any new file subsequently created in `workspaceId` (by user UI or by agent `createWorkspaceFile`) inherits `isEncrypted = true` automatically.
     - Server RPC/REST file write handlers reject any request setting `isEncrypted = false` or omitting `encryptionMetadata` when `workspace.isEncrypted === true` (`HTTP 400 WORKSPACE_ENCRYPTION_REQUIRED`).
2. **All-or-Nothing Workspace Decryption Confirmation Guard:**
   - If `workspace.isEncrypted === true` and the user triggers "Decrypt File" on any file inside the workspace, the action MUST be intercepted by `WorkspaceDecryptionWarningModal` (`../../src/components/vault/workspace-decryption-warning-modal.tsx` — Planned / New):
     - Displays the mandatory warning copy: _"Decrypting any file inside an encrypted workspace requires decrypting the entire workspace and all of its files. Do you want to proceed?"_
     - Only if the user explicitly confirms ("Decrypt Entire Workspace") does `SyncCryptoGateway` decrypt all files in `workspaceId`, push their plaintext envelopes, and set `workspace.isEncrypted = false`.
3. **Selective Per-File Encryption in Unencrypted Workspaces (`workspace.isEncrypted === false`):**
   - When `workspace.isEncrypted === false`, users may encrypt or decrypt individual files (`file.isEncrypted = true/false`) freely without modifying sibling files.

### 4.2. Default-Enabled AI (`allowAIOnEncryptedFiles = true`) & One-Time Notice (`REQ-ZK-03`)

File: `../../src/server/db/schema/vault.ts`

- Update `allowAIOnEncryptedFiles` column default:
  ```typescript
  allowAIOnEncryptedFiles: boolean("allow_ai_on_encrypted_files").default(true).notNull(),
  ```
- When a user encrypts their first file or workspace, display a one-time non-blocking informational banner noting that AI analysis is enabled by default via ephemeral in-memory processing and can be toggled in Vault Settings (`../../src/components/vault/vault-security-card.tsx`).

### 4.3. Ephemeral Client-Decrypted AI Bridge (`REQ-ZK-04`)

File: `../../src/server/routes/agent.routes.ts` & `../../src/hooks/use-ai-stream.ts`

1. **Pre-Stream Client Decryption:** Before opening `POST /api/agent/stream`, if the vault is unlocked and `allowAIOnEncryptedFiles === true`, `useAIStream` loads all non-excluded encrypted files (`isEncrypted && !isAiExcluded`) in the active `workspaceId` (both open and closed in editor, plus encrypted `decisions.ledger.json`), decrypts them locally via `SyncCryptoGateway`, and attaches `ephemeralVaultPayloads: Record<fileId, string>`.
2. **Request-Scoped ALS & RuntimeContext Wiring:** `POST /api/agent/stream` wraps execution in `runWithEphemeralVaultScope` (`../../src/lib/vault/ephemeral-memory-map.ts`) and passes the shared `CloudPostgresWorkspaceProvider` instance (initialized with `workspaceId`, `ephemeralVaultPayloads`, and `liveDocumentSnapshots`) into `AgentRuntimeContext`.
3. **Client Re-Encryption Commit Handshake (`vault_file_commit_required`):** Whenever `ledger_commit_node` or `workspace_mutator_node` produces an updated payload for an encrypted file in `semi_auto` or `full_auto` mode, the server emits SSE frame:
   ```typescript
   export interface VaultFileCommitRequiredEvent {
     readonly type: "vault_file_commit_required";
     readonly fileId: string;
     readonly relativePath: string;
     readonly artifactRole: "document" | "decision_ledger";
     readonly mergedPlaintext: string;
     readonly expectedBaseVersion: number;
     readonly expectedBaseEtag: string;
     readonly turnId: string;
   }
   ```
   The client receives the frame, records the pre-mutation `IDBOperation` snapshot ([`ADR-015`](../architecture/adrs/adr_015_two_tier_workspace_undo_and_turn_rollback.md)), encrypts `mergedPlaintext` via `SyncCryptoGateway`, and pushes the encrypted envelope via Hono RPC.

## 5. Brand-Agnostic Domain Prefix Standardization (`REQ-PREFIX-01 .. 03`)

To decouple cryptographic, storage, and cross-tab channels permanently from legacy or changing product names:

| Module Path                                            | Legacy Prefix / Key                                   | Canonical Brand-Agnostic Value                                                                                                                 | Backward-Compatibility Rule                                                                                                                                        |
| :----------------------------------------------------- | :---------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../../src/lib/crypto/aad.ts`                          | `AAD_VERSION_V1 = 'lugx:v1'`                          | `AAD_VERSION_V1 = 'zk:v1'` (`zk:v1:pass:<userId>`, `zk:v1:recovery:<userId>`, `zk:v1:device:<userId>:<epoch>`, `zk:v1:file:<userId>:<fileId>`) | **Clean-Cut Purge (Pre-Production):** `AAD.legacy` is removed completely; `zk:v1:*` is enforced exclusively with zero legacy `lugx:v1:*` decryption fallback.                                       |
| `../../src/lib/sync/session-key-store.ts`              | `SESSION_STORAGE_VAULT_KEY = 'lugx_vault_session_v1'` | `SESSION_STORAGE_VAULT_KEY = 'vault_session_v1'`                                                                                               | **Clean-Cut Purge (Pre-Production):** Uses `'vault_session_v1'` exclusively without legacy key probes.                                                            |
| `../../src/lib/sync/cross-tab-sync.ts` & `tab-sync.ts` | `lugx_sync_${userId}`                                 | `workspace_sync_${userId}`                                                                                                                     | All active tabs within the SPA build share `workspace_sync_${userId}`.                                                                                             |

## 6. Verification & Acceptance Criteria

1. **Isolation & Lifecycle Tests (`../../src/test/workspace/`):**
   - Verify creating two workspaces with identical root filenames (`architecture.md`) succeeds without index collision, while duplicate filenames in the same `(workspaceId, parentFolderId)` fail with `409 Conflict`.
   - Verify `CloudPostgresWorkspaceProvider` reads and updates closed files in `workspaceId` and throws `CrossWorkspaceAccessForbiddenError (403)` when queried with a `fileId` from another workspace.
2. **Encryption Invariant Tests (`../../src/test/vault/`):**
   - Verify that inside an encrypted workspace (`workspace.isEncrypted === true`), `createWorkspaceFile` and `decisions.ledger.json` are strictly encrypted, plaintext writes fail with `400 WORKSPACE_ENCRYPTION_REQUIRED`, and decrypting a single file requires confirming full-workspace decryption.
   - Verify `AAD` enforces `zk:v1:*` exclusively across all encryption/decryption paths and that `AAD.legacy` (`lugx:v1:*` fallback) is completely purged.
