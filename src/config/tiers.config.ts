/**
 * Tier Configuration
 *
 * Defines Micro-Credit allocations and pricing for each subscription tier in Elixent.
 */

export type TierName = "free" | "pro" | "ultra";

export interface TierLimits {
    creditAllocationMicro: bigint;
    creditsDisplay: number;
    // Price information
    price: {
        monthly: number;
        originalPrice?: number;
        discount?: number;
    };
}

export const TIER_LIMITS: Record<TierName, TierLimits> = {
    free: {
        creditAllocationMicro: BigInt(50_000_000),
        creditsDisplay: 50,
        price: {
            monthly: 0,
        },
    },
    pro: {
        creditAllocationMicro: BigInt(1_000_000_000),
        creditsDisplay: 1_000,
        price: {
            monthly: 12,
            originalPrice: 15,
            discount: 20, // 20% off
        },
    },
    ultra: {
        creditAllocationMicro: BigInt(3_500_000_000),
        creditsDisplay: 3_500,
        price: {
            monthly: 120,
            originalPrice: 160,
            discount: 25, // 25% off
        },
    },
};

/**
 * Get tier limits for a specific tier
 */
export function getTierLimits(tier: TierName): TierLimits {
    return TIER_LIMITS[tier];
}

/**
 * Get the display name for a tier
 */
export function getTierDisplayName(tier: TierName): string {
    const names: Record<TierName, string> = {
        free: "Free",
        pro: "Pro",
        ultra: "Ultra",
    };
    return names[tier];
}
