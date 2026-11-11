/**
 * Files & Sync API Route Handlers
 *
 * Implements:
 * - GET /api/files/sync - Fetch files updated after a timestamp with pagination and rate limiting
 * - GET /api/files/:id - Fetch a single file with ETag conditional request support (304 Not Modified)
 * - PUT /api/files/:id - Update a single file with ETag / expectedVersion optimistic concurrency control
 * - DELETE /api/files/:id - Soft-delete a file or folder tree with optimistic concurrency control
 */

import { Hono } from "hono";
import { db, schema, type FileEncryptionMetadata } from "@/server/db";
import { getUser } from "@/lib/supabase/server";
import { eq, and, gt, isNull, or, inArray } from "drizzle-orm";
import {
  generateETagSync,
  parseETagHeader,
  formatETagHeader,
  normalizeMarkdownSource,
} from "@/lib/sync/etag-generator.server";
import {
  syncApiRateLimiter,
  fileApiRateLimiter,
  addRateLimitHeaders,
  rateLimitExceededResponse,
} from "@/lib/rate-limit";
import {
  getOrGenerateCorrelationId,
  addCorrelationHeader,
} from "@/lib/utils/correlation";
import { getDescendantIds } from "@/server/actions/folders";
import { syncPullRequestSchema } from "@/types/sync-contracts";
import { documentStoragePayloadSchema } from "@/types/storage-payload";
import { createProblemDetails } from "@/types/problem-details";

/**
 * Default and maximum page sizes
 */
const DEFAULT_LIMIT = 50;

export interface RouteParams {
  id?: string;
  params?: { id: string };
}

export type RouteContext = RouteParams;

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeFileId(rawId: string | undefined): string | null {
  if (!rawId || typeof rawId !== "string") {
    return null;
  }
  // Reject double-percent-encoding (%25)
  if (rawId.toLowerCase().includes("%25")) {
    return null;
  }
  let decoded = rawId;
  try {
    decoded = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (decoded.toLowerCase().includes("%25")) {
    return null;
  }
  const trimmed = decoded.trim();
  if (!UUID_V4_REGEX.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function createInvalidFileIdResponse(correlationId: string): Response {
  const res = Response.json(
    { error: "Invalid or missing file ID", correlationId },
    { status: 400 }
  );
  addCorrelationHeader(res.headers, correlationId);
  return res;
}

/**
 * Resolves the target file ID from route context or the request URL path.
 * Rejects double-percent-encoding, malformed URL path structures, and non-UUID formats.
 * Returns null if the candidate ID is missing, malformed, or not a valid UUID v4.
 */
export function resolveFileId(
  request: Request,
  context?: RouteContext | string
): string | null {
  if (typeof context === "string") {
    return normalizeFileId(context);
  }
  if (typeof context?.id === "string") {
    return normalizeFileId(context.id);
  }
  if (typeof context?.params?.id === "string") {
    return normalizeFileId(context.params.id);
  }

  try {
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
      return null;
    }

    let candidateSegment = "";
    if (segments[0] === "api") {
      if (segments[1] !== "files" || segments.length !== 3) {
        return null;
      }
      candidateSegment = segments[2];
    } else {
      candidateSegment = segments[segments.length - 1];
    }

    return normalizeFileId(candidateSegment);
  } catch {
    return null;
  }
}

/**
 * GET /api/files/sync
 *
 * Query Parameters:
 * - updated_after: ISO timestamp to fetch updates after
 * - limit: Number of files to return (max 100)
 * - cursor: Pagination cursor for next page
 *
 * Response:
 * - files: Array of file objects with sync metadata
 * - has_more: Whether more files are available
 * - next_cursor: Cursor for next page (if has_more is true)
 */
export async function handleFilesSyncGet(request: Request): Promise<Response> {
  const correlationId = getOrGenerateCorrelationId(request);
  try {
    // Authenticate user
    const user = await getUser();
    if (!user) {
      const res = Response.json(
        { error: "Authentication required", correlationId },
        { status: 401 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    // Apply rate limiting
    const rateLimitResult = await syncApiRateLimiter.limit(user.id);
    if (!rateLimitResult.success) {
      const res = rateLimitExceededResponse(rateLimitResult);
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const updatedAfterRaw =
      searchParams.get("updatedAfter") || searchParams.get("updated_after");
    const limitRaw = searchParams.get("limit");
    const cursorRaw = searchParams.get("cursor");

    const pullParams: Record<string, unknown> = {};
    if (updatedAfterRaw) pullParams.updatedAfter = updatedAfterRaw;
    if (cursorRaw) pullParams.cursor = cursorRaw;
    if (limitRaw !== null) {
      const parsedNum = Number(limitRaw);
      pullParams.limit = isNaN(parsedNum) ? limitRaw : parsedNum;
    }

    const pullParsed = syncPullRequestSchema.safeParse(pullParams);
    if (!pullParsed.success) {
      const problem = createProblemDetails({
        type: "urn:problem-type:invalid-sync-pull-request",
        title: "Invalid Sync Pull Request",
        status: 400,
        detail: pullParsed.error.issues.map((i) => i.message).join(", "),
        instance: "/api/files/sync",
        correlationId,
      });
      const res = new Response(JSON.stringify(problem), {
        status: 400,
        headers: { "Content-Type": "application/problem+json" },
      });
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    // Parse updated_after timestamp
    const updatedAfter = pullParsed.data.updatedAfter
      ? new Date(pullParsed.data.updatedAfter)
      : null;

    // Parse limit with bounds
    const limit = pullParsed.data.limit ?? DEFAULT_LIMIT;
    const cursor = pullParsed.data.cursor;

    // Build query conditions
    const conditions = [
      eq(schema.files.userId, user.id),
      // Exclude soft-deleted files unless they were deleted after updatedAfter
      or(
        isNull(schema.files.deletedAt),
        updatedAfter ? gt(schema.files.deletedAt, updatedAfter) : undefined
      ),
    ].filter(Boolean);

    // Add updated_after condition
    if (updatedAfter) {
      conditions.push(gt(schema.files.updatedAt, updatedAfter));
    }

    // Add cursor condition for pagination
    if (cursor) {
      try {
        const cursorData = JSON.parse(
          Buffer.from(cursor, "base64").toString()
        );
        if (
          cursorData &&
          typeof cursorData.id === "string" &&
          cursorData.updatedAt
        ) {
          const cursorDate = new Date(cursorData.updatedAt);
          if (!isNaN(cursorDate.getTime())) {
            conditions.push(
              or(
                gt(schema.files.updatedAt, cursorDate),
                and(
                  eq(schema.files.updatedAt, cursorDate),
                  gt(schema.files.id, cursorData.id)
                )
              )!
            );
          }
        }
      } catch {
        // Invalid cursor, ignore
      }
    }

    // Fetch files with limit + 1 to check for more
    const files = await db.query.files.findMany({
      where: and(...conditions),
      orderBy: (files, { asc }) => [asc(files.updatedAt), asc(files.id)],
      limit: limit + 1,
    });

    // Check if there are more results
    const hasMore = files.length > limit;
    const resultFiles = hasMore ? files.slice(0, limit) : files;

    // Generate next cursor if there are more results
    let nextCursor: string | null = null;
    if (hasMore && resultFiles.length > 0) {
      const lastFile = resultFiles[resultFiles.length - 1];
      const cursorData = {
        updatedAt: lastFile.updatedAt.toISOString(),
        id: lastFile.id,
      };
      nextCursor = Buffer.from(JSON.stringify(cursorData)).toString("base64");
    }

    // Format response
    const responseFiles = resultFiles.map((file) => ({
      id: file.id,
      title: file.title,
      content: file.content,
      isEncrypted: file.isEncrypted,
      encryptionMetadata: file.encryptionMetadata,
      etag: file.etag,
      version: file.version,
      parentFolderId: file.parentFolderId,
      isFolder: file.isFolder,
      deletedAt: file.deletedAt?.toISOString() || null,
      updatedAt: file.updatedAt.toISOString(),
      createdAt: file.createdAt.toISOString(),
    }));

    // Build response with rate limit headers
    const responseHeaders = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    });
    addRateLimitHeaders(responseHeaders, rateLimitResult);
    addCorrelationHeader(responseHeaders, correlationId);

    return new Response(
      JSON.stringify({
        files: responseFiles,
        has_more: hasMore,
        next_cursor: nextCursor,
        sync_timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: responseHeaders,
      }
    );
  } catch (error) {
    console.error("[Sync API] Error:", error);
    const res = Response.json(
      { error: "Internal server error", correlationId },
      { status: 500 }
    );
    addCorrelationHeader(res.headers, correlationId);
    return res;
  }
}

export async function handleFileByIdGet(
  request: Request,
  context?: RouteContext
): Promise<Response> {
  const correlationId = getOrGenerateCorrelationId(request);
  try {
    const fileId = resolveFileId(request, context);
    if (!fileId) {
      return createInvalidFileIdResponse(correlationId);
    }

    const user = await getUser();
    if (!user) {
      const res = Response.json(
        { error: "Authentication required", correlationId },
        { status: 401 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const rateLimitResult = await fileApiRateLimiter.limit(user.id);
    if (!rateLimitResult.success) {
      const res = rateLimitExceededResponse(rateLimitResult);
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const file = await db.query.files.findFirst({
      where: and(
        eq(schema.files.id, fileId),
        eq(schema.files.userId, user.id),
        isNull(schema.files.deletedAt)
      ),
    });

    if (!file) {
      const res = Response.json(
        { error: "File not found", correlationId },
        { status: 404 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const ifNoneMatch = parseETagHeader(request.headers.get("If-None-Match"));
    if (ifNoneMatch && file.etag && ifNoneMatch === file.etag) {
      const headers = new Headers();
      headers.set("ETag", formatETagHeader(file.etag));
      addRateLimitHeaders(headers, rateLimitResult);
      addCorrelationHeader(headers, correlationId);
      return new Response(null, { status: 304, headers });
    }

    const responseData = {
      id: file.id,
      title: file.title,
      content: file.content,
      isEncrypted: file.isEncrypted,
      encryptionMetadata: file.encryptionMetadata,
      etag: file.etag,
      version: file.version,
      parentFolderId: file.parentFolderId,
      isFolder: file.isFolder,
      deletedAt: file.deletedAt?.toISOString() || null,
      updatedAt: file.updatedAt.toISOString(),
      createdAt: file.createdAt.toISOString(),
    };

    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "private, must-revalidate, max-age=0",
      "Vary": "If-None-Match",
      "Last-Modified": file.updatedAt.toUTCString(),
    });
    if (file.etag) headers.set("ETag", formatETagHeader(file.etag));
    addRateLimitHeaders(headers, rateLimitResult);
    addCorrelationHeader(headers, correlationId);

    return new Response(JSON.stringify(responseData), { status: 200, headers });
  } catch (error) {
    console.error("[File API GET] Error:", error);
    const res = Response.json(
      { error: "Internal server error", correlationId },
      { status: 500 }
    );
    addCorrelationHeader(res.headers, correlationId);
    return res;
  }
}

export async function handleFileByIdPut(
  request: Request,
  context?: RouteContext
): Promise<Response> {
  const correlationId = getOrGenerateCorrelationId(request);
  try {
    const fileId = resolveFileId(request, context);
    if (!fileId) {
      return createInvalidFileIdResponse(correlationId);
    }

    const user = await getUser();
    if (!user) {
      const res = Response.json(
        { error: "Authentication required", correlationId },
        { status: 401 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const rateLimitResult = await fileApiRateLimiter.limit(user.id);
    if (!rateLimitResult.success) {
      const res = rateLimitExceededResponse(rateLimitResult);
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      const res = Response.json(
        { error: "Invalid JSON request body", correlationId },
        { status: 400 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      const res = Response.json(
        { error: "Invalid request body: expected a JSON object", correlationId },
        { status: 400 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const body = rawBody as Record<string, unknown>;

    if ("title" in body && body.title !== null && typeof body.title !== "string") {
      const res = Response.json(
        { error: "Invalid title: must be a string", correlationId },
        { status: 400 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const {
      content,
      title,
      expectedVersion,
      baseVersion,
      isEncrypted,
      encryptionMetadata,
    } = body as {
      content?: string;
      title?: string;
      expectedVersion?: number;
      baseVersion?: number;
      isEncrypted?: boolean;
      encryptionMetadata?: FileEncryptionMetadata | null;
    };

    if (content !== undefined || isEncrypted !== undefined) {
      const validationPayload = isEncrypted
        ? {
            type: "encrypted" as const,
            ciphertextBase64: content ?? "",
            isEncrypted: true as const,
            encryptionMetadata: encryptionMetadata ?? null,
          }
        : {
            type: "plaintext" as const,
            content: content ?? "",
            isEncrypted: false as const,
            encryptionMetadata: encryptionMetadata ?? null,
          };
      const payloadParsed =
        documentStoragePayloadSchema.safeParse(validationPayload);
      if (!payloadParsed.success) {
        const problem = createProblemDetails({
          type: "urn:problem-type:invalid-storage-payload",
          title: "Invalid Storage Payload",
          status: 400,
          detail: payloadParsed.error.issues.map((i) => i.message).join(", "),
          instance: `/api/files/${fileId}`,
          correlationId,
        });
        const res = new Response(JSON.stringify(problem), {
          status: 400,
          headers: { "Content-Type": "application/problem+json" },
        });
        addCorrelationHeader(res.headers, correlationId);
        return res;
      }
    }

    const ifMatch = parseETagHeader(request.headers.get("If-Match"));
    const requestedVersion =
      expectedVersion !== undefined ? expectedVersion : baseVersion;

    // PHASE 3: Mandatory If-Match or expectedVersion on file updates
    if (!ifMatch && requestedVersion === undefined) {
      const headers = new Headers({ "Content-Type": "application/json" });
      addRateLimitHeaders(headers, rateLimitResult);
      addCorrelationHeader(headers, correlationId);
      return new Response(
        JSON.stringify({
          error:
            "Precondition Required: If-Match header or expectedVersion is required for file updates",
          correlationId,
        }),
        { status: 428, headers }
      );
    }

    const currentFile = await db.query.files.findFirst({
      where: and(
        eq(schema.files.id, fileId),
        eq(schema.files.userId, user.id),
        isNull(schema.files.deletedAt)
      ),
    });

    if (!currentFile) {
      const res = Response.json(
        { error: "File not found", correlationId },
        { status: 404 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    if (currentFile.isFolder) {
      const res = Response.json(
        { error: "Cannot update content of a folder", correlationId },
        { status: 400 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    // Security invariant: If the existing file is encrypted, reject attempts to set isEncrypted: false unless explicit replacement plaintext content is supplied
    if (currentFile.isEncrypted && isEncrypted === false && content === undefined) {
      const res = Response.json(
        {
          error:
            "Cannot remove encryption from a file without supplying replacement plaintext content",
          correlationId,
        },
        { status: 400 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    if (
      currentFile.isEncrypted &&
      isEncrypted !== false &&
      content !== undefined
    ) {
      const effectiveMetadata =
        encryptionMetadata || currentFile.encryptionMetadata;
      if (!effectiveMetadata?.iv) {
        const res = Response.json(
          {
            error:
              "Cannot update content of an encrypted file without valid encryption metadata",
            correlationId,
          },
          { status: 400 }
        );
        addCorrelationHeader(res.headers, correlationId);
        return res;
      }
    }

    // Check If-Match condition
    if (ifMatch && currentFile.etag && ifMatch !== currentFile.etag) {
      const headers = new Headers({
        "Content-Type": "application/json",
        "ETag": formatETagHeader(currentFile.etag),
      });
      addRateLimitHeaders(headers, rateLimitResult);
      addCorrelationHeader(headers, correlationId);
      return new Response(
        JSON.stringify({
          error: "Precondition Failed: ETag mismatch",
          correlationId,
          serverVersion: {
            etag: currentFile.etag,
            version: currentFile.version,
            content: currentFile.content,
            isEncrypted: currentFile.isEncrypted,
            encryptionMetadata: currentFile.encryptionMetadata,
            updatedAt: currentFile.updatedAt.toISOString(),
          },
        }),
        { status: 412, headers }
      );
    }

    // Check expectedVersion condition
    if (
      requestedVersion !== undefined &&
      currentFile.version !== requestedVersion
    ) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (currentFile.etag)
        headers.set("ETag", formatETagHeader(currentFile.etag));
      addRateLimitHeaders(headers, rateLimitResult);
      addCorrelationHeader(headers, correlationId);
      return new Response(
        JSON.stringify({
          error: "Precondition Failed: version mismatch",
          correlationId,
          serverVersion: {
            etag: currentFile.etag,
            version: currentFile.version,
            content: currentFile.content,
            isEncrypted: currentFile.isEncrypted,
            encryptionMetadata: currentFile.encryptionMetadata,
            updatedAt: currentFile.updatedAt.toISOString(),
          },
        }),
        { status: 412, headers }
      );
    }

    // Optimistic-locking atomic update
    const now = new Date();
    const currentVersion = currentFile.version || 0;
    const newVersion = currentVersion + 1;
    const effectiveIsEncrypted =
      isEncrypted !== undefined ? isEncrypted : currentFile.isEncrypted;
    const effectiveMetadata = effectiveIsEncrypted
      ? encryptionMetadata !== undefined
        ? encryptionMetadata
        : currentFile.encryptionMetadata
      : null;

    // Zero-Knowledge Boundary Guard: Encrypted files require valid encryptionMetadata with an IV
    if (effectiveIsEncrypted && (!effectiveMetadata || !effectiveMetadata.iv)) {
      const res = Response.json(
        {
          error: "Encrypted files require valid encryptionMetadata with an IV",
          correlationId,
        },
        { status: 400 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const newContent =
      content !== undefined
        ? effectiveIsEncrypted
          ? content
          : normalizeMarkdownSource(content)
        : currentFile.content;
    const newTitle =
      typeof title === "string" ? title.trim().slice(0, 500) : currentFile.title;

    const newEtag = generateETagSync({
      id: fileId,
      content: newContent || "",
      updatedAt: now,
      isEncrypted: effectiveIsEncrypted,
      envelope: effectiveIsEncrypted
        ? {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: effectiveMetadata?.keyId ?? "master-v1",
            salt: effectiveMetadata?.salt ?? "",
            iv: effectiveMetadata?.iv ?? "",
            kdfIterations: effectiveMetadata?.kdfIterations ?? 600000,
            ciphertext: newContent || "",
          }
        : undefined,
    });

    const [updatedFile] = await db
      .update(schema.files)
      .set({
        content: newContent,
        title: newTitle,
        isEncrypted: effectiveIsEncrypted,
        encryptionMetadata: effectiveMetadata,
        etag: newEtag,
        version: newVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.files.id, fileId),
          eq(schema.files.userId, user.id),
          eq(schema.files.version, currentVersion),
          isNull(schema.files.deletedAt)
        )
      )
      .returning();

    if (!updatedFile) {
      // Concurrent writer raced inside the read-write window
      const refreshed = await db.query.files.findFirst({
        where: and(
          eq(schema.files.id, fileId),
          eq(schema.files.userId, user.id)
        ),
      });
      const headers = new Headers({ "Content-Type": "application/json" });
      if (refreshed && !refreshed.deletedAt) {
        if (refreshed.etag)
          headers.set("ETag", formatETagHeader(refreshed.etag));
        addRateLimitHeaders(headers, rateLimitResult);
        addCorrelationHeader(headers, correlationId);
        return new Response(
          JSON.stringify({
            error:
              "Conflict: this file was modified by another session. Please reload and try again",
            correlationId,
            serverVersion: {
              etag: refreshed.etag,
              version: refreshed.version,
              content: refreshed.content,
              isEncrypted: refreshed.isEncrypted,
              encryptionMetadata: refreshed.encryptionMetadata,
              updatedAt: refreshed.updatedAt.toISOString(),
            },
          }),
          { status: 412, headers }
        );
      }
      const res = Response.json(
        { error: "File not found", correlationId },
        { status: 404 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      "ETag": formatETagHeader(updatedFile.etag!),
      "Cache-Control": "private, must-revalidate, max-age=0",
    });
    addRateLimitHeaders(headers, rateLimitResult);
    addCorrelationHeader(headers, correlationId);

    return new Response(
      JSON.stringify({
        id: updatedFile.id,
        title: updatedFile.title,
        etag: updatedFile.etag,
        version: updatedFile.version,
        updatedAt: updatedFile.updatedAt.toISOString(),
      }),
      { status: 200, headers }
    );
  } catch (error) {
    console.error("[File API PUT] Error:", error);
    const res = Response.json(
      { error: "Internal server error", correlationId },
      { status: 500 }
    );
    addCorrelationHeader(res.headers, correlationId);
    return res;
  }
}

export async function handleFileByIdDelete(
  request: Request,
  context?: RouteContext
): Promise<Response> {
  const correlationId = getOrGenerateCorrelationId(request);
  try {
    const fileId = resolveFileId(request, context);
    if (!fileId) {
      return createInvalidFileIdResponse(correlationId);
    }

    const user = await getUser();
    if (!user) {
      const res = Response.json(
        { error: "Authentication required", correlationId },
        { status: 401 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const rateLimitResult = await fileApiRateLimiter.limit(user.id);
    if (!rateLimitResult.success) {
      const res = rateLimitExceededResponse(rateLimitResult);
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    const ifMatch = parseETagHeader(request.headers.get("If-Match"));
    const searchParams = new URL(request.url).searchParams;
    const expectedVersionParam = searchParams.get("expectedVersion");
    let expectedVersion: number | undefined;
    if (expectedVersionParam !== null) {
      if (/^\d+$/.test(expectedVersionParam)) {
        const parsed = Number(expectedVersionParam);
        if (Number.isSafeInteger(parsed)) {
          expectedVersion = parsed;
        }
      }
    }

    // PHASE 3 & PHASE 8: Mandatory If-Match or expectedVersion on file mutations
    if (!ifMatch && expectedVersion === undefined) {
      const headers = new Headers({ "Content-Type": "application/json" });
      addRateLimitHeaders(headers, rateLimitResult);
      addCorrelationHeader(headers, correlationId);
      return new Response(
        JSON.stringify({
          error:
            "Precondition Required: If-Match header or expectedVersion is required for file deletion",
          correlationId,
        }),
        { status: 428, headers }
      );
    }

    const currentFile = await db.query.files.findFirst({
      where: and(
        eq(schema.files.id, fileId),
        eq(schema.files.userId, user.id),
        isNull(schema.files.deletedAt)
      ),
    });

    if (!currentFile) {
      const res = Response.json(
        { error: "File not found", correlationId },
        { status: 404 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    // Check If-Match condition
    if (ifMatch && currentFile.etag && ifMatch !== currentFile.etag) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (currentFile.etag)
        headers.set("ETag", formatETagHeader(currentFile.etag));
      addRateLimitHeaders(headers, rateLimitResult);
      addCorrelationHeader(headers, correlationId);
      return new Response(
        JSON.stringify({
          error: "Precondition Failed: ETag mismatch",
          correlationId,
          serverVersion: {
            etag: currentFile.etag,
            version: currentFile.version,
            updatedAt: currentFile.updatedAt.toISOString(),
          },
        }),
        { status: 412, headers }
      );
    }

    // Check expectedVersion condition
    if (
      expectedVersion !== undefined &&
      currentFile.version !== expectedVersion
    ) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (currentFile.etag)
        headers.set("ETag", formatETagHeader(currentFile.etag));
      addRateLimitHeaders(headers, rateLimitResult);
      addCorrelationHeader(headers, correlationId);
      return new Response(
        JSON.stringify({
          error: "Precondition Failed: version mismatch",
          correlationId,
          serverVersion: {
            etag: currentFile.etag,
            version: currentFile.version,
            updatedAt: currentFile.updatedAt.toISOString(),
          },
        }),
        { status: 412, headers }
      );
    }

    const now = new Date();
    const currentVersion = currentFile.version || 0;
    const newVersion = currentVersion + 1;

    const [deletedFile] = await db
      .update(schema.files)
      .set({
        deletedAt: now,
        updatedAt: now,
        version: newVersion,
      })
      .where(
        and(
          eq(schema.files.id, fileId),
          eq(schema.files.userId, user.id),
          eq(schema.files.version, currentVersion),
          isNull(schema.files.deletedAt)
        )
      )
      .returning();

    if (!deletedFile) {
      const res = Response.json(
        { error: "Conflict: file was modified concurrently", correlationId },
        { status: 412 }
      );
      addCorrelationHeader(res.headers, correlationId);
      return res;
    }

    if (currentFile.isFolder) {
      const descendantIds = await getDescendantIds(fileId, user.id);
      if (descendantIds.length > 0) {
        await db
          .update(schema.files)
          .set({
            deletedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.files.userId, user.id),
              inArray(schema.files.id, descendantIds)
            )
          );
      }
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "private, must-revalidate, max-age=0",
    });
    addRateLimitHeaders(headers, rateLimitResult);
    addCorrelationHeader(headers, correlationId);

    return new Response(
      JSON.stringify({
        success: true,
        id: fileId,
        version: newVersion,
        deletedAt: now.toISOString(),
      }),
      { status: 200, headers }
    );
  } catch (error) {
    console.error("[File API DELETE] Error:", error);
    const res = Response.json(
      { error: "Internal server error", correlationId },
      { status: 500 }
    );
    addCorrelationHeader(res.headers, correlationId);
    return res;
  }
}

export const filesApiRoutes = new Hono()
  .get("/sync", (c) => handleFilesSyncGet(c.req.raw))
  .get("/:id", (c) => handleFileByIdGet(c.req.raw, { id: c.req.param("id") }))
  .put("/:id", (c) => handleFileByIdPut(c.req.raw, { id: c.req.param("id") }))
  .delete("/:id", (c) => handleFileByIdDelete(c.req.raw, { id: c.req.param("id") }));
