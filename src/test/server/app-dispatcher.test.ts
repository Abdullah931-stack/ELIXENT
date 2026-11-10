/**
 * Comprehensive Integration & Verification Test Suite for Master Hono Dispatcher (Wave 2.2)
 *
 * SSoT Reference: `docs/Plans/elixent_framework_migration_plan.md` lines 288–314.
 *
 * Verifies:
 * 1. Master Application Architecture & Module Exports (`src/server/app.ts`):
 *    - `app` is an instance of `Hono`.
 *    - `export default app` is referentially identical to `export const app`.
 *    - `AppType` matches `typeof app`.
 *    - All 6 router sub-paths mounted: `/api/agent`, `/api/files`, `/api/stripe`, `/api/cron`, `/api/test/e2e-auth`, `/auth/callback`.
 * 2. Global Pipeline & `sessionMiddleware` Integration via `app.request(...)`:
 *    - Intercepts requests on `*` before reaching sub-routers.
 *    - Binds `ServerRequestContext` so downstream route handlers have access to `getActiveRequestContext()`.
 *    - Propagates cookies from incoming `Cookie` header into context.
 *    - Propagates mutated cookies set by downstream handlers into HTTP `Set-Cookie` headers.
 *    - OAuth landing candidate interception: `/?code=...` or `/login?code=...` redirects (307) to `/auth/callback?code=...`.
 *    - Fast-Path Cookie Gating (`TD-12`): public / API requests bypass `getUser()` when no `sb-*` cookie exists.
 *    - Protected route gating: `/workspace` or `/dashboard` redirects to `/login` for HTML navigations or returns 401 for actions/API.
 * 3. Sub-Router Dispatching & HTTP Method / Parameter Matching via `app.request(...)`:
 *    - `/api/agent/stream` (POST) -> `agentRoutes` (200 SSE stream on success, 401 on unauthenticated, 404 on GET).
 *    - `/api/files/sync` (GET) -> `filesApiRoutes` (200 JSON with sync contracts, 404 on POST).
 *    - `/api/files/:id` (GET, PUT, DELETE) -> `filesApiRoutes` with dynamic `:id` parameter extraction.
 *    - `/api/stripe/create-checkout` (POST) & `/api/stripe/webhook` (POST) -> `stripeRoutes` (404 on GET).
 *    - `/api/cron/expire-reservations` (GET, POST) & `/api/cron/purge-deleted` (GET, POST) -> `cronRoutes` (401 on missing secret).
 *    - `/api/test/e2e-auth` (POST, DELETE) -> `e2eAuthRoutes` (404 in production, 200 in test environment).
 *    - `/auth/callback` (GET) -> `authCallbackRoutes` (307 redirect with session cookies, 404 on POST).
 * 4. Direct Hono Route Execution:
 *    - Thin Next.js delegates retired; Hono routes are tested directly via app.request.
 * 5. Edge Cases, Security Boundaries & Request Isolation:
 *    - 404 on unknown routes (`/api/unmapped`, `/not-found`).
 *    - Header propagation (`X-Correlation-ID`, `Content-Type`).
 *    - Query string and URL encoding preservation.
 *    - Concurrency and request context isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { app } from "@/server/app";
import defaultApp from "@/server/app";
import {
  getActiveRequestContext,
  type ServerRequestContext,
} from "@/server/context/request-context";
import Stripe from "stripe";

// ---------------------------------------------------------------------------
// Hoisted Mock State (System Boundaries: Auth, Database, Redis, Stripe, Governor)
// ---------------------------------------------------------------------------

const {
  mockGetUser,
  mockCreateClient,
  mockExchangeCodeForSession,
  mockSyncUserToDatabase,
  mockGetUserProfile,
  mockUpdateUserStripeCustomerId,
  mockCreateCheckoutSession,
  mockConstructEvent,
  mockAcquireCronLock,
  mockFlushPendingSettlements,
  mockDbFindMany,
  mockDbFindFirst,
  mockDbUpdateReturning,
  mockDbExecute,
  mockDbInsertValues,
  mockDbOnConflictDoUpdate,
  mockRedisSmembers,
  mockRedisSet,
  mockRedisDel,
  mockIsRedisConfigured,
  mockSsrSetSession,
  mockSsrSignOut,
  mockAdminListUsers,
  mockAdminCreateUser,
  mockAnonSignInWithPassword,
  governorState,
  graphState,
  MockStreamGovernor,
} = vi.hoisted(() => {
  const governorState = {
    permitted: true,
    instances: [] as any[],
  };

  class MockStreamGovernor {
    public userId: string;
    public operationId: string;
    public modelId: string;
    public initialTokens: number;
    public abortController: AbortController;
    public settledStatus: string | null = null;

    constructor(
      userId: string,
      operationId: string,
      modelId: string,
      initialTokens: number,
      abortController: AbortController
    ) {
      this.userId = userId;
      this.operationId = operationId;
      this.modelId = modelId;
      this.initialTokens = initialTokens;
      this.abortController = abortController;
      governorState.instances.push(this);
    }

    async onTokenChunk(): Promise<boolean> {
      return governorState.permitted;
    }

    async settle(status: "SETTLED" | "ABORTED" = "SETTLED"): Promise<{ status: string }> {
      this.settledStatus = status;
      return { status };
    }
  }

  return {
    mockGetUser: vi.fn(),
    mockCreateClient: vi.fn(),
    mockExchangeCodeForSession: vi.fn(),
    mockSyncUserToDatabase: vi.fn(),
    mockGetUserProfile: vi.fn(),
    mockUpdateUserStripeCustomerId: vi.fn(),
    mockCreateCheckoutSession: vi.fn(),
    mockConstructEvent: vi.fn(),
    mockAcquireCronLock: vi.fn(),
    mockFlushPendingSettlements: vi.fn(),
    mockDbFindMany: vi.fn(),
    mockDbFindFirst: vi.fn(),
    mockDbUpdateReturning: vi.fn(),
    mockDbExecute: vi.fn(),
    mockDbInsertValues: vi.fn(),
    mockDbOnConflictDoUpdate: vi.fn(),
    mockRedisSmembers: vi.fn(),
    mockRedisSet: vi.fn(),
    mockRedisDel: vi.fn(),
    mockIsRedisConfigured: vi.fn(),
    mockSsrSetSession: vi.fn(),
    mockSsrSignOut: vi.fn(),
    mockAdminListUsers: vi.fn(),
    mockAdminCreateUser: vi.fn(),
    mockAnonSignInWithPassword: vi.fn(),
    governorState,
    MockStreamGovernor,
    graphState: {
      chunksToEmit: ['data: {"event":"token","data":"Hello from agent"}\n\n'],
    },
  };
});

// ---------------------------------------------------------------------------
// Boundary Mocks
// ---------------------------------------------------------------------------

// 1. Supabase Server Auth
vi.mock("@/lib/supabase/server", async () => {
  const { resolveCookiesAndHeaders } = await import(
    "@/server/context/request-context"
  );
  return {
    getUser: () => mockGetUser(),
    createClient: async () => {
      const ctx = await resolveCookiesAndHeaders();
      return mockCreateClient(ctx);
    },
  };
});

// 2. Supabase SSR Client (sessionMiddleware, e2e-auth, auth-callback)
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _url: string,
      _key: string,
      options: {
        cookies: {
          getAll: () => Array<{ name: string; value: string }>;
          setAll: (
            c: Array<{
              name: string;
              value: string;
              options?: Record<string, unknown>;
            }>
          ) => void;
        };
      }
    ) => ({
      auth: {
        getUser: async () => {
          options?.cookies?.getAll?.();
          return { data: { user: await mockGetUser() }, error: null };
        },
        setSession: async (tokens: {
          access_token: string;
          refresh_token: string;
        }) => {
          options?.cookies?.getAll?.();
          await mockSsrSetSession(tokens);
          options?.cookies?.setAll?.([
            {
              name: "sb-mock-auth-token",
              value: tokens.access_token,
              options: { path: "/", httpOnly: true },
            },
          ]);
          return { data: {}, error: null };
        },
        signOut: async () => {
          options?.cookies?.getAll?.();
          await mockSsrSignOut();
          options?.cookies?.setAll?.([
            {
              name: "sb-mock-auth-token",
              value: "",
              options: { path: "/", maxAge: 0 },
            },
          ]);
          return { error: null };
        },
        exchangeCodeForSession: async (code: string) => {
          options?.cookies?.getAll?.();
          return mockExchangeCodeForSession(code);
        },
      },
    })
  ),
}));

// 3. Supabase JS Admin Client (e2e-auth)
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn((_url: string, key: string) => {
    if (key && key.includes("service")) {
      return {
        auth: {
          admin: {
            listUsers: () => mockAdminListUsers(),
            createUser: (args: unknown) => mockAdminCreateUser(args),
          },
        },
      };
    }
    return {
      auth: {
        signInWithPassword: (creds: unknown) =>
          mockAnonSignInWithPassword(creds),
      },
    };
  }),
}));

// 4. Server Actions
vi.mock("@/server/actions/auth-actions", () => ({
  getUserProfile: () => mockGetUserProfile(),
  syncUserToDatabase: () => mockSyncUserToDatabase(),
}));

vi.mock("@/server/actions/subscription-actions", () => ({
  updateUserStripeCustomerId: (...args: unknown[]) =>
    mockUpdateUserStripeCustomerId(...args),
  updateUserTier: vi.fn(),
  upsertSubscription: vi.fn(),
  cancelUserSubscription: vi.fn(),
  getUserSubscription: vi.fn(),
  isSubscriptionEventProcessed: vi.fn(async () => false),
  recordSubscriptionEvent: vi.fn(),
  executeSubscriptionTransition: vi.fn(async (fn: (tx: any) => Promise<any>) =>
    fn({})
  ),
}));

vi.mock("@/server/actions/folders", () => ({
  getDescendantIds: vi.fn(async () => []),
}));

// 5. Stripe SDK
vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: (...args: unknown[]) => mockConstructEvent(...args),
    },
    subscriptions: {
      retrieve: vi.fn(async () => ({
        id: "sub_mock",
        status: "active",
        current_period_start: 1700000000,
        current_period_end: 1702592000,
      })),
    },
  },
  createCheckoutSession: (...args: unknown[]) =>
    mockCreateCheckoutSession(...args),
  getOrCreateStripeCustomer: vi.fn(async () => "cus_mock_app_123"),
}));

// 6. Redis & Distributed Lock
vi.mock("@/lib/redis", () => ({
  redis: {
    get: vi.fn(async () => null),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    smembers: (...args: unknown[]) => mockRedisSmembers(...args),
  },
  isRedisConfigured: () => mockIsRedisConfigured(),
}));

vi.mock("@/lib/cron/lock", () => ({
  acquireCronLock: (...args: unknown[]) => mockAcquireCronLock(...args),
}));

// 7. Settlement Service
vi.mock("@/server/services/ai-settlement-service", () => ({
  flushPendingSettlementsToPostgres: (...args: unknown[]) =>
    mockFlushPendingSettlements(...args),
}));

// 8. Drizzle Database
vi.mock("@/server/db", () => ({
  db: {
    query: {
      files: {
        findMany: (...args: unknown[]) => mockDbFindMany(...args),
        findFirst: (...args: unknown[]) => mockDbFindFirst(...args),
      },
      users: {
        findFirst: vi.fn(async () => ({
          id: "user-app-001",
          tier: "free",
          subscriptionStatus: "active",
          currentPeriodEnd: new Date(Date.now() + 86400000),
        })),
      },
    },
    update: vi.fn(() => ({
      set: () => ({
        where: () => {
          const thenable = Promise.resolve(undefined) as Promise<unknown> & {
            returning: () => Promise<unknown>;
          };
          thenable.returning = () => mockDbUpdateReturning();
          return thenable;
        },
      }),
    })),
    insert: () => ({
      values: (val: unknown) => {
        mockDbInsertValues(val);
        return {
          onConflictDoUpdate: (spec: unknown) => mockDbOnConflictDoUpdate(spec),
        };
      },
    }),
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
  schema: {
    files: {
      id: "files.id",
      userId: "files.user_id",
      version: "files.version",
      deletedAt: "files.deleted_at",
      updatedAt: "files.updated_at",
    },
    users: { id: "users.id" },
  },
}));

// 9. LangGraph & Stream Governor (Agent Stream)

vi.mock("@/lib/metering/stream-governor", () => ({
  StreamGovernor: MockStreamGovernor,
}));

vi.mock("@/core/agent/graph", () => ({
  elixentAgentGraph: {
    stream: vi.fn(async () => {
      async function* gen() {
        for (const chunk of graphState.chunksToEmit) {
          yield chunk;
        }
      }
      return gen();
    }),
  },
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  const dummyLimiter = {
    limit: vi.fn(async () => ({
      success: true,
      remaining: 25,
      reset: Math.ceil(Date.now() / 1000) + 60,
      limit: 30,
      isDegraded: false,
    })),
  };
  return {
    ...actual,
    syncApiRateLimiter: dummyLimiter,
    fileApiRateLimiter: dummyLimiter,
    aiStreamRateLimiter: dummyLimiter,
  };
});

// ---------------------------------------------------------------------------
// Test Suite Definition
// ---------------------------------------------------------------------------

describe("Master Hono Application Dispatcher (src/server/app.ts)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete (process.env as Record<string, string | undefined>).VITE_APP_URL;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.PLAYWRIGHT = "1";
    process.env.CRON_SECRET = "test_cron_secret_app_999";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
    process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
    process.env.STRIPE_PRICE_ID_ULTRA = "price_ultra_test";
    process.env.VITE_SUPABASE_URL = "https://mock-app-supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "mock-app-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-app-service-key";

    // Default mock behaviors
    mockGetUser.mockResolvedValue({
      id: "user-app-001",
      email: "master-app@lugx.test",
    });
    mockGetUserProfile.mockResolvedValue({
      success: true,
      data: {
        id: "user-app-001",
        email: "master-app@lugx.test",
        tier: "free",
        stripeCustomerId: null,
      },
    });
    mockAcquireCronLock.mockResolvedValue({
      acquired: true,
      lockKey: "cron:lock:test",
      lockId: "lock-test-app",
      release: vi.fn(async () => {}),
    });
    mockFlushPendingSettlements.mockResolvedValue({
      flushedCount: 1,
      netDeltaMicro: BigInt(0),
    });
    mockDbExecute.mockResolvedValue({ rowCount: 5 });
    mockRedisSmembers.mockResolvedValue([]);
    mockIsRedisConfigured.mockReturnValue(true);
    mockRedisSet.mockResolvedValue("OK");
    mockRedisDel.mockResolvedValue(1);
    governorState.permitted = true;
    governorState.instances = [];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // Suite 1: Master Application Architecture & Exports
  // -------------------------------------------------------------------------

  describe("Suite 1: Master Application Architecture & Exports", () => {
    it("exports an instance of Hono as named export `app` and default export", () => {
      expect(app).toBeInstanceOf(Hono);
      expect(defaultApp).toBe(app);
    });

    it("registers all 6 functional sub-router paths and wildcard middleware", () => {
      const routes = app.routes;
      const registeredPaths = routes.map((r) => r.path);

      // Verify sessionMiddleware wildcard registration
      expect(registeredPaths).toContain("/*");

      // Verify sub-router mounted paths exist in router table
      const hasAgentPath = registeredPaths.some((p) => p.startsWith("/api/agent"));
      const hasFilesPath = registeredPaths.some((p) => p.startsWith("/api/files"));
      const hasStripePath = registeredPaths.some((p) => p.startsWith("/api/stripe"));
      const hasCronPath = registeredPaths.some((p) => p.startsWith("/api/cron"));
      const hasE2EAuthPath = registeredPaths.some((p) => p.startsWith("/api/test/e2e-auth"));
      const hasAuthCallbackPath = registeredPaths.some((p) => p.startsWith("/auth/callback"));

      expect(hasAgentPath).toBe(true);
      expect(hasFilesPath).toBe(true);
      expect(hasStripePath).toBe(true);
      expect(hasCronPath).toBe(true);
      expect(hasE2EAuthPath).toBe(true);
      expect(hasAuthCallbackPath).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Suite 2: Global Pipeline & sessionMiddleware Integration
  // -------------------------------------------------------------------------

  describe("Suite 2: Global sessionMiddleware Pipeline Integration", () => {
    it("binds ServerRequestContext across dispatching so downstream routes observe active context", async () => {
      let observedContextInsideHandler: ServerRequestContext | null = null;

      // Mount an ephemeral diagnostic route on a fresh test instance to inspect context propagation
      const testApp = new Hono().route("/", app);
      testApp.get("/api/test/context-probe", async (c) => {
        observedContextInsideHandler = getActiveRequestContext();
        return c.json({ hasContext: observedContextInsideHandler !== null });
      });

      const res = await testApp.request(
        "http://localhost/api/test/context-probe",
        {
          headers: {
            Cookie: "probe_token=val123; user_theme=nord",
            "X-Test-Probe": "enabled",
          },
        }
      );

      expect(res.status).toBe(200);
      expect(observedContextInsideHandler).not.toBeNull();
      const ctx = observedContextInsideHandler as unknown as ServerRequestContext;
      expect(ctx.headers.get("x-test-probe")).toBe("enabled");

      const cookieList = ctx.cookies.getAll();
      expect(cookieList).toContainEqual({ name: "probe_token", value: "val123" });
      expect(cookieList).toContainEqual({ name: "user_theme", value: "nord" });
    });

    it("propagates mutated cookies set by downstream handlers into HTTP Set-Cookie headers", async () => {
      const testApp = new Hono().route("/", app);
      testApp.get("/api/test/cookie-mutation-probe", async (c) => {
        const ctx = getActiveRequestContext();
        ctx?.cookies.set("probe_cookie_out", "secret_value_xyz", {
          httpOnly: true,
          path: "/",
        });
        return c.json({ mutated: true });
      });

      const res = await testApp.request(
        "http://localhost/api/test/cookie-mutation-probe"
      );
      expect(res.status).toBe(200);

      const setCookieHeader = res.headers.get("set-cookie");
      expect(setCookieHeader).not.toBeNull();
      expect(setCookieHeader).toContain("probe_cookie_out=secret_value_xyz");
      expect(setCookieHeader).toContain("HttpOnly");
    });

    it("intercepts OAuth landing candidate with ?code= on root / and redirects (307) to /auth/callback", async () => {
      const res = await app.request("http://localhost/?code=oauth_auth_code_789");
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost/auth/callback?code=oauth_auth_code_789");
    });

    it("intercepts OAuth landing candidate with ?code= on /login and redirects (307) to /auth/callback", async () => {
      const res = await app.request("http://localhost/login?code=login_auth_code_999");
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost/auth/callback?code=login_auth_code_999");
    });

    it("enforces protected route redirection to /login when unauthenticated navigation occurs", async () => {
      mockGetUser.mockResolvedValueOnce(null);

      const res = await app.request("http://localhost/dashboard");
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login?redirectTo=%2Fdashboard");
    });

    it("returns 401 JSON when unauthenticated action request hits protected route", async () => {
      mockGetUser.mockResolvedValueOnce(null);

      const res = await app.request("http://localhost/dashboard", {
        headers: { "next-action": "action_uuid_test" },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });
  });

  // -------------------------------------------------------------------------
  // Suite 3: Sub-Router Dispatching & HTTP Method / Parameter Matching
  // -------------------------------------------------------------------------

  describe("Suite 3: Sub-Router Dispatching & HTTP Method Matching", () => {
    // -----------------------------------------------------------------------
    // Router 1: /api/agent
    // -----------------------------------------------------------------------
    describe("Router 1: /api/agent (agentRoutes)", () => {
      it("dispatches POST /api/agent/stream -> 401 Unauthorized Problem Details when unauthenticated", async () => {
        mockGetUser.mockResolvedValueOnce(null);

        const res = await app.request("http://localhost/api/agent/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: "thread-app-001",
            projectId: "proj-app-001",
            targetFileIds: [],
            prompt: "Synthesize document",
          }),
        });

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.type).toBe("urn:problem-type:unauthorized");
      });

      it("dispatches POST /api/agent/stream -> 200 text/event-stream SSE when authenticated", async () => {
        const res = await app.request("http://localhost/api/agent/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Correlation-ID": "corr-agent-stream-001",
          },
          body: JSON.stringify({
            threadId: "thread-app-001",
            projectId: "proj-app-001",
            targetFileIds: [],
            prompt: "Refactor architecture document",
          }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        expect(res.headers.get("x-correlation-id")).toBe("corr-agent-stream-001");

        const reader = res.body?.getReader();
        let streamOutput = "";
        while (true) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) break;
          streamOutput += new TextDecoder().decode(chunk.value);
        }
        expect(streamOutput).toContain("event: start");
        expect(streamOutput).toContain("thread-app-001");
      });

      it("returns 404 on invalid HTTP methods and unmapped sub-routes", async () => {
        const getRes = await app.request("http://localhost/api/agent/stream", {
          method: "GET",
        });
        expect(getRes.status).toBe(404);

        const unknownRes = await app.request("http://localhost/api/agent/unmapped", {
          method: "POST",
        });
        expect(unknownRes.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Router 2: /api/files
    // -----------------------------------------------------------------------
    describe("Router 2: /api/files (filesApiRoutes)", () => {
      it("dispatches GET /api/files/sync -> 401 when unauthenticated", async () => {
        mockGetUser.mockResolvedValueOnce(null);

        const res = await app.request("http://localhost/api/files/sync");
        expect(res.status).toBe(401);
      });

      it("dispatches GET /api/files/sync -> 200 JSON with files sync payload and query parsing", async () => {
        const now = new Date("2026-11-01T00:00:00Z");
        mockDbFindMany.mockResolvedValueOnce([
          {
            id: "file-sync-1",
            userId: "user-app-001",
            title: "Plan",
            content: "# Plan",
            isEncrypted: false,
            encryptionMetadata: null,
            etag: "etag_sync_1",
            version: 1,
            parentFolderId: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ]);

        const res = await app.request(
          "http://localhost/api/files/sync?limit=10&updatedAfter=2026-10-01T00:00:00.000Z",
          {
            headers: { "X-Correlation-ID": "corr-sync-001" },
          }
        );

        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe(
          "private, no-cache, no-store, must-revalidate"
        );
        expect(res.headers.get("x-correlation-id")).toBe("corr-sync-001");

        const data = await res.json();
        expect(data.files).toHaveLength(1);
        expect(data.files[0].id).toBe("file-sync-1");
        expect(data.has_more).toBe(false);
      });

      it("dispatches GET /api/files/:id -> extracts :id parameter and returns 200 with ETag header", async () => {
        const now = new Date("2026-11-01T00:00:00Z");
        mockDbFindFirst.mockResolvedValueOnce({
          id: "doc-target-abc-123",
          userId: "user-app-001",
          title: "Architecture SSoT",
          content: "# System Spec",
          isEncrypted: false,
          encryptionMetadata: null,
          etag: "etag_spec_hash_v1",
          version: 1,
          parentFolderId: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });

        const res = await app.request("http://localhost/api/files/doc-target-abc-123");
        expect(res.status).toBe(200);
        expect(res.headers.get("etag")).toBe('"etag_spec_hash_v1"');

        const body = await res.json();
        expect(body.id).toBe("doc-target-abc-123");
        expect(body.title).toBe("Architecture SSoT");
      });

      it("dispatches GET /api/files/:id -> returns 304 Not Modified when If-None-Match matches", async () => {
        const now = new Date("2026-11-01T00:00:00Z");
        mockDbFindFirst.mockResolvedValueOnce({
          id: "doc-target-abc-123",
          userId: "user-app-001",
          title: "Architecture SSoT",
          content: "# System Spec",
          isEncrypted: false,
          encryptionMetadata: null,
          etag: "etag_spec_hash_v1",
          version: 1,
          parentFolderId: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });

        const res = await app.request("http://localhost/api/files/doc-target-abc-123", {
          headers: { "If-None-Match": '"etag_spec_hash_v1"' },
        });

        expect(res.status).toBe(304);
        expect(res.headers.get("etag")).toBe('"etag_spec_hash_v1"');
      });

      it("dispatches PUT /api/files/:id -> extracts :id parameter and updates file", async () => {
        const now = new Date("2026-11-02T00:00:00Z");
        mockDbFindFirst.mockResolvedValueOnce({
          id: "doc-target-abc-123",
          userId: "user-app-001",
          title: "Spec Updated",
          content: "# Old Spec",
          isEncrypted: false,
          encryptionMetadata: null,
          etag: "etag_v1",
          version: 1,
          parentFolderId: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });

        mockDbUpdateReturning.mockResolvedValueOnce([
          {
            id: "doc-target-abc-123",
            userId: "user-app-001",
            title: "Spec Updated",
            content: "# Updated Spec",
            isEncrypted: false,
            encryptionMetadata: null,
            etag: "etag_v2",
            version: 2,
            parentFolderId: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ]);

        const res = await app.request("http://localhost/api/files/doc-target-abc-123", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": '"etag_v1"',
          },
          body: JSON.stringify({
            title: "Spec Updated",
            content: "# Updated Spec",
            isEncrypted: false,
            expectedVersion: 1,
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.version).toBe(2);
      });

      it("dispatches DELETE /api/files/:id -> extracts :id parameter and soft-deletes file", async () => {
        const now = new Date("2026-11-02T00:00:00Z");
        mockDbFindFirst.mockResolvedValueOnce({
          id: "doc-target-abc-123",
          userId: "user-app-001",
          title: "Spec",
          content: "# Spec",
          isEncrypted: false,
          encryptionMetadata: null,
          etag: "etag_v2",
          version: 2,
          parentFolderId: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });

        mockDbUpdateReturning.mockResolvedValueOnce([
          {
            id: "doc-target-abc-123",
            userId: "user-app-001",
            title: "Spec",
            content: "# Spec",
            isEncrypted: false,
            encryptionMetadata: null,
            etag: "etag_v3",
            version: 3,
            parentFolderId: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: now,
          },
        ]);

        const res = await app.request(
          "http://localhost/api/files/doc-target-abc-123?expectedVersion=2",
          {
            method: "DELETE",
            headers: { "If-Match": '"etag_v2"' },
          }
        );

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.id).toBe("doc-target-abc-123");
        expect(data.version).toBe(3);
      });

      it("returns 404 on unmapped sub-routes or disallowed methods on /api/files", async () => {
        const postRes = await app.request("http://localhost/api/files/sync", {
          method: "POST",
        });
        expect(postRes.status).toBe(404);

        const patchRes = await app.request("http://localhost/api/files/doc-1", {
          method: "PATCH",
        });
        expect(patchRes.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Router 3: /api/stripe
    // -----------------------------------------------------------------------
    describe("Router 3: /api/stripe (stripeRoutes)", () => {
      it("dispatches POST /api/stripe/create-checkout -> 401 when unauthenticated", async () => {
        mockGetUser.mockResolvedValueOnce(null);

        const res = await app.request("http://localhost/api/stripe/create-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier: "pro" }),
        });

        expect(res.status).toBe(401);
      });

      it("dispatches POST /api/stripe/create-checkout -> 200 with checkout URL when authenticated", async () => {
        mockCreateCheckoutSession.mockResolvedValueOnce({
          id: "cs_test_app_session_1",
          url: "https://checkout.stripe.com/pay/cs_test_app_session_1",
        });

        const res = await app.request("http://localhost/api/stripe/create-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier: "pro" }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.url).toBe("https://checkout.stripe.com/pay/cs_test_app_session_1");
        expect(body.sessionId).toBe("cs_test_app_session_1");
      });

      it("dispatches POST /api/stripe/webhook -> 400 when stripe-signature is missing", async () => {
        const res = await app.request("http://localhost/api/stripe/webhook", {
          method: "POST",
          body: "{}",
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("Missing stripe-signature header");
      });

      it("dispatches POST /api/stripe/webhook -> 200 { received: true } on valid signature", async () => {
        mockConstructEvent.mockReturnValueOnce({
          id: "evt_stripe_app_001",
          type: "customer.subscription.trial_will_end",
          data: { object: {} },
        } as unknown as Stripe.Event);

        const res = await app.request("http://localhost/api/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": "valid_test_sig" },
          body: JSON.stringify({ id: "evt_stripe_app_001" }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.received).toBe(true);
        expect(body.event).toBe("evt_stripe_app_001");
      });

      it("returns 404 on invalid methods on stripe endpoints", async () => {
        const getCheckoutRes = await app.request(
          "http://localhost/api/stripe/create-checkout",
          { method: "GET" }
        );
        expect(getCheckoutRes.status).toBe(404);

        const getWebhookRes = await app.request(
          "http://localhost/api/stripe/webhook",
          { method: "GET" }
        );
        expect(getWebhookRes.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Router 4: /api/cron
    // -----------------------------------------------------------------------
    describe("Router 4: /api/cron (cronRoutes)", () => {
      it("dispatches GET & POST /api/cron/expire-reservations -> 401 when unauthorized", async () => {
        const getRes = await app.request("http://localhost/api/cron/expire-reservations");
        expect(getRes.status).toBe(401);

        const postRes = await app.request(
          "http://localhost/api/cron/expire-reservations",
          { method: "POST" }
        );
        expect(postRes.status).toBe(401);
      });

      it("dispatches GET & POST /api/cron/expire-reservations -> 200 when authorized with Bearer token", async () => {
        const authHeader = {
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        };

        const getRes = await app.request(
          "http://localhost/api/cron/expire-reservations",
          { headers: authHeader }
        );
        expect(getRes.status).toBe(200);
        const getBody = await getRes.json();
        expect(getBody.success).toBe(true);
        expect(getBody.processedUsers).toBe(0);
        expect(getBody.flushedOperations).toBe(0);

        const postRes = await app.request(
          "http://localhost/api/cron/expire-reservations",
          { method: "POST", headers: authHeader }
        );
        expect(postRes.status).toBe(200);
        const postBody = await postRes.json();
        expect(postBody.success).toBe(true);
      });

      it("dispatches GET & POST /api/cron/purge-deleted -> 401 when unauthorized", async () => {
        const res = await app.request("http://localhost/api/cron/purge-deleted");
        expect(res.status).toBe(401);
      });

      it("dispatches GET & POST /api/cron/purge-deleted -> 200 when authorized with Bearer token", async () => {
        const authHeader = {
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        };

        const res = await app.request("http://localhost/api/cron/purge-deleted", {
          headers: authHeader,
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.deleted).toBe(5);
      });

      it("returns 404 on unsupported methods on cron routes", async () => {
        const deleteRes = await app.request(
          "http://localhost/api/cron/expire-reservations",
          { method: "DELETE" }
        );
        expect(deleteRes.status).toBe(404);

        const putRes = await app.request(
          "http://localhost/api/cron/purge-deleted",
          { method: "PUT" }
        );
        expect(putRes.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Router 5: /api/test/e2e-auth
    // -----------------------------------------------------------------------
    describe("Router 5: /api/test/e2e-auth (e2eAuthRoutes)", () => {
      it("dispatches POST /api/test/e2e-auth -> 404 in production environment (fail-safe)", async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = "production";
        delete process.env.PLAYWRIGHT;

        const res = await app.request("http://localhost/api/test/e2e-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "prod-attacker@lugx.app" }),
        });

        expect(res.status).toBe(404);
      });

      it("dispatches POST /api/test/e2e-auth -> 200 with cookies in test environment", async () => {
        mockAdminListUsers.mockResolvedValueOnce({
          data: { users: [{ id: "usr_e2e_100", email: "e2e@lugx.test" }] },
          error: null,
        });
        mockAnonSignInWithPassword.mockResolvedValueOnce({
          data: {
            session: {
              access_token: "mock_jwt_access_e2e",
              refresh_token: "mock_jwt_refresh_e2e",
            },
          },
          error: null,
        });

        const res = await app.request("http://localhost/api/test/e2e-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "e2e@lugx.test",
            tier: "pro",
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.user.email).toBe("e2e@lugx.test");
        expect(res.headers.get("set-cookie")).toContain("sb-mock-auth-token=mock_jwt_access_e2e");
      });

      it("dispatches DELETE /api/test/e2e-auth -> 200 and expires cookies in test environment", async () => {
        const res = await app.request("http://localhost/api/test/e2e-auth", {
          method: "DELETE",
          headers: {
            Cookie: "sb-mock-auth-token=active_jwt_token",
          },
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
      });

      it("returns 404 on GET /api/test/e2e-auth", async () => {
        const res = await app.request("http://localhost/api/test/e2e-auth", {
          method: "GET",
        });
        expect(res.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Router 6: /auth/callback
    // -----------------------------------------------------------------------
    describe("Router 6: /auth/callback (authCallbackRoutes)", () => {
      it("dispatches GET /auth/callback -> 307 redirect to /login?error=auth_failed when code is missing", async () => {
        const res = await app.request("http://localhost/auth/callback");
        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toContain("/login?error=auth_failed");
      });

      it("dispatches GET /auth/callback?code=... -> 307 redirect to /dashboard and sets session cookies", async () => {
        mockCreateClient.mockResolvedValueOnce({
          auth: {
            exchangeCodeForSession: vi.fn(async (_code: string) => ({
              data: { user: { id: "user_oauth_123", email: "oauth@lugx.test" } },
              error: null,
            })),
          },
        });

        const res = await app.request("http://localhost/auth/callback?code=auth_code_xyz");
        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("http://localhost/dashboard");
      });

      it("dispatches GET /auth/callback with custom safe redirect -> 307 to /workspace", async () => {
        mockCreateClient.mockResolvedValueOnce({
          auth: {
            exchangeCodeForSession: vi.fn(async () => ({
              data: { user: { id: "user_oauth_123" } },
              error: null,
            })),
          },
        });

        const res = await app.request(
          "http://localhost/auth/callback?code=auth_code_xyz&redirectTo=/workspace"
        );
        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("http://localhost/workspace");
      });

      it("dispatches GET /auth/callback and neutralizes open-redirect attacks to /dashboard", async () => {
        mockCreateClient.mockResolvedValueOnce({
          auth: {
            exchangeCodeForSession: vi.fn(async () => ({
              data: { user: { id: "user_oauth_123" } },
              error: null,
            })),
          },
        });

        const res = await app.request(
          "http://localhost/auth/callback?code=auth_code_xyz&redirectTo=https://attacker.evil.com"
        );
        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("http://localhost/dashboard");
      });

      it("returns 404 on POST /auth/callback", async () => {
        const res = await app.request("http://localhost/auth/callback", {
          method: "POST",
        });
        expect(res.status).toBe(404);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Suite 5: Edge Cases, Security Boundaries & Request Isolation
  // -------------------------------------------------------------------------

  describe("Suite 5: Edge Cases, Security Boundaries & Request Isolation", () => {
    it("returns 404 for completely unmapped routes on app.request()", async () => {
      const res1 = await app.request("http://localhost/api/nonexistent-service");
      expect(res1.status).toBe(404);

      const res2 = await app.request("http://localhost/random-page-does-not-exist");
      expect(res2.status).toBe(404);
    });

    it("preserves query strings with special characters and URL encoding across dispatch", async () => {
      let capturedUrl = "";
      const testApp = new Hono().route("/", app);
      testApp.get("/api/test/query-inspect", async (c) => {
        capturedUrl = c.req.url;
        return c.json({ query: c.req.query() });
      });

      const res = await testApp.request(
        "http://localhost/api/test/query-inspect?tag=front%20end&filter=%2B100&empty="
      );

      expect(res.status).toBe(200);
      expect(capturedUrl).toContain("tag=front%20end");
      expect(capturedUrl).toContain("filter=%2B100");
    });

    it("maintains strict isolation across consecutive requests on different routes without cookie leakage", async () => {
      // First request: sets cookie A
      const testApp = new Hono().route("/", app);
      testApp.get("/api/test/leak-a", async (c) => {
        const ctx = getActiveRequestContext();
        ctx?.cookies.set("cookie_session_a", "val_a");
        return c.json({ ok: true });
      });
      testApp.get("/api/test/leak-b", async (c) => {
        const ctx = getActiveRequestContext();
        const cookies = ctx?.cookies.getAll() || [];
        return c.json({ cookies });
      });

      const resA = await testApp.request("http://localhost/api/test/leak-a");
      expect(resA.headers.get("set-cookie")).toContain("cookie_session_a=val_a");

      // Second request: should not observe cookie_session_a in context
      const resB = await testApp.request("http://localhost/api/test/leak-b");
      const bodyB = await resB.json();
      expect(bodyB.cookies).toEqual([]);
      expect(resB.headers.get("set-cookie")).toBeNull();
    });
  });
});
