import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Lock, X } from "lucide-react";
import type { EditorSelection, GhostHunk } from "@/components/editor/markdown/types";
import type { WorkspaceRecord } from "@/types/rpc-contracts";
import { getFile, listWorkspacesRpc, toggleFileEncryption, updateFileContent } from "@/client/rpc-client";
import { navigateTo } from "@/client/navigation";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";
import { resolveInitialClientUserIdSync } from "@/lib/auth/client-identity";
import { UnresolvedEditsTracker } from "./unresolved-edits-tracker";

const ACTIVE_WORKSPACE_STORAGE_KEY = "elixent_active_workspace_id";

export interface WorkspaceOpenTab {
    readonly fileId: string;
    readonly title: string;
    readonly relativePath: string;
    readonly isDirty: boolean;
    readonly isEncrypted: boolean;
    readonly pendingGhostCount: number;
    readonly cursorSelection?: EditorSelection;
    readonly scrollTop?: number;
}

export interface WorkspacePendingGhostState {
    readonly ghostHunksByFileId: Readonly<Record<string, readonly GhostHunk[]>>;
    readonly turnIdByHunkId: Readonly<Record<string, string>>;
}

export interface WorkspaceTabsContextValue {
    readonly workspaces: readonly WorkspaceRecord[];
    readonly activeWorkspaceId: string;
    readonly activeWorkspace: WorkspaceRecord | null;
    readonly setActiveWorkspaceId: (workspaceId: string) => void;
    readonly refreshWorkspaces: () => Promise<void>;
    readonly openTabs: readonly WorkspaceOpenTab[];
    readonly activeFileId: string | null;
    readonly openTab: (tab: Omit<WorkspaceOpenTab, "pendingGhostCount"> & { pendingGhostCount?: number }) => void;
    readonly closeTab: (fileId: string) => void;
    readonly setActiveFileId: (fileId: string | null) => void;
    readonly updateTabState: (fileId: string, patch: Partial<WorkspaceOpenTab>) => void;
    readonly ghostHunksByFileId: Readonly<Record<string, readonly GhostHunk[]>>;
    readonly turnIdByHunkId: Readonly<Record<string, string>>;
    readonly totalPendingGhostCount: number;
    readonly hasUnsavedDirtyBuffer: boolean;
    readonly setGhostHunksForFile: (fileId: string, hunks: readonly GhostHunk[], turnId?: string) => void;
    readonly acceptAllPendingInFile: (fileId: string) => Promise<void>;
    readonly rejectAllPendingInFile: (fileId: string) => void;
    readonly acceptAllPendingInWorkspace: () => Promise<void>;
    readonly rejectAllPendingInWorkspace: () => void;
    readonly discardAllDirtyAndPending: () => Promise<void>;
    readonly registerSaveFlushHandler: (fn: (() => Promise<void>) | null) => void;
    readonly registerDiscardFlushHandler?: (fn: (() => void | Promise<void>) | null) => void;
}

const WorkspaceTabsContext = createContext<WorkspaceTabsContextValue | null>(null);

function applyHunksToContent(content: string, hunks: readonly GhostHunk[]): string {
    const sorted = [...hunks].sort((a, b) => b.from - a.from);
    let next = content;
    for (const hunk of sorted) {
        const from = Math.max(0, Math.min(hunk.from, next.length));
        const to = Math.max(from, Math.min(hunk.to, next.length));
        next = next.slice(0, from) + hunk.replacementText + next.slice(to);
    }
    return next;
}

function readStoredWorkspaceId(): string {
    try {
        if (typeof window !== "undefined" && window.localStorage) {
            return window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY) ?? "";
        }
    } catch {
        // Ignore storage access errors in restricted environments
    }
    return "";
}

function writeStoredWorkspaceId(workspaceId: string): void {
    try {
        if (typeof window !== "undefined" && window.localStorage) {
            if (workspaceId) {
                window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
            } else {
                window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
            }
        }
    } catch {
        // Ignore storage access errors in restricted environments
    }
}

function isTabUnchanged(existing: WorkspaceOpenTab, next: WorkspaceOpenTab): boolean {
    return (
        existing.fileId === next.fileId &&
        existing.title === next.title &&
        existing.relativePath === next.relativePath &&
        existing.isDirty === next.isDirty &&
        existing.isEncrypted === next.isEncrypted &&
        existing.pendingGhostCount === next.pendingGhostCount &&
        existing.scrollTop === next.scrollTop &&
        existing.cursorSelection?.from === next.cursorSelection?.from &&
        existing.cursorSelection?.to === next.cursorSelection?.to
    );
}

export function WorkspaceTabsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
    const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string>(() => readStoredWorkspaceId());
    const [openTabs, setOpenTabs] = useState<WorkspaceOpenTab[]>([]);
    const [activeFileId, setActiveFileId] = useState<string | null>(null);
    const [ghostHunksByFileId, setGhostHunksByFileId] = useState<Record<string, readonly GhostHunk[]>>({});
    const [turnIdByHunkId, setTurnIdByHunkId] = useState<Record<string, string>>({});

    const saveFlushHandlerRef = useRef<(() => Promise<void>) | null>(null);
    const discardFlushHandlerRef = useRef<(() => void | Promise<void>) | null>(null);
    const hydratedWorkspaceRef = useRef<string>("");
    const ghostHunksByFileIdRef = useRef(ghostHunksByFileId);
    ghostHunksByFileIdRef.current = ghostHunksByFileId;

    const refreshWorkspaces = useCallback(async () => {
        try {
            const res = await listWorkspacesRpc();
            if (res.success && Array.isArray(res.data)) {
                setWorkspaces(res.data);
                setActiveWorkspaceIdState((prev) => {
                    const exists = res.data?.some((w) => w.id === prev);
                    if (exists) return prev;
                    const fallback = res.data?.[0]?.id ?? "";
                    writeStoredWorkspaceId(fallback);
                    return fallback;
                });
            }
        } catch {
            // Non-fatal in offline/test contexts
        }
    }, []);

    useEffect(() => {
        void refreshWorkspaces();
    }, [refreshWorkspaces]);

    const setActiveWorkspaceId = useCallback((workspaceId: string) => {
        setActiveWorkspaceIdState(workspaceId);
        writeStoredWorkspaceId(workspaceId);
        setOpenTabs([]);
        setActiveFileId(null);
    }, []);

    const activeWorkspace = useMemo(
        () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
        [workspaces, activeWorkspaceId]
    );

    // Hydrate pending ghost hunks from IndexedDB when activeWorkspaceId changes
    useEffect(() => {
        if (!activeWorkspaceId) {
            setGhostHunksByFileId({});
            setTurnIdByHunkId({});
            hydratedWorkspaceRef.current = "";
            return;
        }

        let cancelled = false;
        hydratedWorkspaceRef.current = "";

        void (async () => {
            try {
                const uid = resolveInitialClientUserIdSync();
                if (uid) {
                    await indexedDBManager.init(uid);
                }
                const loadFn = (
                    indexedDBManager as unknown as {
                        loadPendingGhostHunks?: (
                            wsId: string
                        ) => Promise<{
                            ghostHunksByFileId: Record<string, GhostHunk[]>;
                            turnIdByHunkId: Record<string, string>;
                        } | null>;
                    }
                ).loadPendingGhostHunks;

                if (typeof loadFn !== "function") {
                    hydratedWorkspaceRef.current = activeWorkspaceId;
                    return;
                }

                const persisted = await loadFn.call(indexedDBManager, activeWorkspaceId);
                if (cancelled) return;

                if (persisted) {
                    setGhostHunksByFileId(persisted.ghostHunksByFileId ?? {});
                    setTurnIdByHunkId(persisted.turnIdByHunkId ?? {});
                } else {
                    setGhostHunksByFileId({});
                    setTurnIdByHunkId({});
                }
            } catch {
                if (!cancelled) {
                    setGhostHunksByFileId({});
                    setTurnIdByHunkId({});
                }
            } finally {
                if (!cancelled) {
                    hydratedWorkspaceRef.current = activeWorkspaceId;
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [activeWorkspaceId]);

    // Persist pending ghost hunks to IndexedDB when state changes after hydration
    useEffect(() => {
        if (!activeWorkspaceId || hydratedWorkspaceRef.current !== activeWorkspaceId) {
            return;
        }

        const totalCount = Object.values(ghostHunksByFileId).reduce((sum, list) => sum + list.length, 0);

        void (async () => {
            try {
                const idbAny = indexedDBManager as unknown as {
                    savePendingGhostHunks?: (
                        wsId: string,
                        payload: {
                            ghostHunksByFileId: Record<string, GhostHunk[]>;
                            turnIdByHunkId: Record<string, string>;
                        }
                    ) => Promise<void>;
                    clearPendingGhostHunks?: (wsId: string) => Promise<void>;
                };

                if (totalCount === 0) {
                    if (typeof idbAny.clearPendingGhostHunks === "function") {
                        await idbAny.clearPendingGhostHunks(activeWorkspaceId);
                    }
                } else if (typeof idbAny.savePendingGhostHunks === "function") {
                    const serializable: Record<string, GhostHunk[]> = {};
                    for (const [fid, hunks] of Object.entries(ghostHunksByFileId)) {
                        if (hunks.length > 0) {
                            serializable[fid] = hunks.map(({ hunkId, decisionIds, headingSlug, from, to, originalSlice, replacementText, status, operation }) => ({
                                hunkId,
                                decisionIds,
                                headingSlug,
                                from,
                                to,
                                originalSlice,
                                replacementText,
                                status,
                                operation,
                            }));
                        }
                    }
                    await idbAny.savePendingGhostHunks(activeWorkspaceId, {
                        ghostHunksByFileId: serializable,
                        turnIdByHunkId,
                    });
                }
            } catch {
                // Gracefully ignore IDB persistence failures in tests or restricted browsers
            }
        })();
    }, [activeWorkspaceId, ghostHunksByFileId, turnIdByHunkId]);

    const openTab = useCallback(
        (tab: Omit<WorkspaceOpenTab, "pendingGhostCount"> & { pendingGhostCount?: number }) => {
            setOpenTabs((prev) => {
                const existingIdx = prev.findIndex((t) => t.fileId === tab.fileId);
                const resolvedGhostCount =
                    tab.pendingGhostCount ?? ghostHunksByFileIdRef.current[tab.fileId]?.length ?? 0;

                if (existingIdx >= 0) {
                    const existing = prev[existingIdx];
                    const merged: WorkspaceOpenTab = {
                        ...existing,
                        ...tab,
                        pendingGhostCount: resolvedGhostCount,
                    };
                    if (isTabUnchanged(existing, merged)) {
                        return prev;
                    }
                    const updated = [...prev];
                    updated[existingIdx] = merged;
                    return updated;
                }

                return [
                    ...prev,
                    {
                        ...tab,
                        pendingGhostCount: resolvedGhostCount,
                    },
                ];
            });
            setActiveFileId(tab.fileId);
        },
        []
    );

    const closeTab = useCallback(
        (fileId: string) => {
            setOpenTabs((prev) => {
                const idx = prev.findIndex((t) => t.fileId === fileId);
                if (idx === -1) return prev;

                const nextTabs = prev.filter((t) => t.fileId !== fileId);

                if (activeFileId === fileId) {
                    if (nextTabs.length > 0) {
                        const adjacent = nextTabs[Math.min(idx, nextTabs.length - 1)];
                        setActiveFileId(adjacent.fileId);
                        navigateTo(`/workspace/editor/${adjacent.fileId}`);
                    } else {
                        setActiveFileId(null);
                        navigateTo("/workspace");
                    }
                }

                return nextTabs;
            });
        },
        [activeFileId]
    );

    const updateTabState = useCallback((fileId: string, patch: Partial<WorkspaceOpenTab>) => {
        setOpenTabs((prev) => {
            const idx = prev.findIndex((t) => t.fileId === fileId);
            if (idx === -1) return prev;
            const existing = prev[idx];
            const merged: WorkspaceOpenTab = { ...existing, ...patch };
            if (isTabUnchanged(existing, merged)) {
                return prev;
            }
            const updated = [...prev];
            updated[idx] = merged;
            return updated;
        });
    }, []);

    const setGhostHunksForFile = useCallback(
        (fileId: string, hunks: readonly GhostHunk[], turnId?: string) => {
            setGhostHunksByFileId((prev) => {
                const next = { ...prev };
                if (hunks.length === 0) {
                    delete next[fileId];
                } else {
                    next[fileId] = [...hunks];
                }
                return next;
            });

            setTurnIdByHunkId((prev) => {
                const next = { ...prev };
                if (turnId && hunks.length > 0) {
                    for (const h of hunks) {
                        next[h.hunkId] = turnId;
                    }
                }
                return next;
            });

            setOpenTabs((prev) =>
                prev.map((tab) =>
                    tab.fileId === fileId ? { ...tab, pendingGhostCount: hunks.length } : tab
                )
            );
        },
        []
    );

    const clearFileGhostHunks = useCallback((fileId: string) => {
        const removedIds = (ghostHunksByFileIdRef.current[fileId] ?? []).map((h) => h.hunkId);

        setGhostHunksByFileId((prev) => {
            if (!prev[fileId]) return prev;
            const next = { ...prev };
            delete next[fileId];
            return next;
        });

        if (removedIds.length > 0) {
            setTurnIdByHunkId((prev) => {
                const next = { ...prev };
                for (const id of removedIds) {
                    delete next[id];
                }
                return next;
            });
        }

        setOpenTabs((prev) => {
            const idx = prev.findIndex((t) => t.fileId === fileId);
            if (idx === -1 || prev[idx].pendingGhostCount === 0) {
                return prev;
            }
            const updated = [...prev];
            updated[idx] = { ...prev[idx], pendingGhostCount: 0 };
            return updated;
        });
    }, []);

    const acceptAllPendingInFile = useCallback(
        async (fileId: string) => {
            const hunks = ghostHunksByFileId[fileId];
            if (!hunks || hunks.length === 0) return;

            try {
                const uid = resolveInitialClientUserIdSync() ?? "";
                if (uid) {
                    await indexedDBManager.init(uid);
                }

                const localFile = await indexedDBManager.getFile(fileId, uid);
                let currentContent = localFile?.content ?? null;
                let isEncrypted = localFile?.isEncrypted ?? false;
                let encryptionMetadata = localFile?.encryptionMetadata ?? null;

                if (currentContent === null) {
                    const serverRes = await getFile(fileId);
                    if (serverRes.success && serverRes.data) {
                        currentContent = serverRes.data.content ?? "";
                        isEncrypted = serverRes.data.isEncrypted;
                        encryptionMetadata = serverRes.data.encryptionMetadata;
                    }
                }

                if (currentContent !== null) {
                    if (isEncrypted) {
                        const inbound = await SyncCryptoGateway.decryptInbound({
                            fileId,
                            content: currentContent,
                            isEncrypted: true,
                            encryptionMetadata,
                            userId: uid,
                        });
                        if (inbound.status !== "error" && inbound.status !== "locked") {
                            currentContent = inbound.content;
                        }
                    }

                    const nextContent = applyHunksToContent(currentContent, hunks);
                    if (isEncrypted) {
                        const outbound = await SyncCryptoGateway.encryptOutbound(
                            fileId,
                            nextContent,
                            uid || undefined
                        );
                        await toggleFileEncryption(
                            fileId,
                            true,
                            outbound.ciphertextBase64,
                            outbound.encryptionMetadata,
                            {
                                expectedVersion: localFile?.version ?? undefined,
                                expectedETag: localFile?.etag ?? undefined,
                            }
                        ).catch(() => undefined);

                        if (localFile) {
                            await indexedDBManager
                                .saveFile(
                                    {
                                        ...localFile,
                                        content: outbound.ciphertextBase64,
                                        isEncrypted: true,
                                        encryptionMetadata: outbound.encryptionMetadata,
                                        isDirty: false,
                                        lastModified: Date.now(),
                                        lastSyncedAt: Date.now(),
                                    },
                                    uid
                                )
                                .catch(() => undefined);
                        }
                    } else {
                        await updateFileContent(fileId, nextContent, {
                            expectedVersion: localFile?.version ?? undefined,
                            expectedETag: localFile?.etag ?? undefined,
                        }).catch(() => undefined);

                        if (localFile) {
                            await indexedDBManager
                                .saveFile(
                                    {
                                        ...localFile,
                                        content: nextContent,
                                        isEncrypted: false,
                                        encryptionMetadata: null,
                                        isDirty: false,
                                        lastModified: Date.now(),
                                        lastSyncedAt: Date.now(),
                                    },
                                    uid
                                )
                                .catch(() => undefined);
                        }
                    }
                }
            } catch {
                // Ensure UI state clears even if offline or running in unit tests
            }

            clearFileGhostHunks(fileId);
            updateTabState(fileId, { isDirty: false, pendingGhostCount: 0 });
        },
        [ghostHunksByFileId, clearFileGhostHunks, updateTabState]
    );

    const rejectAllPendingInFile = useCallback(
        (fileId: string) => {
            const hunks = ghostHunksByFileId[fileId];
            if (hunks) {
                for (const hunk of hunks) {
                    hunk.onReject?.();
                }
            }
            clearFileGhostHunks(fileId);
        },
        [ghostHunksByFileId, clearFileGhostHunks]
    );

    const acceptAllPendingInWorkspace = useCallback(async () => {
        const fileIds = Object.keys(ghostHunksByFileId);
        for (const fileId of fileIds) {
            await acceptAllPendingInFile(fileId);
        }
        if (saveFlushHandlerRef.current) {
            await saveFlushHandlerRef.current();
        }
        setOpenTabs((prev) => prev.map((t) => ({ ...t, isDirty: false, pendingGhostCount: 0 })));
    }, [ghostHunksByFileId, acceptAllPendingInFile]);

    const rejectAllPendingInWorkspace = useCallback(() => {
        for (const fileId of Object.keys(ghostHunksByFileId)) {
            rejectAllPendingInFile(fileId);
        }
    }, [ghostHunksByFileId, rejectAllPendingInFile]);

    const discardAllDirtyAndPending = useCallback(async () => {
        await discardFlushHandlerRef.current?.();
        rejectAllPendingInWorkspace();
        setOpenTabs((prev) => prev.map((t) => ({ ...t, isDirty: false, pendingGhostCount: 0 })));
    }, [rejectAllPendingInWorkspace]);

    const registerSaveFlushHandler = useCallback((fn: (() => Promise<void>) | null) => {
        saveFlushHandlerRef.current = fn;
    }, []);

    const registerDiscardFlushHandler = useCallback(
        (fn: (() => void | Promise<void>) | null) => {
            discardFlushHandlerRef.current = fn;
        },
        []
    );

    const totalPendingGhostCount = useMemo(
        () => Object.values(ghostHunksByFileId).reduce((sum, hunks) => sum + hunks.length, 0),
        [ghostHunksByFileId]
    );

    const hasUnsavedDirtyBuffer = useMemo(
        () => openTabs.some((tab) => tab.isDirty),
        [openTabs]
    );

    const value = useMemo<WorkspaceTabsContextValue>(
        () => ({
            workspaces,
            activeWorkspaceId,
            activeWorkspace,
            setActiveWorkspaceId,
            refreshWorkspaces,
            openTabs,
            activeFileId,
            openTab,
            closeTab,
            setActiveFileId,
            updateTabState,
            ghostHunksByFileId,
            turnIdByHunkId,
            totalPendingGhostCount,
            hasUnsavedDirtyBuffer,
            setGhostHunksForFile,
            acceptAllPendingInFile,
            rejectAllPendingInFile,
            acceptAllPendingInWorkspace,
            rejectAllPendingInWorkspace,
            discardAllDirtyAndPending,
            registerSaveFlushHandler,
            registerDiscardFlushHandler,
        }),
        [
            workspaces,
            activeWorkspaceId,
            activeWorkspace,
            setActiveWorkspaceId,
            refreshWorkspaces,
            openTabs,
            activeFileId,
            openTab,
            closeTab,
            updateTabState,
            ghostHunksByFileId,
            turnIdByHunkId,
            totalPendingGhostCount,
            hasUnsavedDirtyBuffer,
            setGhostHunksForFile,
            acceptAllPendingInFile,
            rejectAllPendingInFile,
            acceptAllPendingInWorkspace,
            rejectAllPendingInWorkspace,
            discardAllDirtyAndPending,
            registerSaveFlushHandler,
            registerDiscardFlushHandler,
        ]
    );

    return <WorkspaceTabsContext.Provider value={value}>{children}</WorkspaceTabsContext.Provider>;
}

export function useWorkspaceTabs(): WorkspaceTabsContextValue {
    const ctx = useContext(WorkspaceTabsContext);
    if (!ctx) {
        throw new Error("useWorkspaceTabs must be used within a WorkspaceTabsProvider");
    }
    return ctx;
}

export function useOptionalWorkspaceTabs(): WorkspaceTabsContextValue | null {
    return useContext(WorkspaceTabsContext);
}

export function WorkspaceTabBar(): React.JSX.Element {
    const { openTabs, activeFileId, setActiveFileId, closeTab } = useWorkspaceTabs();

    return (
        <div
            role="tablist"
            aria-label="Open workspace tabs"
            className="h-10 border-b border-zinc-800/60 bg-zinc-950/90 flex items-center justify-between px-2 gap-2 flex-shrink-0"
        >
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0 flex-1">
                {openTabs.map((tab) => {
                    const isActive = tab.fileId === activeFileId;
                    return (
                        <div
                            key={tab.fileId}
                            role="tab"
                            aria-selected={isActive}
                            onClick={() => {
                                setActiveFileId(tab.fileId);
                                navigateTo(`/workspace/editor/${tab.fileId}`);
                            }}
                            className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-t-md text-xs font-medium cursor-pointer transition-colors max-w-[200px] border-b-2 ${
                                isActive
                                    ? "bg-zinc-900 text-zinc-100 border-indigo-500"
                                    : "text-zinc-400 border-transparent hover:text-zinc-200 hover:bg-zinc-900/50"
                            }`}
                        >
                            {tab.isEncrypted && (
                                <Lock className="w-3 h-3 text-amber-400 flex-shrink-0" aria-label="Encrypted file" />
                            )}
                            <span className="truncate">{tab.title}</span>
                            {tab.isDirty && (
                                <span
                                    className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0"
                                    title="Unsaved changes"
                                    aria-label="Unsaved changes"
                                />
                            )}
                            {tab.pendingGhostCount > 0 && (
                                <span
                                    className="px-1.5 py-0.5 text-[10px] leading-none font-semibold rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex-shrink-0"
                                    title={`${tab.pendingGhostCount} pending AI edits`}
                                >
                                    {tab.pendingGhostCount}
                                </span>
                            )}
                            <button
                                type="button"
                                aria-label={`Close ${tab.title}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    closeTab(tab.fileId);
                                }}
                                className="ml-1 p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors flex-shrink-0"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    );
                })}
            </div>

            <div className="flex items-center flex-shrink-0">
                <UnresolvedEditsTracker />
            </div>
        </div>
    );
}
