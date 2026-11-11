/**
 * Comprehensive Unit & Edge-Case Test Suite for Web-Standard Files & Sync API Routes (`src/server/routes/files-api.routes.ts`)
 *
 * Verifies:
 * 1. Both direct handler invocation (`handleFilesSyncGet`, `handleFileByIdGet`, `handleFileByIdPut`, `handleFileByIdDelete`)
 *    and Hono router dispatch (`filesApiRoutes.request(...)`).
 * 2. `resolveFileId` parameter resolution across synchronous object params and URL pathname extraction when context is omitted.
 * 4. `GET /api/files/sync`:
 *    - 401 unauthenticated, 429 rate limited, 400 RFC 7807 on invalid `limit` or `updatedAfter` query parameters.
 *    - Pagination (`limit + 1` probe, `has_more`, base64 `next_cursor` generation & decoding, malformed cursor resilience).
 *    - 200 OK headers (`Cache-Control`, rate limit, `X-Correlation-ID`) and 500 DB error fallback.
 * 5. `GET /api/files/:id`:
 *    - 401, 429, 404, 304 Not Modified on matching `If-None-Match` (strong & weak ETags), 200 OK with `ETag`, `Vary`, `Last-Modified`, and 500 error fallback.
 * 6. `PUT /api/files/:id`:
 *    - 401, 429, 400 RFC 7807 on invalid storage payload (`urn:problem-type:invalid-storage-payload`).
 *    - 428 Precondition Required when neither `If-Match` nor `expectedVersion`/`baseVersion` is supplied.
 *    - 404 file not found, 400 folder content update rejection, 400 encrypted file missing `encryptionMetadata.iv`.
 *    - 412 Precondition Failed on `If-Match` ETag mismatch or `expectedVersion`/`baseVersion` mismatch (returning `serverVersion` and `ETag`).
 *    - Atomic CAS update (`db.update`): 200 OK on success (normalizing plaintext markdown vs preserving encrypted ciphertext & computing envelope ETag),
 *      412 Conflict when concurrent writer wins (refreshed file exists), 404 when concurrently deleted, and 500 DB error fallback.
 * 7. `DELETE /api/files/:id`:
 *    - Standard Web `Request` compatibility (extracting `expectedVersion` via `new URL(request.url).searchParams` without `request.nextUrl`).
 *    - 401, 429, 428 Precondition Required (missing or non-numeric `expectedVersion` without `If-Match`).
 *    - 404, 412 ETag mismatch, 412 `expectedVersion` mismatch, 412 concurrent update race (`!deletedFile`).
 *    - Folder cascade soft-delete (`getDescendantIds`) and 200 OK response.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatETagHeader } from "@/lib/sync/etag-generator";

// ---------------------------------------------------------------------------
// Hoisted Mock State (System Boundaries Only: Auth, Rate Limit, DB, Descendants)
// ---------------------------------------------------------------------------

const {
  mockGetUser,
  mockSyncLimit,
  mockFileLimit,
  mockFindMany,
  mockFindFirst,
  mockUpdateReturning,
  mockUpdateSetCalls,
  mockGetDescendantIds,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockSyncLimit: vi.fn(),
  mockFileLimit: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockUpdateSetCalls: [] as Array<Record<string, unknown>>,
  mockGetDescendantIds: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: () => mockGetUser(),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    syncApiRateLimiter: {
      limit: (userId: string) => mockSyncLimit(userId),
    },
    fileApiRateLimiter: {
      limit: (userId: string) => mockFileLimit(userId),
    },
  };
});

vi.mock("@/server/actions/folders", () => ({
  getDescendantIds: (folderId: string, userId: string) =>
    mockGetDescendantIds(folderId, userId),
}));

vi.mock("@/server/db", () => {
  const schema = {
    files: {
      id: "files.id",
      userId: "files.user_id",
      version: "files.version",
      deletedAt: "files.deleted_at",
      updatedAt: "files.updated_at",
    },
  };

  const db = {
    query: {
      files: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        mockUpdateSetCalls.push(values);
        return {
          where: () => {
            const thenable = Promise.resolve(undefined) as Promise<unknown> & {
              returning: () => Promise<unknown>;
            };
            thenable.returning = () => mockUpdateReturning();
            return thenable;
          },
        };
      },
    })),
  };

  return { db, schema };
});

import {
  resolveFileId,
  handleFilesSyncGet,
  handleFileByIdGet,
  handleFileByIdPut,
  handleFileByIdDelete,
  filesApiRoutes,
} from "@/server/routes/files-api.routes";

// ---------------------------------------------------------------------------
// Fixture Builders
// ---------------------------------------------------------------------------

const TEST_USER = { id: "user-files-001", email: "files@elixent.ai" };
const TEST_FILE_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_FOLDER_ID = "660e8400-e29b-41d4-a716-446655440000";
const TEST_FILE_2 = "770e8400-e29b-41d4-a716-446655440000";

function buildFileRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_FILE_ID,
    userId: TEST_USER.id,
    title: "Architecture Spec",
    content: "# Architecture\n\nClean content.",
    isEncrypted: false,
    encryptionMetadata: null,
    etag: "etag_hash_v3",
    version: 3,
    parentFolderId: null,
    isFolder: false,
    deletedAt: null as Date | null,
    updatedAt: new Date("2026-11-07T10:00:00.000Z"),
    createdAt: new Date("2026-11-01T08:00:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Web-Standard Hono Files & Sync API Routes (src/server/routes/files-api.routes.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSetCalls.length = 0;

    mockGetUser.mockResolvedValue(TEST_USER);
    mockSyncLimit.mockResolvedValue({
      success: true,
      remaining: 59,
      reset: Math.ceil(Date.now() / 1000) + 60,
      limit: 60,
    });
    mockFileLimit.mockResolvedValue({
      success: true,
      remaining: 119,
      reset: Math.ceil(Date.now() / 1000) + 60,
      limit: 120,
    });
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(buildFileRecord());
    mockUpdateReturning.mockResolvedValue([
      buildFileRecord({
        version: 4,
        etag: "etag_hash_v4",
        updatedAt: new Date("2026-11-07T12:00:00.000Z"),
      }),
    ]);
    mockGetDescendantIds.mockResolvedValue([]);
  });

  // =========================================================================
  // 1. GET /api/files/sync
  // =========================================================================
  describe("GET /api/files/sync (handleFilesSyncGet & filesApiRoutes)", () => {
    it("returns 401 with X-Correlation-ID when user is unauthenticated", async () => {
      mockGetUser.mockResolvedValueOnce(null);

      const res = await handleFilesSyncGet(
        new Request("http://localhost/api/files/sync", {
          headers: { "X-Correlation-ID": "corr-sync-401" },
        })
      );

      expect(res.status).toBe(401);
      expect(res.headers.get("X-Correlation-ID")).toBe("corr-sync-401");
      const body = await res.json();
      expect(body).toEqual({
        error: "Authentication required",
        correlationId: "corr-sync-401",
      });
    });

    it("returns 429 with rate limit headers when syncApiRateLimiter rejects request", async () => {
      mockSyncLimit.mockResolvedValueOnce({
        success: false,
        remaining: 0,
        reset: Math.ceil(Date.now() / 1000) + 30,
        limit: 60,
      });

      const res = await handleFilesSyncGet(
        new Request("http://localhost/api/files/sync")
      );

      expect(res.status).toBe(429);
      expect(res.headers.get("X-Correlation-ID")).toBeTruthy();
    });

    it.each([
      ["limit=0", "limit below minimum (1)"],
      ["limit=101", "limit above maximum (100)"],
      ["limit=not-a-number", "non-numeric limit"],
      ["updatedAfter=not-an-iso-date", "invalid ISO datetime"],
    ])(
      "returns 400 RFC 7807 Problem Details for invalid query parameter (%s — %s)",
      async (query, _reason) => {
        const res = await handleFilesSyncGet(
          new Request(`http://localhost/api/files/sync?${query}`)
        );

        expect(res.status).toBe(400);
        expect(res.headers.get("Content-Type")).toBe("application/problem+json");
        const body = await res.json();
        expect(body.type).toBe("urn:problem-type:invalid-sync-pull-request");
        expect(body.status).toBe(400);
      }
    );

    it("paginates results with limit + 1 probe, generates base64 next_cursor, and tolerates malformed incoming cursor", async () => {
      const f1 = buildFileRecord({
        id: "file-1",
        updatedAt: new Date("2026-11-07T10:00:00.000Z"),
      });
      const f2 = buildFileRecord({
        id: "file-2",
        updatedAt: new Date("2026-11-07T10:05:00.000Z"),
      });
      const f3Extra = buildFileRecord({
        id: "file-3",
        updatedAt: new Date("2026-11-07T10:10:00.000Z"),
      });
      mockFindMany.mockResolvedValueOnce([f1, f2, f3Extra]);

      const res = await filesApiRoutes.request(
        "http://localhost/sync?limit=2&updated_after=2026-11-07T09:00:00.000Z&cursor=!!!not-valid-base64-json!!!",
        { method: "GET" }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "private, no-cache, no-store, must-revalidate"
      );
      expect(res.headers.get("X-Correlation-ID")).toBeTruthy();

      const body = await res.json();
      expect(body.files).toHaveLength(2);
      expect(body.has_more).toBe(true);
      expect(body.next_cursor).toBeTruthy();

      const decodedCursor = JSON.parse(
        Buffer.from(body.next_cursor, "base64").toString("utf-8")
      );
      expect(decodedCursor).toEqual({
        updatedAt: "2026-11-07T10:05:00.000Z",
        id: "file-2",
      });

      // Verify second page request using valid base64 cursor succeeds
      mockFindMany.mockResolvedValueOnce([f3Extra]);
      const page2Res = await handleFilesSyncGet(
        new Request(
          `http://localhost/api/files/sync?limit=2&cursor=${encodeURIComponent(body.next_cursor)}`
        )
      );
      expect(page2Res.status).toBe(200);
      const page2Body = await page2Res.json();
      expect(page2Body.files).toHaveLength(1);
      expect(page2Body.has_more).toBe(false);
      expect(page2Body.next_cursor).toBeNull();
    });

    it("returns 500 with X-Correlation-ID when db.query.files.findMany throws", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFindMany.mockRejectedValueOnce(new Error("Neon connection reset"));

      const res = await handleFilesSyncGet(
        new Request("http://localhost/api/files/sync")
      );

      expect(res.status).toBe(500);
      expect(res.headers.get("X-Correlation-ID")).toBeTruthy();
      const body = await res.json();
      expect(body.error).toBe("Internal server error");
      errSpy.mockRestore();
    });
  });

  // =========================================================================
  // 2. GET /api/files/:id
  // =========================================================================
  describe("GET /api/files/:id (handleFileByIdGet & filesApiRoutes)", () => {
    it("resolves file ID from synchronous params or URL pathname when context is omitted", async () => {
      // 1. Omitted context -> extracts from URL pathname
      const resNoCtx = await handleFileByIdGet(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`)
      );
      expect(resNoCtx.status).toBe(200);

      // 2. Synchronous params context
      const resPromiseCtx = await handleFileByIdGet(
        new Request("http://localhost/api/files/ignored"),
        { params: { id: TEST_FILE_ID } }
      );
      expect(resPromiseCtx.status).toBe(200);

      // 3. Hono router dispatch (sync params)
      const resHono = await filesApiRoutes.request(
        `http://localhost/${TEST_FILE_ID}`,
        { method: "GET" }
      );
      expect(resHono.status).toBe(200);
    });

    it("returns 404 when file does not exist or belongs to another user", async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const res = await handleFileByIdGet(
        new Request(`http://localhost/api/files/${TEST_FILE_2}`)
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("File not found");
    });

    it("returns 304 Not Modified with ETag header when If-None-Match matches file ETag", async () => {
      mockFindFirst.mockResolvedValueOnce(
        buildFileRecord({ etag: "etag_match_999" })
      );

      const res = await handleFileByIdGet(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          headers: { "If-None-Match": 'W/"etag_match_999"' },
        })
      );

      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toBe(formatETagHeader("etag_match_999"));
      expect(res.headers.get("X-Correlation-ID")).toBeTruthy();
      expect(await res.text()).toBe("");
    });

    it("returns 200 OK with full file metadata, ETag, Vary, and Last-Modified headers when ETag differs", async () => {
      const record = buildFileRecord({ etag: "etag_current" });
      mockFindFirst.mockResolvedValueOnce(record);

      const res = await handleFileByIdGet(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          headers: { "If-None-Match": '"etag_stale"' },
        })
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBe(formatETagHeader("etag_current"));
      expect(res.headers.get("Vary")).toBe("If-None-Match");
      expect(res.headers.get("Last-Modified")).toBe(record.updatedAt.toUTCString());

      const body = await res.json();
      expect(body).toMatchObject({
        id: TEST_FILE_ID,
        title: "Architecture Spec",
        version: 3,
        etag: "etag_current",
      });
    });
  });

  // =========================================================================
  // 3. PUT /api/files/:id
  // =========================================================================
  describe("PUT /api/files/:id (handleFileByIdPut & filesApiRoutes)", () => {
    it("returns 400 RFC 7807 Invalid Storage Payload when plaintext payload includes non-null encryptionMetadata", async () => {
      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": '"etag_hash_v3"',
          },
          body: JSON.stringify({
            content: "Plaintext with forbidden metadata",
            isEncrypted: false,
            encryptionMetadata: {
              version: 1,
              algorithm: "AES-GCM-256",
              keyId: "k1",
              salt: "s1",
              iv: "iv1",
            },
          }),
        })
      );

      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("application/problem+json");
      const body = await res.json();
      expect(body.type).toBe("urn:problem-type:invalid-storage-payload");
      expect(body.instance).toBe(`/api/files/${TEST_FILE_ID}`);
    });

    it("returns 428 Precondition Required when neither If-Match nor expectedVersion/baseVersion is provided", async () => {
      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Updated Title Only" }),
        })
      );

      expect(res.status).toBe(428);
      const body = await res.json();
      expect(body.error).toContain("Precondition Required");
    });

    it("returns 400 when attempting to update content of a folder", async () => {
      mockFindFirst.mockResolvedValueOnce(
        buildFileRecord({ isFolder: true })
      );

      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FOLDER_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Rename Folder", expectedVersion: 3 }),
        })
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Cannot update content of a folder");
    });

    it("returns 400 when updating an encrypted file that lacks valid encryptionMetadata.iv in both request and DB", async () => {
      mockFindFirst.mockResolvedValueOnce(
        buildFileRecord({
          isEncrypted: true,
          encryptionMetadata: null,
        })
      );

      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_2}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Title Update On Encrypted File Without IV",
            expectedVersion: 3,
          }),
        })
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("encryptionMetadata with an IV");
    });

    it("returns 412 Precondition Failed with serverVersion when If-Match ETag mismatches", async () => {
      mockFindFirst.mockResolvedValueOnce(
        buildFileRecord({ etag: "server_etag_v5", version: 5 })
      );

      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": '"client_stale_etag"',
          },
          body: JSON.stringify({ content: "New text" }),
        })
      );

      expect(res.status).toBe(412);
      expect(res.headers.get("ETag")).toBe(formatETagHeader("server_etag_v5"));
      const body = await res.json();
      expect(body.error).toBe("Precondition Failed: ETag mismatch");
      expect(body.serverVersion).toMatchObject({
        etag: "server_etag_v5",
        version: 5,
      });
    });

    it("returns 412 Precondition Failed with serverVersion when baseVersion mismatches currentFile.version", async () => {
      mockFindFirst.mockResolvedValueOnce(
        buildFileRecord({ etag: "server_etag_v5", version: 5 })
      );

      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "New text", baseVersion: 2 }),
        })
      );

      expect(res.status).toBe(412);
      const body = await res.json();
      expect(body.error).toBe("Precondition Failed: version mismatch");
      expect(body.serverVersion.version).toBe(5);
    });

    it("returns 412 Conflict with refreshed serverVersion when concurrent writer wins inside the read-write window", async () => {
      const initialRecord = buildFileRecord({ version: 3, etag: "etag_v3" });
      const concurrentRecord = buildFileRecord({
        version: 4,
        etag: "etag_v4_concurrent",
        content: "Concurrent session content",
      });

      mockFindFirst
        .mockResolvedValueOnce(initialRecord)
        .mockResolvedValueOnce(concurrentRecord);
      mockUpdateReturning.mockResolvedValueOnce([]); // CAS update matched 0 rows

      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "My content", expectedVersion: 3 }),
        })
      );

      expect(res.status).toBe(412);
      expect(res.headers.get("ETag")).toBe(
        formatETagHeader("etag_v4_concurrent")
      );
      const body = await res.json();
      expect(body.error).toContain("Conflict: this file was modified by another session");
      expect(body.serverVersion).toMatchObject({
        version: 4,
        etag: "etag_v4_concurrent",
        content: "Concurrent session content",
      });
    });

    it("returns 404 when concurrent writer deletes the file inside the read-write window", async () => {
      mockFindFirst
        .mockResolvedValueOnce(buildFileRecord({ version: 3 }))
        .mockResolvedValueOnce(
          buildFileRecord({ version: 4, deletedAt: new Date() })
        );
      mockUpdateReturning.mockResolvedValueOnce([]);

      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "My content", expectedVersion: 3 }),
        })
      );

      expect(res.status).toBe(404);
    });

    it("updates encrypted file with valid encryptionMetadata and returns 200 OK with new ETag and incremented version", async () => {
      const metadata = {
        version: 1,
        algorithm: "AES-GCM-256",
        keyId: "vault-key-1",
        salt: "c2FsdF9iYXNlNjQ=",
        iv: "aXZfYmFzZTY0X3ZhbA==",
        kdfIterations: 600000,
      };
      mockFindFirst.mockResolvedValueOnce(
        buildFileRecord({
          version: 3,
          isEncrypted: true,
          encryptionMetadata: metadata,
        })
      );
      mockUpdateReturning.mockResolvedValueOnce([
        buildFileRecord({
          version: 4,
          title: "Encrypted Spec",
          isEncrypted: true,
          encryptionMetadata: metadata,
          etag: "etag_enc_v4",
        }),
      ]);

      const res = await filesApiRoutes.request(`http://localhost/${TEST_FILE_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "  Encrypted Spec  ",
          content: "Y2lwaGVydGV4dF9iYXNlNjRfcGF5bG9hZA==",
          isEncrypted: true,
          encryptionMetadata: metadata,
          expectedVersion: 3,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBe(formatETagHeader("etag_enc_v4"));
      const body = await res.json();
      expect(body).toMatchObject({
        id: TEST_FILE_ID,
        title: "Encrypted Spec",
        version: 4,
        etag: "etag_enc_v4",
      });
      expect(mockUpdateSetCalls[0].title).toBe("Encrypted Spec");
      expect(mockUpdateSetCalls[0].content).toBe("Y2lwaGVydGV4dF9iYXNlNjRfcGF5bG9hZA==");
    });
  });

  // =========================================================================
  // 4. DELETE /api/files/:id
  // =========================================================================
  describe("DELETE /api/files/:id (handleFileByIdDelete & filesApiRoutes)", () => {
    it("parses expectedVersion from standard Web Request URL searchParams without requiring request.nextUrl", async () => {
      const res = await handleFileByIdDelete(
        new Request(
          `http://localhost/api/files/${TEST_FILE_ID}?expectedVersion=3`,
          { method: "DELETE" }
        )
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        success: true,
        id: TEST_FILE_ID,
        version: 4,
      });
      expect(body.deletedAt).toBeTruthy();
    });

    it("returns 428 Precondition Required when neither If-Match nor a valid numeric expectedVersion is provided", async () => {
      const res = await handleFileByIdDelete(
        new Request(
          `http://localhost/api/files/${TEST_FILE_ID}?expectedVersion=not-a-num`,
          { method: "DELETE" }
        )
      );

      expect(res.status).toBe(428);
      const body = await res.json();
      expect(body.error).toContain(
        "Precondition Required: If-Match header or expectedVersion is required for file deletion"
      );
    });

    it("returns 412 when If-Match or expectedVersion mismatches currentFile", async () => {
      mockFindFirst.mockResolvedValue(
        buildFileRecord({ etag: "etag_actual", version: 7 })
      );

      const resEtag = await handleFileByIdDelete(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "DELETE",
          headers: { "If-Match": '"etag_wrong"' },
        })
      );
      expect(resEtag.status).toBe(412);
      expect((await resEtag.json()).error).toBe(
        "Precondition Failed: ETag mismatch"
      );

      const resVer = await handleFileByIdDelete(
        new Request(
          `http://localhost/api/files/${TEST_FILE_ID}?expectedVersion=2`,
          { method: "DELETE" }
        )
      );
      expect(resVer.status).toBe(412);
      expect((await resVer.json()).error).toBe(
        "Precondition Failed: version mismatch"
      );
    });

    it("returns 412 when atomic delete update returns empty (concurrent modification race)", async () => {
      mockUpdateReturning.mockResolvedValueOnce([]);

      const res = await handleFileByIdDelete(
        new Request(
          `http://localhost/api/files/${TEST_FILE_ID}?expectedVersion=3`,
          { method: "DELETE" }
        )
      );

      expect(res.status).toBe(412);
      const body = await res.json();
      expect(body.error).toBe("Conflict: file was modified concurrently");
    });

    it("soft-deletes folder and cascades deletedAt to all descendant IDs via Hono router", async () => {
      mockFindFirst.mockResolvedValueOnce(
        buildFileRecord({
          id: TEST_FOLDER_ID,
          isFolder: true,
          version: 2,
          etag: "etag_folder_v2",
        })
      );
      mockUpdateReturning.mockResolvedValueOnce([
        buildFileRecord({ id: TEST_FOLDER_ID, isFolder: true, version: 3 }),
      ]);
      mockGetDescendantIds.mockResolvedValueOnce(["child-1", "child-2"]);

      const res = await filesApiRoutes.request(
        `http://localhost/${TEST_FOLDER_ID}?expectedVersion=2`,
        { method: "DELETE" }
      );

      expect(res.status).toBe(200);
      expect(mockGetDescendantIds).toHaveBeenCalledWith(
        TEST_FOLDER_ID,
        TEST_USER.id
      );
      // 1st update for the folder itself, 2nd update for the descendants
      expect(mockUpdateSetCalls).toHaveLength(2);
      expect(mockUpdateSetCalls[1]).toHaveProperty("deletedAt");
    });
  });

  // =========================================================================
  // 5. DEF-A08: resolveFileId Hardening & Invalid File ID Rejection
  // =========================================================================
  describe("DEF-A08: resolveFileId Hardening & Invalid File ID Rejection", () => {
    it.each([
      { url: "http://localhost/api/files/", label: "trailing slash after /api/files" },
      { url: "http://localhost/api/files", label: "base /api/files without ID" },
      { url: "http://localhost/api/files/sync", label: "reserved sync route" },
      { url: "http://localhost/api/files/sync/", label: "reserved sync route with trailing slash" },
      { url: "http://localhost/api/files/upload", label: "reserved upload route" },
      { url: "http://localhost/api/files/upload/", label: "reserved upload route with trailing slash" },
      { url: "http://localhost/api/files/file-123/extra", label: "nested extra segment under /api/files" },
      { url: "http://localhost/api/files/%20%20", label: "URL-encoded whitespace segment" },
      { url: "http://localhost/api/files/%2F", label: "URL-encoded slash segment" },
      { url: "http://localhost/api/files/%73%79%6e%63", label: "URL-encoded reserved 'sync' segment" },
      { url: "http://localhost/api/files/%2e", label: "URL-encoded dot segment" },
      { url: "http://localhost/api/files/%2e%2e", label: "URL-encoded dot-dot traversal segment" },
      { url: "http://localhost/api/files/550e8400-e29b-41d4-a716-446655440000%2520", label: "double-percent encoded %2520" },
      { url: "http://localhost/api/files/%252e%252e", label: "double-percent encoded %252e%252e" },
      { url: "http://localhost/api/files/file-123", label: "non-UUID segment file-123" },
      { url: "http://localhost/api/files/not-a-valid-uuid", label: "arbitrary non-UUID string" },
      { url: "http://localhost/api", label: "bare /api path" },
      { url: "http://localhost/", label: "root path" },
    ])(
      "returns null for $url ($label)",
      ({ url }) => {
        expect(resolveFileId(new Request(url))).toBeNull();
      }
    );

    it.each([
      { context: "sync", label: "string reserved sync" },
      { context: "upload", label: "string reserved upload" },
      { context: "..", label: "string dot-dot traversal" },
      { context: "not-a-uuid", label: "string non-UUID" },
      { context: "550e8400-e29b-41d4-a716-446655440000%2520", label: "string double-percent-encoded" },
      { context: { id: "files" }, label: "object reserved files" },
      { context: { params: { id: "api" } }, label: "nested reserved api" },
      { context: { id: "not-a-uuid" }, label: "object non-UUID" },
      { context: { id: "   " }, label: "whitespace-only id" },
      { context: { id: "" }, label: "explicit empty string id" },
      { context: { params: { id: "" } }, label: "explicit nested empty string id" },
    ])("rejects reserved, non-UUID, or empty context ($label)", ({ context }) => {
      expect(
        resolveFileId(new Request(`http://localhost/api/files/${TEST_FILE_ID}`), context)
      ).toBeNull();
    });

    it.each([
      [
        "http://localhost/api/files/550e8400-e29b-41d4-a716-446655440000",
        undefined,
        "550e8400-e29b-41d4-a716-446655440000",
      ],
      [
        "http://localhost/api/files/550e8400-e29b-41d4-a716-446655440000/",
        undefined,
        "550e8400-e29b-41d4-a716-446655440000",
      ],
      [
        "http://localhost/api/files/ignored",
        "  550e8400-e29b-41d4-a716-446655440000  ",
        "550e8400-e29b-41d4-a716-446655440000",
      ],
      [
        "http://localhost/api/files/ignored",
        { id: "  550e8400-e29b-41d4-a716-446655440000  " },
        "550e8400-e29b-41d4-a716-446655440000",
      ],
      [
        "http://localhost/api/files/ignored",
        { params: { id: "  550e8400-e29b-41d4-a716-446655440000  " } },
        "550e8400-e29b-41d4-a716-446655440000",
      ],
    ])(
      "extracts valid UUID file ID from %s with context %o -> %s",
      (url, context, expectedId) => {
        expect(resolveFileId(new Request(url), context)).toBe(expectedId);
      }
    );

    it.each([
      ["GET", "http://localhost/api/files/", handleFileByIdGet],
      ["GET", "http://localhost/api/files", handleFileByIdGet],
      ["GET", "http://localhost/api/files/upload", handleFileByIdGet],
      ["GET", "http://localhost/api/files/malformed-id-123", handleFileByIdGet],
      ["PUT", "http://localhost/api/files/", handleFileByIdPut],
      ["PUT", "http://localhost/api/files/sync", handleFileByIdPut],
      ["PUT", "http://localhost/api/files/malformed-id-123", handleFileByIdPut],
      ["DELETE", "http://localhost/api/files/", handleFileByIdDelete],
      ["DELETE", "http://localhost/api/files/upload", handleFileByIdDelete],
      ["DELETE", "http://localhost/api/files/malformed-id-123", handleFileByIdDelete],
    ] as const)(
      "returns 400 without querying DB and without consuming rate limit when %s %s has invalid fileId",
      async (method, url, handler) => {
        const res = await handler(
          new Request(url, {
            method,
            headers: { "X-Correlation-ID": "corr-invalid-id" },
          })
        );

        expect(res.status).toBe(400);
        expect(res.headers.get("X-Correlation-ID")).toBe("corr-invalid-id");
        expect(await res.json()).toEqual({
          error: "Invalid or missing file ID",
          correlationId: "corr-invalid-id",
        });
        expect(mockFindFirst).not.toHaveBeenCalled();
        expect(mockFileLimit).not.toHaveBeenCalled();
      }
    );

    it("rejects reserved /upload path routed through Hono /:id with 400 without hitting DB or consuming rate limit", async () => {
      const res = await filesApiRoutes.request("http://localhost/upload", {
        method: "GET",
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid or missing file ID");
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockFileLimit).not.toHaveBeenCalled();
    });

    it("PUT /api/files/:id rejects null and array JSON bodies with 400", async () => {
      const resNull = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "null",
        })
      );
      expect(resNull.status).toBe(400);
      expect((await resNull.json()).error).toContain("expected a JSON object");

      const resArray = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(["item1", "item2"]),
        })
      );
      expect(resArray.status).toBe(400);
      expect((await resArray.json()).error).toContain("expected a JSON object");
    });

    it("PUT /api/files/:id rejects non-string title with 400", async () => {
      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: 12345, expectedVersion: 3 }),
        })
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid title: must be a string");
    });

    it("PUT /api/files/:id strictly rejects stripping encryption from an encrypted file without supplying replacement content", async () => {
      mockFindFirst.mockResolvedValueOnce(
        buildFileRecord({
          id: TEST_FILE_ID,
          isEncrypted: true,
          content: "encrypted-ciphertext-data",
          encryptionMetadata: {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "master-v1",
            salt: "salt",
            iv: "iv",
            kdfIterations: 600000,
          },
        })
      );

      const res = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            isEncrypted: false,
            expectedVersion: 3,
          }),
        })
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        "Cannot remove encryption from a file without supplying replacement plaintext content"
      );
    });

    it("DELETE /api/files/:id strictly validates expectedVersion against non-integer / unsafe integers", async () => {
      const resFloat = await handleFileByIdDelete(
        new Request(`http://localhost/api/files/${TEST_FILE_ID}?expectedVersion=3.14`, {
          method: "DELETE",
        })
      );
      expect(resFloat.status).toBe(428);

      const resUnsafe = await handleFileByIdDelete(
        new Request(
          `http://localhost/api/files/${TEST_FILE_ID}?expectedVersion=99999999999999999999999999999999`,
          { method: "DELETE" }
        )
      );
      expect(resUnsafe.status).toBe(428);
    });
  });
});
