import { describe, it, expect, vi, beforeEach } from "vitest";
import { BillingService, type DbClient } from "@/server/services/billing-service";
import { executeStripeDualWrite } from "@/lib/metering/lua-scripts";

vi.mock("@/lib/metering/lua-scripts", () => ({
    executeStripeDualWrite: vi.fn(),
}));

describe("BillingService (Phase 12 Domain Logic)", () => {
    let mockDb: DbClient;

    beforeEach(() => {
        vi.mocked(executeStripeDualWrite).mockReset();

        // Clean, minimal typed stubs returning resolved promises directly
        mockDb = {
            select: vi.fn(() => ({
                from: vi.fn(() => ({
                    where: vi.fn(() => Object.assign(Promise.resolve([]), {
                        limit: vi.fn().mockResolvedValue([]),
                        orderBy: vi.fn().mockResolvedValue([]),
                    })),
                    orderBy: vi.fn().mockResolvedValue([]),
                })),
            })),
            insert: vi.fn(() => ({
                values: vi.fn(() => ({
                    onConflictDoNothing: vi.fn(() => ({
                        returning: vi.fn().mockResolvedValue([]),
                    })),
                    returning: vi.fn().mockResolvedValue([]),
                })),
            })),
            update: vi.fn(() => ({
                set: vi.fn(() => ({
                    where: vi.fn().mockResolvedValue([{ affected: 1 }]),
                })),
            })),
            delete: vi.fn(() => ({
                where: vi.fn().mockResolvedValue([]),
            })),
        } as unknown as DbClient;
    });

    describe("calculateEffectiveTier (MAX(tier) derivation)", () => {
        it.each([
            {
                description: "returns 'free' when user has no subscriptions",
                subscriptions: [],
                expectedTier: "free",
            },
            {
                description: "returns 'pro' when user has a single active Pro subscription",
                subscriptions: [{ tier: "pro", status: "active" }],
                expectedTier: "pro",
            },
            {
                description: "returns 'ultra' when user has BOTH an active Pro AND an active Ultra subscription (1:N MAX)",
                subscriptions: [
                    { tier: "pro", status: "active" },
                    { tier: "ultra", status: "active" },
                ],
                expectedTier: "ultra",
            },
            {
                description: "returns 'pro' when Ultra subscription is canceled but Pro subscription remains active",
                subscriptions: [
                    { tier: "pro", status: "active" },
                    { tier: "ultra", status: "canceled" },
                ],
                expectedTier: "pro",
            },
            {
                description: "returns 'pro' when Ultra subscription is past_due but Pro subscription is active",
                subscriptions: [
                    { tier: "pro", status: "active" },
                    { tier: "ultra", status: "past_due" },
                ],
                expectedTier: "pro",
            },
            {
                description: "accepts 'trialing' subscriptions as active tier entitlement",
                subscriptions: [{ tier: "ultra", status: "trialing" }],
                expectedTier: "ultra",
            },
            {
                description: "ignores 'paused' subscription status when calculating active tier",
                subscriptions: [{ tier: "ultra", status: "paused" }],
                expectedTier: "free",
            },
        ])("$description", async ({ subscriptions, expectedTier }) => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () => Promise.resolve(subscriptions),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe(expectedTier);
        });
    });

    describe("resolveUserId (Multi-source resolution)", () => {
        it.each([
            {
                name: "prefers metadataUserId over all other sources",
                options: {
                    metadataUserId: "direct-user-id",
                    subscriptionDetailsUserId: "ignored-id",
                    stripeCustomerId: "cus_123",
                    stripeSubscriptionId: "sub_123",
                },
                dbReturns: [],
                expected: "direct-user-id",
            },
            {
                name: "falls back to subscriptionDetailsUserId if metadataUserId is missing",
                options: {
                    subscriptionDetailsUserId: "sub-details-user-id",
                    stripeCustomerId: "cus_123",
                },
                dbReturns: [],
                expected: "sub-details-user-id",
            },
            {
                name: "resolves userId via stripeCustomerId from users table (LUGX-141)",
                options: {
                    stripeCustomerId: "cus_known",
                },
                dbReturns: [[{ id: "user-via-customer" }]],
                expected: "user-via-customer",
            },
            {
                name: "resolves userId via stripeSubscriptionId from subscriptions table",
                options: {
                    stripeCustomerId: "cus_unknown",
                    stripeSubscriptionId: "sub_known",
                },
                dbReturns: [[], [{ userId: "user-via-sub" }]],
                expected: "user-via-sub",
            },
            {
                name: "returns null if no sources match",
                options: {},
                dbReturns: [[]],
                expected: null,
            },
        ])("$name", async ({ options, dbReturns, expected }) => {
            let callCount = 0;
            vi.mocked(mockDb.select).mockImplementation(() => ({
                from: () => ({
                    where: () => ({
                        limit: () => Promise.resolve(dbReturns[callCount++] ?? []),
                    }),
                }),
            } as any));

            const resolved = await BillingService.resolveUserId(options, mockDb);
            expect(resolved).toBe(expected);
        });
    });

    describe("handleCancellation (Preserving 1:N multi-subscriptions)", () => {
        it("retains Pro tier if Ultra subscription is canceled but user still holds active Pro sub", async () => {
            vi.mocked(mockDb.select)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () =>
                                Promise.resolve([
                                    { id: "sub-ultra-id", userId: "user-1", stripeSubscriptionId: "sub_ultra" },
                                ]),
                        }),
                    }),
                } as any)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () =>
                            Promise.resolve([
                                { tier: "free", status: "canceled" },
                                { tier: "pro", status: "active" },
                            ]),
                    }),
                } as any);

            const result = await BillingService.handleCancellation("sub_ultra", "user-1", mockDb);

            expect(result.success).toBe(true);
            expect(result.effectiveTier).toBe("pro");
        });

        it("downgrades to free if user has no remaining active subscriptions", async () => {
            vi.mocked(mockDb.select)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () =>
                                Promise.resolve([
                                    { id: "sub-sole-id", userId: "user-1", stripeSubscriptionId: "sub_sole" },
                                ]),
                        }),
                    }),
                } as any)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () =>
                            Promise.resolve([
                                { tier: "free", status: "canceled" },
                            ]),
                    }),
                } as any);

            const result = await BillingService.handleCancellation("sub_sole", "user-1", mockDb);

            expect(result.success).toBe(true);
            expect(result.effectiveTier).toBe("free");
        });

        it("throws error if userId cannot be resolved", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () => ({
                        limit: () => Promise.resolve([]),
                    }),
                }),
            } as any);

            await expect(
                BillingService.handleCancellation("sub_phantom", null, mockDb)
            ).rejects.toThrow("userId unresolved");
        });
    });

    describe("handleInvoicePaymentFailed (Grace period preservation - LUGX-026)", () => {
        it("marks subscription as past_due and preserves other active subscriptions", async () => {
            vi.mocked(mockDb.select)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () =>
                                Promise.resolve([
                                    { id: "sub-1-id", userId: "user-1", stripeSubscriptionId: "sub_failed" },
                                ]),
                        }),
                    }),
                } as any)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () =>
                            Promise.resolve([
                                { tier: "pro", status: "past_due" },
                            ]),
                    }),
                } as any);

            const result = await BillingService.handleInvoicePaymentFailed(
                {
                    userId: "user-1",
                    stripeSubscriptionId: "sub_failed",
                },
                mockDb
            );

            expect(result.success).toBe(true);
            expect(result.effectiveTier).toBe("free");
            expect(result.subscriptionId).toBe("sub_failed");
        });
    });

    describe("recordCreditTopup & executeRedisDualWrite (Wave 4.2 Stripe Dual-Write Protocol)", () => {
        describe("recordCreditTopup (PostgreSQL Ledger Step 1)", () => {
            it("atomically inserts ledger transaction and increments user creditBalanceMicro on fresh event", async () => {
                const allocationMicro = BigInt(1_000_000_000); // 1,000 display credits (Pro)
                const mockRow = {
                    id: "tx_topup_1",
                    operationId: "stripe_topup_evt_topup_fresh_1",
                    userId: "user-1",
                    modelId: "system/stripe-topup",
                    executionMode: "CREDIT_TOPUP",
                    status: "TOPUP_APPLIED",
                    deltaMicro: allocationMicro,
                    createdAt: new Date(),
                };

                vi.mocked(mockDb.insert).mockReturnValueOnce({
                    values: () => ({
                        onConflictDoNothing: () => ({
                            returning: async () => [mockRow],
                        }),
                    }),
                } as any);

                const result = await BillingService.recordCreditTopup(
                    {
                        userId: "user-1",
                        eventId: "evt_topup_fresh_1",
                        allocationMicro,
                    },
                    mockDb
                );

                expect(result.applied).toBe(true);
                expect(result.row).toBeDefined();
                expect(result.row?.operationId).toBe("stripe_topup_evt_topup_fresh_1");
                expect(result.row?.modelId).toBe("system/stripe-topup");
                expect(result.row?.executionMode).toBe("CREDIT_TOPUP");
                expect(result.row?.status).toBe("TOPUP_APPLIED");
                expect(result.row?.deltaMicro).toBe(allocationMicro);
                expect(mockDb.update).toHaveBeenCalled();
            });

            it("enforces ON CONFLICT DO NOTHING idempotency: duplicate event returns applied=false without balance mutation", async () => {
                const allocationMicro = BigInt(500_000_000);
                const eventId = "evt_topup_duplicate_idempotent";

                // Duplicate event returns empty array from onConflictDoNothing().returning()
                vi.mocked(mockDb.insert).mockReturnValueOnce({
                    values: () => ({
                        onConflictDoNothing: () => ({
                            returning: async () => [],
                        }),
                    }),
                } as any);

                const result = await BillingService.recordCreditTopup(
                    {
                        userId: "user-1",
                        eventId,
                        allocationMicro,
                    },
                    mockDb
                );

                expect(result.applied).toBe(false);
                expect(result.row).toBeUndefined();
            });

            it("rejects zero or negative micro-credit allocations without database interaction", async () => {
                const zeroResult = await BillingService.recordCreditTopup(
                    {
                        userId: "user-1",
                        eventId: "evt_zero",
                        allocationMicro: BigInt(0),
                    },
                    mockDb
                );
                expect(zeroResult.applied).toBe(false);

                const negResult = await BillingService.recordCreditTopup(
                    {
                        userId: "user-1",
                        eventId: "evt_negative",
                        allocationMicro: BigInt(-100_000),
                    },
                    mockDb
                );
                expect(negResult.applied).toBe(false);
            });

            it("propagates database errors to trigger atomic transaction rollback", async () => {
                vi.mocked(mockDb.insert).mockReturnValueOnce({
                    values: () => ({
                        onConflictDoNothing: () => ({
                            returning: async () => {
                                throw new Error("Neon connection timeout during top-up ledger insert");
                            },
                        }),
                    }),
                } as any);

                await expect(
                    BillingService.recordCreditTopup(
                        {
                            userId: "user-1",
                            eventId: "evt_db_error",
                            allocationMicro: BigInt(1_000_000_000),
                        },
                        mockDb
                    )
                ).rejects.toThrow("Neon connection timeout during top-up ledger insert");
            });
        });

        describe("executeRedisDualWrite (Upstash Redis Step 2)", () => {
            it("triggers executeStripeDualWrite with userId and positive topupMicro", async () => {
                vi.mocked(executeStripeDualWrite).mockResolvedValueOnce({
                    applied: true,
                    newBalanceMicro: 1_000_000_000,
                });

                await BillingService.executeRedisDualWrite({
                    userId: "user-1",
                    topupMicro: BigInt(1_000_000_000),
                });

                expect(executeStripeDualWrite).toHaveBeenCalledWith({
                    userId: "user-1",
                    topupMicro: BigInt(1_000_000_000),
                });
            });

            it("skips Redis execution when topupMicro is zero or negative", async () => {
                await BillingService.executeRedisDualWrite({
                    userId: "user-1",
                    topupMicro: BigInt(0),
                });
                expect(executeStripeDualWrite).not.toHaveBeenCalled();

                await BillingService.executeRedisDualWrite({
                    userId: "user-1",
                    topupMicro: BigInt(-500),
                });
                expect(executeStripeDualWrite).not.toHaveBeenCalled();
            });

            it("fails open gracefully without throwing when Redis dual-write throws error", async () => {
                vi.mocked(executeStripeDualWrite).mockRejectedValueOnce(
                    new Error("Upstash REST connection ECONNREFUSED")
                );

                // Must not throw — Postgres commit is authoritative, Redis will hydrate on cold start
                await expect(
                    BillingService.executeRedisDualWrite({
                        userId: "user-1",
                        topupMicro: BigInt(500_000_000),
                    })
                ).resolves.toBeUndefined();

                expect(executeStripeDualWrite).toHaveBeenCalledWith({
                    userId: "user-1",
                    topupMicro: BigInt(500_000_000),
                });
            });
        });
    });
});
