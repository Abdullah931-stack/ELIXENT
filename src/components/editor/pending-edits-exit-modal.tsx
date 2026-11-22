import React, { useEffect, useState } from "react";
import { useBlocker, useRouter } from "@tanstack/react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOptionalWorkspaceTabs, type WorkspaceTabsContextValue } from "./workspace-tab-bar";

interface PendingEditsRouterBlockerProps {
    readonly tabs: WorkspaceTabsContextValue | null;
    readonly totalPending: number;
    readonly hasDirty: boolean;
    readonly hasPendingChanges: boolean;
}

function PendingEditsRouterBlocker({
    tabs,
    totalPending,
    hasDirty,
    hasPendingChanges,
}: PendingEditsRouterBlockerProps): React.JSX.Element | null {
    const [isProcessing, setIsProcessing] = useState(false);

    const blocker = useBlocker({
        shouldBlockFn: ({ next }) => {
            if (!hasPendingChanges) return false;
            if (next.pathname.startsWith("/workspace")) return false;
            return true;
        },
        enableBeforeUnload: false,
        withResolver: true,
    });

    if (blocker.status !== "blocked") {
        return null;
    }

    const handleSaveAndLeave = async () => {
        setIsProcessing(true);
        try {
            if (tabs) {
                await tabs.acceptAllPendingInWorkspace();
            }
            blocker.proceed();
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDiscardAndLeave = async () => {
        setIsProcessing(true);
        try {
            if (tabs) {
                await tabs.discardAllDirtyAndPending();
            }
            blocker.proceed();
        } finally {
            setIsProcessing(false);
        }
    };

    const handleStay = () => {
        if (!isProcessing) {
            blocker.reset();
        }
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pending-edits-exit-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
        >
            <div className="w-full max-w-md rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl p-6 space-y-4">
                <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 flex-shrink-0">
                        <AlertTriangle className="w-5 h-5" />
                    </div>
                    <div className="space-y-1">
                        <h2 id="pending-edits-exit-title" className="text-base font-semibold text-zinc-100">
                            Unresolved Workspace Changes
                        </h2>
                        <p className="text-sm text-zinc-400">
                            {totalPending > 0 && hasDirty
                                ? `You have ${totalPending} unresolved AI ${totalPending === 1 ? "edit" : "edits"} and unsaved file changes.`
                                : totalPending > 0
                                    ? `You have ${totalPending} unresolved AI ${totalPending === 1 ? "edit" : "edits"} pending review.`
                                    : "You have unsaved changes in open workspace files."}
                        </p>
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 pt-2">
                    <Button
                        type="button"
                        variant="ghost"
                        disabled={isProcessing}
                        onClick={handleStay}
                    >
                        Stay
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        disabled={isProcessing}
                        onClick={() => void handleDiscardAndLeave()}
                    >
                        Discard &amp; Leave
                    </Button>
                    <Button
                        type="button"
                        variant="primary"
                        disabled={isProcessing}
                        onClick={() => void handleSaveAndLeave()}
                    >
                        {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
                        <span>Save &amp; Leave</span>
                    </Button>
                </div>
            </div>
        </div>
    );
}

export function PendingEditsExitModal(): React.JSX.Element | null {
    const tabs = useOptionalWorkspaceTabs();
    const router = typeof useRouter === "function" ? useRouter({ warn: false }) : null;

    const totalPending = tabs?.totalPendingGhostCount ?? 0;
    const hasDirty = tabs?.hasUnsavedDirtyBuffer ?? false;
    const hasPendingChanges = totalPending > 0 || hasDirty;

    useEffect(() => {
        if (!hasPendingChanges || typeof window === "undefined") {
            return;
        }

        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };

        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => {
            window.removeEventListener("beforeunload", handleBeforeUnload);
        };
    }, [hasPendingChanges]);

    if (!router || typeof useBlocker !== "function") {
        return null;
    }

    return (
        <PendingEditsRouterBlocker
            tabs={tabs}
            totalPending={totalPending}
            hasDirty={hasDirty}
            hasPendingChanges={hasPendingChanges}
        />
    );
}
