import { describe, it, expect } from "vitest";
import {
    TIER_LIMITS,
    getTierLimits,
    getTierDisplayName,
    type TierName,
} from "@/config/tiers.config";
import { MICRO_PER_CREDIT } from "@/lib/metering/constants";

describe("Tiers Configuration & Micro-Credit Allocation (Elixent)", () => {
    const tiers: TierName[] = ["free", "pro", "ultra"];

    describe("Micro-Credit Allocations & Conversion Consistency", () => {
        it("strictly enforces 1 display credit = 1,000,000 micro-credits ratio across all tiers", () => {
            for (const tier of tiers) {
                const limits = TIER_LIMITS[tier];
                const expectedMicro = BigInt(limits.creditsDisplay) * MICRO_PER_CREDIT;
                expect(limits.creditAllocationMicro).toBe(expectedMicro);
            }
        });

        it("maintains exact canonical micro-credit allocations for free (50), pro (1,000), and ultra (3,500)", () => {
            expect(TIER_LIMITS.free.creditsDisplay).toBe(50);
            expect(TIER_LIMITS.free.creditAllocationMicro).toBe(BigInt(50_000_000));

            expect(TIER_LIMITS.pro.creditsDisplay).toBe(1_000);
            expect(TIER_LIMITS.pro.creditAllocationMicro).toBe(BigInt(1_000_000_000));

            expect(TIER_LIMITS.ultra.creditsDisplay).toBe(3_500);
            expect(TIER_LIMITS.ultra.creditAllocationMicro).toBe(BigInt(3_500_000_000));
        });

        it("maintains strict ascending order of credit allocation and pricing with tier weights", () => {
            expect(TIER_LIMITS.free.creditAllocationMicro).toBeLessThan(
                TIER_LIMITS.pro.creditAllocationMicro
            );
            expect(TIER_LIMITS.pro.creditAllocationMicro).toBeLessThan(
                TIER_LIMITS.ultra.creditAllocationMicro
            );
            expect(TIER_LIMITS.free.price.monthly).toBeLessThan(
                TIER_LIMITS.pro.price.monthly
            );
            expect(TIER_LIMITS.pro.price.monthly).toBeLessThan(
                TIER_LIMITS.ultra.price.monthly
            );
        });
    });

    describe("Tier Lookup Helpers & Pricing Metadata", () => {
        it("returns accurate tier limits and pricing metadata via getTierLimits", () => {
            expect(getTierLimits("free")).toEqual({
                creditAllocationMicro: BigInt(50_000_000),
                creditsDisplay: 50,
                price: { monthly: 0 },
            });

            expect(getTierLimits("pro")).toEqual({
                creditAllocationMicro: BigInt(1_000_000_000),
                creditsDisplay: 1_000,
                price: {
                    monthly: 12,
                    originalPrice: 15,
                    discount: 20,
                },
            });

            expect(getTierLimits("ultra")).toEqual({
                creditAllocationMicro: BigInt(3_500_000_000),
                creditsDisplay: 3_500,
                price: {
                    monthly: 120,
                    originalPrice: 160,
                    discount: 25,
                },
            });
        });

        it("returns canonical human-readable display names via getTierDisplayName", () => {
            expect(getTierDisplayName("free")).toBe("Free");
            expect(getTierDisplayName("pro")).toBe("Pro");
            expect(getTierDisplayName("ultra")).toBe("Ultra");
        });
    });
});

