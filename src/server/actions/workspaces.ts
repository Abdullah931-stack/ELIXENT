import * as dbModule from "@/server/db";
const { db, schema } = dbModule;
import { deriveDefaultWorkspaceId } from "@/server/db/schema/files";
import { requireAuthenticatedUser } from "@/server/auth/session";
import { eq, and, isNull, or } from "drizzle-orm";
import { generateETagSync, normalizeMarkdownSource } from "@/lib/sync/etag-generator.server";

export type WorkspacePermissionMode = "safe" | "semi_auto" | "full_auto";

export interface WorkspaceOpResult<T = typeof schema.workspaces.$inferSelect> {
  success: boolean;
  data?: T;
  error?: string;
  status?: "unauthorized" | "not_found" | "forbidden" | "conflict" | "error";
  statusCode?: number;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string | null;
  isEncrypted?: boolean;
  defaultPermissionMode?: WorkspacePermissionMode;
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string | null;
  isEncrypted?: boolean;
  defaultPermissionMode?: WorkspacePermissionMode;
}

export interface DecryptedWorkspaceFilePayload {
  fileId: string;
  content: string;
  expectedVersion?: number;
  expectedETag?: string;
}

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "WORKSPACE_NOT_FOUND";

  constructor(message = "Workspace not found or access denied") {
    super(message);
    this.name = "WorkspaceNotFoundError";
    Object.setPrototypeOf(this, WorkspaceNotFoundError.prototype);
  }
}

/**
 * Resolves a valid, user-owned workspaceId:
 * 1. If `workspaceId` is explicitly provided, verifies ownership and returns it.
 * 2. Else if `parentFolderId` is provided, inherits `workspaceId` from that parent folder.
 * 3. Else finds or creates the user's deterministic Default Workspace.
 */
export async function resolveOrEnsureWorkspaceId(
  userId: string,
  workspaceId?: string | null,
  parentFolderId?: string | null
): Promise<string> {
  if (workspaceId) {
    const existing = await db.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.userId, userId)
      ),
      columns: { id: true },
    });

    if (!existing) {
      throw new WorkspaceNotFoundError();
    }

    return existing.id;
  }

  if (parentFolderId) {
    const parent = await db.query.files.findFirst({
      where: and(
        eq(schema.files.id, parentFolderId),
        eq(schema.files.userId, userId),
        isNull(schema.files.deletedAt)
      ),
      columns: { workspaceId: true },
    });

    if (parent?.workspaceId) {
      return parent.workspaceId;
    }
  }

  const defaultId = deriveDefaultWorkspaceId(userId);
  const existingDefault = await db.query.workspaces.findFirst({
    where: and(
      eq(schema.workspaces.userId, userId),
      or(
        eq(schema.workspaces.id, defaultId),
        eq(schema.workspaces.name, "Default Workspace")
      )
    ),
    columns: { id: true },
  });

  if (existingDefault) {
    return existingDefault.id;
  }

  await db
    .insert(schema.workspaces)
    .values({
      id: defaultId,
      userId,
      name: "Default Workspace",
      description: "Default personal workspace",
      isEncrypted: false,
      defaultPermissionMode: "safe",
    })
    .onConflictDoNothing();

  const ensured = await db.query.workspaces.findFirst({
    where: and(
      eq(schema.workspaces.userId, userId),
      or(
        eq(schema.workspaces.id, defaultId),
        eq(schema.workspaces.name, "Default Workspace")
      )
    ),
    columns: { id: true },
  });

  return ensured?.id ?? defaultId;
}

/**
 * Returns whether the given user-owned workspace enforces Zero-Knowledge encryption.
 */
export async function isWorkspaceEncrypted(
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const ws = await db.query.workspaces.findFirst({
    where: and(
      eq(schema.workspaces.id, workspaceId),
      eq(schema.workspaces.userId, userId)
    ),
    columns: { isEncrypted: true },
  });

  return Boolean(ws?.isEncrypted);
}

/**
 * Lists all workspaces owned by the authenticated user.
 */
export async function listUserWorkspaces(): Promise<
  WorkspaceOpResult<(typeof schema.workspaces.$inferSelect)[]>
> {
  try {
    let user;
    try {
      user = await requireAuthenticatedUser();
    } catch {
      return { success: false, status: "unauthorized", statusCode: 401, error: "Authentication required" };
    }

    const rows = await db.query.workspaces.findMany({
      where: eq(schema.workspaces.userId, user.id),
      orderBy: (workspaces, { asc }) => [asc(workspaces.createdAt)],
    });

    return { success: true, data: rows };
  } catch (error) {
    console.error("List user workspaces error:", error);
    return { success: false, status: "error", statusCode: 500, error: "Failed to list workspaces" };
  }
}

/**
 * Creates a new workspace for the authenticated user.
 */
export async function createWorkspace(
  input: CreateWorkspaceInput
): Promise<WorkspaceOpResult> {
  try {
    let user;
    try {
      user = await requireAuthenticatedUser();
    } catch {
      return { success: false, status: "unauthorized", statusCode: 401, error: "Authentication required" };
    }

    const name = (input.name || "").trim().slice(0, 255);
    if (!name) {
      return { success: false, status: "error", statusCode: 400, error: "Workspace name cannot be empty" };
    }

    const duplicate = await db.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.userId, user.id),
        eq(schema.workspaces.name, name)
      ),
      columns: { id: true },
    });

    if (duplicate) {
      return {
        success: false,
        status: "conflict",
        statusCode: 409,
        error: "A workspace with this name already exists",
      };
    }

    const now = new Date();
    const [created] = await db
      .insert(schema.workspaces)
      .values({
        userId: user.id,
        name,
        description: input.description ?? null,
        isEncrypted: Boolean(input.isEncrypted),
        defaultPermissionMode: input.defaultPermissionMode ?? "safe",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return { success: true, data: created };
  } catch (error) {
    console.error("Create workspace error:", error);
    return { success: false, status: "error", statusCode: 500, error: "Failed to create workspace" };
  }
}

/**
 * Updates metadata or settings for a user-owned workspace.
 */
export async function updateWorkspace(
  workspaceId: string,
  input: UpdateWorkspaceInput
): Promise<WorkspaceOpResult> {
  try {
    let user;
    try {
      user = await requireAuthenticatedUser();
    } catch {
      return { success: false, status: "unauthorized", statusCode: 401, error: "Authentication required" };
    }

    const existing = await db.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.userId, user.id)
      ),
    });

    if (!existing) {
      return { success: false, status: "not_found", statusCode: 404, error: "Workspace not found" };
    }

    const updates: Partial<typeof schema.workspaces.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) {
      const trimmed = input.name.trim().slice(0, 255);
      if (!trimmed) {
        return { success: false, status: "error", statusCode: 400, error: "Workspace name cannot be empty" };
      }
      if (trimmed !== existing.name) {
        const duplicate = await db.query.workspaces.findFirst({
          where: and(
            eq(schema.workspaces.userId, user.id),
            eq(schema.workspaces.name, trimmed)
          ),
          columns: { id: true },
        });
        if (duplicate) {
          return {
            success: false,
            status: "conflict",
            statusCode: 409,
            error: "A workspace with this name already exists",
          };
        }
      }
      updates.name = trimmed;
    }

    if (input.description !== undefined) {
      updates.description = input.description;
    }
    if (input.isEncrypted !== undefined) {
      updates.isEncrypted = input.isEncrypted;
    }
    if (input.defaultPermissionMode !== undefined) {
      updates.defaultPermissionMode = input.defaultPermissionMode;
    }

    const [updated] = await db
      .update(schema.workspaces)
      .set(updates)
      .where(
        and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.userId, user.id)
        )
      )
      .returning();

    return { success: true, data: updated };
  } catch (error) {
    console.error("Update workspace error:", error);
    return { success: false, status: "error", statusCode: 500, error: "Failed to update workspace" };
  }
}

/**
 * Deletes a non-default workspace and cascades deletion to its files.
 */
export async function deleteWorkspace(
  workspaceId: string
): Promise<WorkspaceOpResult<null>> {
  try {
    let user;
    try {
      user = await requireAuthenticatedUser();
    } catch {
      return { success: false, status: "unauthorized", statusCode: 401, error: "Authentication required" };
    }

    const existing = await db.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.userId, user.id)
      ),
      columns: { id: true, name: true },
    });

    if (!existing) {
      return { success: false, status: "not_found", statusCode: 404, error: "Workspace not found" };
    }

    if (
      workspaceId === deriveDefaultWorkspaceId(user.id) ||
      existing.name === "Default Workspace"
    ) {
      return {
        success: false,
        status: "forbidden",
        statusCode: 403,
        error: "Cannot delete the default workspace",
      };
    }

    const deleted = await db
      .delete(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.userId, user.id)
        )
      )
      .returning({ id: schema.workspaces.id });

    if (deleted.length === 0) {
      return { success: false, status: "not_found", statusCode: 404, error: "Workspace not found" };
    }

    return { success: true, data: null };
  } catch (error) {
    console.error("Delete workspace error:", error);
    return { success: false, status: "error", statusCode: 500, error: "Failed to delete workspace" };
  }
}

/**
 * All-or-nothing workspace decryption (SRS-02 §4.1):
 * Atomically updates every encrypted live file in `workspaceId` with client-decrypted
 * plaintext envelopes and sets `workspace.isEncrypted = false`.
 */
export async function decryptEntireWorkspace(
  workspaceId: string,
  decryptedFilesPayload: DecryptedWorkspaceFilePayload[]
): Promise<WorkspaceOpResult> {
  try {
    let user;
    try {
      user = await requireAuthenticatedUser();
    } catch {
      return { success: false, status: "unauthorized", statusCode: 401, error: "Authentication required" };
    }

    const workspace = await db.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.userId, user.id)
      ),
    });

    if (!workspace) {
      return { success: false, status: "not_found", statusCode: 404, error: "Workspace not found" };
    }

    const encryptedFiles = await db.query.files.findMany({
      where: and(
        eq(schema.files.workspaceId, workspaceId),
        eq(schema.files.userId, user.id),
        eq(schema.files.isEncrypted, true),
        isNull(schema.files.deletedAt)
      ),
    });

    const payloadByFileId = new Map<string, DecryptedWorkspaceFilePayload>();
    for (const item of decryptedFilesPayload) {
      payloadByFileId.set(item.fileId, item);
    }

    for (const file of encryptedFiles) {
      if (!payloadByFileId.has(file.id)) {
        return {
          success: false,
          status: "error",
          statusCode: 400,
          error: "All encrypted files in the workspace must be decrypted together",
        };
      }
    }

    const now = new Date();
    let targetDb: typeof db = db;
    try {
      const candidateTxDb = (dbModule as unknown as { txDb?: typeof db }).txDb;
      if (candidateTxDb && typeof candidateTxDb.transaction === "function") {
        targetDb = candidateTxDb;
      }
    } catch {
      // Fallback to db when a test mock of "@/server/db" omits txDb
    }
    const updatedWorkspace = await targetDb.transaction(async (tx) => {
      for (const file of encryptedFiles) {
        const payload = payloadByFileId.get(file.id)!;
        const currentVersion = file.version ?? 0;

        if (
          payload.expectedVersion !== undefined &&
          payload.expectedVersion !== currentVersion
        ) {
          throw new Error(`CONFLICT:${file.id}`);
        }
        if (
          payload.expectedETag !== undefined &&
          file.etag &&
          payload.expectedETag !== file.etag
        ) {
          throw new Error(`CONFLICT:${file.id}`);
        }

        const normalizedContent = normalizeMarkdownSource(payload.content);
        const newEtag = generateETagSync({
          id: file.id,
          content: normalizedContent,
          updatedAt: now,
          isEncrypted: false,
        });

        await tx
          .update(schema.files)
          .set({
            content: normalizedContent,
            isEncrypted: false,
            encryptionMetadata: null,
            etag: newEtag,
            version: currentVersion + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.files.id, file.id),
              eq(schema.files.userId, user.id),
              eq(schema.files.workspaceId, workspaceId),
              isNull(schema.files.deletedAt)
            )
          );
      }

      const [ws] = await tx
        .update(schema.workspaces)
        .set({
          isEncrypted: false,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.workspaces.id, workspaceId),
            eq(schema.workspaces.userId, user.id)
          )
        )
        .returning();

      return ws;
    });

    return { success: true, data: updatedWorkspace };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CONFLICT:")) {
      return {
        success: false,
        status: "conflict",
        statusCode: 409,
        error: "Conflict: one or more files were modified concurrently during workspace decryption",
      };
    }
    console.error("Decrypt entire workspace error:", error);
    return {
      success: false,
      status: "error",
      statusCode: 500,
      error: "Failed to decrypt entire workspace",
    };
  }
}
