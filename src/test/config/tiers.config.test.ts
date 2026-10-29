import { describe, it, expect } from "vitest";
import {
    TIER_LIMITS,
    isToPromptEnabled,
    type TierName,
} from "@/config/tiers.config";
import { MICRO_PER_CREDIT } from "@/lib/metering/constants";

describe("Tiers Configuration & Micro-Credit Allocation (Wave 4.2)", () => {
    const tiers: TierName[] = ["free", "pro", "ultra"];

    describe("Micro-Credit Allocations & Conversion Consistency", () => {
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

    describe("Feature Flags & Capabilities", () => {
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
    });
});
