/**
 * Comprehensive Unit & Edge-Case Test Suite for Web-Standard Hono Route Modules (Wave 2.1 - Part B):
 * 1. `src/server/routes/stripe.routes.ts` (`handleStripeCreateCheckoutPost`, `handleStripeWebhookPost`, `stripeRoutes`)
 * 2. `src/server/routes/cron.routes.ts` (`handleExpireReservationsCron`, `handlePurgeDeletedCron`, `cronRoutes`)
 * 3. `src/server/routes/auth-callback.routes.ts` (`handleAuthCallbackGet`, `authCallbackRoutes`)
 * 4. `src/server/routes/e2e-auth.routes.ts` (`handleE2EAuthPost`, `handleE2EAuthDelete`, `e2eAuthRoutes`)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Stripe from "stripe";
import {
  createInMemoryCookieStore,
  runWithServerRequestContext,
  type ServerRequestContext,
} from "@/server/context/request-context";
import { __resetProcessedEventIds } from "@/lib/stripe/webhook-dedupe";
import { MeteringServiceUnavailableError } from "@/lib/metering/lua-scripts";

// ---------------------------------------------------------------------------
// Hoisted Mock State (System Boundaries Only)
// ---------------------------------------------------------------------------

const {
  mockGetUser,
  mockCreateClient,
  mockExchangeCodeForSession,
  mockSyncUserToDatabase,
  mockGetUserProfile,
  mockUpdateUserStripeCustomerId,
  mockUpdateUserTier,
  mockUpsertSubscription,
  mockCancelUserSubscription,
  mockGetUserSubscription,
  mockIsSubscriptionEventProcessed,
  mockRecordSubscriptionEvent,
  mockExecuteSubscriptionTransition,
  mockConstructEvent,
  mockSubscriptionsRetrieve,
  mockGetOrCreateStripeCustomer,
  mockCreateCheckoutSession,
  mockRecordCreditTopup,
  mockResolveUserId,
  mockExecuteStripeDualWrite,
  mockRedisGet,
  mockRedisSet,
  mockRedisDel,
  mockRedisSmembers,
  mockIsRedisConfigured,
  mockAcquireCronLock,
  mockFlushPendingSettlements,
  mockDbExecute,
  mockDbInsertValues,
  mockDbOnConflictDoUpdate,
  mockSsrSetSession,
  mockSsrSignOut,
  mockSsrCookiesSetOnSession,
  mockAdminListUsers,
  mockAdminCreateUser,
  mockAnonSignInWithPassword,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockCreateClient: vi.fn(),
  mockExchangeCodeForSession: vi.fn(),
  mockSyncUserToDatabase: vi.fn(),
  mockGetUserProfile: vi.fn(),
  mockUpdateUserStripeCustomerId: vi.fn(),
  mockUpdateUserTier: vi.fn(),
  mockUpsertSubscription: vi.fn(),
  mockCancelUserSubscription: vi.fn(),
  mockGetUserSubscription: vi.fn(),
  mockIsSubscriptionEventProcessed: vi.fn(),
  mockRecordSubscriptionEvent: vi.fn(),
  mockExecuteSubscriptionTransition: vi.fn(),
  mockConstructEvent: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
  mockGetOrCreateStripeCustomer: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockRecordCreditTopup: vi.fn(),
  mockResolveUserId: vi.fn(),
  mockExecuteStripeDualWrite: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockRedisSmembers: vi.fn(),
  mockIsRedisConfigured: vi.fn(),
  mockAcquireCronLock: vi.fn(),
  mockFlushPendingSettlements: vi.fn(),
  mockDbExecute: vi.fn(),
  mockDbInsertValues: vi.fn(),
  mockDbOnConflictDoUpdate: vi.fn(),
  mockSsrSetSession: vi.fn(),
  mockSsrSignOut: vi.fn(),
  mockSsrCookiesSetOnSession: [] as Array<{
    name: string;
    value: string;
    options?: Record<string, unknown>;
  }>,
  mockAdminListUsers: vi.fn(),
  mockAdminCreateUser: vi.fn(),
  mockAnonSignInWithPassword: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module Mocks
// ---------------------------------------------------------------------------

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

vi.mock("@/server/actions/auth-actions", () => ({
  getUserProfile: () => mockGetUserProfile(),
  syncUserToDatabase: () => mockSyncUserToDatabase(),
}));

vi.mock("@/server/actions/subscription-actions", () => ({
  updateUserStripeCustomerId: (...args: unknown[]) =>
    mockUpdateUserStripeCustomerId(...args),
  updateUserTier: (...args: unknown[]) => mockUpdateUserTier(...args),
  upsertSubscription: (...args: unknown[]) => mockUpsertSubscription(...args),
  cancelUserSubscription: (...args: unknown[]) =>
    mockCancelUserSubscription(...args),
  getUserSubscription: (...args: unknown[]) => mockGetUserSubscription(...args),
  isSubscriptionEventProcessed: (...args: unknown[]) =>
    mockIsSubscriptionEventProcessed(...args),
  recordSubscriptionEvent: (...args: unknown[]) =>
    mockRecordSubscriptionEvent(...args),
  executeSubscriptionTransition: (fn: (tx: unknown) => Promise<unknown>) =>
    mockExecuteSubscriptionTransition(fn),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: (...args: unknown[]) => mockConstructEvent(...args),
    },
    subscriptions: {
      retrieve: (...args: unknown[]) => mockSubscriptionsRetrieve(...args),
    },
  },
  getOrCreateStripeCustomer: (...args: unknown[]) =>
    mockGetOrCreateStripeCustomer(...args),
  createCheckoutSession: (...args: unknown[]) =>
    mockCreateCheckoutSession(...args),
}));

vi.mock("@/server/services/billing-service", () => ({
  BillingService: {
    recordCreditTopup: (...args: unknown[]) => mockRecordCreditTopup(...args),
    resolveUserId: (...args: unknown[]) => mockResolveUserId(...args),
  },
}));

vi.mock("@/lib/metering/lua-scripts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/metering/lua-scripts")>();
  return {
    ...actual,
    executeStripeDualWrite: (...args: unknown[]) =>
      mockExecuteStripeDualWrite(...args),
  };
});

vi.mock("@/lib/redis", () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
    smembers: (...args: unknown[]) => mockRedisSmembers(...args),
  },
  isRedisConfigured: () => mockIsRedisConfigured(),
}));

vi.mock("@/lib/cron/lock", () => ({
  acquireCronLock: (...args: unknown[]) => mockAcquireCronLock(...args),
}));

vi.mock("@/server/services/ai-settlement-service", () => ({
  flushPendingSettlementsToPostgres: (...args: unknown[]) =>
    mockFlushPendingSettlements(...args),
}));

vi.mock("@/server/db", () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
    insert: () => ({
      values: (val: unknown) => {
        mockDbInsertValues(val);
        return {
          onConflictDoUpdate: (conflictSpec: unknown) =>
            mockDbOnConflictDoUpdate(conflictSpec),
        };
      },
    }),
  },
  schema: {
    users: { id: "users.id" },
  },
}));

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
        setSession: async (tokens: {
          access_token: string;
          refresh_token: string;
        }) => {
          options.cookies.getAll();
          await mockSsrSetSession(tokens);
          options.cookies.setAll(mockSsrCookiesSetOnSession);
          return { data: {}, error: null };
        },
        signOut: async () => {
          options.cookies.getAll();
          await mockSsrSignOut();
          options.cookies.setAll([
            {
              name: "sb-ssr-signout-marker",
              value: "",
              options: { path: "/", maxAge: 0 },
            },
          ]);
          return { error: null };
        },
      },
    })
  ),
}));

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

// Import route modules under test AFTER mocks
import {
  handleStripeCreateCheckoutPost,
  handleStripeWebhookPost,
  stripeRoutes,
} from "@/server/routes/stripe.routes";
import {
  handleExpireReservationsCron,
  handlePurgeDeletedCron,
  cronRoutes,
} from "@/server/routes/cron.routes";
import {
  handleAuthCallbackGet,
  authCallbackRoutes,
} from "@/server/routes/auth-callback.routes";
import {
  handleE2EAuthPost,
  handleE2EAuthDelete,
  e2eAuthRoutes,
} from "@/server/routes/e2e-auth.routes";

// ===========================================================================
// 1. STRIPE ROUTES (`src/server/routes/stripe.routes.ts`)
// ===========================================================================

describe("Stripe Route Module (src/server/routes/stripe.routes.ts)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetProcessedEventIds();
    process.env = {
      ...ORIGINAL_ENV,
      STRIPE_PRO_PRICE_ID: "price_pro_test_123",
      STRIPE_ULTRA_PRICE_ID: "price_ultra_test_456",
      STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
    };

    mockGetUser.mockResolvedValue({ id: "user-stripe-1", email: "u@lugx.app" });
    mockGetUserProfile.mockResolvedValue({
      success: true,
      data: {
        id: "user-stripe-1",
        email: "u@lugx.app",
        displayName: "Stripe Tester",
        tier: "free",
        stripeCustomerId: "cus_existing_1",
      },
    });
    mockGetOrCreateStripeCustomer.mockResolvedValue("cus_existing_1");
    mockUpdateUserStripeCustomerId.mockResolvedValue({ success: true });
    mockCreateCheckoutSession.mockResolvedValue({
      id: "cs_test_session_1",
      url: "https://checkout.stripe.com/pay/cs_test_session_1",
    });

    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue("OK");
    mockRedisDel.mockResolvedValue(1);
    mockIsSubscriptionEventProcessed.mockResolvedValue(false);
    mockExecuteSubscriptionTransition.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn({})
    );
    mockUpdateUserTier.mockResolvedValue({ success: true });
    mockUpsertSubscription.mockResolvedValue({ success: true });
    mockCancelUserSubscription.mockResolvedValue({ success: true });
    mockGetUserSubscription.mockResolvedValue(null);
    mockRecordSubscriptionEvent.mockResolvedValue({ success: true });
    mockRecordCreditTopup.mockResolvedValue({ applied: true, row: {} });
    mockExecuteStripeDualWrite.mockResolvedValue({
      applied: true,
      newBalanceMicro: 1_000_000_000,
    });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("POST /create-checkout (handleStripeCreateCheckoutPost & stripeRoutes)", () => {
    it("returns 401 when user is unauthenticated", async () => {
      mockGetUser.mockResolvedValueOnce(null);

      const res = await handleStripeCreateCheckoutPost(
        new Request("http://localhost/api/stripe/create-checkout", {
          method: "POST",
          body: JSON.stringify({ tier: "pro" }),
        })
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Unauthorized. Please log in.",
      });
    });

    it.each([
      ["{broken-json", "Malformed JSON payload."],
      ["null", "Invalid JSON body. Expected object."],
      [JSON.stringify({ tier: "invalid_tier" }), 'Invalid tier. Must be "pro" or "ultra".'],
    ])(
      "returns 400 for invalid checkout request payload (%s -> %s)",
      async (rawBody, expectedError) => {
        const res = await handleStripeCreateCheckoutPost(
          new Request("http://localhost/api/stripe/create-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: rawBody,
          })
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(expectedError);
      }
    );

    it("returns 500 when getUserProfile fails", async () => {
      mockGetUserProfile.mockResolvedValueOnce({
        success: false,
        data: null,
      });

      const res = await handleStripeCreateCheckoutPost(
        new Request("http://localhost/api/stripe/create-checkout", {
          method: "POST",
          body: JSON.stringify({ tier: "pro" }),
        })
      );

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("Failed to retrieve user profile.");
    });

    it("rejects downgrade from Ultra to Pro (400) and duplicate subscription to same tier (400)", async () => {
      mockGetUserProfile.mockResolvedValueOnce({
        success: true,
        data: {
          id: "user-stripe-1",
          email: "u@lugx.app",
          tier: "ultra",
          stripeCustomerId: "cus_1",
        },
      });

      const downgradeRes = await handleStripeCreateCheckoutPost(
        new Request("http://localhost/api/stripe/create-checkout", {
          method: "POST",
          body: JSON.stringify({ tier: "pro" }),
        })
      );
      expect(downgradeRes.status).toBe(400);
      expect((await downgradeRes.json()).error).toContain(
        "Cannot downgrade from Ultra to Pro"
      );

      mockGetUserProfile.mockResolvedValueOnce({
        success: true,
        data: {
          id: "user-stripe-1",
          email: "u@lugx.app",
          tier: "pro",
          stripeCustomerId: "cus_1",
        },
      });

      const sameTierRes = await handleStripeCreateCheckoutPost(
        new Request("http://localhost/api/stripe/create-checkout", {
          method: "POST",
          body: JSON.stringify({ tier: "pro" }),
        })
      );
      expect(sameTierRes.status).toBe(400);
      expect((await sameTierRes.json()).error).toBe(
        "You are already subscribed to the pro plan."
      );
    });

    it("updates stripeCustomerId when newly created and returns checkout session URL via stripeRoutes", async () => {
      mockGetOrCreateStripeCustomer.mockResolvedValueOnce("cus_new_999");

      const res = await stripeRoutes.request(
        "http://localhost/create-checkout",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier: "pro" }),
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        success: true,
        url: "https://checkout.stripe.com/pay/cs_test_session_1",
        sessionId: "cs_test_session_1",
      });
      expect(mockUpdateUserStripeCustomerId).toHaveBeenCalledWith(
        "user-stripe-1",
        "cus_new_999"
      );
    });
  });

  describe("POST /webhook (handleStripeWebhookPost & stripeRoutes)", () => {
    it("reads stripe-signature from Request headers or falls back to resolveCookiesAndHeaders()", async () => {
      mockConstructEvent.mockResolvedValueOnce({
        id: "evt_ctx_sig_1",
        type: "customer.subscription.trial_will_end",
        data: { object: {} },
      } as unknown as Stripe.Event);

      // Request without stripe-signature on Request.headers, provided via ServerRequestContext
      const ctx: ServerRequestContext = {
        cookies: createInMemoryCookieStore(),
        headers: new Headers({ "stripe-signature": "sig_from_context" }),
      };

      const res = await runWithServerRequestContext(ctx, () =>
        handleStripeWebhookPost(
          new Request("http://localhost/api/stripe/webhook", {
            method: "POST",
            body: "{}",
          })
        )
      );

      expect(res.status).toBe(200);
      expect(mockConstructEvent).toHaveBeenCalledWith(
        "{}",
        "sig_from_context",
        "whsec_test_secret",
        300
      );
    });

    it("returns 400 when stripe-signature header is missing from both Request and context", async () => {
      const res = await handleStripeWebhookPost(
        new Request("http://localhost/api/stripe/webhook", {
          method: "POST",
          body: "{}",
        })
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Missing stripe-signature header",
      });
    });

    it("returns 400 with replay protection message when signature timestamp is outside tolerance window", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockConstructEvent.mockRejectedValueOnce(
        new Error("Timestamp outside the tolerance zone")
      );

      const res = await handleStripeWebhookPost(
        new Request("http://localhost/api/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": "sig_expired" },
          body: "{}",
        })
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Webhook timestamp outside tolerance window",
      });
      errSpy.mockRestore();
    });

    it("returns 503 with Retry-After: 5 when Redis in-flight lock is held by a concurrent worker", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockConstructEvent.mockResolvedValueOnce({
        id: "evt_locked_1",
        type: "checkout.session.completed",
        data: { object: {} },
      } as unknown as Stripe.Event);
      mockRedisSet.mockResolvedValueOnce(null); // NX lock not acquired

      const res = await stripeRoutes.request("http://localhost/webhook", {
        method: "POST",
        headers: { "stripe-signature": "sig_valid" },
        body: "{}",
      });

      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(await res.json()).toEqual({
        error: "Concurrent event in flight, retry requested",
      });
      warnSpy.mockRestore();
    });

    it("processes checkout.session.completed atomically and executes Redis dual-write via stripeRoutes", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockConstructEvent.mockResolvedValueOnce({
        id: "evt_checkout_paid_1",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_paid_1",
            payment_status: "paid",
            subscription: "sub_paid_1",
            created: 1700000000,
            metadata: { userId: "user-stripe-1", tier: "pro" },
          },
        },
      } as unknown as Stripe.Event);
      mockSubscriptionsRetrieve.mockResolvedValueOnce({
        id: "sub_paid_1",
        items: {
          data: [
            {
              current_period_start: 1700000000,
              current_period_end: 1702592000,
            },
          ],
        },
      });

      const res = await stripeRoutes.request("http://localhost/webhook", {
        method: "POST",
        headers: { "stripe-signature": "sig_valid" },
        body: "{}",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        received: true,
        event: "evt_checkout_paid_1",
      });
      expect(mockUpdateUserTier).toHaveBeenCalledWith(
        "user-stripe-1",
        "pro",
        expect.anything()
      );
      expect(mockUpsertSubscription).toHaveBeenCalledWith(
        "user-stripe-1",
        expect.objectContaining({
          stripeSubscriptionId: "sub_paid_1",
          tier: "pro",
          status: "active",
        }),
        expect.anything()
      );
      expect(mockExecuteStripeDualWrite).toHaveBeenCalledTimes(1);
      logSpy.mockRestore();
    });
  });
});

// ===========================================================================
// 2. CRON ROUTES (`src/server/routes/cron.routes.ts`)
// ===========================================================================

describe("Cron Maintenance Route Module (src/server/routes/cron.routes.ts)", () => {
  const ORIGINAL_ENV = process.env;
  const CRON_SECRET = "cron_secret_wave_2_1";
  let mockReleaseLock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET };
    mockReleaseLock = vi.fn().mockResolvedValue(undefined);
    mockAcquireCronLock.mockResolvedValue({
      acquired: true,
      lockKey: "cron:lock:test",
      lockId: "lock-1",
      release: mockReleaseLock,
    });
    mockIsRedisConfigured.mockReturnValue(true);
    mockRedisSmembers.mockResolvedValue([]);
    mockFlushPendingSettlements.mockResolvedValue({
      flushedCount: 1,
      netDeltaMicro: BigInt(-10000),
    });
    mockDbExecute.mockResolvedValue({ rowCount: 12 });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("GET | POST /expire-reservations", () => {
    it.each([
      [undefined, "missing Authorization header"],
      ["Bearer short", "different length token"],
      [`Bearer ${"x".repeat(CRON_SECRET.length)}`, "same length wrong content"],
    ])(
      "returns 401 Unauthorized when Authorization is invalid (%s — %s)",
      async (authHeader, _reason) => {
        const headers = new Headers();
        if (authHeader) headers.set("Authorization", authHeader);

        const res = await handleExpireReservationsCron(
          new Request("http://localhost/api/cron/expire-reservations", {
            headers,
          })
        );
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({
          success: false,
          error: "Unauthorized",
        });
      }
    );

    it("handles Set iterable from redis.smembers, skips empty entries, and releases lock via cronRoutes", async () => {
      mockRedisSmembers.mockResolvedValueOnce(
        new Set(["", "user-dirty-1", "user-dirty-2"])
      );
      mockFlushPendingSettlements
        .mockResolvedValueOnce({
          flushedCount: 3,
          netDeltaMicro: BigInt(-30000),
        })
        .mockResolvedValueOnce({
          flushedCount: 2,
          netDeltaMicro: BigInt(-20000),
        });

      const res = await cronRoutes.request(
        "http://localhost/expire-reservations",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${CRON_SECRET}` },
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        success: true,
        processedUsers: 2,
        flushedOperations: 5,
        netDeltaMicro: "-50000",
      });
      expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    });

    it("returns 503 on MeteringServiceUnavailableError and 500 on non-Redis error while always releasing lock", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockRedisSmembers.mockRejectedValueOnce(
        new MeteringServiceUnavailableError("Upstash unreachable")
      );

      const res503 = await cronRoutes.request(
        "http://localhost/expire-reservations",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${CRON_SECRET}` },
        }
      );
      expect(res503.status).toBe(503);
      expect(mockReleaseLock).toHaveBeenCalledTimes(1);

      mockRedisSmembers.mockResolvedValueOnce(["user-1"]);
      mockFlushPendingSettlements.mockRejectedValueOnce(
        new Error("Postgres constraint violation")
      );

      const res500 = await handleExpireReservationsCron(
        new Request("http://localhost/api/cron/expire-reservations", {
          headers: { Authorization: `Bearer ${CRON_SECRET}` },
        })
      );
      expect(res500.status).toBe(500);
      expect(mockReleaseLock).toHaveBeenCalledTimes(2);
      errSpy.mockRestore();
    });
  });

  describe("GET | POST /purge-deleted", () => {
    it("returns skipped: true (200) when distributed lock is not acquired", async () => {
      mockAcquireCronLock.mockResolvedValueOnce({
        acquired: false,
        lockKey: "cron:lock:purge-deleted",
        lockId: "none",
        release: mockReleaseLock,
      });

      const res = await cronRoutes.request("http://localhost/purge-deleted", {
        method: "GET",
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        success: true,
        skipped: true,
      });
      expect(mockDbExecute).not.toHaveBeenCalled();
    });

    it("reports done: true when deleted < BATCH_LIMIT (500) and done: false when deleted === 500", async () => {
      mockDbExecute.mockResolvedValueOnce({ rowCount: 42 });

      const resDone = await cronRoutes.request(
        "http://localhost/purge-deleted",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${CRON_SECRET}` },
        }
      );
      expect(resDone.status).toBe(200);
      expect(await resDone.json()).toMatchObject({
        success: true,
        deleted: 42,
        retentionDays: 30,
        batchLimit: 500,
        done: true,
      });

      mockDbExecute.mockResolvedValueOnce({ rowCount: 500 });
      const resMore = await handlePurgeDeletedCron(
        new Request("http://localhost/api/cron/purge-deleted", {
          method: "POST",
          headers: { Authorization: `Bearer ${CRON_SECRET}` },
        })
      );
      expect(resMore.status).toBe(200);
      expect(await resMore.json()).toMatchObject({
        success: true,
        deleted: 500,
        done: false,
      });
    });

    it("returns 500 when db.execute throws and releases lock in finally block", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockDbExecute.mockRejectedValueOnce(new Error("Query timeout"));

      const res = await handlePurgeDeletedCron(
        new Request("http://localhost/api/cron/purge-deleted", {
          headers: { Authorization: `Bearer ${CRON_SECRET}` },
        })
      );

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        success: false,
        error: "Purge failed",
      });
      expect(mockReleaseLock).toHaveBeenCalledTimes(1);
      errSpy.mockRestore();
    });
  });
});

// ===========================================================================
// 3. AUTH CALLBACK ROUTE (`src/server/routes/auth-callback.routes.ts`)
// ===========================================================================

describe("OAuth Auth Callback Route Module (src/server/routes/auth-callback.routes.ts)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.VITE_APP_URL;

    mockCreateClient.mockImplementation((ctx: ServerRequestContext) => ({
      auth: {
        exchangeCodeForSession: async (code: string) => {
          const result = await mockExchangeCodeForSession(code, ctx);
          return result;
        },
      },
    }));
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    mockSyncUserToDatabase.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("prioritizes VITE_APP_URL over request origin, and preserves Set-Cookie headers in standalone mode", async () => {
    process.env.VITE_APP_URL = "https://vite.elixent.app";

    mockExchangeCodeForSession.mockImplementationOnce(
      async (_code: string, ctx: ServerRequestContext) => {
        // Verify incoming cookies are readable via ctx.cookies.getAll()
        expect(ctx.cookies.getAll()).toEqual(
          expect.arrayContaining([{ name: "pkce_verifier", value: "v_123" }])
        );
        ctx.cookies.set("sb-access-token", "jwt_tok_1", {
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          maxAge: 3600,
        });
        ctx.cookies.delete("pkce_verifier");
        return { error: null };
      }
    );

    const res = await authCallbackRoutes.request(
      "http://localhost/?code=oauth_123&redirectTo=/workspace/doc-1",
      {
        headers: {
          cookie: "pkce_verifier=v_123",
          "x-forwarded-host": "evil-spoofed.com",
        },
      }
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe(
      "https://vite.elixent.app/workspace/doc-1"
    );
    const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
    expect(setCookieHeader).toContain("sb-access-token=jwt_tok_1");
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("Secure");
    expect(setCookieHeader).toContain("SameSite=Lax");
    expect(setCookieHeader).toContain("pkce_verifier=; Max-Age=0; Path=/");
  });

  it("enforces APP_URL > VITE_APP_URL precedence over request origin, ignoring NEXT_PUBLIC_APP_URL", async () => {
    process.env.APP_URL = "https://canonical.elixent.app";
    process.env.VITE_APP_URL = "https://vite.elixent.app";
    process.env.NEXT_PUBLIC_APP_URL = "https://legacy-ignored.elixent.app";

    const res = await authCallbackRoutes.request(
      "https://auth-origin.elixent.app/?code=oauth_123&redirectTo=/dashboard"
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe(
      "https://canonical.elixent.app/dashboard"
    );
  });

  it("falls back to request origin in non-production when APP_URL and VITE_APP_URL are absent, strictly ignoring NEXT_PUBLIC_APP_URL", async () => {
    delete process.env.APP_URL;
    delete process.env.VITE_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://legacy-ignored.elixent.app";

    const res = await authCallbackRoutes.request(
      "https://auth-origin.elixent.app/?code=oauth_123&redirectTo=/dashboard"
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe(
      "https://auth-origin.elixent.app/dashboard"
    );
  });

  it("refuses unverified request origin and fails fast in production when APP_URL and VITE_APP_URL are absent", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_URL;
    delete process.env.VITE_APP_URL;

    await expect(
      handleAuthCallbackGet(
        new Request("https://spoofed-origin.elixent.app/?code=oauth_123&redirectTo=/dashboard")
      )
    ).rejects.toThrow(/APP_URL \(or VITE_APP_URL\) must be configured with an https:\/\/ URL in production/);
  });

  it("continues with 307 redirect to safeRedirectPath even if syncUserToDatabase throws", async () => {
    process.env.APP_URL = "https://elixent.app";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSyncUserToDatabase.mockRejectedValueOnce(
      new Error("Transient Neon DB error")
    );

    const res = await handleAuthCallbackGet(
      new Request(
        "https://elixent.app/auth/callback?code=valid_code&redirectTo=/account"
      )
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("https://elixent.app/account");
    expect(errSpy).toHaveBeenCalledWith(
      "[Auth Callback] Failed to sync user to database:",
      expect.any(Error)
    );
    errSpy.mockRestore();
  });

  it("executes directly inside an active ServerRequestContext when bound via runWithServerRequestContext", async () => {
    process.env.APP_URL = "https://elixent.app";
    const store = createInMemoryCookieStore();
    const ctx: ServerRequestContext = {
      cookies: store,
      headers: new Headers(),
    };

    mockExchangeCodeForSession.mockImplementationOnce(
      async (_code: string, activeCtx: ServerRequestContext) => {
        activeCtx.cookies.set("sb-ctx-token", "bound_val");
        return { error: null };
      }
    );

    const res = await runWithServerRequestContext(ctx, () =>
      handleAuthCallbackGet(
        new Request("https://elixent.app/auth/callback?code=ctx_code")
      )
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("https://elixent.app/dashboard");
    expect(store.getAll()).toEqual([
      { name: "sb-ctx-token", value: "bound_val" },
    ]);
  });
});

// ===========================================================================
// 4. E2E AUTH ROUTE (`src/server/routes/e2e-auth.routes.ts`)
// ===========================================================================

describe("E2E Auth Route Module (src/server/routes/e2e-auth.routes.ts)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "test",
      VITE_SUPABASE_URL: "https://e2e-supabase.co",
      VITE_SUPABASE_ANON_KEY: "anon_key_e2e",
      SUPABASE_SERVICE_ROLE_KEY: "service_role_key_e2e",
    };

    mockSsrCookiesSetOnSession.length = 0;
    mockSsrCookiesSetOnSession.push({
      name: "sb-e2e-auth-token",
      value: "cookie_session_payload",
      options: { path: "/" },
    });

    mockAdminListUsers.mockResolvedValue({
      data: {
        users: [{ id: "usr-e2e-100", email: "e2e-runner@lugx.test" }],
      },
    });
    mockAdminCreateUser.mockResolvedValue({
      data: {
        user: { id: "usr-e2e-created", email: "new-e2e@lugx.test" },
      },
      error: null,
    });
    mockAnonSignInWithPassword.mockResolvedValue({
      data: {
        session: {
          access_token: "acc_tok_e2e",
          refresh_token: "ref_tok_e2e",
          expires_at: 1900000000,
        },
      },
      error: null,
    });
    mockDbOnConflictDoUpdate.mockResolvedValue(undefined);
    mockSsrSetSession.mockResolvedValue(undefined);
    mockSsrSignOut.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("Environment Guard (isAllowedEnvironment)", () => {
    it("blocks POST and DELETE with 404 Not Found in production even when PLAYWRIGHT='1'", async () => {
      process.env = {
        ...process.env,
        NODE_ENV: "production",
        PLAYWRIGHT: "1",
      };

      const postRes = await e2eAuthRoutes.request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(postRes.status).toBe(404);
      expect(await postRes.json()).toEqual({ error: "Not Found" });

      const delRes = await e2eAuthRoutes.request("http://localhost/", {
        method: "DELETE",
      });
      expect(delRes.status).toBe(404);
    });

    it("blocks requests with 404 in development when PLAYWRIGHT !== '1', and allows when PLAYWRIGHT === '1'", async () => {
      process.env = {
        ...process.env,
        NODE_ENV: "development",
      };
      delete process.env.PLAYWRIGHT;

      const blockedRes = await handleE2EAuthDelete(
        new Request("http://localhost/api/test/e2e-auth", { method: "DELETE" })
      );
      expect(blockedRes.status).toBe(404);

      process.env.PLAYWRIGHT = "1";
      const allowedRes = await handleE2EAuthDelete(
        new Request("http://localhost/api/test/e2e-auth", { method: "DELETE" })
      );
      expect(allowedRes.status).toBe(200);
    });
  });

  describe("POST /api/test/e2e-auth (handleE2EAuthPost & e2eAuthRoutes)", () => {
    it.each([
      ["free", BigInt(50000000)],
      ["pro", BigInt(1000000000)],
      ["ultra", BigInt(3500000000)],
    ] as const)(
      "provisions E2E user with tier '%s' (creditBalanceMicro = %s), sets cookies, and returns auth-fixture contract",
      async (tier, expectedMicro) => {
        const res = await e2eAuthRoutes.request("http://localhost/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            cookie: "existing_cookie=val1",
          },
          body: JSON.stringify({
            email: "e2e-runner@lugx.test",
            displayName: "E2E Runner",
            tier,
          }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("Set-Cookie")).toContain(
          "sb-e2e-auth-token=cookie_session_payload; Path=/; SameSite=Lax"
        );

        const body = await res.json();
        expect(body).toEqual({
          ok: true,
          success: true,
          user: {
            id: "usr-e2e-100",
            email: "e2e-runner@lugx.test",
            displayName: "E2E Runner",
          },
          session: {
            accessToken: "acc_tok_e2e",
            expiresAt: 1900000000,
          },
          cookies: [
            {
              name: "sb-e2e-auth-token",
              value: "cookie_session_payload",
              path: "/",
            },
          ],
        });

        expect(mockDbInsertValues).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "usr-e2e-100",
            tier,
            creditBalanceMicro: expectedMicro,
          })
        );
      }
    );

    it("creates a new Supabase Auth user when email is not found in listUsers, and returns 400 if createUser fails", async () => {
      mockAdminListUsers.mockResolvedValue({ data: { users: [] } });

      const okRes = await handleE2EAuthPost(
        new Request("http://localhost/api/test/e2e-auth", {
          method: "POST",
          body: JSON.stringify({ email: "new-e2e@lugx.test" }),
        })
      );
      expect(okRes.status).toBe(200);
      expect(mockAdminCreateUser).toHaveBeenCalledTimes(1);

      mockAdminCreateUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Password policy violation" },
      });
      const failCreateRes = await handleE2EAuthPost(
        new Request("http://localhost/api/test/e2e-auth", {
          method: "POST",
          body: JSON.stringify({ email: "fail-e2e@lugx.test" }),
        })
      );
      expect(failCreateRes.status).toBe(400);
      expect(await failCreateRes.json()).toEqual({
        error: "Password policy violation",
      });
    });

    it("returns 400 when signInWithPassword fails and 500 when request body is malformed JSON", async () => {
      mockAnonSignInWithPassword.mockResolvedValueOnce({
        data: { session: null },
        error: { message: "Invalid login credentials" },
      });

      const signInFailRes = await handleE2EAuthPost(
        new Request("http://localhost/api/test/e2e-auth", {
          method: "POST",
          body: JSON.stringify({ email: "e2e-runner@lugx.test" }),
        })
      );
      expect(signInFailRes.status).toBe(400);
      expect(await signInFailRes.json()).toEqual({
        error: "Invalid login credentials",
      });

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const badJsonRes = await handleE2EAuthPost(
        new Request("http://localhost/api/test/e2e-auth", {
          method: "POST",
          body: "{bad-json",
        })
      );
      expect(badJsonRes.status).toBe(500);
      errSpy.mockRestore();
    });
  });

  describe("DELETE /api/test/e2e-auth (handleE2EAuthDelete & e2eAuthRoutes)", () => {
    it("signs out SSR client and clears all incoming sb-* cookies with Max-Age=0", async () => {
      const res = await e2eAuthRoutes.request("http://localhost/", {
        method: "DELETE",
        headers: {
          cookie:
            "sb-access-token=tok_1; sb-refresh-token=tok_2; theme=dark",
        },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        success: true,
        message: "Logged out",
      });

      const setCookie = res.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toContain("sb-access-token=; Max-Age=0; Path=/");
      expect(setCookie).toContain("sb-refresh-token=; Max-Age=0; Path=/");
      expect(setCookie).not.toContain("theme=;");
    });
  });

  describe("Application URL Hardening (src/lib/config/app-url.ts / FIND-08)", () => {
    it("rejects path traversal attempts in resolveAppUrl", async () => {
      const { resolveAppUrl } = await import("@/lib/config/app-url");
      process.env.APP_URL = "https://canonical.elixent.com";

      expect(() => resolveAppUrl("/../admin")).toThrow(/Refusing path traversal/);
      expect(() => resolveAppUrl("../admin")).toThrow(/Refusing path traversal/);
      expect(() => resolveAppUrl("/workspace/../admin")).toThrow(/Refusing path traversal/);
    });

    it("evaluates resolveSameOriginAppUrl allowing same-origin absolute and relative URLs and rejecting cross-origin", async () => {
      const { resolveSameOriginAppUrl } = await import("@/lib/config/app-url");
      process.env.APP_URL = "https://canonical.elixent.com";

      // Relative paths
      expect(resolveSameOriginAppUrl("/dashboard")).toBe("https://canonical.elixent.com/dashboard");
      expect(resolveSameOriginAppUrl("account")).toBe("https://canonical.elixent.com/account");

      // Same-origin absolute URL
      expect(resolveSameOriginAppUrl("https://canonical.elixent.com/billing")).toBe(
        "https://canonical.elixent.com/billing"
      );

      // Cross-origin absolute URL rejected
      expect(() => resolveSameOriginAppUrl("https://evil.com/phish")).toThrow(
        /Cross-origin app URL rejected/
      );

      // Protocol-relative rejected
      expect(() => resolveSameOriginAppUrl("//evil.com/phish")).toThrow(
        /Refusing protocol-relative app URL/
      );

      // Path traversal rejected
      expect(() => resolveSameOriginAppUrl("/../secret")).toThrow(/Refusing path traversal/);
    });
  });
});
