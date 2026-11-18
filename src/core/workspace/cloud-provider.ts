/**
 * Cloud PostgreSQL Workspace Provider Implementation
 *
 * Implements `IWorkspaceProvider` backed by server-side PostgreSQL storage,
 * enforcing strict file ownership isolation, zero-knowledge vault boundaries,
 * client-side ephemeral plaintext reconciliation, and Diff3 section merges.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, schema } from "@/server/db";
import { deriveDefaultWorkspaceId } from "@/server/db/schema/files";
import { generateETagSync } from "@/lib/sync/etag-generator.server";
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
  type WorkspaceTreeEntry,
  type DecisionLedgerDocument,
  VaultAIAccessDeniedError,
  WorkspaceFileAccessDeniedError,
  WorkspaceSectionNotFoundError,
  EncryptedPayloadMissingError,
  CrossWorkspaceAccessForbiddenError,
  DecisionLedgerConflictError,
} from "./provider";

/**
 * Configuration options for CloudPostgresWorkspaceProvider.
 */
export interface CloudPostgresWorkspaceProviderOptions {
  userId: string;
  workspaceId?: string;
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
  etag: string;
  version: number;
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
  public readonly workspaceId: string;
  public readonly userId: string;
  private readonly ephemeralVaultPayloads: Record<string, string>;
  private readonly liveDocumentSnapshots: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;

  constructor(options: CloudPostgresWorkspaceProviderOptions) {
    if (!options || typeof options.userId !== "string" || options.userId.trim().length === 0) {
      throw new TypeError("CloudPostgresWorkspaceProvider: userId must be a non-empty string");
    }
    this.userId = options.userId;
    this.workspaceId =
      options.workspaceId && options.workspaceId.trim().length > 0
        ? options.workspaceId.trim()
        : deriveDefaultWorkspaceId(options.userId);
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

    for (const r of records as Array<{ id: string; workspaceId?: string | null }>) {
      if (r.workspaceId && r.workspaceId !== this.workspaceId) {
        throw new CrossWorkspaceAccessForbiddenError(
          `Cross-workspace file access is forbidden for file ${r.id}`
        );
      }
    }

    const accessibleRecords = records.filter(
      (r: { isAiExcluded?: boolean }) => r.isAiExcluded !== true
    );
    const foundIds = new Set(accessibleRecords.map((r: { id: string }) => r.id));
    const missing = uniqueFileIds.filter((id) => !foundIds.has(id));

    if (missing.length > 0) {
      throw new WorkspaceFileAccessDeniedError(
        `Workspace file access denied or not found: ${missing.join(", ")}`
      );
    }

    const hasEncrypted = accessibleRecords.some((r: { isEncrypted: boolean }) =>
      Boolean(r.isEncrypted)
    );
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

    return accessibleRecords.map(
      (r: {
        id: string;
        title: string;
        isEncrypted: boolean;
        content: string | null;
        etag?: string | null;
        version?: number | null;
      }) => {
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
          etag: r.etag ?? "",
          version: r.version ?? 1,
        };
      }
    );
  }

  private async isWorkspaceEncrypted(): Promise<boolean> {
    const query = this.db
      .select()
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, this.workspaceId),
          eq(schema.workspaces.userId, this.userId)
        )
      );
    const queryRes = typeof query?.limit === "function" ? await query.limit(1) : await query;
    const rows = Array.isArray(queryRes) ? queryRes : [];
    return Boolean(rows[0]?.isEncrypted);
  }

  private async resolveTargetFileIds(fileIds?: string[]): Promise<string[]> {
    if (fileIds !== undefined) {
      return fileIds;
    }
    const rows = await this.db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.workspaceId, this.workspaceId),
          eq(schema.files.userId, this.userId),
          isNull(schema.files.deletedAt),
          eq(schema.files.isAiExcluded, false),
          eq(schema.files.isFolder, false),
          eq(schema.files.artifactRole, "document")
        )
      );
    return Array.isArray(rows) ? rows.map((r: { id: string }) => r.id) : [];
  }

  /**
   * Lists all non-deleted, non-AI-excluded files and folders in the active workspace.
   */
  public async listWorkspaceTree(): Promise<WorkspaceTreeEntry[]> {
    const rows = await this.db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.workspaceId, this.workspaceId),
          eq(schema.files.userId, this.userId),
          isNull(schema.files.deletedAt),
          eq(schema.files.isAiExcluded, false)
        )
      );

    const records = Array.isArray(rows) ? rows : [];
    const byId = new Map<string, { id: string; title: string; parentFolderId: string | null }>();
    for (const r of records) {
      byId.set(r.id, {
        id: r.id,
        title: r.title,
        parentFolderId: r.parentFolderId ?? null,
      });
    }

    const buildRelativePath = (id: string): string => {
      const segments: string[] = [];
      const visited = new Set<string>();
      let currentId: string | null = id;
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const node = byId.get(currentId);
        if (!node) break;
        segments.unshift(node.title);
        currentId = node.parentFolderId;
      }
      return segments.join("/");
    };

    return records.map(
      (r: {
        id: string;
        parentFolderId?: string | null;
        title: string;
        isFolder?: boolean;
        isEncrypted?: boolean;
        isAiExcluded?: boolean;
        artifactRole?: string;
        etag?: string | null;
        version?: number | null;
        updatedAt?: Date | string;
      }) => ({
        fileId: r.id,
        parentFolderId: r.parentFolderId ?? null,
        title: r.title,
        relativePath: buildRelativePath(r.id),
        isFolder: Boolean(r.isFolder),
        isEncrypted: Boolean(r.isEncrypted),
        isAiExcluded: Boolean(r.isAiExcluded),
        artifactRole: r.artifactRole === "decision_ledger" ? "decision_ledger" : "document",
        etag: r.etag ?? "",
        version: r.version ?? 1,
        updatedAt:
          r.updatedAt instanceof Date
            ? r.updatedAt.toISOString()
            : String(r.updatedAt ?? new Date().toISOString()),
      })
    );
  }

  /**
   * Retrieves the AST heading hierarchy for the specified file identifiers.
   */
  public async listHeadingsTree(
    fileIds?: string[]
  ): Promise<Record<string, HeadingNode[]>> {
    const targetIds = await this.resolveTargetFileIds(fileIds);
    if (targetIds.length === 0) {
      return {};
    }

    const resolvedFiles = await this.loadAndValidateFiles(targetIds, true);
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

    const resolvedHeadingSlug = section.heading.headingSlug || headingSlug;
    const sectionHash = createHash("sha256")
      .update(section.sectionContent)
      .digest("hex");

    if (file.isEncrypted) {
      const vaultRef = storeEphemeralVaultSection(
        fileId,
        headingSlug,
        section.sectionContent
      );
      return {
        fileId: file.id,
        headingSlug: resolvedHeadingSlug,
        breadcrumb: section.heading.breadcrumb,
        contentOrVaultRef: vaultRef,
        isVaultRef: true,
        sectionHash,
        fileEtag: file.etag,
        fileVersion: file.version,
      };
    }

    return {
      fileId: file.id,
      headingSlug: resolvedHeadingSlug,
      breadcrumb: section.heading.breadcrumb,
      contentOrVaultRef: section.sectionContent,
      isVaultRef: false,
      sectionHash,
      fileEtag: file.etag,
      fileVersion: file.version,
    };
  }

  /**
   * Executes path-coupled BM25 lexical search across the specified workspace files.
   */
  public async searchLexicalWithASTBreadcrumb(params: {
    fileIds?: string[];
    query: string;
    maxResults?: number;
  }): Promise<LexicalMatchResult[]> {
    if (!params.query || params.query.trim().length === 0) {
      return [];
    }

    const targetIds = await this.resolveTargetFileIds(params.fileIds);
    if (targetIds.length === 0) {
      return [];
    }

    const resolvedFiles = await this.loadAndValidateFiles(targetIds, true);
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
    const [file] = await this.loadAndValidateFiles([params.fileId], false);

    const baseContentResolved = resolveVaultRefJustInTime(params.baseSectionContent ?? "");
    const proposedContentResolved = resolveVaultRefJustInTime(params.agentProposedSectionContent ?? "");
    const liveDocResolved = resolveVaultRefJustInTime(params.liveDocumentContent ?? "");

    const outcome = diff3MergeSection(
      liveDocResolved,
      baseContentResolved,
      proposedContentResolved,
      params.headingSlug
    );

    if (
      outcome.status === "clean" &&
      this.liveDocumentSnapshots[params.fileId] === undefined &&
      file &&
      !file.isEncrypted &&
      typeof this.db?.update === "function"
    ) {
      const now = new Date();
      const nextVersion = (file.version ?? 1) + 1;
      const nextEtag = generateETagSync({
        id: file.id,
        content: outcome.mergedDocumentContent,
        updatedAt: now,
        isEncrypted: false,
      });

      const updateQuery = this.db
        .update(schema.files)
        .set({
          content: outcome.mergedDocumentContent,
          version: nextVersion,
          etag: nextEtag,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.files.id, file.id),
            eq(schema.files.workspaceId, this.workspaceId),
            eq(schema.files.userId, this.userId),
            eq(schema.files.version, file.version),
            isNull(schema.files.deletedAt)
          )
        );

      if (typeof updateQuery?.returning === "function") {
        const updatedRows = await updateQuery.returning({ id: schema.files.id });
        if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
          throw Object.assign(
            new Error(`Optimistic concurrency conflict while persisting merged file ${file.id}`),
            { status: 409, code: "FILE_VERSION_CONFLICT" }
          );
        }
      } else {
        await updateQuery;
      }
    }

    return outcome;
  }

  /**
   * Creates a new Markdown file (and any missing parent folders) inside the active workspaceId.
   */
  public async createWorkspaceFile(params: {
    relativePath: string;
    initialContent: string;
  }): Promise<WorkspaceTreeEntry> {
    const segments = params.relativePath
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (segments.length === 0) {
      throw new WorkspaceFileAccessDeniedError("Relative path must not be empty");
    }

    const fileName = segments[segments.length - 1];
    const folderSegments = segments.slice(0, -1);
    const workspaceEncrypted = await this.isWorkspaceEncrypted();

    let parentFolderId: string | null = null;
    for (const folderName of folderSegments) {
      const currentParentId: string | null = parentFolderId;
      const parentCondition =
        currentParentId === null
          ? isNull(schema.files.parentFolderId)
          : eq(schema.files.parentFolderId, currentParentId);

      const existingRows: Array<{ id: string }> = await this.db
        .select()
        .from(schema.files)
        .where(
          and(
            eq(schema.files.workspaceId, this.workspaceId),
            eq(schema.files.userId, this.userId),
            isNull(schema.files.deletedAt),
            eq(schema.files.isFolder, true),
            eq(schema.files.title, folderName),
            parentCondition
          )
        );

      const existing = Array.isArray(existingRows) ? existingRows[0] : undefined;
      if (existing) {
        parentFolderId = existing.id;
      } else {
        const now = new Date();
        const folderId = randomUUID();
        const insertedRows: Array<{ id: string }> = await this.db
          .insert(schema.files)
          .values({
            id: folderId,
            userId: this.userId,
            workspaceId: this.workspaceId,
            parentFolderId: currentParentId,
            title: folderName,
            content: null,
            isFolder: true,
            isEncrypted: workspaceEncrypted,
            isAiExcluded: false,
            artifactRole: "document",
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const createdFolder = Array.isArray(insertedRows) ? insertedRows[0] : undefined;
        parentFolderId = createdFolder?.id ?? folderId;
      }
    }

    const now = new Date();
    const fileId = randomUUID();
    const etag = generateETagSync({
      id: fileId,
      content: params.initialContent,
      updatedAt: now,
      isEncrypted: workspaceEncrypted,
    });

    const insertedFileRows = await this.db
      .insert(schema.files)
      .values({
        id: fileId,
        userId: this.userId,
        workspaceId: this.workspaceId,
        parentFolderId,
        title: fileName,
        content: params.initialContent,
        isFolder: false,
        isEncrypted: workspaceEncrypted,
        isAiExcluded: false,
        artifactRole: "document",
        etag,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const created = Array.isArray(insertedFileRows) ? insertedFileRows[0] : undefined;
    const resolvedId = created?.id ?? fileId;
    const resolvedUpdatedAt =
      created?.updatedAt instanceof Date
        ? created.updatedAt.toISOString()
        : now.toISOString();

    return {
      fileId: resolvedId,
      parentFolderId,
      title: fileName,
      relativePath: segments.join("/"),
      isFolder: false,
      isEncrypted: workspaceEncrypted,
      isAiExcluded: false,
      artifactRole: "document",
      etag: created?.etag ?? etag,
      version: created?.version ?? 1,
      updatedAt: resolvedUpdatedAt,
    };
  }

  /**
   * Soft-deletes a document file inside workspaceId; blocks deleting decisions.ledger.json.
   */
  public async deleteWorkspaceFile(params: {
    fileId: string;
  }): Promise<{ fileId: string; deletedAt: string }> {
    if (!params.fileId || typeof params.fileId !== "string" || params.fileId.trim().length === 0) {
      throw new WorkspaceFileAccessDeniedError("File ID must be a non-empty string");
    }

    const rows = await this.db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.id, params.fileId),
          eq(schema.files.userId, this.userId),
          isNull(schema.files.deletedAt)
        )
      );

    const record = Array.isArray(rows) ? rows[0] : undefined;
    if (!record) {
      throw new WorkspaceFileAccessDeniedError(`File not found: ${params.fileId}`);
    }

    if (record.workspaceId && record.workspaceId !== this.workspaceId) {
      throw new CrossWorkspaceAccessForbiddenError(
        `Cross-workspace file access is forbidden for file ${params.fileId}`
      );
    }

    if (record.artifactRole === "decision_ledger") {
      throw Object.assign(new Error("Deleting canonical decisions.ledger.json is forbidden"), {
        status: 403,
        code: "DECISION_LEDGER_DELETE_FORBIDDEN",
      });
    }

    const deletedAt = new Date();
    await this.db
      .update(schema.files)
      .set({
        deletedAt,
        updatedAt: deletedAt,
      })
      .where(
        and(
          eq(schema.files.id, params.fileId),
          eq(schema.files.workspaceId, this.workspaceId),
          eq(schema.files.userId, this.userId),
          isNull(schema.files.deletedAt)
        )
      );

    return {
      fileId: params.fileId,
      deletedAt: deletedAt.toISOString(),
    };
  }

  /**
   * Reads the workspace's canonical decisions.ledger.json document (initializing v2.0 if absent).
   */
  public async readDecisionLedger(): Promise<DecisionLedgerDocument> {
    const rows = await this.db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.workspaceId, this.workspaceId),
          eq(schema.files.userId, this.userId),
          isNull(schema.files.deletedAt),
          eq(schema.files.artifactRole, "decision_ledger")
        )
      );

    const record = Array.isArray(rows) ? rows[0] : undefined;
    if (!record) {
      return {
        schemaVersion: "2.0",
        workspaceId: this.workspaceId,
        updatedAt: new Date().toISOString(),
        decisions: {},
      };
    }

    let rawContent: string;
    if (record.isEncrypted) {
      const candidate =
        this.liveDocumentSnapshots[record.id] ??
        this.ephemeralVaultPayloads[record.id];
      if (typeof candidate !== "string") {
        throw new EncryptedPayloadMissingError(
          `Decrypted plaintext payload missing for encrypted decision ledger ${record.id}`
        );
      }
      rawContent = candidate;
    } else {
      rawContent =
        this.liveDocumentSnapshots[record.id] ??
        record.content ??
        "";
    }

    try {
      const parsed = JSON.parse(rawContent) as Partial<DecisionLedgerDocument>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          ...parsed,
          schemaVersion: typeof parsed.schemaVersion === "string" ? parsed.schemaVersion : "2.0",
          workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : this.workspaceId,
          updatedAt:
            typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
          decisions:
            parsed.decisions && typeof parsed.decisions === "object" && !Array.isArray(parsed.decisions)
              ? parsed.decisions
              : {},
        };
      }
    } catch {
      // Fall through to empty v2.0 ledger
    }

    return {
      schemaVersion: "2.0",
      workspaceId: this.workspaceId,
      updatedAt: new Date().toISOString(),
      decisions: {},
    };
  }

  /**
   * Atomically writes the updated decisions.ledger.json document with optional OCC checks.
   */
  public async writeDecisionLedger(
    document: DecisionLedgerDocument,
    options?: { expectedVersion?: number; expectedEtag?: string }
  ): Promise<{ etag: string; version: number }> {
    const rows = await this.db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.workspaceId, this.workspaceId),
          eq(schema.files.userId, this.userId),
          isNull(schema.files.deletedAt),
          eq(schema.files.artifactRole, "decision_ledger")
        )
      );

    const existing = Array.isArray(rows) ? rows[0] : undefined;
    const now = new Date();
    const normalizedDoc: DecisionLedgerDocument = {
      ...document,
      schemaVersion: document.schemaVersion || "2.0",
      workspaceId: this.workspaceId,
      updatedAt: now.toISOString(),
      decisions: document.decisions ?? {},
    };
    const serialized = JSON.stringify(normalizedDoc, null, 2);

    if (existing) {
      const currentVersion = existing.version ?? 1;
      const currentEtag = existing.etag ?? "";

      if (
        options?.expectedVersion !== undefined &&
        currentVersion !== options.expectedVersion
      ) {
        throw new DecisionLedgerConflictError(
          `Decision ledger version conflict: expected ${options.expectedVersion}, actual ${currentVersion}`
        );
      }

      if (
        options?.expectedEtag !== undefined &&
        currentEtag !== options.expectedEtag
      ) {
        throw new DecisionLedgerConflictError(
          `Decision ledger etag conflict: expected ${options.expectedEtag}, actual ${currentEtag}`
        );
      }

      const nextVersion = currentVersion + 1;
      const nextEtag = generateETagSync({
        id: existing.id,
        content: serialized,
        updatedAt: now,
        isEncrypted: Boolean(existing.isEncrypted),
      });

      await this.db
        .update(schema.files)
        .set({
          content: serialized,
          version: nextVersion,
          etag: nextEtag,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.files.id, existing.id),
            eq(schema.files.workspaceId, this.workspaceId),
            eq(schema.files.userId, this.userId),
            isNull(schema.files.deletedAt)
          )
        );

      return { etag: nextEtag, version: nextVersion };
    }

    if (options?.expectedVersion !== undefined && options.expectedVersion !== 0) {
      throw new DecisionLedgerConflictError(
        `Decision ledger version conflict: expected ${options.expectedVersion}, ledger does not exist`
      );
    }

    const workspaceEncrypted = await this.isWorkspaceEncrypted();
    const id = randomUUID();
    const version = 1;
    const etag = generateETagSync({
      id,
      content: serialized,
      updatedAt: now,
      isEncrypted: workspaceEncrypted,
    });

    await this.db.insert(schema.files).values({
      id,
      userId: this.userId,
      workspaceId: this.workspaceId,
      parentFolderId: null,
      title: "decisions.ledger.json",
      content: serialized,
      isFolder: false,
      isEncrypted: workspaceEncrypted,
      isAiExcluded: false,
      artifactRole: "decision_ledger",
      etag,
      version,
      createdAt: now,
      updatedAt: now,
    });

    return { etag, version };
  }
}
