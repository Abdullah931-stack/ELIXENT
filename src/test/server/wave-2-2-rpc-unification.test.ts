/**
 * Wave 2.2 Integration & Architectural Invariant Test Suite
 *
 * Verifies:
 * 1. Unified Hono RPC Client Typing & Transport Injection (`src/client/rpc-client.ts`):
 *    - `createElixentRpcClient` factory instantiation with true Hono typing `hc<AppType>`.
 *    - `setRpcClientFetch` / `getRpcClientFetch` transport override and restoration.
 *    - Confirmation that legacy `isVitestBridgeActive` is removed from `src/client/rpc-client.ts`.
 *    - Custom fetch routing through typed facades (`createFile`, `getCreditBalance`, `signOut`).
 * 2. DEF-11: Cookie Invalidation & Invariant Enforcement (`src/server/routes/rpc.routes.ts`):
 *    - `hono/cookie` `deleteCookie` adoption with `expires: new Date(0)`.
 *    - Deletion strictly targeted at `sb-*` Supabase authentication cookies.
 *    - Preservation of non-`sb-*` application and session cookies.
 *    - Graceful no-op when request lacks `sb-*` cookies or has malformed/empty Cookie headers.
 * 3. Simplified RouteParams & Context Resolution (`src/server/routes/files-api.routes.ts`):
 *    - `RouteParams` contract compatibility (`{ id?: string; params?: { id: string } }`).
 *    - Resolution precedence: direct `{ id }` -> nested `{ params: { id } }` -> string -> URL pathname fallback.
 *    - End-to-end routing dispatch via `filesApiRoutes` (`GET /:id`, `PUT /:id`, `DELETE /:id`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { rpcRoutes } from "@/server/routes/rpc.routes";
import {
  filesApiRoutes,
  handleFileByIdGet,
  handleFileByIdPut,
  handleFileByIdDelete,
  type RouteParams,
} from "@/server/routes/files-api.routes";
import {
  createElixentRpcClient,
  setRpcClientFetch,
  getRpcClientFetch,
  createFile,
  getCreditBalance,
  signOut as clientSignOut,
} from "@/client/rpc-client";

// ---------------------------------------------------------------------------
// Hoisted Mock Boundaries (Auth, DB, Rate Limit)
// ---------------------------------------------------------------------------

const {
  mockServerSignOut,
  mockGetUser,
  mockFileLimit,
  mockFindFirst,
  mockUpdateReturning,
  mockUpdateSetCalls,
} = vi.hoisted(() => ({
  mockServerSignOut: vi.fn(),
  mockGetUser: vi.fn(),
  mockFileLimit: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockUpdateSetCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/actions/auth-actions", () => ({
  signOut: () => mockServerSignOut(),
  signInWithGoogle: vi.fn(),
  syncUserToDatabase: vi.fn(),
  getUserProfile: vi.fn(),
  updateUserProfile: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: () => mockGetUser(),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    fileApiRateLimiter: {
      limit: (userId: string) => mockFileLimit(userId),
    },
    syncApiRateLimiter: {
      limit: () => Promise.resolve({ success: true, remaining: 100, reset: 0 }),
    },
  };
});

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
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: vi.fn().mockResolvedValue([]),
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

describe("Wave 2.2 Integration & Architectural Invariants", () => {
  const TEST_USER = { id: "user-w22-test", email: "test-w22@elixent.ai" };
  const defaultTransportFetch = getRpcClientFetch();

  beforeEach(() => {
    vi.clearAllMocks();
    setRpcClientFetch(defaultTransportFetch);
    mockUpdateSetCalls.length = 0;
    mockGetUser.mockResolvedValue(TEST_USER);
    mockFileLimit.mockResolvedValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: Math.ceil(Date.now() / 1000) + 60,
    });
    mockServerSignOut.mockResolvedValue({ success: true, redirectUrl: "/" });
  });

  afterEach(() => {
    setRpcClientFetch(defaultTransportFetch);
  });

  // ==========================================================================
  // Section 1: RPC Client Typing & Dynamic Transport Unification
  // ==========================================================================

  describe("1. Unified Hono RPC Client Typing & Transport Bridge", () => {
    it("instantiates createElixentRpcClient with typed routes matching Hono router", () => {
      const client = createElixentRpcClient("http://localhost:3000");
      expect(client).toBeDefined();
      expect(client.api).toBeDefined();
      expect(client.api.rpc).toBeDefined();
      expect(client.api.rpc.files).toBeDefined();
      expect(client.api.rpc.vault).toBeDefined();
      expect(client.api.rpc.auth).toBeDefined();
      expect(client.api.rpc.billing).toBeDefined();
    });

    it("confirms isVitestBridgeActive is purged and supports setRpcClientFetch override and restoration", async () => {
      const rpcClientMod = await import("@/client/rpc-client");
      expect("isVitestBridgeActive" in rpcClientMod).toBe(false);
      expect(typeof defaultTransportFetch).toBe("function");
      expect(getRpcClientFetch()).toBe(defaultTransportFetch);

      // Injected custom fetch overrides the active transport
      const dummyFetch: typeof fetch = vi.fn();
      setRpcClientFetch(dummyFetch);
      expect(getRpcClientFetch()).toBe(dummyFetch);

      // Restoring default loopback transport cleanly clears custom override
      setRpcClientFetch(defaultTransportFetch);
      expect(getRpcClientFetch()).toBe(defaultTransportFetch);
    });

    it("dispatches typed HTTP requests via custom fetch when bridge is deactivated", async () => {
      const capturedRequests: Array<{ url: string; method: string; body?: string }> = [];

      const mockHttpFetch: typeof fetch = vi.fn(async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        const method = init?.method ?? "GET";
        const body = init?.body ? String(init.body) : undefined;
        capturedRequests.push({ url, method, body });

        if (url.includes("/api/rpc/files/create")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                id: "file-created-1",
                title: "Doc Title",
                version: 1,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/api/rpc/billing/credit-balance")) {
          return new Response(
            JSON.stringify({
              success: true,
              balanceMicro: "500000000",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/api/rpc/auth/sign-out")) {
          return new Response(
            JSON.stringify({
              success: true,
              redirectUrl: "/login",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });

      setRpcClientFetch(mockHttpFetch);

      // Test 1: createFile
      const fileRes = await createFile("Doc Title", null, false);
      expect(fileRes.success).toBe(true);
      expect(fileRes.data?.id).toBe("file-created-1");
      expect(capturedRequests[0].url).toContain("/api/rpc/files/create");
      expect(capturedRequests[0].method).toBe("POST");
      expect(JSON.parse(capturedRequests[0].body!)).toEqual({
        title: "Doc Title",
        parentFolderId: null,
        isFolder: false,
      });

      // Test 2: getCreditBalance parsing BigInt
      const balance = await getCreditBalance();
      expect(balance).toBe(BigInt(500000000));
      expect(capturedRequests[1].url).toContain("/api/rpc/billing/credit-balance");
      expect(capturedRequests[1].method).toBe("GET");

      // Test 3: clientSignOut
      const signOutRes = await clientSignOut();
      expect(signOutRes).toEqual({ success: true, redirectUrl: "/login" });
      expect(capturedRequests[2].url).toContain("/api/rpc/auth/sign-out");
      expect(capturedRequests[2].method).toBe("POST");
    });

    it("returns 0n for getCreditBalance when custom fetch returns 401 unauthenticated", async () => {
      const mockUnauthFetch: typeof fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({ success: false, error: "Unauthorized" }),
          { status: 401 }
        );
      });

      setRpcClientFetch(mockUnauthFetch);
      const balance = await getCreditBalance();
      expect(balance).toBe(BigInt(0));
    });
  });

  // ==========================================================================
  // Section 2: DEF-11 Cookie Invalidation Invariant
  // ==========================================================================

  describe("2. DEF-11: Cookie Invalidation Invariant (POST /api/rpc/auth/sign-out)", () => {
    it("deletes all sb-* cookies with RFC 6265 dual deletion (HttpOnly + non-HttpOnly), expires: new Date(0), Path=/, and SameSite=Lax", async () => {
      const cookieHeader = [
        "sb-access-token=access_jwt_123",
        "sb-refresh-token=refresh_jwt_456",
        "sb-auth-token-code-verifier=verifier_789",
        "sb-chunked.0=part_0",
        "sb-chunked.1=part_1",
        "user_theme=system_dark",
        "session_marker=active",
      ].join("; ");

      const res = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: { Cookie: cookieHeader },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, redirectUrl: "/" });
      expect(mockServerSignOut).toHaveBeenCalledTimes(1);

      const setCookieHeaders = res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(10);

      const expectedSbCookies = [
        "sb-access-token",
        "sb-refresh-token",
        "sb-auth-token-code-verifier",
        "sb-chunked.0",
        "sb-chunked.1",
      ];
      const deletedCookieNames = setCookieHeaders.map((c) => c.split("=")[0].trim());
      expect(deletedCookieNames).toEqual(expect.arrayContaining(expectedSbCookies));

      // Verify dual deletion (1 HttpOnly + 1 client-accessible non-HttpOnly) per sb-* cookie
      for (const name of expectedSbCookies) {
        const cookieHeaders = setCookieHeaders.filter((c) => c.startsWith(`${name}=`));
        expect(cookieHeaders).toHaveLength(2);
        expect(cookieHeaders.filter((c) => c.includes("HttpOnly"))).toHaveLength(1);
        expect(cookieHeaders.filter((c) => !c.includes("HttpOnly"))).toHaveLength(1);
      }

      // Verify that non-sb-* cookies are preserved
      expect(deletedCookieNames).not.toContain("user_theme");
      expect(deletedCookieNames).not.toContain("session_marker");

      // Verify standardized cookie deletion attributes
      for (const cookieStr of setCookieHeaders) {
        expect(cookieStr).toContain("Max-Age=0");
        expect(cookieStr).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        expect(cookieStr).toContain("Path=/");
        expect(cookieStr).toMatch(/SameSite=Lax/i);
      }
    });

    it("emits zero Set-Cookie headers when incoming request contains only non-sb-* cookies", async () => {
      const res = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: { Cookie: "app_theme=light; analytics_id=anon-999; session=abc" },
      });

      expect(res.status).toBe(200);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toHaveLength(0);
    });

    it("gracefully handles requests with no Cookie header or empty/whitespace values", async () => {
      // 1. Completely absent Cookie header
      const resEmpty = await rpcRoutes.request("/auth/sign-out", { method: "POST" });
      expect(resEmpty.status).toBe(200);
      expect(resEmpty.headers.getSetCookie()).toHaveLength(0);

      // 2. Whitespace and empty semicolons
      const resMalformed = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: { Cookie: " ; ;   ; " },
      });
      expect(resMalformed.status).toBe(200);
      expect(resMalformed.headers.getSetCookie()).toHaveLength(0);
    });

    it("deletes cookie when cookie name is exactly 'sb-' prefix boundary using dual deletion", async () => {
      const res = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: { Cookie: "sb-=some_token_boundary; valid=true" },
      });

      expect(res.status).toBe(200);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toHaveLength(2);
      expect(setCookies.every((c) => c.startsWith("sb-="))).toBe(true);
      expect(setCookies.filter((c) => c.includes("HttpOnly"))).toHaveLength(1);
      expect(setCookies.filter((c) => !c.includes("HttpOnly"))).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Section 3: Simplified RouteParams & Parameter Precedence
  // ==========================================================================

  describe("3. Simplified RouteParams & Parameter Precedence in filesApiRoutes", () => {
    const TARGET_FILE_ID = "550e8400-e29b-41d4-a716-446655440888";
    const mockFileRecord = {
      id: TARGET_FILE_ID,
      userId: TEST_USER.id,
      title: "Target File",
      content: "Sample content",
      isEncrypted: false,
      encryptionMetadata: null,
      etag: "etag_888",
      version: 1,
      parentFolderId: null,
      isFolder: false,
      deletedAt: null,
      updatedAt: new Date(),
      createdAt: new Date(),
    };

    it("resolves file ID using flat Hono context `{ id }`", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);

      const context: RouteParams = { id: TARGET_FILE_ID };
      const req = new Request("http://localhost/api/files/ignored-path");
      const res = await handleFileByIdGet(req, context);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(TARGET_FILE_ID);
      expect(mockFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.anything(),
        })
      );
    });

    it("resolves file ID using nested context `{ params: { id } }` for compatibility", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);

      const context: RouteParams = { params: { id: TARGET_FILE_ID } };
      const req = new Request("http://localhost/api/files/ignored-path");
      const res = await handleFileByIdGet(req, context);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(TARGET_FILE_ID);
    });

    it("resolves file ID using direct string context", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);

      const req = new Request("http://localhost/api/files/ignored-path");
      const res = await handleFileByIdGet(req, TARGET_FILE_ID as any);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(TARGET_FILE_ID);
    });

    it("falls back to URL pathname extraction when context is omitted or empty", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);

      // Context omitted -> extracts file ID from path
      const req = new Request(`http://localhost/api/files/${TARGET_FILE_ID}`);
      const res = await handleFileByIdGet(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(TARGET_FILE_ID);
    });

    it("routes GET /:id through filesApiRoutes Hono dispatcher and binds params", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);

      const res = await filesApiRoutes.request(`http://localhost/${TARGET_FILE_ID}`, {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(TARGET_FILE_ID);
    });

    it("routes PUT /:id through filesApiRoutes Hono dispatcher and executes update", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);
      mockUpdateReturning.mockResolvedValueOnce([
        {
          ...mockFileRecord,
          content: "Updated content",
          version: 2,
          etag: "etag_new_2",
          updatedAt: new Date(),
        },
      ]);

      const res = await filesApiRoutes.request(`http://localhost/${TARGET_FILE_ID}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": 'W/"etag_888"',
        },
        body: JSON.stringify({
          content: "Updated content",
          expectedVersion: 1,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(TARGET_FILE_ID);
      expect(body.version).toBe(2);
      expect(body.etag).toBe("etag_new_2");
    });

    it("routes DELETE /:id through filesApiRoutes Hono dispatcher and soft-deletes file", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);
      mockUpdateReturning.mockResolvedValueOnce([
        {
          ...mockFileRecord,
          deletedAt: new Date(),
        },
      ]);

      const res = await filesApiRoutes.request(`http://localhost/${TARGET_FILE_ID}`, {
        method: "DELETE",
        headers: {
          "If-Match": 'W/"etag_888"',
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.id).toBe(TARGET_FILE_ID);
    });

    it("executes handleFileByIdPut directly with RouteParams context for handler parity", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);
      mockUpdateReturning.mockResolvedValueOnce([
        {
          ...mockFileRecord,
          content: "Direct PUT content",
          version: 2,
          etag: "etag_direct_2",
          updatedAt: new Date(),
        },
      ]);

      const req = new Request(`http://localhost/api/files/${TARGET_FILE_ID}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": 'W/"etag_888"',
        },
        body: JSON.stringify({
          content: "Direct PUT content",
          expectedVersion: 1,
        }),
      });

      const res = await handleFileByIdPut(req, { id: TARGET_FILE_ID });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(TARGET_FILE_ID);
      expect(body.version).toBe(2);
      expect(body.etag).toBe("etag_direct_2");
    });

    it("executes handleFileByIdDelete directly with RouteParams context for handler parity", async () => {
      mockFindFirst.mockResolvedValueOnce(mockFileRecord);
      mockUpdateReturning.mockResolvedValueOnce([
        {
          ...mockFileRecord,
          deletedAt: new Date(),
        },
      ]);

      const req = new Request(`http://localhost/api/files/${TARGET_FILE_ID}`, {
        method: "DELETE",
        headers: {
          "If-Match": 'W/"etag_888"',
        },
      });

      const res = await handleFileByIdDelete(req, { id: TARGET_FILE_ID });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.id).toBe(TARGET_FILE_ID);
    });

    it("verifies filesApiRoutes is an instance of Hono and can be mounted onto parent Hono router", async () => {
      expect(filesApiRoutes).toBeInstanceOf(Hono);

      mockFindFirst.mockResolvedValueOnce(mockFileRecord);

      const parentApp = new Hono().route("/api/files", filesApiRoutes);
      const res = await parentApp.request(`http://localhost/api/files/${TARGET_FILE_ID}`, {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(TARGET_FILE_ID);
    });
  });
});
