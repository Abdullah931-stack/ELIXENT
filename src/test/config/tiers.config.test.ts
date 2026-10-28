import { describe, it, expect } from "vitest";
import {
    TIER_LIMITS,
    getTierLimits,
    isToPromptEnabled,
    getTierDisplayName,
    type TierName,
} from "@/config/tiers.config";
import { MICRO_PER_CREDIT } from "@/lib/metering/constants";

describe("Tiers Configuration & Micro-Credit Allocation (Wave 4.2)", () => {
    const tiers: TierName[] = ["free", "pro", "ultra"];

    describe("Micro-Credit Allocations & Conversion Consistency", () => {
        it("defines valid micro-credit allocations for all subscription tiers", () => {
            expect(TIER_LIMITS.free.creditAllocationMicro).toBe(BigInt(50_000_000));
            expect(TIER_LIMITS.free.creditsDisplay).toBe(50);

            expect(TIER_LIMITS.pro.creditAllocationMicro).toBe(BigInt(1_000_000_000));
            expect(TIER_LIMITS.pro.creditsDisplay).toBe(1_000);

            expect(TIER_LIMITS.ultra.creditAllocationMicro).toBe(BigInt(3_500_000_000));
            expect(TIER_LIMITS.ultra.creditsDisplay).toBe(3_500);
        });

        it("strictly enforces 1 display credit = 1,000,000 micro-credits ratio across all tiers", () => {
            for (const tier of tiers) {
                const limits = TIER_LIMITS[tier];
                const expectedMicro = BigInt(limits.creditsDisplay) * MICRO_PER_CREDIT;
                expect(limits.creditAllocationMicro).toBe(expectedMicro);
            }
        });

        it("maintains strict ascending order of credit allocation with tier weights", () => {
            expect(TIER_LIMITS.free.creditAllocationMicro).toBeLessThan(
                TIER_LIMITS.pro.creditAllocationMicro
            );
            expect(TIER_LIMITS.pro.creditAllocationMicro).toBeLessThan(
                TIER_LIMITS.ultra.creditAllocationMicro
            );
        });
    });

    describe("Backwards Compatibility: Legacy Limits & Feature Flags", () => {
        it("returns correct tier limits via getTierLimits helper", () => {
            for (const tier of tiers) {
                expect(getTierLimits(tier)).toEqual(TIER_LIMITS[tier]);
            }
        });

        it("configures ToPrompt feature correctly according to tier specification", () => {
            expect(isToPromptEnabled("free")).toBe(false);
            expect(TIER_LIMITS.free.toPrompt).toBeNull();

            expect(isToPromptEnabled("pro")).toBe(true);
            expect(TIER_LIMITS.pro.toPrompt).toEqual({
                enabled: true,
                dailyLimit: 10,
            });

            expect(isToPromptEnabled("ultra")).toBe(true);
            expect(TIER_LIMITS.ultra.toPrompt).toEqual({
                enabled: true,
                dailyLimit: 500,
            });
        });

        it("returns standardized display names for UI presentation", () => {
            expect(getTierDisplayName("free")).toBe("Free");
            expect(getTierDisplayName("pro")).toBe("Pro");
            expect(getTierDisplayName("ultra")).toBe("Ultra");
        });

        it("preserves correct word and request quotas for legacy operations", () => {
            // Free: weekly window, 2000 words
            expect(TIER_LIMITS.free.correctImproveTranslate).toEqual({
                words: 2000,
                period: "weekly",
            });
            expect(TIER_LIMITS.free.summarize).toEqual({
                maxWordsPerRequest: 500,
                dailyLimit: 1,
            });
            expect(TIER_LIMITS.free.price.monthly).toBe(0);

            // Pro: daily window, 20000 words
            expect(TIER_LIMITS.pro.correctImproveTranslate).toEqual({
                words: 20000,
                period: "daily",
            });
            expect(TIER_LIMITS.pro.summarize).toEqual({
                maxWordsPerRequest: 5000,
                dailyLimit: 5,
            });
            expect(TIER_LIMITS.pro.price.monthly).toBe(12);

            // Ultra: daily window, 250000 words
            expect(TIER_LIMITS.ultra.correctImproveTranslate).toEqual({
                words: 250000,
                period: "daily",
            });
            expect(TIER_LIMITS.ultra.summarize).toEqual({
                maxWordsPerRequest: 30000,
                dailyLimit: 50,
            });
            expect(TIER_LIMITS.ultra.price.monthly).toBe(120);
        });
    });
});
