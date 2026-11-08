import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { getUserProfile, signOut } from "@/server/actions/auth-actions";
import { getUserCreditBalance } from "@/server/services/ai-settlement-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TIER_LIMITS, type TierName, getTierDisplayName } from "@/config/tiers.config";
import { MICRO_PER_CREDIT } from "@/lib/metering/constants";
import { ArrowLeft, User, CreditCard, LogOut, Check, Coins } from "lucide-react";
import { UpgradeButton } from "@/components/subscription/upgrade-button";
import { VaultSecurityCard } from "@/components/vault";
import { OcrSettingsCard } from "@/components/layout/ocr-settings-card";

export default async function AccountPage() {
    const user = await getUser();

    if (!user) {
        redirect("/login");
    }

    const [profileResult, balanceMicro] = await Promise.all([
        getUserProfile(),
        getUserCreditBalance(user.id),
    ]);

    const profile = profileResult.data;
    const currentTier: TierName = (profile?.tier as TierName) || "free";
    const limits = TIER_LIMITS[currentTier];
    const currentCredits = Number(balanceMicro / MICRO_PER_CREDIT);
    const tierCredits = limits.creditsDisplay;
    const percentageRemaining =
        tierCredits > 0
            ? Math.min(Math.max(0, Math.round((currentCredits / tierCredits) * 100)), 100)
            : 0;

    return (
        <div className="min-h-screen bg-zinc-950">
            {/* Navigation */}
            <nav className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-lg">
                <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-16">
                        <div className="flex items-center gap-4">
                            <Link href="/dashboard">
                                <Button variant="ghost" size="icon-sm">
                                    <ArrowLeft className="w-4 h-4" />
                                </Button>
                            </Link>
                            <Link href="/dashboard">
                                <Image
                                    src="/logo.png"
                                    alt="LUGX"
                                    width={80}
                                    height={24}
                                    className="h-6 w-auto"
                                    style={{ width: "auto" }}
                                />
                            </Link>
                        </div>

                        <form
                            action={async () => {
                                "use server";
                                await signOut();
                                redirect("/");
                            }}
                        >
                            <Button type="submit" variant="ghost" size="sm" className="gap-2">
                                <LogOut className="w-4 h-4" />
                                Sign Out
                            </Button>
                        </form>
                    </div>
                </div>
            </nav>

            {/* Main Content */}
            <main className="pt-24 pb-12 px-4 max-w-4xl mx-auto">
                <h1 className="text-2xl font-medium text-zinc-50 mb-8">Account Settings</h1>

                <div className="space-y-6">
                    {/* Profile Section */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <User className="w-5 h-5" />
                                Profile
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center gap-4">
                                {profile?.avatarUrl ? (
                                    <Image
                                        src={profile.avatarUrl}
                                        alt={profile.displayName || "User"}
                                        width={64}
                                        height={64}
                                        className="rounded-full"
                                    />
                                ) : (
                                    <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400 text-xl">
                                        {profile?.displayName?.[0]?.toUpperCase() || "U"}
                                    </div>
                                )}
                                <div>
                                    <h3 className="font-medium text-zinc-50">
                                        {profile?.displayName || "User"}
                                    </h3>
                                    <p className="text-sm text-zinc-500">{profile?.email}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Vault Security & Trusted Devices */}
                    <VaultSecurityCard userId={user.id} />

                    {/* Document Processing & OCR Settings */}
                    <OcrSettingsCard />

                    {/* Subscription Section */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <CreditCard className="w-5 h-5" />
                                Subscription & AI Credits
                            </CardTitle>
                            <CardDescription>
                                Manage your plan and architectural AI credit settlement
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center justify-between p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 mb-6">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-lg font-medium text-zinc-50 capitalize">
                                            {getTierDisplayName(currentTier)}
                                        </span>
                                        {currentTier === "ultra" && (
                                            <span className="text-xs px-2 py-0.5 rounded-full ultra-badge">
                                                ✦
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-sm text-zinc-500 mt-1">
                                        ${TIER_LIMITS[currentTier].price.monthly}/month
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    {/* Show Pro button if user is on Free */}
                                    {currentTier === "free" && (
                                        <UpgradeButton
                                            tier="pro"
                                            currentTier={currentTier}
                                        />
                                    )}
                                    {/* Show Ultra button if user is on Free or Pro */}
                                    {currentTier !== "ultra" && (
                                        <UpgradeButton
                                            tier="ultra"
                                            currentTier={currentTier}
                                        />
                                    )}
                                </div>
                            </div>

                            {/* Micro-Credit Metered AI Settlement */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-sm font-medium text-zinc-400 flex items-center gap-1.5">
                                        <Coins className="w-4 h-4 text-indigo-400" />
                                        Micro-Credit Metered AI Settlement
                                    </h4>
                                    <span className="text-xs font-mono text-zinc-400">
                                        Tier: <span className="text-zinc-200 font-semibold">{currentTier.toUpperCase()}</span>
                                    </span>
                                </div>

                                <div>
                                    <div className="flex justify-between text-sm mb-1.5">
                                        <span className="text-zinc-400">Current Balance</span>
                                        <span className="text-zinc-200 font-medium font-mono">
                                            {currentCredits.toLocaleString()} / {tierCredits.toLocaleString()} Credits
                                        </span>
                                    </div>
                                    <div className="h-2.5 bg-zinc-800 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
                                            style={{ width: `${percentageRemaining}%` }}
                                        />
                                    </div>
                                    <div className="flex justify-between text-xs text-zinc-500 mt-2">
                                        <span>Allocation resets each monthly billing cycle</span>
                                        <span className="font-mono">{percentageRemaining}% remaining</span>
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Plan Comparison */}
                    <Card>
                        <CardHeader>
                            <CardTitle>Available Plans</CardTitle>
                            <CardDescription>
                                Compare architectural credit allocations and upgrade your plan
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="grid md:grid-cols-3 gap-4">
                                {(["free", "pro", "ultra"] as const).map((tier) => {
                                    const tierConfig = TIER_LIMITS[tier];
                                    const isCurrentPlan = currentTier === tier;

                                    return (
                                        <div
                                            key={tier}
                                            className={`p-4 rounded-lg border ${
                                                isCurrentPlan
                                                    ? "border-indigo-500/50 bg-indigo-500/5"
                                                    : "border-zinc-800"
                                            }`}
                                        >
                                            <div className="flex items-center justify-between mb-3">
                                                <span className="font-medium text-zinc-50 capitalize">
                                                    {getTierDisplayName(tier)}
                                                </span>
                                                {isCurrentPlan && (
                                                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">
                                                        Current
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-2xl font-medium text-zinc-50 mb-3">
                                                ${tierConfig.price.monthly}
                                                <span className="text-sm text-zinc-500 font-normal">/mo</span>
                                            </div>
                                            <ul className="space-y-2 text-sm text-zinc-400">
                                                <li className="flex items-center gap-2">
                                                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                                                    <span>{tierConfig.creditsDisplay.toLocaleString()} Credits/month</span>
                                                </li>
                                                <li className="flex items-center gap-2">
                                                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                                                    <span>
                                                        {tier === "free"
                                                            ? "Standard LangGraph reasoning"
                                                            : tier === "pro"
                                                            ? "High-speed reasoning & HITL support"
                                                            : "Ultra-fast priority reasoning & ATMS ledger"}
                                                    </span>
                                                </li>
                                                <li className="flex items-center gap-2">
                                                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                                                    <span>Zero-Knowledge E2E Encryption</span>
                                                </li>
                                                <li className="flex items-center gap-2">
                                                    <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                                                    <span>Incremental Multi-Hunk Ghost Review</span>
                                                </li>
                                            </ul>
                                        </div>
                                    );
                                })}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </main>
        </div>
    );
}
