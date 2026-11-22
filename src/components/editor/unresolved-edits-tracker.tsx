import React, { useMemo, useState } from "react";
import { Check, ChevronDown, FileText, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { navigateTo } from "@/client/navigation";
import { useOptionalWorkspaceTabs } from "./workspace-tab-bar";

export interface UnresolvedEditsTrackerProps {
    readonly className?: string;
    readonly compact?: boolean;
}

export function UnresolvedEditsTracker({
    className = "",
    compact = false,
}: UnresolvedEditsTrackerProps): React.JSX.Element | null {
    const tabs = useOptionalWorkspaceTabs();
    const [isOpen, setIsOpen] = useState(false);
    const [isWorking, setIsWorking] = useState(false);

    const entries = useMemo(() => {
        if (!tabs) return [];
        const openTabMap = new Map(tabs.openTabs.map((t) => [t.fileId, t]));
        return Object.entries(tabs.ghostHunksByFileId)
            .filter(([, hunks]) => hunks.length > 0)
            .map(([fileId, hunks]) => {
                const openTab = openTabMap.get(fileId);
                return {
                    fileId,
                    title: openTab?.title ?? fileId,
                    relativePath: openTab?.relativePath ?? "",
                    isEncrypted: openTab?.isEncrypted ?? false,
                    isOpenTab: Boolean(openTab),
                    hunks,
                };
            });
    }, [tabs]);

    if (!tabs || tabs.totalPendingGhostCount === 0 || entries.length === 0) {
        return null;
    }

    const totalCount = tabs.totalPendingGhostCount;
    const fileCount = entries.length;
    const fullLabel = `${totalCount} Unresolved ${totalCount === 1 ? "Edit" : "Edits"} in ${fileCount} ${
        fileCount === 1 ? "File" : "Files"
    }`;

    const handleOpenAndReview = (entry: (typeof entries)[number]) => {
        tabs.openTab({
            fileId: entry.fileId,
            title: entry.title,
            relativePath: entry.relativePath,
            isDirty: false,
            isEncrypted: entry.isEncrypted,
            pendingGhostCount: entry.hunks.length,
        });
        setIsOpen(false);
        navigateTo(`/workspace/editor/${entry.fileId}`);
    };

    const handleAcceptAll = async () => {
        setIsWorking(true);
        try {
            await tabs.acceptAllPendingInWorkspace();
            setIsOpen(false);
        } finally {
            setIsWorking(false);
        }
    };

    const handleRejectAll = () => {
        tabs.rejectAllPendingInWorkspace();
        setIsOpen(false);
    };

    return (
        <div className={`relative ${className}`}>
            <button
                type="button"
                onClick={() => setIsOpen((prev) => !prev)}
                aria-expanded={isOpen}
                aria-label={fullLabel}
                title={fullLabel}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/25 transition-colors cursor-pointer"
            >
                <Sparkles className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                <span className="truncate">{compact ? `${totalCount} Unresolved` : fullLabel}</span>
                <ChevronDown className="w-3 h-3 text-indigo-400 flex-shrink-0" />
            </button>

            {isOpen && (
                <div
                    role="dialog"
                    aria-label="Unresolved AI edits"
                    className="absolute right-0 mt-2 w-80 rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl z-50 overflow-hidden"
                >
                    <div className="px-3.5 py-2.5 border-b border-zinc-800 flex items-center justify-between">
                        <span className="text-xs font-semibold text-zinc-200">{fullLabel}</span>
                        <button
                            type="button"
                            onClick={() => setIsOpen(false)}
                            aria-label="Close unresolved edits popover"
                            className="text-zinc-500 hover:text-zinc-200 p-0.5 rounded"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    <div className="max-h-64 overflow-y-auto divide-y divide-zinc-800/60">
                        {entries.map((entry) => (
                            <div
                                key={entry.fileId}
                                className="px-3.5 py-2.5 flex items-center justify-between gap-2 hover:bg-zinc-800/40"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                        <FileText className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                                        <span className="text-xs font-medium text-zinc-200 truncate">
                                            {entry.title}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                                            {entry.isOpenTab ? "Open" : "Closed"}
                                        </span>
                                        <span className="text-[10px] text-indigo-300">
                                            {entry.hunks.length} {entry.hunks.length === 1 ? "edit" : "edits"}
                                        </span>
                                    </div>
                                </div>

                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleOpenAndReview(entry)}
                                    className="h-7 px-2 text-[11px] flex-shrink-0"
                                >
                                    Open &amp; Review
                                </Button>
                            </div>
                        ))}
                    </div>

                    <div className="p-2.5 border-t border-zinc-800 bg-zinc-950/60 flex items-center gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            disabled={isWorking}
                            onClick={() => void handleAcceptAll()}
                            className="flex-1 h-7 text-xs"
                        >
                            <Check className="w-3.5 h-3.5" />
                            <span>Accept All in Workspace</span>
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={isWorking}
                            onClick={handleRejectAll}
                            className="flex-1 h-7 text-xs"
                        >
                            <X className="w-3.5 h-3.5" />
                            <span>Reject All in Workspace</span>
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
