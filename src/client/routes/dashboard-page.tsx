import React, { useState, useEffect } from "react";
import { AppLink as Link } from "@/components/ui/app-link";
import { navigateTo } from "@/client/navigation";
import { getUserProfile, signOut, getCreditBalanceResult } from "@/client/rpc-client";
import { TIER_LIMITS, type TierName, getTierDisplayName } from "@/config/tiers.config";
import { MICRO_PER_CREDIT } from "@/lib/metering/constants";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Settings, LogOut, Plus, Sparkles, Coins } from "lucide-react";

import { createClient } from "@/lib/supabase/client";

async function resolveAuthUser() {
    try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        return user;
    } catch {
        return null;
    }
}

export default function DashboardPage(props?: {
    searchParams?: Promise<{ session_id?: string }> | { session_id?: string };
    sessionId?: string;
}) {
    const [resolvedSessionId, setResolvedSessionId] = useState<string | undefined>(props?.sessionId);

    useEffect(() => {
        if (props?.sessionId) {
            setResolvedSessionId(props.sessionId);
        } else if (props?.searchParams) {
            if ("then" in props.searchParams && typeof props.searchParams.then === "function") {
                props.searchParams.then((sp) => setResolvedSessionId(sp?.session_id));
            } else {
                setResolvedSessionId((props.searchParams as { session_id?: string }).session_id);
            }
        }
    }, [props?.searchParams, props?.sessionId]);

    const sessionId =
        props?.sessionId ||
        (props?.searchParams && !("then" in props.searchParams)
            ? (props.searchParams as { session_id?: string }).session_id
            : undefined) ||
        resolvedSessionId;
    const params = sessionId ? { session_id: sessionId } : undefined;

    const [loading, setLoading] = useState(true);
    const [user, setUser] = useState<{ id: string } | null>(null);
    const [profile, setProfile] = useState<NonNullable<Awaited<ReturnType<typeof getUserProfile>>["data"]> | null>(null);
    const [balanceMicro, setBalanceMicro] = useState<bigint | null>(null);
    const [balanceError, setBalanceError] = useState<string | null>(null);

    useEffect(() => {
        let isMounted = true;
        async function loadData() {
            try {
                const authUser = await resolveAuthUser();
                if (!isMounted) return;
                if (!authUser) {
                    navigateTo("/login");
                    return;
                }
                setUser(authUser);

                try {
                    const [profileResult, balanceResult] = await Promise.all([
                        getUserProfile().catch((err) => {
                            console.error("[Dashboard] Profile load error:", err);
                            return null;
                        }),
                        getCreditBalanceResult(),
                    ]);
                    if (!isMounted) return;

                    if (profileResult && "data" in profileResult) {
                        setProfile(profileResult.data ?? null);
                    }

                    if (balanceResult.success) {
                        setBalanceMicro(balanceResult.balance);
                        setBalanceError(null);
                    } else if (balanceResult.status === "unauthorized") {
                        navigateTo("/login");
                        return;
                    } else {
                        // Error condition: do not redirect, do not set 0, show retryable UI warning
                        setBalanceError(balanceResult.error || "Unable to load credit balance");
                    }
                } catch (rpcErr) {
                    console.error("[Dashboard] RPC load error:", rpcErr);
                    if (!isMounted) return;
                    setBalanceError("Unable to load credit balance");
                }

                setLoading(false);
            } catch {
                if (isMounted) {
                    navigateTo("/login");
                }
            }
        }
        loadData();
        return () => {
            isMounted = false;
        };
    }, []);

    if (loading || !user) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    const userTier: TierName = (profile?.tier as TierName) || "free";
    const limits = TIER_LIMITS[userTier] || TIER_LIMITS.free;
    const currentCredits = balanceMicro !== null ? Number(balanceMicro / MICRO_PER_CREDIT) : 0;
    const tierCredits = limits.creditsDisplay;
    const percentageRemaining =
        tierCredits > 0 && balanceMicro !== null
            ? Math.min(Math.max(0, Math.round((currentCredits / tierCredits) * 100)), 100)
            : 0;


    return (
        <div className="min-h-screen bg-zinc-950">
            {/* Navigation */}
            <nav className="fixed top-0 left-0 right-0 z-50 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-lg">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-16">
                        <Link href="/dashboard" className="flex items-center gap-2">
                            <img
                                src="/logo.png"
                                alt="LUGX"
                                width={100}
                                height={28}
                                className="h-7 w-auto"
                                style={{ width: "auto" }}
                            />
                        </Link>

                        <div className="flex items-center gap-4">
                            <Link href="/workspace">
                                <Button variant="ai" size="sm" className="gap-2">
                                    <Sparkles className="w-4 h-4" />
                                    Open Editor
                                </Button>
                            </Link>

                            <Link href="/account">
                                <Button variant="ghost" size="icon-sm">
                                    <Settings className="w-4 h-4" />
                                </Button>
                            </Link>

                            <form
                                onSubmit={async (e) => {
                                    e.preventDefault();
                                    try {
                                        await signOut();
                                    } catch (err) {
                                        console.error("[Dashboard] signOut error:", err);
                                    }
                                    try {
                                        const supabase = createClient();
                                        await supabase.auth.signOut();
                                    } catch {}
                                    if (typeof window !== "undefined") {
                                        navigateTo("/");
                                    }
                                }}
                            >
                                <Button type="submit" variant="ghost" size="icon-sm">
                                    <LogOut className="w-4 h-4" />
                                </Button>
                            </form>
                        </div>
                    </div>
                </div>
            </nav>

            {/* Main Content */}
            <main className="pt-24 pb-12 px-4 max-w-7xl mx-auto">
                {params?.session_id && (
                    <div className="mb-6 p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <span className="text-2xl">🎉</span>
                            <div>
                                <p className="font-medium text-emerald-200">Payment Successful!</p>
                                <p className="text-xs text-emerald-400/80">Your subscription has been activated. Welcome to your upgraded workspace.</p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Welcome Header */}
                <div className="mb-8">
                    <h1 className="text-2xl font-medium text-zinc-50">
                        Welcome back, {profile?.displayName || "User"}
                    </h1>
                    <p className="text-zinc-500 mt-1">
                        Your AI-powered text editing workspace
                    </p>
                </div>

                {/* Quick Stats */}
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                    {/* Current Plan */}
                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription>Current Plan</CardDescription>
                            <CardTitle className="text-xl capitalize flex items-center gap-2">
                                {getTierDisplayName(userTier)}
                                {userTier === "ultra" && (
                                    <span className="text-xs px-2 py-0.5 rounded-full ultra-badge">
                                        ✦
                                    </span>
                                )}
                            </CardTitle>
                        </CardHeader>
                    </Card>

                    {/* AI Architectural Credits */}
                    <Card className="sm:col-span-1 lg:col-span-2">
                        <CardHeader className="pb-2">
                            <div className="flex items-center justify-between">
                                <CardDescription className="flex items-center gap-1.5">
                                    <Coins className="w-4 h-4 text-indigo-400" />
                                    AI Architectural Credits
                                </CardDescription>
                                <span className="text-xs font-mono text-zinc-400">
                                    {balanceError ? "Unavailable" : `${percentageRemaining}% available`}
                                </span>
                            </div>
                            <CardTitle className="text-xl flex items-center justify-between">
                                {balanceError ? (
                                    <div className="flex items-center justify-between w-full">
                                        <span className="text-sm font-normal text-amber-400">
                                            {balanceError}
                                        </span>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={async () => {
                                                try {
                                                    const res = await getCreditBalanceResult();
                                                    if (res.success) {
                                                        setBalanceMicro(res.balance);
                                                        setBalanceError(null);
                                                    } else if (res.status === "unauthorized") {
                                                        navigateTo("/login");
                                                    } else {
                                                        setBalanceError(res.error || "Unable to load credit balance");
                                                    }
                                                } catch {
                                                    setBalanceError("Unable to load credit balance");
                                                }
                                            }}
                                            className="text-xs text-indigo-400 hover:text-indigo-300 h-7 px-2"
                                        >
                                            Retry
                                        </Button>
                                    </div>
                                ) : (
                                    <span>
                                        {currentCredits.toLocaleString()}
                                        <span className="text-zinc-500 text-sm font-normal">
                                            {" / "}
                                            {tierCredits.toLocaleString()} Credits
                                        </span>
                                    </span>
                                )}
                            </CardTitle>
                        </CardHeader>
                        <div className="px-6 pb-4">
                            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
                                    style={{ width: `${balanceError ? 0 : percentageRemaining}%` }}
                                />
                            </div>
                        </div>
                    </Card>
                </div>

                {/* Quick Actions */}
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {/* New Document */}
                    <Link href="/workspace">
                        <Card className="group hover:border-zinc-700 cursor-pointer transition-all h-full">
                            <CardHeader>
                                <div className="w-12 h-12 rounded-lg bg-indigo-500/10 flex items-center justify-center mb-3 group-hover:bg-indigo-500/20 transition-colors">
                                    <Plus className="w-6 h-6 text-indigo-400" />
                                </div>
                                <CardTitle>New Document</CardTitle>
                                <CardDescription>
                                    Create a new document and start writing
                                </CardDescription>
                            </CardHeader>
                        </Card>
                    </Link>

                    {/* Recent Files */}
                    <Link href="/workspace">
                        <Card className="group hover:border-zinc-700 cursor-pointer transition-all h-full">
                            <CardHeader>
                                <div className="w-12 h-12 rounded-lg bg-violet-500/10 flex items-center justify-center mb-3 group-hover:bg-violet-500/20 transition-colors">
                                    <FileText className="w-6 h-6 text-violet-400" />
                                </div>
                                <CardTitle>Your Files</CardTitle>
                                <CardDescription>
                                    Browse and manage your documents
                                </CardDescription>
                            </CardHeader>
                        </Card>
                    </Link>

                    {/* Upgrade */}
                    {userTier === "free" && (
                        <Link href="/account">
                            <Card className="group hover:border-indigo-500/50 cursor-pointer transition-all h-full border-indigo-500/20 bg-gradient-to-br from-indigo-500/5 to-transparent">
                                <CardHeader>
                                    <div className="w-12 h-12 rounded-lg bg-indigo-500/20 flex items-center justify-center mb-3 group-hover:bg-indigo-500/30 transition-colors">
                                        <Sparkles className="w-6 h-6 text-indigo-400" />
                                    </div>
                                    <CardTitle>Upgrade to Pro</CardTitle>
                                    <CardDescription>
                                        Unlock 1,000 monthly credits, multi-device sync, and priority AI reasoning
                                    </CardDescription>
                                </CardHeader>
                            </Card>
                        </Link>
                    )}
                </div>
            </main>
        </div>
    );
}

export function DashboardRouteView() {
    const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const sessionId = searchParams?.get("session_id") || undefined;
    return <DashboardPage searchParams={{ session_id: sessionId }} />;
}
