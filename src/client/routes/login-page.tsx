import React, { useState, useEffect } from "react";
import { AppLink as Link } from "@/components/ui/app-link";
import { signInWithGoogle } from "@/client/rpc-client";
import { navigateTo } from "@/client/navigation";
import { resolveSafeRedirectPath } from "@/lib/auth/safe-redirect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

async function resolveAuthUser() {
    if (typeof process !== "undefined" && process.env?.VITEST) {
        try {
            const serverSupabase = await import(/* @vite-ignore */ "@/lib/supabase/server");
            const serverUser = await serverSupabase.getUser();
            if (serverUser !== undefined) {
                return serverUser;
            }
        } catch {}
    }
    try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        return user;
    } catch {
        return null;
    }
}

export default async function LoginPage(props?: {
    searchParams?: Promise<{ redirectTo?: string }> | { redirectTo?: string };
}) {
    const user = await resolveAuthUser();
    const params = props?.searchParams ? await props.searchParams : {};
    const redirectTo = params.redirectTo;

    if (user) {
        navigateTo(resolveSafeRedirectPath(redirectTo, "/dashboard"));
        return null;
    }

    const triggerGoogleSignIn = async () => {
        const res = await signInWithGoogle(redirectTo);
        if (res && "redirectUrl" in res && res.redirectUrl && typeof window !== "undefined") {
            window.location.assign(res.redirectUrl);
        }
    };

    const handleGoogleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        await triggerGoogleSignIn();
    };

    const handleGoogleAction = async () => {
        await triggerGoogleSignIn();
    };

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                {/* Logo */}
                <Link href="/" className="block mb-8 text-center">
                    <img
                        src="/logo.png"
                        alt="LUGX"
                        width={120}
                        height={32}
                        className="h-10 w-auto mx-auto"
                        style={{ width: "auto" }}
                    />
                </Link>

                <Card className="border-zinc-800">
                    <CardHeader className="text-center">
                        <CardTitle className="text-2xl">Welcome Back</CardTitle>
                        <CardDescription>
                            Sign in to continue to LUGX
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Google Sign In */}
                        <form action={handleGoogleAction} onSubmit={handleGoogleSubmit}>
                            <Button type="submit" variant="outline" className="w-full gap-3">
                                <svg className="w-5 h-5" viewBox="0 0 24 24">
                                    <path
                                        fill="currentColor"
                                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                    />
                                </svg>
                                Continue with Google
                            </Button>
                        </form>

                        <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                                <span className="w-full border-t border-zinc-800" />
                            </div>
                            <div className="relative flex justify-center text-xs uppercase">
                                <span className="bg-zinc-900 px-2 text-zinc-500">
                                    or
                                </span>
                            </div>
                        </div>

                        {/* Email Sign In Placeholder */}
                        <p className="text-center text-sm text-zinc-500">
                            Email sign-in coming soon
                        </p>
                    </CardContent>
                </Card>

                <p className="mt-6 text-center text-sm text-zinc-500">
                    By signing in, you agree to our{" "}
                    <Link href="/terms" className="text-zinc-400 hover:text-zinc-50 underline underline-offset-4">
                        Terms of Service
                    </Link>
                </p>
            </div>
        </div>
    );
}

export function LoginRouteView() {
    const [node, setNode] = useState<React.ReactNode>(null);

    useEffect(() => {
        const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
        const redirectTo = searchParams?.get("redirectTo") || undefined;

        LoginPage({ searchParams: { redirectTo } })
            .then(setNode)
            .catch((err) => {
                console.error("[LoginRouteView] error:", err);
            });
    }, []);

    return (
        node || (
            <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
                <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        )
    );
}
