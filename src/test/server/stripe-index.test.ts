import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
    mockCheckoutSessionsCreate,
    mockBillingPortalSessionsCreate,
    mockCustomersList,
    mockCustomersCreate,
    mockCustomersRetrieve,
    mockWebhooksConstructEvent,
    mockGlobalDb,
} = vi.hoisted(() => ({
    mockCheckoutSessionsCreate: vi.fn(),
    mockBillingPortalSessionsCreate: vi.fn(),
    mockCustomersList: vi.fn(),
    mockCustomersCreate: vi.fn(),
    mockCustomersRetrieve: vi.fn(),
    mockWebhooksConstructEvent: vi.fn(),
    mockGlobalDb: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
}));

vi.mock("stripe", () => {
    return {
        default: class MockStripe {
            checkout = {
                sessions: {
                    create: mockCheckoutSessionsCreate,
                },
            };
            billingPortal = {
                sessions: {
                    create: mockBillingPortalSessionsCreate,
                },
            };
            customers = {
                list: mockCustomersList,
                create: mockCustomersCreate,
                retrieve: mockCustomersRetrieve,
            };
            webhooks = {
                constructEvent: mockWebhooksConstructEvent,
            };
        },
    };
});

vi.mock("@/server/db", () => ({
    db: mockGlobalDb,
}));

vi.mock("@/lib/metering/lua-scripts", () => ({
    executeStripeDualWrite: vi.fn(),
}));

import {
    createCheckoutSession,
    getOrCreateStripeCustomer,
    getStripeCustomer,
    constructWebhookEvent,
} from "@/lib/stripe";
import { getAppBaseUrl, resolveAppUrl } from "@/lib/config/app-url";
import { BillingService } from "@/server/services/billing-service";

describe("Stripe Integration Library (src/lib/stripe/index.ts)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = {
            ...originalEnv,
            NODE_ENV: "test",
            STRIPE_SECRET_KEY: "sk_test_mock_key_123",
            STRIPE_WEBHOOK_SECRET: "whsec_test_mock_webhook_secret",
        };
        delete process.env.APP_URL;
        delete process.env.VITE_APP_URL;
        delete process.env.NEXT_PUBLIC_APP_URL;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("Canonical App URL Resolution (src/lib/config/app-url.ts)", () => {
        it("returns normalized base URL without trailing slashes when path is omitted or empty", () => {
            process.env.APP_URL = "https://elixent.app///";

            expect(getAppBaseUrl()).toBe("https://elixent.app");
            expect(resolveAppUrl()).toBe("https://elixent.app");
            expect(resolveAppUrl("")).toBe("https://elixent.app");
            expect(resolveAppUrl("   ")).toBe("https://elixent.app");
        });

        it("preserves literal Stripe template placeholders without double slashes", () => {
            process.env.APP_URL = "https://elixent.app/";

            expect(resolveAppUrl("/dashboard?session_id={CHECKOUT_SESSION_ID}")).toBe(
                "https://elixent.app/dashboard?session_id={CHECKOUT_SESSION_ID}"
            );
            expect(resolveAppUrl("account")).toBe("https://elixent.app/account");
        });

        it.each([
            "//evil.com",
            "///evil.com/phish",
            "https://evil.com/dashboard",
            "http://evil.com/account",
            "javascript:alert(1)",
            "https:evil.com",
            "/\\evil.com",
            "/\n/evil.com",
        ])("rejects unsafe or cross-origin path %s", (unsafePath) => {
            process.env.APP_URL = "https://elixent.app";

            expect(() => resolveAppUrl(unsafePath)).toThrow();
        });

        it.each([
            "not-a-valid-url",
            "ftp://elixent.app",
            "https://user:pass@elixent.app",
            "https://elixent.app/?foo=bar",
            "https://elixent.app/#fragment",
        ])("rejects malformed or invalid base URL %s in all environments", (invalidBaseUrl) => {
            process.env.APP_URL = invalidBaseUrl;

            expect(() => getAppBaseUrl()).toThrow();
        });
    });

    describe("createCheckoutSession", () => {
        it("prioritizes APP_URL over VITE_APP_URL and ignores NEXT_PUBLIC_APP_URL", async () => {
            process.env.APP_URL = "https://canonical.elixent.com";
            process.env.VITE_APP_URL = "https://vite.elixent.com";
            process.env.NEXT_PUBLIC_APP_URL = "https://legacy.elixent.com";

            mockCheckoutSessionsCreate.mockResolvedValueOnce({
                id: "cs_test_123",
                url: "https://checkout.stripe.com/pay/cs_test_123",
            });

            const session = await createCheckoutSession(
                "cus_123",
                "price_pro_month",
                "usr_456",
                "pro"
            );

            expect(session.id).toBe("cs_test_123");
            expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    customer: "cus_123",
                    mode: "subscription",
                    success_url: "https://canonical.elixent.com/dashboard?session_id={CHECKOUT_SESSION_ID}",
                    cancel_url: "https://canonical.elixent.com/account",
                    metadata: {
                        userId: "usr_456",
                        tier: "pro",
                    },
                })
            );
        });

        it("falls back to VITE_APP_URL when APP_URL is missing or whitespace and ignores NEXT_PUBLIC_APP_URL", async () => {
            process.env.APP_URL = "   ";
            process.env.VITE_APP_URL = "https://vite.elixent.com/";
            process.env.NEXT_PUBLIC_APP_URL = "https://legacy.elixent.com";

            mockCheckoutSessionsCreate.mockResolvedValueOnce({
                id: "cs_test_vite_url",
            });

            await createCheckoutSession("cus_123", "price_pro_month", "usr_456", "pro");

            expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    success_url: "https://vite.elixent.com/dashboard?session_id={CHECKOUT_SESSION_ID}",
                    cancel_url: "https://vite.elixent.com/account",
                })
            );
        });

        it("falls back to http://localhost:3000 in non-production when APP_URL and VITE_APP_URL are missing, ignoring NEXT_PUBLIC_APP_URL", async () => {
            process.env.NEXT_PUBLIC_APP_URL = "https://legacy.elixent.com";

            mockCheckoutSessionsCreate.mockResolvedValueOnce({
                id: "cs_test_default",
            });

            await createCheckoutSession("cus_123", "price_pro_month", "usr_456", "pro");

            expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    success_url: "http://localhost:3000/dashboard?session_id={CHECKOUT_SESSION_ID}",
                    cancel_url: "http://localhost:3000/account",
                })
            );
        });

        it.each([
            {
                input: "https://localhost:3000",
                expectedBase: "http://localhost:3000",
            },
            {
                input: "https://localhost:3000/",
                expectedBase: "http://localhost:3000",
            },
            {
                input: "https://127.0.0.1:5173/",
                expectedBase: "http://127.0.0.1:5173",
            },
        ])(
            "normalizes non-production loopback $input to $expectedBase",
            async ({ input, expectedBase }) => {
                process.env.APP_URL = input;
                mockCheckoutSessionsCreate.mockResolvedValueOnce({ id: "cs_test_loopback" });

                await createCheckoutSession("cus_123", "price_pro_month", "usr_456", "pro");

                expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                    expect.objectContaining({
                        success_url: `${expectedBase}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
                        cancel_url: `${expectedBase}/account`,
                    })
                );
            }
        );

        it.each([
            "https://staging.elixent.com",
            "https://elixent.app/",
            "https://localhost.attacker.com",
            "https://my-localhost-tunnel.ngrok-free.app/",
            "https://notlocalhost.com",
        ])("preserves https:// without downgrade for remote URL %s", async (remoteUrl) => {
            process.env.VITE_APP_URL = remoteUrl;
            const normalizedBase = remoteUrl.replace(/\/+$/, "");

            mockCheckoutSessionsCreate.mockResolvedValueOnce({
                id: "cs_test_remote",
            });

            await createCheckoutSession("cus_123", "price_ultra_month", "usr_789", "ultra");

            expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    success_url: `${normalizedBase}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${normalizedBase}/account`,
                    metadata: {
                        userId: "usr_789",
                        tier: "ultra",
                    },
                })
            );
        });

        it.each([
            { label: "missing URL", env: {} },
            { label: "http:// URL", env: { APP_URL: "http://elixent.app" } },
            { label: "http://localhost URL", env: { APP_URL: "http://localhost:3000" } },
            { label: "malformed URL", env: { VITE_APP_URL: "not-a-url" } },
        ])("fails closed in production when configuration has $label", async ({ env }) => {
            process.env.NODE_ENV = "production";
            Object.assign(process.env, env);

            await expect(
                createCheckoutSession("cus_123", "price_pro_month", "usr_456", "pro")
            ).rejects.toThrow();

            expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
        });

        it("throws an error when STRIPE_SECRET_KEY is absent", async () => {
            delete process.env.STRIPE_SECRET_KEY;

            await expect(
                createCheckoutSession("cus_123", "price_pro", "usr_456", "pro")
            ).rejects.toThrow("STRIPE_SECRET_KEY is not defined in environment variables");

            expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
        });

        it("logs and throws 'Failed to create checkout session' when stripe.checkout.sessions.create fails", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            mockCheckoutSessionsCreate.mockRejectedValueOnce(
                new Error("Stripe network timeout")
            );

            await expect(
                createCheckoutSession("cus_123", "price_pro", "usr_456", "pro")
            ).rejects.toThrow("Failed to create checkout session");

            expect(errSpy).toHaveBeenCalledWith(
                "Error in createCheckoutSession:",
                expect.any(Error)
            );
            errSpy.mockRestore();
        });
    });

    describe("getOrCreateStripeCustomer", () => {
        it("returns existing customer ID when customer already exists in Stripe", async () => {
            mockCustomersList.mockResolvedValueOnce({
                data: [{ id: "cus_existing_999" }],
            });

            const customerId = await getOrCreateStripeCustomer(
                "usr_123",
                "test@example.com",
                "Test User"
            );

            expect(customerId).toBe("cus_existing_999");
            expect(mockCustomersList).toHaveBeenCalledWith({
                email: "test@example.com",
                limit: 1,
            });
            expect(mockCustomersCreate).not.toHaveBeenCalled();
        });

        it("creates new customer with name and metadata when no customer exists", async () => {
            mockCustomersList.mockResolvedValueOnce({
                data: [],
            });
            mockCustomersCreate.mockResolvedValueOnce({
                id: "cus_new_888",
            });

            const customerId = await getOrCreateStripeCustomer(
                "usr_123",
                "newuser@example.com",
                "New User"
            );

            expect(customerId).toBe("cus_new_888");
            expect(mockCustomersCreate).toHaveBeenCalledWith({
                email: "newuser@example.com",
                name: "New User",
                metadata: {
                    userId: "usr_123",
                },
            });
        });

        it("falls back to email as name when name is omitted during customer creation", async () => {
            mockCustomersList.mockResolvedValueOnce({
                data: [],
            });
            mockCustomersCreate.mockResolvedValueOnce({
                id: "cus_new_email_name",
            });

            const customerId = await getOrCreateStripeCustomer(
                "usr_123",
                "noname@example.com"
            );

            expect(customerId).toBe("cus_new_email_name");
            expect(mockCustomersCreate).toHaveBeenCalledWith({
                email: "noname@example.com",
                name: "noname@example.com",
                metadata: {
                    userId: "usr_123",
                },
            });
        });

        it("throws an error when STRIPE_SECRET_KEY is missing", async () => {
            delete process.env.STRIPE_SECRET_KEY;

            await expect(
                getOrCreateStripeCustomer("usr_123", "test@example.com")
            ).rejects.toThrow("STRIPE_SECRET_KEY is not defined in environment variables");
        });

        it("logs and throws 'Failed to create or retrieve Stripe customer' when API fails", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            mockCustomersList.mockRejectedValueOnce(new Error("Stripe rate limit"));

            await expect(
                getOrCreateStripeCustomer("usr_123", "fail@example.com")
            ).rejects.toThrow("Failed to create or retrieve Stripe customer");

            expect(errSpy).toHaveBeenCalledWith(
                "Error in getOrCreateStripeCustomer:",
                expect.any(Error)
            );
            errSpy.mockRestore();
        });
    });

    describe("getStripeCustomer", () => {
        it("returns customer object when customer exists and is not deleted", async () => {
            const mockCust = { id: "cus_active_1", deleted: false };
            mockCustomersRetrieve.mockResolvedValueOnce(mockCust);

            const result = await getStripeCustomer("cus_active_1");
            expect(result).toEqual(mockCust);
            expect(mockCustomersRetrieve).toHaveBeenCalledWith("cus_active_1");
        });

        it("returns null when customer object is marked as deleted", async () => {
            mockCustomersRetrieve.mockResolvedValueOnce({ id: "cus_del_2", deleted: true });

            const result = await getStripeCustomer("cus_del_2");
            expect(result).toBeNull();
        });

        it("throws when STRIPE_SECRET_KEY is missing", async () => {
            delete process.env.STRIPE_SECRET_KEY;

            await expect(getStripeCustomer("cus_123")).rejects.toThrow(
                "STRIPE_SECRET_KEY is not defined in environment variables"
            );
        });

        it("logs error and returns null when API fails", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            mockCustomersRetrieve.mockRejectedValueOnce(new Error("Stripe network error"));

            const result = await getStripeCustomer("cus_fail");
            expect(result).toBeNull();

            expect(errSpy).toHaveBeenCalledWith(
                "Error retrieving Stripe customer:",
                expect.any(Error)
            );
            errSpy.mockRestore();
        });
    });

    describe("constructWebhookEvent", () => {
        it("constructs and returns verified Stripe event when valid signature and secret are provided", () => {
            const mockEvent = { id: "evt_123", type: "checkout.session.completed" };
            mockWebhooksConstructEvent.mockReturnValueOnce(mockEvent);

            const event = constructWebhookEvent('{"id":"evt_123"}', "sig_abc");

            expect(event).toEqual(mockEvent);
            expect(mockWebhooksConstructEvent).toHaveBeenCalledWith(
                '{"id":"evt_123"}',
                "sig_abc",
                "whsec_test_mock_webhook_secret"
            );
        });

        it("throws when STRIPE_WEBHOOK_SECRET is missing outside test environment", () => {
            delete process.env.STRIPE_WEBHOOK_SECRET;
            process.env.NODE_ENV = "production";
            delete process.env.PLAYWRIGHT;

            expect(() => constructWebhookEvent("{}", "sig")).toThrow(
                "STRIPE_WEBHOOK_SECRET is not defined in environment variables"
            );
        });

        it("logs and throws 'Invalid webhook signature' when signature verification fails", () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            mockWebhooksConstructEvent.mockImplementationOnce(() => {
                throw new Error("Signature mismatch");
            });

            expect(() => constructWebhookEvent("{}", "invalid_sig")).toThrow(
                "Invalid webhook signature"
            );

            expect(errSpy).toHaveBeenCalledWith(
                "Webhook signature verification failed:",
                expect.any(Error)
            );
            errSpy.mockRestore();
        });
    });

    describe("Cross-service URL consistency (stripe/index.ts & billing-service.ts)", () => {
        function mockPortalUserCustomer(stripeCustomerId: string) {
            mockGlobalDb.select.mockReturnValueOnce({
                from: () => ({
                    where: () => ({
                        limit: () => Promise.resolve([{ stripeCustomerId }]),
                    }),
                }),
            });
        }

        it.each([
            {
                scenario: "APP_URL overrides VITE_APP_URL and ignores NEXT_PUBLIC_APP_URL",
                env: {
                    APP_URL: "https://canonical.elixent.app/",
                    VITE_APP_URL: "https://vite.elixent.app",
                    NEXT_PUBLIC_APP_URL: "https://legacy.elixent.app",
                },
                expectedBase: "https://canonical.elixent.app",
            },
            {
                scenario: "non-prod https://localhost:3000 normalizes to http://localhost:3000",
                env: {
                    APP_URL: "https://localhost:3000/",
                },
                expectedBase: "http://localhost:3000",
            },
            {
                scenario: "non-prod https://localhost.attacker.com is not downgraded",
                env: {
                    VITE_APP_URL: "https://localhost.attacker.com",
                },
                expectedBase: "https://localhost.attacker.com",
            },
            {
                scenario: "non-prod fallback ignores NEXT_PUBLIC_APP_URL and uses localhost:3000",
                env: {
                    NEXT_PUBLIC_APP_URL: "https://legacy.elixent.app",
                },
                expectedBase: "http://localhost:3000",
            },
        ])("produces identical /account URL across checkout and portal when $scenario", async ({ env, expectedBase }) => {
            Object.assign(process.env, env);
            mockCheckoutSessionsCreate.mockResolvedValueOnce({ id: "cs_sync_1" });
            mockPortalUserCustomer("cus_sync_1");
            mockBillingPortalSessionsCreate.mockResolvedValueOnce({
                url: "https://billing.stripe.com/p/session_sync_1",
            });

            await createCheckoutSession("cus_sync_1", "price_pro_month", "usr_1", "pro");
            await BillingService.createCustomerPortalSession("usr_1");

            const checkoutArgs = mockCheckoutSessionsCreate.mock.calls[0][0];
            const portalArgs = mockBillingPortalSessionsCreate.mock.calls[0][0];

            expect(checkoutArgs.cancel_url).toBe(`${expectedBase}/account`);
            expect(portalArgs.return_url).toBe(`${expectedBase}/account`);
            expect(checkoutArgs.success_url).toBe(`${expectedBase}/dashboard?session_id={CHECKOUT_SESSION_ID}`);
        });

        it("fails closed in production across both checkout and customer portal when URL is unconfigured", async () => {
            process.env.NODE_ENV = "production";
            mockPortalUserCustomer("cus_prod_fail");

            await expect(
                createCheckoutSession("cus_prod_fail", "price_pro_month", "usr_1", "pro")
            ).rejects.toThrow();

            await expect(
                BillingService.createCustomerPortalSession("usr_1")
            ).rejects.toThrow();

            expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
            expect(mockBillingPortalSessionsCreate).not.toHaveBeenCalled();
        });
    });
});
