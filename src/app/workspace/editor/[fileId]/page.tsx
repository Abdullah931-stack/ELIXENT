"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
    MarkdownEditor,
    type EditorAdapter,
    type EditorMode,
    type EditorSelection,
    type DirectionSettings,
    type TextDirectionMode,
} from "@/components/editor/markdown";
import { AIToolbar } from "@/components/editor/ai-toolbar";
import { SearchReplace } from "@/components/editor/search-replace";
import { countWords, detectTextDirection, countCharacters } from "@/lib/utils";
import { Loader2, AlertTriangle, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { SyncIndicator } from "@/components/sync/sync-indicator";
import { AIStreamStatus } from "@/components/editor/ai-stream-status";
import { AgentChatPanel } from "@/components/agent/chat-panel";
import { ConflictDialog } from "@/components/sync/conflict-dialog";
import { useEditorOrchestrator } from "@/hooks/use-editor-orchestrator";
import { VaultUnlockModal } from "@/components/vault";
import { ExportWarningModal } from "@/components/export/export-warning-modal";

export default function EditorPage() {
    const params = useParams();
    const router = useRouter();
    const fileId = params.fileId as string;

    const [userId, setUserId] = useState<string | null>(null);
    const [isAgentPanelOpen, setIsAgentPanelOpen] = useState(false);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [selectedText, setSelectedText] = useState("");
    const [editorMode, setEditorMode] = useState<EditorMode>("live");
    const [adapter, setAdapter] = useState<EditorAdapter | null>(null);
    const [directionSettings, setDirectionSettings] = useState<DirectionSettings>(() => {
        if (typeof window !== "undefined") {
            try {
                const saved = localStorage.getItem("lugx_editor_direction_pref");
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed && typeof parsed === "object") {
                        return {
                            mode: ["auto", "rtl", "ltr"].includes(parsed.mode) ? parsed.mode : "auto",
                            lockCodeBlocksLTR:
                                typeof parsed.lockCodeBlocksLTR === "boolean"
                                    ? parsed.lockCodeBlocksLTR
                                    : true,
                        };
                    }
                }
            } catch {
                // Ignore localStorage errors (e.g. privacy mode / SSR)
            }
        }
        return {
            mode: "auto",
            lockCodeBlocksLTR: true,
        };
    });
    const [isExportWarningOpen, setIsExportWarningOpen] = useState(false);
    const [pendingExportFormat, setPendingExportFormat] = useState<"md" | "txt">("txt");

    // Update direction settings callback
    const handleDirectionSettingsChange = useCallback(
        (updated: Partial<DirectionSettings>) => {
            setDirectionSettings((prev) => {
                const next = { ...prev, ...updated };
                try {
                    localStorage.setItem("lugx_editor_direction_pref", JSON.stringify(next));
                } catch {
                    // Ignore storage errors
                }
                if (adapter) {
                    adapter.setDirectionSettings(next);
                }
                return next;
            });
        },
        [adapter]
    );

    // Stabilized navigation callback
    const handleNavigate = useCallback((path: string) => router.push(path), [router]);

    // Resilient return-to-workspace handler guaranteeing navigation across client/fatal states
    const handleReturnToWorkspace = useCallback(() => {
        router.push("/workspace");
        if (typeof window !== "undefined") {
            setTimeout(() => {
                if (window.location.pathname.startsWith("/workspace/editor")) {
                    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Intentional hard navigation watchdog if SPA router hangs on fatal state
                    window.location.assign("/workspace");
                }
            }, 400);
        }
    }, [router]);

    // Centralized Editor Orchestrator
    const {
        title,
        hydration,

        // Architectural Agent & Multi-Hunk Ghost State (Phase 11)
        aiStatus,
        aiError,
        agentGraphStage,
        activeQuestionQueue,
        masterDecisionLedger,
        activeGhostHunks,
        activeGhostHunksCount,
        startAgentSession,
        resumeAgentInterrupt,
        stopAIOperation,
        resetAI,
        acceptGhostHunk,
        rejectGhostHunk,
        acceptAllGhostHunks,
        rejectAllGhostHunks,

        // Editor & Sync State
        isCommitting,
        isAIActive,
        isAIConflict,
        isSaving,
        lastSaved,
        error,
        setError,

        activeConflict,
        isConflictDialogOpen,
        setIsConflictDialogOpen,
        isResolvingConflict,
        handleResolveConflict,

        syncHook,
        handleEditorChange,

        // Vault State
        isEncrypted,
        allowAIOnEncryptedFiles,
        isVaultLocked,
        isUnlockModalOpen,
        setIsUnlockModalOpen,
        handleVaultUnlocked,
    } = useEditorOrchestrator({
        fileId,
        userId,
        editor: adapter,
        onNavigate: handleNavigate,
    });

    const isVaultUnlocked = !isVaultLocked;

    // Fetch authenticated user ID
    useEffect(() => {
        async function fetchUser() {
            try {
                const supabase = createClient();
                const {
                    data: { user },
                } = await supabase.auth.getUser();
                if (user) {
                    setUserId(user.id);
                }
            } catch (authErr) {
                console.warn("[Editor] fetchUser network exception:", authErr);
            }
        }
        fetchUser();
    }, []);

    // Keyboard shortcuts (Ctrl+F for search, Escape for stopping AI generation, Ctrl+Alt+D for direction cycle)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "f" && !e.altKey) {
                e.preventDefault();
                setIsSearchOpen(true);
            } else if (e.key === "Escape" && isAIActive) {
                stopAIOperation();
            } else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key.toLowerCase() === "d" || e.code === "KeyD")) {
                if (e.repeat) return;
                e.preventDefault();
                setDirectionSettings((prev) => {
                    const nextMode: TextDirectionMode = prev.mode === "auto" ? "rtl" : prev.mode === "rtl" ? "ltr" : "auto";
                    const next: DirectionSettings = { ...prev, mode: nextMode };
                    try {
                        localStorage.setItem("lugx_editor_direction_pref", JSON.stringify(next));
                    } catch {
                        // Ignore storage errors
                    }
                    if (adapter) {
                        adapter.setDirectionSettings(next);
                    }
                    return next;
                });
            }
        };

        window.addEventListener("keydown", handleKeyDown);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [isAIActive, stopAIOperation, adapter]);

    // Copy raw Markdown to clipboard with safe fallback
    const handleCopy = useCallback(async () => {
        if (!adapter) return;
        try {
            await navigator.clipboard.writeText(adapter.getValue());
        } catch (copyErr) {
            console.warn("[Editor] Clipboard writeText failed, attempting fallback:", copyErr);
            try {
                const textArea = document.createElement("textarea");
                textArea.value = adapter.getValue();
                textArea.style.position = "fixed";
                textArea.style.opacity = "0";
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand("copy");
                document.body.removeChild(textArea);
            } catch (fallbackErr) {
                console.error("[Editor] Fallback copy failed:", fallbackErr);
            }
        }
    }, [adapter]);

    // Toggle search and replace dialog
    const handleSearch = useCallback(() => {
        setIsSearchOpen((prev) => !prev);
    }, []);

    // Formatting handler
    const handleFormat = useCallback(
        (prefix: string, suffix: string = "", placeholder: string = "") => {
            if (adapter) {
                adapter.insertMarkdown(prefix, suffix, placeholder);
            }
        },
        [adapter]
    );

    // Toggle between Live Preview and Raw Source mode
    const handleToggleMode = useCallback(() => {
        setEditorMode((prev) => (prev === "live" ? "source" : "live"));
    }, []);

    // Governed document export execution
    const executeExport = useCallback(
        async (format: "md" | "txt", confirmedPlaintext: boolean) => {
            if (!adapter) return;

            try {
                const { exportDocument, triggerBrowserDownload } = await import("@/lib/export/export-service");
                const content = adapter.getValue();
                const result = await exportDocument({
                    content,
                    filename: title || "document",
                    format,
                    isEncrypted,
                    confirmedPlaintextExport: confirmedPlaintext,
                });

                if (result.success && result.blob && result.filename) {
                    triggerBrowserDownload(result.blob, result.filename);
                } else {
                    setError(result.error || "Export failed");
                }
            } catch (err) {
                setError("Export failed: " + (err instanceof Error ? err.message : "Unknown error"));
                console.error("Export error:", err);
            }
        },
        [adapter, title, isEncrypted, setError]
    );

    // Export document in multiple formats (MD, TXT)
    const handleExport = useCallback(
        async (format: "md" | "txt" = "txt") => {
            if (!adapter) return;

            // Zero-Knowledge Encrypted Content Governance Barrier (LUGX-004, LUGX-085)
            if (isEncrypted) {
                setPendingExportFormat(format);
                setIsExportWarningOpen(true);
                return;
            }

            await executeExport(format, false);
        },
        [adapter, isEncrypted, executeExport]
    );

    // Dynamic stats computation from raw Markdown
    const isSelection = selectedText.length > 0;
    const textToAnalyze = isSelection ? selectedText : adapter?.getValue() || "";
    const wordCount = isSelection
        ? countWords(selectedText)
        : adapter
        ? adapter.getWordCount()
        : 0;
    const charCount = isSelection
        ? countCharacters(selectedText)
        : adapter
        ? adapter.getCharCount()
        : 0;
    const textDir = detectTextDirection(textToAnalyze);

    return (
        <div className="h-full flex flex-col bg-zinc-950">
            {/* Toolbar - Fixed position */}
            <AIToolbar
                onToggleAgentPanel={() => setIsAgentPanelOpen((prev) => !prev)}
                isAgentPanelOpen={isAgentPanelOpen}
                activeGhostHunksCount={activeGhostHunksCount}
                onAcceptAllGhostHunks={acceptAllGhostHunks}
                onRejectAllGhostHunks={rejectAllGhostHunks}
                onUndo={() => adapter?.undo()}
                onRedo={() => adapter?.redo()}
                onExport={handleExport}
                onCopy={handleCopy}
                onSearch={handleSearch}
                onStop={stopAIOperation}
                onFormat={handleFormat}
                mode={editorMode}
                onToggleMode={handleToggleMode}
                directionSettings={directionSettings}
                onDirectionSettingsChange={handleDirectionSettingsChange}
                canUndo={adapter?.canUndo() || false}
                canRedo={adapter?.canRedo() || false}
                isLoading={isAIActive}
                isEncrypted={isEncrypted}
                isVaultUnlocked={isVaultUnlocked}
                allowAIOnEncryptedFiles={allowAIOnEncryptedFiles}
                allowAIOnEncrypted={allowAIOnEncryptedFiles}
            />

            {/* Search and Replace Dialog */}
            <SearchReplace
                adapter={adapter}
                isOpen={isSearchOpen}
                onClose={() => setIsSearchOpen(false)}
            />

            {/* AI Stream Ephemeral Status & Alerts */}
            <AIStreamStatus
                status={aiStatus}
                currentStage={agentGraphStage}
                error={aiError}
                errorMessage={aiError}
                activeGhostHunksCount={activeGhostHunksCount}
                isConflict={isAIConflict}
                onRetry={resetAI}
                onStop={stopAIOperation}
                onCancel={stopAIOperation}
            />

            {/* Persistent Conflict Alert Banner */}
            {activeConflict && !isConflictDialogOpen && (
                <div className="mx-6 mt-4 p-3.5 rounded-lg bg-amber-950/40 border border-amber-800/60 flex items-center justify-between text-xs text-amber-300 flex-shrink-0 animate-in fade-in">
                    <div className="flex items-center gap-2.5">
                        <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                        <span>
                            <strong>Conflict Warning:</strong> Remote modifications detected on the server. Autosave is paused to protect your local data until the conflict is resolved.
                        </span>
                    </div>
                    <button
                        onClick={() => setIsConflictDialogOpen(true)}
                        className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors shadow-sm cursor-pointer"
                    >
                        Review & Resolve Conflict
                    </button>
                </div>
            )}

            {/* Conflict Resolution Modal Dialog */}
            {activeConflict && isConflictDialogOpen && (
                <ConflictDialog
                    conflict={activeConflict}
                    onResolve={handleResolveConflict}
                    onClose={() => setIsConflictDialogOpen(false)}
                    isResolving={isResolvingConflict}
                />
            )}

            {/* Error Message */}
            {error && (
                <div className="mx-6 mt-4 p-3 rounded-md bg-red-900/20 border border-red-800/50 text-red-300 text-sm flex-shrink-0 flex items-center justify-between">
                    <span>{error}</span>
                    <button
                        className="ml-2 text-red-400 hover:text-red-300 cursor-pointer"
                        onClick={() => setError(null)}
                    >
                        Dismiss
                    </button>
                </div>
            )}

            {/* Work Area: Editor Canvas + Side-by-Side Agent Chat Panel */}
            <div className="flex-1 flex overflow-hidden relative">
                {/* Editor - Scrollable container */}
                <div className="flex-1 overflow-auto custom-scrollbar relative">
                    {hydration === "hydrating" && !adapter?.getValue() && (
                        <div className="absolute inset-0 bg-zinc-950/80 backdrop-blur-xs z-10 flex flex-col items-center justify-center gap-3">
                            <Loader2 className="w-7 h-7 animate-spin text-indigo-400" />
                            <span className="text-xs text-zinc-400 font-medium">Loading and synchronizing document...</span>
                        </div>
                    )}
                    {hydration === "vault_locked" && (
                        <div className="absolute inset-0 z-20 bg-zinc-950 flex items-center justify-center">
                            <div className="m-6 p-8 rounded-xl bg-zinc-900 border border-zinc-800 text-center flex flex-col items-center justify-center gap-3 max-w-md mx-auto shadow-2xl">
                                <div className="p-3 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 mb-1">
                                    <Lock className="w-8 h-8" />
                                </div>
                                <h3 className="text-base font-semibold text-zinc-100">Document Encrypted & Protected</h3>
                                <p className="text-xs text-zinc-400 leading-relaxed max-w-sm">
                                    This document is end-to-end encrypted (Zero-Knowledge). Unlock your vault to view and edit content.
                                </p>
                                <div className="flex items-center gap-2 mt-3">
                                    <button
                                        onClick={() => setIsUnlockModalOpen(true)}
                                        className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5"
                                    >
                                        <Lock className="w-3.5 h-3.5" />
                                        <span>Unlock Vault</span>
                                    </button>
                                    <button
                                        onClick={handleReturnToWorkspace}
                                        className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors cursor-pointer"
                                    >
                                        Return to Workspace
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    {hydration === "fatal" ? (
                        <div className="m-6 p-8 rounded-xl bg-red-950/30 border border-red-800/40 text-center flex flex-col items-center justify-center gap-3 max-w-md mx-auto mt-16">
                            <AlertTriangle className="w-10 h-10 text-red-400" />
                            <h3 className="text-base font-semibold text-red-200">Unable to Open Document</h3>
                            <p className="text-xs text-zinc-400 leading-relaxed">
                                The requested document does not exist on the server and no local cached copy was found.
                            </p>
                            <button
                                onClick={handleReturnToWorkspace}
                                className="mt-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition-colors cursor-pointer"
                            >
                                Return to Workspace
                            </button>
                        </div>
                    ) : (
                        <div className={`max-w-4xl mx-auto p-4 md:p-6 ${hydration === "vault_locked" ? "invisible pointer-events-none" : ""}`}>
                            <MarkdownEditor
                                onAdapterReady={setAdapter}
                                onChange={handleEditorChange}
                                onSelectionChange={(_sel: EditorSelection) => {
                                    if (adapter) {
                                        setSelectedText(adapter.getSelectedText());
                                    }
                                }}
                                mode={editorMode}
                                onModeChange={setEditorMode}
                                dir={directionSettings.mode}
                                lockCodeBlocksLTR={directionSettings.lockCodeBlocksLTR}
                                onDirectionChange={handleDirectionSettingsChange}
                                placeholder="Start typing in Markdown..."
                                className="min-h-[70vh] text-zinc-300"
                            />
                        </div>
                    )}
                </div>

                {/* Elixent Architectural Agent Chat Panel */}
                <AgentChatPanel
                    isOpen={isAgentPanelOpen}
                    onClose={() => setIsAgentPanelOpen(false)}
                    status={aiStatus}
                    currentStage={agentGraphStage}
                    activeQuestionQueue={activeQuestionQueue}
                    masterDecisionLedger={masterDecisionLedger}
                    activeGhostHunksCount={activeGhostHunksCount}
                    activeGhostHunks={activeGhostHunks}
                    error={aiError}
                    onStartSession={startAgentSession}
                    onResumeInterrupt={resumeAgentInterrupt}
                    onStopSession={stopAIOperation}
                    onResetSession={resetAI}
                    onAcceptGhostHunk={acceptGhostHunk}
                    onRejectGhostHunk={rejectGhostHunk}
                    onAcceptAllGhostHunks={acceptAllGhostHunks}
                    onRejectAllGhostHunks={rejectAllGhostHunks}
                    targetFileIds={[fileId]}
                    isEncrypted={isEncrypted}
                    isVaultUnlocked={isVaultUnlocked}
                    allowAIOnEncryptedFiles={allowAIOnEncryptedFiles}
                />
            </div>

            {/* Status Bar - Fixed at bottom */}
            <div className="border-t border-zinc-800/50 px-4 py-2 flex items-center justify-between text-xs text-zinc-500 flex-shrink-0">
                {/* Left: File Title */}
                <span className="truncate max-w-[200px] flex items-center gap-1.5" title={title}>
                    {isEncrypted && <Lock className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
                    <span>{title || "Untitled"}</span>
                </span>

                {/* Center: Save Status & Sync Indicator */}
                <div className="flex items-center gap-2">
                    {hydration === "hydrating" ? (
                        <div className="flex items-center gap-1.5 text-zinc-400">
                            <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                            <span>Syncing...</span>
                        </div>
                    ) : (
                        <>
                            <span>Save</span>
                            {isSaving || isCommitting ? (
                                <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                            ) : lastSaved ? (
                                <div className="w-2 h-2 rounded-full bg-green-500/70 blur-[1px]" title="Saved" />
                            ) : (
                                <div className="w-2 h-2 rounded-full bg-red-500/70 blur-[1px]" title="Unsaved" />
                            )}
                        </>
                    )}

                    {/* Sync Status Indicator */}
                    {userId && (
                        <SyncIndicator
                            status={syncHook.status}
                            connectionState={syncHook.connectionState}
                            pendingCount={syncHook.pendingCount}
                            lastSyncResult={syncHook.lastSyncResult}
                            onSyncNow={() => syncHook.sync()}
                            compact={true}
                        />
                    )}
                </div>

                {/* Right: Stats (Words + Characters) + Text Direction */}
                <div className="flex items-center gap-3">
                    {isSelection && (
                        <span className="text-indigo-400 text-xs">Selected:</span>
                    )}
                    <span title={`${wordCount.toLocaleString()} word${wordCount !== 1 ? "s" : ""}`}>
                        {wordCount.toLocaleString()} words
                    </span>
                    <span className="text-zinc-700">|</span>
                    <span title={`${charCount.toLocaleString()} character${charCount !== 1 ? "s" : ""}`}>
                        {charCount.toLocaleString()} chars
                    </span>
                    <span className="uppercase">{textDir}</span>
                </div>
            </div>

            {/* Vault Unlock Modal */}
            {userId && (
                <VaultUnlockModal
                    isOpen={isUnlockModalOpen}
                    onClose={() => setIsUnlockModalOpen(false)}
                    onUnlocked={handleVaultUnlocked}
                    userId={userId}
                />
            )}

            {/* Plaintext Export Warning Modal for Encrypted Documents */}
            <ExportWarningModal
                isOpen={isExportWarningOpen}
                onClose={() => setIsExportWarningOpen(false)}
                onConfirm={() => {
                    setIsExportWarningOpen(false);
                    executeExport(pendingExportFormat, true);
                }}
                fileName={title || "document"}
                format={pendingExportFormat}
            />
        </div>
    );
}
