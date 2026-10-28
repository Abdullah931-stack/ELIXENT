/**
 * Tier Configuration
 * 
 * Defines usage limits for each subscription tier as specified in the
 * LUGX platform subscription plans document.
 */

export type TierName = "free" | "pro" | "ultra";

export interface TierLimits {
    creditAllocationMicro: bigint;
    creditsDisplay: number;
    // Combined limit for Correct, Improve, Translate operations
    correctImproveTranslate: {
        words: number;
        period: "daily" | "weekly";
    };
    // Summarize operation limits
    summarize: {
        maxWordsPerRequest: number;
        dailyLimit: number;
    };
    // ToPrompt operation limits (null if disabled)
    toPrompt: {
        enabled: boolean;
        dailyLimit: number;
    } | null;
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
        correctImproveTranslate: {
            words: 2000,
            period: "weekly",
        },
        summarize: {
            maxWordsPerRequest: 500,
            dailyLimit: 1,
        },
        toPrompt: null, // Feature disabled and hidden
        price: {
            monthly: 0,
        },
    },
    pro: {
        creditAllocationMicro: BigInt(1_000_000_000),
        creditsDisplay: 1_000,
        correctImproveTranslate: {
            words: 20000,
            period: "daily",
        },
        summarize: {
            maxWordsPerRequest: 5000,
            dailyLimit: 5,
        },
        toPrompt: {
            enabled: true,
            dailyLimit: 10,
        },
        price: {
            monthly: 12,
            originalPrice: 15,
            discount: 20, // 20% off
        },
    },
    ultra: {
        creditAllocationMicro: BigInt(3_500_000_000),
        creditsDisplay: 3_500,
        correctImproveTranslate: {
            words: 250000,
            period: "daily",
        },
        summarize: {
            maxWordsPerRequest: 30000,
            dailyLimit: 50,
        },
        toPrompt: {
            enabled: true,
            dailyLimit: 500,
        },
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
 * Check if ToPrompt feature is enabled for a tier
 */
export function isToPromptEnabled(tier: TierName): boolean {
    const limits = TIER_LIMITS[tier];
    return limits.toPrompt !== null && limits.toPrompt.enabled;
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
