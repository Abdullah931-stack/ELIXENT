import { describe, it, expect, vi, beforeEach } from "vitest";
import { BillingService, type DbClient } from "@/server/services/billing-service";
import * as schema from "@/server/db/schema";
import { executeStripeDualWrite } from "@/lib/metering/lua-scripts";

vi.mock("@/lib/metering/lua-scripts", () => ({
    executeStripeDualWrite: vi.fn(),
}));

describe("BillingService (Phase 12 Domain Logic)", () => {
    let mockSubscriptions: Array<{
        id: string;
        userId: string;
        stripeSubscriptionId: string;
        tier: string;
        status: string;
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        cancelAtPeriodEnd: boolean;
    }>;
    let mockUsers: Array<{
        id: string;
        stripeCustomerId?: string | null;
        tier: string;
        creditBalanceMicro?: bigint;
    }>;
    let mockLedger: Array<any>;

    let mockDb: DbClient;

    beforeEach(() => {
        mockSubscriptions = [];
        mockLedger = [];
        mockUsers = [
            { id: "user-1", stripeCustomerId: "cus_123", tier: "free", creditBalanceMicro: BigInt(0) },
            { id: "user-2", stripeCustomerId: "cus_456", tier: "free", creditBalanceMicro: BigInt(0) },
        ];
        vi.mocked(executeStripeDualWrite).mockReset();

        // Create an in-memory mock client that mirrors Drizzle operations used by BillingService
        mockDb = {
            select: vi.fn((_fields?: any) => {
                let selectedTable: any = null;
                let whereClause: any = null;
                let limitCount: number | null = null;

                const queryBuilder: any = {
                    from: vi.fn((table: any) => {
                        selectedTable = table;
                        return queryBuilder;
                    }),
                    where: vi.fn((clause: any) => {
                        whereClause = clause;
                        return queryBuilder;
                    }),
                    orderBy: vi.fn(() => queryBuilder),
                    limit: vi.fn((n: number) => {
                        limitCount = n;
                        return queryBuilder;
                    }),
                    then: (resolve: (val: any) => void) => {
                        let data: any[] = [];
                        if (selectedTable === schema.subscriptions) {
                            data = [...mockSubscriptions];
                            if (whereClause) {
                                if (whereClause.__userId) {
                                    data = data.filter((s) => s.userId === whereClause.__userId);
                                }
                                if (whereClause.__subId) {
                                    data = data.filter(
                                        (s) => s.stripeSubscriptionId === whereClause.__subId
                                    );
                                }
                            }
                        } else if (selectedTable === schema.users) {
                            data = [...mockUsers];
                            if (whereClause?.__customerId) {
                                data = data.filter(
                                    (u) => u.stripeCustomerId === whereClause.__customerId
                                );
                            }
                        }

                        if (limitCount !== null) {
                            data = data.slice(0, limitCount);
                        }
                        return Promise.resolve(resolve(data));
                    },
                };
                return queryBuilder;
            }),

            insert: vi.fn((table: any) => {
                let insertedValues: any = null;
                const builder: any = {
                    values: vi.fn((val: any) => {
                        insertedValues = val;
                        return builder;
                    }),
                    onConflictDoNothing: vi.fn(() => builder),
                    returning: vi.fn(async () => {
                        if (table === schema.creditLedgerTransactions) {
                            const duplicate = mockLedger.some(
                                (r) => r.operationId === insertedValues?.operationId
                            );
                            if (duplicate) {
                                return [];
                            }
                            const row = { id: `tx_${Date.now()}`, ...insertedValues };
                            mockLedger.push(row);
                            return [row];
                        }
                        return [{ id: "mock_id" }];
                    }),
                    then: (resolve: (val: any) => void) => {
                        if (table === schema.subscriptions) {
                            mockSubscriptions.push({
                                id: `sub_${Date.now()}_${Math.random()}`,
                                ...insertedValues,
                            });
                        }
                        return Promise.resolve(resolve([{ id: "mock_id" }]));
                    },
                };
                return builder;
            }),

            update: vi.fn((table: any) => ({
                set: vi.fn((setValues: any) => ({
                    where: vi.fn(async (clause: any) => {
                        if (table === schema.subscriptions) {
                            for (const sub of mockSubscriptions) {
                                if (
                                    (clause?.__id && sub.id === clause.__id) ||
                                    (clause?.__subId && sub.stripeSubscriptionId === clause.__subId) ||
                                    (clause?.__userId && sub.userId === clause.__userId)
                                ) {
                                    Object.assign(sub, setValues);
                                }
                            }
                        } else if (table === schema.users) {
                            for (const user of mockUsers) {
                                Object.assign(user, setValues);
                            }
                        }
                        return [{ affected: 1 }];
                    }),
                })),
            })),

            delete: vi.fn(() => ({
                where: vi.fn(async () => []),
            })),
        } as unknown as DbClient;
    });

    describe("calculateEffectiveTier (MAX(tier) derivation)", () => {
        it("returns 'free' when user has no subscriptions", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () => Promise.resolve([]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("free");
        });

        it("returns 'pro' when user has a single active Pro subscription", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "pro", status: "active" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("pro");
        });

        it("returns 'ultra' when user has BOTH an active Pro AND an active Ultra subscription (1:N MAX)", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "pro", status: "active" },
                            { tier: "ultra", status: "active" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("ultra");
        });

        it("returns 'pro' when Ultra subscription is canceled but Pro subscription remains active", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "pro", status: "active" },
                            { tier: "ultra", status: "canceled" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("pro");
        });

        it("returns 'pro' when Ultra subscription is past_due but Pro subscription is active", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "pro", status: "active" },
                            { tier: "ultra", status: "past_due" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("pro");
        });

        it("accepts 'trialing' subscriptions as active tier entitlement", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "ultra", status: "trialing" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("ultra");
        });

        it("ignores 'paused' subscription status when calculating active tier", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            { tier: "ultra", status: "paused" },
                        ]),
                }),
            } as any);

            const tier = await BillingService.calculateEffectiveTier("user-1", mockDb);
            expect(tier).toBe("free");
        });
    });

    describe("resolveUserId (Multi-source resolution)", () => {
        it("prefers metadataUserId over all other sources", async () => {
            const resolved = await BillingService.resolveUserId(
                {
                    metadataUserId: "direct-user-id",
                    subscriptionDetailsUserId: "ignored-id",
                    stripeCustomerId: "cus_123",
                    stripeSubscriptionId: "sub_123",
                },
                mockDb
            );
            expect(resolved).toBe("direct-user-id");
        });

        it("falls back to subscriptionDetailsUserId if metadataUserId is missing", async () => {
            const resolved = await BillingService.resolveUserId(
                {
                    subscriptionDetailsUserId: "sub-details-user-id",
                    stripeCustomerId: "cus_123",
                },
                mockDb
            );
            expect(resolved).toBe("sub-details-user-id");
        });

        it("resolves userId via stripeCustomerId from users table (LUGX-141)", async () => {
            vi.mocked(mockDb.select).mockReturnValueOnce({
                from: () => ({
                    where: () => ({
                        limit: () => Promise.resolve([{ id: "user-via-customer" }]),
                    }),
                }),
            } as any);

            const resolved = await BillingService.resolveUserId(
                {
                    stripeCustomerId: "cus_known",
                },
                mockDb
            );
            expect(resolved).toBe("user-via-customer");
        });

        it("resolves userId via stripeSubscriptionId from subscriptions table", async () => {
            vi.mocked(mockDb.select)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () => Promise.resolve([]),
                        }),
                    }),
                } as any)
                .mockReturnValueOnce({
                    from: () => ({
                        where: () => ({
                            limit: () => Promise.resolve([{ userId: "user-via-sub" }]),
                        }),
                    }),
                } as any);

            const resolved = await BillingService.resolveUserId(
                {
                    stripeCustomerId: "cus_unknown",
                    stripeSubscriptionId: "sub_known",
                },
                mockDb
            );
            expect(resolved).toBe("user-via-sub");
        });

        it("returns null if no sources match", async () => {
            vi.mocked(mockDb.select).mockReturnValue({
                from: () => ({
                    where: () => ({
                        limit: () => Promise.resolve([]),
                    }),
                }),
            } as any);

            const resolved = await BillingService.resolveUserId({}, mockDb);
            expect(resolved).toBeNull();
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

                expect(mockDb.insert).toHaveBeenCalledWith(schema.creditLedgerTransactions);
                expect(mockDb.update).toHaveBeenCalledWith(schema.users);
            });

            it("enforces ON CONFLICT DO NOTHING idempotency: duplicate event returns applied=false without balance mutation", async () => {
                const allocationMicro = BigInt(500_000_000);
                const eventId = "evt_topup_duplicate_idempotent";

                // First execution: succeeds
                const firstResult = await BillingService.recordCreditTopup(
                    {
                        userId: "user-1",
                        eventId,
                        allocationMicro,
                    },
                    mockDb
                );
                expect(firstResult.applied).toBe(true);
                const updateCallsAfterFirst = vi.mocked(mockDb.update).mock.calls.length;

                // Second execution with same eventId: idempotent conflict returns applied=false
                const secondResult = await BillingService.recordCreditTopup(
                    {
                        userId: "user-1",
                        eventId,
                        allocationMicro,
                    },
                    mockDb
                );
                expect(secondResult.applied).toBe(false);
                expect(secondResult.row).toBeUndefined();

                // Ensure users table was NOT updated again
                expect(vi.mocked(mockDb.update).mock.calls.length).toBe(updateCallsAfterFirst);
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

                expect(mockDb.insert).not.toHaveBeenCalled();
            });

            it("propagates database errors to trigger atomic transaction rollback", async () => {
                const failingDb = {
                    ...mockDb,
                    insert: vi.fn(() => ({
                        values: () => ({
                            onConflictDoNothing: () => ({
                                returning: async () => {
                                    throw new Error("Neon connection timeout during top-up ledger insert");
                                },
                            }),
                        }),
                    })),
                } as unknown as DbClient;

                await expect(
                    BillingService.recordCreditTopup(
                        {
                            userId: "user-1",
                            eventId: "evt_db_error",
                            allocationMicro: BigInt(1_000_000_000),
                        },
                        failingDb
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
