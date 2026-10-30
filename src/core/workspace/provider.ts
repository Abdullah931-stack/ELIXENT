/**
 * Unified Workspace Provider Contracts & Error Definitions
 *
 * Defines the core abstraction layer (`IWorkspaceProvider`) for AST heading
 * hierarchy extraction, isolated section retrieval, path-coupled BM25 lexical
 * search, and three-way section merging across persistent and ephemeral documents.
 *
 * Re-exports AST and synchronization engine types to present a consolidated
 * contract surface for caller agents and stream route handlers.
 */

import type { HeadingNode } from "@/core/ast/heading-slicer";
import type { LexicalMatchResult } from "@/core/workspace/lexical-bm25";
import type { SectionMergeOutcome } from "@/lib/sync/diff3";

export type { HeadingNode } from "@/core/ast/heading-slicer";
export type { LexicalMatchResult } from "@/core/workspace/lexical-bm25";
export type { SectionMergeOutcome } from "@/lib/sync/diff3";

/**
 * Result structure returned when reading a single section by its heading slug.
 *
 * For unencrypted documents, `contentOrVaultRef` contains the verbatim section plaintext.
 * For encrypted vault documents, `contentOrVaultRef` contains an opaque reference pointer
 * (`vault_ref://${fileId}#${headingSlug}`) and `isVaultRef` is set to `true`.
 */
export interface SectionReadResult {
  breadcrumb: string;
  contentOrVaultRef: string;
  isVaultRef: boolean;
}

/**
 * Request payload structure supplied to the agent streaming pipeline.
 *
 * Supports multi-file context binding, transient client-side document snapshots,
 * and ephemeral vault payloads for zero-knowledge decryption scopes.
 */
export interface AgentStreamRequestPayload {
  threadId: string;
  projectId: string;
  prompt?: string;
  targetFileIds: string[];
  resumePayload?: unknown;
  ephemeralVaultPayloads?: Record<string, string>;
  liveDocumentSnapshots?: Record<string, string>;
}

/**
 * Unified workspace provider contract.
 *
 * Abstracts underlying storage (PostgreSQL, local IndexedDB, or memory) behind
 * a clean, deterministic interface enforcing file ownership, AST heading extraction,
 * lexical retrieval, and isolated three-way section merges.
 */
export interface IWorkspaceProvider {
  /**
   * Retrieves the AST heading hierarchy for the specified file identifiers.
   *
   * @param fileIds - Array of target workspace file IDs.
   * @returns Record mapping each file ID to its array of HeadingNode elements.
   * @throws {WorkspaceFileAccessDeniedError} If any fileId is not found or access denied.
   * @throws {VaultAIAccessDeniedError} If any file is encrypted and AI access is not allowed.
   * @throws {EncryptedPayloadMissingError} If any encrypted file lacks decrypted plaintext.
   */
  listHeadingsTree(fileIds: string[]): Promise<Record<string, HeadingNode[]>>;

  /**
   * Reads a single heading section and its subordinate body content.
   *
   * If the file is encrypted, the section plaintext is stored into the active
   * ephemeral vault scope and an opaque `vault_ref://` pointer is returned.
   *
   * @param fileId - ID of the target document.
   * @param headingSlug - Slug of the target heading to retrieve.
   * @returns SectionReadResult containing breadcrumb, content or pointer, and vault flag.
   * @throws {WorkspaceFileAccessDeniedError} If file is not found or access denied.
   * @throws {WorkspaceSectionNotFoundError} If heading slug is not found in the file.
   * @throws {VaultAIAccessDeniedError} If file is encrypted and AI access is disabled.
   * @throws {EncryptedPayloadMissingError} If encrypted file lacks decrypted plaintext.
   */
  readSectionByHeading(fileId: string, headingSlug: string): Promise<SectionReadResult>;

  /**
   * Executes path-coupled BM25 lexical search across the specified workspace files.
   *
   * Returned match excerpts from encrypted files are replaced by ephemeral vault
   * reference pointers (`vault_ref://${fileId}#${headingSlug}`) to prevent plaintext
   * leakage into search reports.
   *
   * @param params - Search parameters: target file IDs, lexical query, and maxResults.
   * @returns Array of LexicalMatchResult items with AST breadcrumbs and BM25 scores.
   * @throws {WorkspaceFileAccessDeniedError} If any file is not found or access denied.
   * @throws {VaultAIAccessDeniedError} If any file is encrypted and AI access is disabled.
   * @throws {EncryptedPayloadMissingError} If encrypted file lacks decrypted plaintext.
   */
  searchLexicalWithASTBreadcrumb(params: {
    fileIds: string[];
    query: string;
    maxResults?: number;
  }): Promise<LexicalMatchResult[]>;

  /**
   * Merges an agent-proposed section modification into a live document using 3-way merge.
   *
   * Automatically resolves any embedded `vault_ref://` pointers just-in-time before
   * invoking the Diff3 merge algorithm, ensuring zero-knowledge isolation.
   *
   * @param params - Merge parameters including file ID, heading slug, base, proposed, and live text.
   * @returns SectionMergeOutcome detailing merge status, hunk ranges, and merged content.
   * @throws {WorkspaceFileAccessDeniedError} If file is not found or access denied.
   * @throws {VaultAIAccessDeniedError} If file is encrypted and AI access is disabled.
   */
  mergeSectionThreeWay(params: {
    fileId: string;
    headingSlug: string;
    baseSectionContent: string;
    agentProposedSectionContent: string;
    liveDocumentContent: string;
  }): Promise<SectionMergeOutcome>;
}

// ============================================================================
// Custom Workspace Domain Errors
// ============================================================================

/**
 * Thrown when AI operations are attempted on encrypted vault files
 * but the user has not enabled AI access in their vault profile.
 */
export class VaultAIAccessDeniedError extends Error {
  readonly status = 403;
  readonly code = "VAULT_AI_ACCESS_DENIED";

  constructor(message = "AI access on encrypted vault files is disabled by user policy") {
    super(message);
    this.name = "VaultAIAccessDeniedError";
    Object.setPrototypeOf(this, VaultAIAccessDeniedError.prototype);
  }
}

/**
 * Thrown when one or more requested workspace files cannot be found,
 * are soft-deleted, or belong to a different user.
 */
export class WorkspaceFileAccessDeniedError extends Error {
  readonly status = 404;
  readonly code = "WORKSPACE_FILE_ACCESS_DENIED";

  constructor(message = "One or more requested workspace files were not found or access is denied") {
    super(message);
    this.name = "WorkspaceFileAccessDeniedError";
    Object.setPrototypeOf(this, WorkspaceFileAccessDeniedError.prototype);
  }
}

/**
 * Thrown when a requested heading slug does not exist within the target document.
 */
export class WorkspaceSectionNotFoundError extends Error {
  readonly status = 404;
  readonly code = "WORKSPACE_SECTION_NOT_FOUND";

  constructor(message = "The requested heading section was not found in the target document") {
    super(message);
    this.name = "WorkspaceSectionNotFoundError";
    Object.setPrototypeOf(this, WorkspaceSectionNotFoundError.prototype);
  }
}

/**
 * Thrown when an encrypted file is accessed for AI operations but no decrypted
 * plaintext was supplied in the request payload or live snapshots.
 */
export class EncryptedPayloadMissingError extends Error {
  readonly status = 400;
  readonly code = "ENCRYPTED_PAYLOAD_MISSING";

  constructor(message = "Decrypted plaintext payload missing for encrypted file") {
    super(message);
    this.name = "EncryptedPayloadMissingError";
    Object.setPrototypeOf(this, EncryptedPayloadMissingError.prototype);
  }
}
