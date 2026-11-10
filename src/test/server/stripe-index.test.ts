import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
    mockCheckoutSessionsCreate,
    mockCustomersList,
    mockCustomersCreate,
    mockCustomersRetrieve,
    mockWebhooksConstructEvent,
} = vi.hoisted(() => ({
    mockCheckoutSessionsCreate: vi.fn(),
    mockCustomersList: vi.fn(),
    mockCustomersCreate: vi.fn(),
    mockCustomersRetrieve: vi.fn(),
    mockWebhooksConstructEvent: vi.fn(),
}));

vi.mock("stripe", () => {
    return {
        default: class MockStripe {
            checkout = {
                sessions: {
                    create: mockCheckoutSessionsCreate,
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

import {
    createCheckoutSession,
    getOrCreateStripeCustomer,
    getStripeCustomer,
    constructWebhookEvent,
} from "@/lib/stripe";

describe("Stripe Integration Library (src/lib/stripe/index.ts)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = {
            ...originalEnv,
            STRIPE_SECRET_KEY: "sk_test_mock_key_123",
            STRIPE_WEBHOOK_SECRET: "whsec_test_mock_webhook_secret",
        };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("createCheckoutSession", () => {
        it("prioritizes VITE_APP_URL over APP_URL and NEXT_PUBLIC_APP_URL", async () => {
            process.env.VITE_APP_URL = "https://vite.elixent.com";
            process.env.APP_URL = "https://canonical.elixent.com";
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
                    success_url: "https://vite.elixent.com/dashboard?session_id={CHECKOUT_SESSION_ID}",
                    cancel_url: "https://vite.elixent.com/account",
                    metadata: {
                        userId: "usr_456",
                        tier: "pro",
                    },
                })
            );
        });

        it("falls back to APP_URL when VITE_APP_URL is missing", async () => {
            delete process.env.VITE_APP_URL;
            process.env.APP_URL = "https://canonical.elixent.com";
            process.env.NEXT_PUBLIC_APP_URL = "https://legacy.elixent.com";

            mockCheckoutSessionsCreate.mockResolvedValueOnce({
                id: "cs_test_app_url",
            });

            await createCheckoutSession("cus_123", "price_pro_month", "usr_456", "pro");

            expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    success_url: "https://canonical.elixent.com/dashboard?session_id={CHECKOUT_SESSION_ID}",
                    cancel_url: "https://canonical.elixent.com/account",
                })
            );
        });

        it("falls back to NEXT_PUBLIC_APP_URL for backward compatibility when both VITE_APP_URL and APP_URL are missing", async () => {
            delete process.env.VITE_APP_URL;
            delete process.env.APP_URL;
            process.env.NEXT_PUBLIC_APP_URL = "https://legacy.elixent.com";

            mockCheckoutSessionsCreate.mockResolvedValueOnce({
                id: "cs_test_next_url",
            });

            await createCheckoutSession("cus_123", "price_pro_month", "usr_456", "pro");

            expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    success_url: "https://legacy.elixent.com/dashboard?session_id={CHECKOUT_SESSION_ID}",
                    cancel_url: "https://legacy.elixent.com/account",
                })
            );
        });

        it("falls back to http://localhost:3000 when all URL environment variables are missing", async () => {
            delete process.env.VITE_APP_URL;
            delete process.env.APP_URL;
            delete process.env.NEXT_PUBLIC_APP_URL;

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

        it("normalizes https://localhost URLs to http:// to prevent local TLS handshake failures", async () => {
            process.env.VITE_APP_URL = "https://localhost:3000";

            mockCheckoutSessionsCreate.mockResolvedValueOnce({
                id: "cs_test_localhost",
            });

            await createCheckoutSession("cus_123", "price_pro_month", "usr_456", "pro");

            expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    success_url: "http://localhost:3000/dashboard?session_id={CHECKOUT_SESSION_ID}",
                    cancel_url: "http://localhost:3000/account",
                })
            );
        });

        it("preserves https:// for non-localhost remote URLs", async () => {
            process.env.VITE_APP_URL = "https://staging.elixent.com";

            mockCheckoutSessionsCreate.mockResolvedValueOnce({
                id: "cs_test_staging",
            });

            await createCheckoutSession("cus_123", "price_ultra_month", "usr_789", "ultra");

            expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    success_url: "https://staging.elixent.com/dashboard?session_id={CHECKOUT_SESSION_ID}",
                    cancel_url: "https://staging.elixent.com/account",
                    metadata: {
                        userId: "usr_789",
                        tier: "ultra",
                    },
                })
            );
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
});
