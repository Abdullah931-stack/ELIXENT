import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    recordCreditTopup,
    executeRedisDualWrite,
    recordSubscriptionEvent,
} from "@/server/actions/subscription-actions";
import { BillingService } from "@/server/services/billing-service";
import * as schema from "@/server/db/schema";

vi.mock("@/server/services/billing-service", () => ({
    BillingService: {
        recordCreditTopup: vi.fn(),
        executeRedisDualWrite: vi.fn(),
    },
}));

describe("Subscription Actions & Stripe Top-Up Delegation (Wave 4.2)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("recordCreditTopup", () => {
        it("delegates to BillingService.recordCreditTopup with provided parameters and client", async () => {
            const mockResult = {
                applied: true,
                row: {
                    id: "tx-123",
                    operationId: "stripe_topup_evt_1",
                    userId: "user-1",
                    modelId: "system/stripe-topup",
                    executionMode: "CREDIT_TOPUP",
                    status: "TOPUP_APPLIED",
                    deltaMicro: BigInt(1_000_000_000),
                    createdAt: new Date(),
                } as unknown as schema.CreditLedgerTransaction,
            };

            vi.mocked(BillingService.recordCreditTopup).mockResolvedValueOnce(mockResult);

            const mockClient = { select: vi.fn(), insert: vi.fn(), update: vi.fn() } as any;

            const res = await recordCreditTopup(
                {
                    userId: "user-1",
                    eventId: "evt_1",
                    allocationMicro: BigInt(1_000_000_000),
                },
                mockClient
            );

            expect(BillingService.recordCreditTopup).toHaveBeenCalledWith(
                {
                    userId: "user-1",
                    eventId: "evt_1",
                    allocationMicro: BigInt(1_000_000_000),
                },
                mockClient
            );
            expect(res).toEqual(mockResult);
        });

        it("propagates error when BillingService.recordCreditTopup fails", async () => {
            vi.mocked(BillingService.recordCreditTopup).mockRejectedValueOnce(
                new Error("Database transaction rolled back")
            );

            await expect(
                recordCreditTopup({
                    userId: "user-1",
                    eventId: "evt_fail",
                    allocationMicro: BigInt(500_000_000),
                })
            ).rejects.toThrow("Database transaction rolled back");
        });
    });

    describe("executeRedisDualWrite", () => {
        it("delegates to BillingService.executeRedisDualWrite with provided parameters", async () => {
            vi.mocked(BillingService.executeRedisDualWrite).mockResolvedValueOnce();

            await executeRedisDualWrite({
                userId: "user-1",
                topupMicro: BigInt(1_000_000_000),
            });

            expect(BillingService.executeRedisDualWrite).toHaveBeenCalledWith({
                userId: "user-1",
                topupMicro: BigInt(1_000_000_000),
            });
        });

        it("resolves safely when BillingService.executeRedisDualWrite encounters non-fatal warning", async () => {
            vi.mocked(BillingService.executeRedisDualWrite).mockResolvedValueOnce();

            await expect(
                executeRedisDualWrite({
                    userId: "user-2",
                    topupMicro: BigInt(500_000_000),
                })
            ).resolves.toBeUndefined();
        });
    });

    describe("recordSubscriptionEvent duplicate detection", () => {
        it("catches unique constraint violation and returns duplicate: true", async () => {
            const mockDb = {
                insert: vi.fn(() => ({
                    values: vi.fn(async () => {
                        throw new Error("duplicate key value violates unique constraint idx_subscription_events_event_id");
                    }),
                })),
            } as any;

            const res = await recordSubscriptionEvent(
                {
                    eventId: "evt_dup",
                    eventType: "checkout.session.completed",
                },
                mockDb
            );

            expect(res.success).toBe(false);
            expect(res.duplicate).toBe(true);
            expect(res.error).toBe("Duplicate event ID");
        });
    });
});
