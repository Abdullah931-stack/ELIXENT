import React, { useState, useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { AppLink as Link } from "@/components/ui/app-link";
import { navigateTo } from "@/client/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Button } from "@/components/ui/button";
import { Settings, Home } from "lucide-react";
import {
    resolveInitialClientUserIdSync,
    resolveLocalFirstAuthUser,
} from "@/lib/auth/client-identity";

export function WorkspaceLayoutRouteView() {
    const [userId, setUserId] = useState<string | null>(() => resolveInitialClientUserIdSync());
    const [isLoading, setIsLoading] = useState<boolean>(() => resolveInitialClientUserIdSync() === null);

    useEffect(() => {
        let cancelled = false;

        resolveLocalFirstAuthUser({
            onSessionExpired: () => {
                if (!cancelled && (typeof navigator === "undefined" || navigator.onLine !== false)) {
                    setUserId(null);
                    setIsLoading(false);
                    navigateTo("/login");
                }
            },
        })
            .then((user) => {
                if (cancelled) return;
                if (!user) {
                    if (typeof navigator === "undefined" || navigator.onLine !== false) {
                        setIsLoading(false);
                        navigateTo("/login");
                    }
                    return;
                }
                setUserId(user.id);
                setIsLoading(false);
            })
            .catch(() => {
                if (!cancelled && (typeof navigator === "undefined" || navigator.onLine !== false)) {
                    setIsLoading(false);
                    navigateTo("/login");
                }
            });

        return () => {
            cancelled = true;
        };
    }, []);

    if (isLoading) {
        return (
            <div className="h-screen bg-zinc-950 flex items-center justify-center">
                <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="h-screen bg-zinc-950 flex overflow-hidden">
            {/* Sidebar */}
            <Sidebar userId={userId ?? undefined} />

            {/* Main Area */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Top Bar */}
                <header className="h-14 border-b border-zinc-800/50 bg-zinc-950 flex items-center justify-between px-4 flex-shrink-0">
                    <Link href="/dashboard" className="flex items-center gap-2">
                        <img
                            src="/logo.png"
                            alt="LUGX"
                            width={80}
                            height={24}
                            className="h-6 w-auto"
                            style={{ width: "auto" }}
                        />
                    </Link>

                    <div className="flex items-center gap-2">
                        <Button asChild variant="ghost" size="icon-sm">
                            <Link href="/dashboard">
                                <Home className="w-4 h-4" />
                            </Link>
                        </Button>
                        <Button asChild variant="ghost" size="icon-sm">
                            <Link href="/account">
                                <Settings className="w-4 h-4" />
                            </Link>
                        </Button>
                    </div>
                </header>

                {/* Content - Outlet for nested routes */}
                <main className="flex-1 overflow-auto">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}

export default WorkspaceLayoutRouteView;

