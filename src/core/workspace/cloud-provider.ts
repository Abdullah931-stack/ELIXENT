/**
 * Cloud PostgreSQL Workspace Provider Implementation
 *
 * Implements `IWorkspaceProvider` backed by server-side PostgreSQL storage,
 * enforcing strict file ownership isolation, zero-knowledge vault boundaries,
 * client-side ephemeral plaintext reconciliation, and Diff3 section merges.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, schema } from "@/server/db";
import {
  parseMarkdownHeadingTree,
  extractSectionBySlug,
  type HeadingNode,
} from "@/core/ast/heading-slicer";
import {
  searchLexicalWithASTBreadcrumb as executeLexicalSearch,
  type SearchDocumentTarget,
  type LexicalMatchResult,
} from "@/core/workspace/lexical-bm25";
import { diff3MergeSection, type SectionMergeOutcome } from "@/lib/sync/diff3";
import {
  storeEphemeralVaultSection,
  resolveVaultRefJustInTime,
} from "@/lib/vault/ephemeral-memory-map";
import {
  type IWorkspaceProvider,
  type SectionReadResult,
  VaultAIAccessDeniedError,
  WorkspaceFileAccessDeniedError,
  WorkspaceSectionNotFoundError,
  EncryptedPayloadMissingError,
} from "./provider";

/**
 * Configuration options for CloudPostgresWorkspaceProvider.
 */
export interface CloudPostgresWorkspaceProviderOptions {
  userId: string;
  ephemeralVaultPayloads?: Record<string, string>;
  liveDocumentSnapshots?: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any; // injected drizzle DB instance, defaults to db from '@/server/db'
}

interface ResolvedWorkspaceFile {
  id: string;
  title: string;
  isEncrypted: boolean;
  content: string;
}

/**
 * Concrete implementation of `IWorkspaceProvider` backed by PostgreSQL.
 *
 * Guarantees:
 * 1. File Ownership: Queries strictly enforce `userId` and filter out soft-deleted files (`deletedAt IS NULL`).
 * 2. Zero-Knowledge Protection: Encrypted files cannot be processed unless `userVaultProfiles.allowAIOnEncryptedFiles === true`.
 * 3. Ciphertext Isolation: Encrypted database ciphertext is never parsed as Markdown. Decrypted plaintexts must be provided
 *    via ephemeral payloads or live snapshots.
 * 4. Pointer Redaction: Plaintext sections or search excerpts belonging to encrypted files are replaced by opaque
 *    `vault_ref://` pointers backed by transient Node.js `AsyncLocalStorage` memory.
 */
export class CloudPostgresWorkspaceProvider implements IWorkspaceProvider {
  private readonly userId: string;
  private readonly ephemeralVaultPayloads: Record<string, string>;
  private readonly liveDocumentSnapshots: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;

  constructor(options: CloudPostgresWorkspaceProviderOptions) {
    if (!options || typeof options.userId !== "string" || options.userId.trim().length === 0) {
      throw new TypeError("CloudPostgresWorkspaceProvider: userId must be a non-empty string");
    }
    this.userId = options.userId;
    this.ephemeralVaultPayloads = options.ephemeralVaultPayloads ?? {};
    this.liveDocumentSnapshots = options.liveDocumentSnapshots ?? {};
    this.db = options.db ?? defaultDb;
  }

  /**
   * Internal helper to load, verify ownership, check vault AI permissions,
   * and resolve document plaintext across requested file IDs.
   */
  private async loadAndValidateFiles(
    fileIds: string[],
    requireDecryptedPayload = true
  ): Promise<ResolvedWorkspaceFile[]> {
    const uniqueFileIds = Array.from(new Set(fileIds));
    if (uniqueFileIds.length === 0) {
      return [];
    }

    const fileRecords = await this.db
      .select()
      .from(schema.files)
      .where(
        and(
          inArray(schema.files.id, uniqueFileIds),
          eq(schema.files.userId, this.userId),
          isNull(schema.files.deletedAt)
        )
      );

    const records = Array.isArray(fileRecords) ? fileRecords : [];
    const foundIds = new Set(records.map((r: { id: string }) => r.id));
    const missing = uniqueFileIds.filter((id) => !foundIds.has(id));

    if (missing.length > 0) {
      throw new WorkspaceFileAccessDeniedError(
        `Workspace file access denied or not found: ${missing.join(", ")}`
      );
    }

    const hasEncrypted = records.some((r: { isEncrypted: boolean }) => Boolean(r.isEncrypted));
    if (hasEncrypted) {
      const query = this.db
        .select()
        .from(schema.userVaultProfiles)
        .where(eq(schema.userVaultProfiles.userId, this.userId));

      const queryRes = typeof query?.limit === "function" ? await query.limit(1) : await query;
      const profiles = Array.isArray(queryRes) ? queryRes : [];
      const profile = profiles[0];

      if (!profile || profile.allowAIOnEncryptedFiles !== true) {
        throw new VaultAIAccessDeniedError();
      }
    }

    return records.map(
      (r: { id: string; title: string; isEncrypted: boolean; content: string | null }) => {
        let content: string;
        if (r.isEncrypted) {
          const candidate =
            this.liveDocumentSnapshots[r.id] ??
            this.ephemeralVaultPayloads[r.id];

          if (requireDecryptedPayload && typeof candidate !== "string") {
            throw new EncryptedPayloadMissingError(
              `Decrypted plaintext payload missing for encrypted file ${r.id}`
            );
          }
          content = candidate ?? "";
        } else {
          content =
            this.liveDocumentSnapshots[r.id] ??
            r.content ??
            "";
        }

        return {
          id: r.id,
          title: r.title,
          isEncrypted: Boolean(r.isEncrypted),
          content,
        };
      }
    );
  }

  /**
   * Retrieves the AST heading hierarchy for the specified file identifiers.
   */
  public async listHeadingsTree(
    fileIds: string[]
  ): Promise<Record<string, HeadingNode[]>> {
    if (!fileIds || fileIds.length === 0) {
      return {};
    }

    const resolvedFiles = await this.loadAndValidateFiles(fileIds, true);
    const result: Record<string, HeadingNode[]> = {};

    for (const file of resolvedFiles) {
      result[file.id] = parseMarkdownHeadingTree(file.content);
    }

    return result;
  }

  /**
   * Reads a single heading section and its subordinate body content.
   */
  public async readSectionByHeading(
    fileId: string,
    headingSlug: string
  ): Promise<SectionReadResult> {
    if (!fileId || typeof fileId !== "string" || fileId.trim().length === 0) {
      throw new WorkspaceFileAccessDeniedError("File ID must be a non-empty string");
    }
    if (!headingSlug || typeof headingSlug !== "string" || headingSlug.trim().length === 0) {
      throw new WorkspaceSectionNotFoundError("Heading slug must be a non-empty string");
    }

    const [file] = await this.loadAndValidateFiles([fileId], true);
    if (!file) {
      throw new WorkspaceFileAccessDeniedError(`File not found: ${fileId}`);
    }

    const section = extractSectionBySlug(file.content, headingSlug);
    if (!section) {
      throw new WorkspaceSectionNotFoundError(
        `Section with heading slug "${headingSlug}" was not found in file ${fileId}`
      );
    }

    if (file.isEncrypted) {
      const vaultRef = storeEphemeralVaultSection(
        fileId,
        headingSlug,
        section.sectionContent
      );
      return {
        breadcrumb: section.heading.breadcrumb,
        contentOrVaultRef: vaultRef,
        isVaultRef: true,
      };
    }

    return {
      breadcrumb: section.heading.breadcrumb,
      contentOrVaultRef: section.sectionContent,
      isVaultRef: false,
    };
  }

  /**
   * Executes path-coupled BM25 lexical search across the specified workspace files.
   */
  public async searchLexicalWithASTBreadcrumb(params: {
    fileIds: string[];
    query: string;
    maxResults?: number;
  }): Promise<LexicalMatchResult[]> {
    if (!params.fileIds || params.fileIds.length === 0) {
      return [];
    }
    if (!params.query || params.query.trim().length === 0) {
      return [];
    }

    const resolvedFiles = await this.loadAndValidateFiles(params.fileIds, true);
    if (resolvedFiles.length === 0) {
      return [];
    }

    const documents: SearchDocumentTarget[] = resolvedFiles.map((f) => ({
      fileId: f.id,
      fileName: f.title,
      content: f.content,
    }));

    const searchResults = executeLexicalSearch({
      documents,
      query: params.query,
      maxResults: params.maxResults,
    });

    const encryptedFileMap = new Map<string, boolean>();
    for (const f of resolvedFiles) {
      encryptedFileMap.set(f.id, f.isEncrypted);
    }

    return searchResults.map((match) => {
      if (encryptedFileMap.get(match.fileId)) {
        const headingSlug =
          match.headingSlug && match.headingSlug.trim().length > 0
            ? match.headingSlug.trim()
            : "search-match";

        const vaultRef = storeEphemeralVaultSection(
          match.fileId,
          headingSlug,
          match.matchedExcerpt
        );

        return {
          ...match,
          matchedExcerpt: vaultRef,
        };
      }
      return match;
    });
  }

  /**
   * Merges an agent-proposed section modification into a live document using 3-way merge.
   */
  public async mergeSectionThreeWay(params: {
    fileId: string;
    headingSlug: string;
    baseSectionContent: string;
    agentProposedSectionContent: string;
    liveDocumentContent: string;
  }): Promise<SectionMergeOutcome> {
    if (!params.fileId || typeof params.fileId !== "string" || params.fileId.trim().length === 0) {
      throw new WorkspaceFileAccessDeniedError("File ID must be a non-empty string");
    }

    // Validates file ownership and vault permissions (without requiring stored content)
    await this.loadAndValidateFiles([params.fileId], false);

    const baseContentResolved = resolveVaultRefJustInTime(params.baseSectionContent ?? "");
    const proposedContentResolved = resolveVaultRefJustInTime(params.agentProposedSectionContent ?? "");
    const liveDocResolved = resolveVaultRefJustInTime(params.liveDocumentContent ?? "");

    return diff3MergeSection(
      liveDocResolved,
      baseContentResolved,
      proposedContentResolved,
      params.headingSlug
    );
  }
}
