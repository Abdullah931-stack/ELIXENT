# ADR-016: Zero-Knowledge Encryption Granularity Governance (Workspace-Wide vs. Per-File) and the Ephemeral Client-Decrypted AI Bridge

| Standard Field | Approved Value |
| :--- | :--- |
| **ADR Identifier** | `ADR-016` (`ELIXENT-ADR-016`) |
| **Classification** | `STANDALONE ARCHITECTURAL DECISION RECORD (ADR)` |
| **Version & Status** | `v1.1 — Accepted (Audited & Schema-Normalized)` |
| **Supersedes / Amends** | Amends the default `allow_ai_on_encrypted_files = false` policy in `../../src/server/db/schema/vault.ts` and [`03_workspace_ast_editor_and_vault_integration.md`](../03_workspace_ast_editor_and_vault_integration.md) (§5 Zero-Knowledge Vault Boundary) |
| **Governing Execution Plan** | [`ELIXENT-EXECUTION-PLAN-v1.1`](../../Plans/elixent-architectural-evolution-execution-plan.md) |
| **Companion SRS** | [`SRS-02: Multi-Workspace Isolation, File Lifecycle & Zero-Knowledge Vault Governance`](../../specs/srs_02_multi_workspace_isolation_and_zk_vault_governance.md) |
| **Affected Repository Scope** | `../../src/server/db/schema/vault.ts`, `../../src/server/db/schema/workspaces.ts` (Planned / New), `../../src/lib/vault/ephemeral-memory-map.ts`, `../../src/lib/sync/sync-crypto-gateway.ts`, `../../src/server/routes/agent.routes.ts`, `../../src/hooks/use-ai-stream.ts` |

## 1. Context & Problem Diagnosis

In [`ADR-005`](../01_architecture_vision_and_adrs.md) (§3.5) and `../../src/server/db/schema/vault.ts`, Zero-Knowledge encryption was designed solely at the individual file level (`files.isEncrypted`), with AI processing disabled by default (`allowAIOnEncryptedFiles: default(false)` in `../../src/server/db/schema/vault.ts`). Expanding the agent to operate across an entire multi-file workspace ([`ADR-011`](./adr_011_multi_workspace_data_isolation_model.md)) and `decisions.ledger.json` ([`ADR-012`](./adr_012_json_decision_ledger_and_graph_traversal.md)) exposes three architectural challenges:

1. **Ambiguity Between Workspace-Wide Encryption and Per-File Encryption:**
   - When a user encrypts an entire workspace (`workspace.isEncrypted = true`), allowing individual files created later (or decrypted individually) to remain unencrypted inside that workspace creates a dangerous security illusion: the user assumes the project is end-to-end encrypted while newly agent-created files or `decisions.ledger.json` sit in plaintext on the server.
   - Conversely, when a workspace is unencrypted (`workspace.isEncrypted = false`), users still need the flexibility to encrypt specific sensitive files individually without being forced to encrypt the entire workspace.
2. **Friction of Default-Disabled AI on Encrypted Files (`allowAIOnEncryptedFiles = false`):**
   - Because Elixent is an AI-first architectural workstation, defaulting `allowAIOnEncryptedFiles` to `false` silently blinds the agent to encrypted files until the user hunts through account settings, degrading the out-of-the-box experience.
3. **Closed Encrypted File Mutation Under Zero-Knowledge Constraints:**
   - Because the server never possesses the user's `Master Key`, `CloudPostgresWorkspaceProvider` on the server cannot decrypt closed encrypted files stored as `ciphertextBase64` in PostgreSQL, nor can it encrypt the mutated Markdown output produced by `workspace_mutator_node` before committing it to PostgreSQL.

## 2. Accepted Decision & Architectural Contract

We adopt a **Hierarchical Encryption Governance Model (`Workspace-All-In vs. Selective Per-File`)** paired with a **Default-Enabled Client-Side Ephemeral Decryption & Re-Encryption Bridge**.

```mermaid
sequenceDiagram
    autonumber
    participant UI as Browser Client (SyncCryptoGateway & IndexedDB)
    participant HONO as Hono SSE Endpoint (POST /api/agent/stream)
    participant CTX as AgentRuntimeContext (Ephemeral RAM Only)
    participant NODE8 as Node 8: workspace_mutator_node
    participant DB as Neon PostgreSQL (files Ciphertext Only)

    Note over UI: 1. Pre-Stream Local Decryption:<br/>Decrypt non-excluded encrypted files in workspaceId<br/>(including closed files & decisions.ledger.json) via Web Worker
    UI->>HONO: 2. POST /api/agent/stream<br/>{ prompt, ephemeralVaultPayloads: Record<fileId, plaintext> }
    HONO->>CTX: 3. Mount into request-scoped EphemeralVaultMemoryMap<br/>(Replace with vault_ref:// in AgentGraphState checkpoints)
    CTX->>NODE8: 4. Resolve vault_ref:// just-in-time in RAM;<br/>execute System 2 edit + 3-way AST merge
    NODE8-->>UI: 5. Emit SSE Event: 'vault_file_commit_required'<br/>{ fileId, mergedPlaintext, baseVersion, baseEtag }
    Note over UI: 6. Client-Side Re-Encryption:<br/>Encrypt mergedPlaintext with AES-256-GCM in Web Worker
    UI->>DB: 7. Atomic CAS Push of ciphertextBase64 + new ETag<br/>(Zero plaintext ever written to PostgreSQL)
    HONO->>CTX: 8. Zero out EphemeralVaultMemoryMap in finally{} block
```

1. **Hierarchical Workspace vs. File Encryption Governance Rules:**
   - **Encrypted Workspace (`workspace.isEncrypted === true`):** Enforces mandatory total encryption across every existing file, newly created file, and `decisions.ledger.json` (`file.isEncrypted = true`). Plaintext writes are rejected server-side (`400 WORKSPACE_ENCRYPTION_REQUIRED`). Decrypting any individual file inside an encrypted workspace is intercepted by a mandatory warning modal requiring explicit user approval to decrypt the entire workspace (`workspace.isEncrypted -> false`).
   - **Unencrypted Workspace (`workspace.isEncrypted === false`):** Permits selective per-file encryption and decryption (`file.isEncrypted = true/false`) independently without affecting sibling files.
2. **Default-Enabled AI (`allowAIOnEncryptedFiles = true`) & Ephemeral Client Bridge:**
   - `user_vault_profiles.allow_ai_on_encrypted_files` defaults to `true` (accompanied by a one-time informational notice upon first encryption), while `files.is_ai_excluded` reserves an architectural seam for future per-file AI exclusion.
   - Open and closed encrypted files in `workspaceId` are decrypted locally in the browser via `SyncCryptoGateway`, passed transiently in `ephemeralVaultPayloads` inside `EphemeralVaultMemoryMap`, and re-encrypted client-side upon mutation via `vault_file_commit_required` SSE frames without persisting plaintext in PostgreSQL.
   - Exact modal copy, SSE event schemas, and `SyncCryptoGateway` contracts are specified in [`SRS-02`](../../specs/srs_02_multi_workspace_isolation_and_zk_vault_governance.md) (§4).

## 3. Evaluated Alternatives & Single-Variable Rejection Rationales

To isolate the encryption boundary invariant and client-server AI delivery protocol (`Ceteris Paribus`), all alternatives are evaluated while holding `WebCrypto AES-256-GCM` (`../../src/lib/sync/encryption.ts`), `PBKDF2` / `WebAuthn PRF` key derivation (`../../src/lib/sync/webauthn-prf.ts`), and `vault_ref://` checkpoint redaction ([`ADR-005`](../01_architecture_vision_and_adrs.md)) strictly constant:

1. **Alternative 1: Allowing Unencrypted Individual Files Inside an Encrypted Workspace + Defaulting `allowAIOnEncryptedFiles = false`**
   - *Rejection Rationale:* Allowing mixed plaintext files inside a workspace marked "Encrypted" breaks user mental models and leaks newly created agent files or `decisions.ledger.json` in plaintext. Defaulting AI to `false` breaks multi-file architectural analysis out of the box.
2. **Alternative 2: Transmitting the User's Wrapped/Unwrapped Master Key or Session DEK to the Cloud Server**
   - *Rejection Rationale:* Violates the foundational Zero-Knowledge security guarantee; if the server holds the decryption key alongside the PostgreSQL database, database ciphertext is no longer zero-knowledge.
3. **Alternative 3 (Accepted): Strict Workspace-Wide Encryption Invariant + Default-Enabled Ephemeral Client-Decrypted Bridge**
   - *Selection Rationale:* Guarantees that an encrypted workspace contains $0$ plaintext files on disk/database (enforcing an explicit full-workspace confirmation if the user attempts to decrypt a file inside it), preserves selective per-file encryption in unencrypted workspaces, and enables seamless multi-file AI inspection and mutation without ever exposing cryptographic keys or persisting plaintext on the server.

## 4. Controlled Trade-off Matrix

| Evaluation Criterion (Isolated to Encryption Governance & AI Bridge) | Accepted Solution (`Strict Workspace Invariant + Ephemeral Client Bridge`) | Alternative 1 (`Mixed Files in Encrypted Workspace + AI Off by Default`) | Alternative 2 (`Server-Side Key Sharing`) |
| :--- | :--- | :--- | :--- |
| **Zero-Knowledge Guarantee at Rest in PostgreSQL** | $100\%$ preserved (Zero keys and zero plaintext stored on server) | Partial (Risks plaintext leakage on newly created files or ledger) | $0\%$ (Violates Zero-Knowledge) |
| **User Mental-Model Safety in Encrypted Workspaces** | $100\%$ (All files & `decisions.ledger.json` encrypted; decrypting any file warns & requires full-workspace decryption approval) | Confusing (Silent mix of encrypted and unencrypted files) | High |
| **Multi-File Closed Encrypted Document AI Support** | Full support out of the box (`ephemeralVaultPayloads` + `vault_file_commit_required`) | Disabled by default; fails on closed encrypted files | Full support, but insecure |

## 5. Consequences, Conflict Reconciliation & Migration Trigger

### 5.1. Architectural Consequences
- **Positive:** Eliminates silent plaintext leaks inside encrypted workspaces, enables out-of-the-box AI analysis across encrypted files without exposing keys to the server, and preserves selective per-file encryption in unencrypted workspaces.
- **Negative / Operational Trade-off:** Requires the browser client to decrypt all non-excluded encrypted files in the active workspace prior to opening `POST /api/agent/stream` and handle `vault_file_commit_required` SSE frames before closing the session.

### 5.2. Prior-ADR Conflict Reconciliation (Deferred to Execution Plan Phase 0)
- **[`03_workspace_ast_editor_and_vault_integration.md`](../03_workspace_ast_editor_and_vault_integration.md) (§5 Zero-Knowledge Vault Boundary):** Update in **Phase 0** to change `allow_ai_on_encrypted_files` default from `false` to `true`, add the workspace-wide encryption governance rules, and document the `vault_file_commit_required` SSE re-encryption handshake.

### 5.3. Migration Trigger (When to Revisit)
If a single encrypted workspace exceeds $50\text{ MB}$ of total Markdown text across hundreds of closed files such that sending all decrypted texts in the initial `ephemeralVaultPayloads` request body introduces noticeable upload latency, switch from eager workspace payload attachment to an interactive **2-Round Selective Vault Fetch** where `search_discovery_node` inspects encrypted heading trees first and requests on-demand client decryption only for the specific `(fileId, headingSlug)` sections matched during discovery.