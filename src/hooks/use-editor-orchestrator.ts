"use client";

/**
 * useEditorOrchestrator
 *
 * Centralized State & Write Controller for Standalone Markdown Editor (Phase 2)
 *
 * Enforces:
 * 1. Single authoritative write path (manual save, AI commit, conflict resolution, sync replay).
 * 2. Strict auto-save suspension invariants (never saves during streaming, reserving, committing, conflict, or stopped).
 * 3. Manual edit during streaming policy: instantly aborts AI generation, clears ghost preview, refunds quota, and preserves user edits.
 * 4. Offline-first loading and optimistic concurrency synchronization with ETag and version precondition guards.
 * 5. Navigation & unload protection when dirty or in-flight committing.
 */

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { EditorAdapter } from "@/components/editor/markdown/types";
import { getFile, updateFileContent, toggleFileEncryption, renameFile, deleteFile } from "@/server/actions/file-ops";
import { getUserVaultProfile } from "@/server/actions/vault-actions";
import type { FileEncryptionMetadata } from "@/types/storage-payload";
import { useSync, type UseSyncReturn } from "@/hooks/use-sync";
import { useEditorAutosave, type UseEditorAutosaveReturn } from "@/hooks/use-editor-autosave";
import { useEditorConflict, type RemoteUpdatePayload } from "@/hooks/use-editor-conflict";
import { useAIStream } from "@/hooks/use-ai-stream";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { createClient } from "@/lib/supabase/client";
import { AIOperationType } from "@/lib/ai/stream-handler";
import { SyncConflict } from "@/lib/sync/idb-types";
import { ConflictResolutionPayload } from "@/components/sync/conflict-dialog";
import { broadcastCrossTabEvent } from "@/lib/sync/cross-tab-sync";
import {
    classifyRemoteUpdate,
    type LocalBaseline,
} from "@/lib/sync/reconciliation";
import { AIStreamStatus } from "@/lib/ai/stream-session";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";

export type { RemoteUpdatePayload } from "@/hooks/use-editor-conflict";

export type WriteStateType =
    | "idle"
    | "saving"
    | "ai_committing"
    | "resolving_conflict"
    | "syncing"
    | "stopped";

export interface UseEditorOrchestratorOptions {
    fileId: string;
    userId: string | null;
    /** EditorAdapter instance for standalone Markdown editor */
    editor?: EditorAdapter | null;
    /** Alias for editor */
    adapter?: EditorAdapter | null;
    onNavigate?: (path: string) => void;
}

export interface UseEditorOrchestratorReturn {
    // 1. Document State
    title: string;
    setTitle: (title: string) => void;
    handleTitleChange: (newTitle: string) => Promise<void>;
    handleDeleteFile: () => Promise<void>;

    // 2. Preview & AI State
    aiStatus: AIStreamStatus;
    previewText: string;
    isStreaming: boolean;
    isCommitting: boolean;
    isAIActive: boolean;
    aiError: string | null;
    isAIConflict: boolean;
    startAIOperation: (operation: AIOperationType) => Promise<void>;
    stopAIOperation: () => void;
    resetAI: () => void;
    /** Accept the completed AI preview: server-first commit + atomic local replace. */
    commitAIPreview: () => Promise<void>;
    /** Reject the completed AI preview: discard output, settle quota as consumed. */
    rejectAIPreview: () => void;
    /** Re-run the last AI operation with identical inputs after settling the current preview. */
    retryAIPreview: () => Promise<void>;

    // 3. Dirty & Save State
    isDirty: boolean;
    isSaving: boolean;
    lastSaved: Date | null;
    error: string | null;
    setError: (error: string | null) => void;

    // 4. Server Version State
    serverVersion: number;
    serverEtag: string | null;

    // 5. Conflict State
    activeConflict: SyncConflict | null;
    isConflictDialogOpen: boolean;
    setIsConflictDialogOpen: (open: boolean) => void;
    isResolvingConflict: boolean;
    handleResolveConflict: (resolution: ConflictResolutionPayload) => Promise<void>;

    // 6. Write Controller & Sync State
    writeState: WriteStateType;
    /** Exposed for tests and UI gating: whether an auto-save may fire right now. */
    canAutoSave: () => boolean;
    /** Hydration lifecycle of the initial load pipeline for this file. */
    hydration: "hydrating" | "ready" | "fatal" | "vault_locked";
    syncHook: ReturnType<typeof useSync>;
    handleEditorChange: (newContent: string) => void;

    // 7. Vault State
    isEncrypted: boolean;
    allowAIOnEncryptedFiles: boolean;
    isVaultLocked: boolean;
    isUnlockModalOpen: boolean;
    setIsUnlockModalOpen: (open: boolean) => void;
    handleVaultUnlocked: () => Promise<void>;
}


export function useEditorOrchestrator({
    fileId,
    userId,
    editor,
    adapter,
    onNavigate,
}: UseEditorOrchestratorOptions): UseEditorOrchestratorReturn {
    const currentAdapter = adapter || editor || null;
    const adapterRef = useRef<EditorAdapter | null>(currentAdapter);
    useLayoutEffect(() => {
        adapterRef.current = currentAdapter;
    }, [currentAdapter]);

    // --- 1. Document State ---
    const [title, setTitle] = useState<string>("");

    // --- 2. Save & Error State ---
    const [isSaving, setIsSaving] = useState<boolean>(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);

    // --- 3. Server Version State & Invariants ---
    const [serverVersion, setServerVersion] = useState<number>(1);
    const [serverEtag, setServerEtag] = useState<string | null>(null);

    const fileVersionRef = useRef<number>(1);
    const fileEtagRef = useRef<string | null>(null);
    const editorGenerationRef = useRef<number>(1);
    const editorContentRef = useRef<string>("");
    const isProgrammaticUpdateRef = useRef<boolean>(false);
    const pendingRemoteUpdateRef = useRef<RemoteUpdatePayload | null>(null);
    // Synchronous mirror of the dirty flag, read by the reconciliation policy at
    // decision time without waiting for a React state flush.
    const isDirtyRef = useRef<boolean>(false);
    const autosaveRef = useRef<UseEditorAutosaveReturn | null>(null);

    const markClean = useCallback(() => {
        isDirtyRef.current = false;
        autosaveRef.current?.markClean();
    }, []);

    const markDirty = useCallback(() => {
        isDirtyRef.current = true;
        autosaveRef.current?.markDirty();
    }, []);

    const cancelAutosave = useCallback(() => {
        autosaveRef.current?.cancelAutosave();
    }, []);

    const runProgrammaticUpdate = useCallback((fn: () => void) => {
        isProgrammaticUpdateRef.current = true;
        try {
            fn();
        } finally {
            isProgrammaticUpdateRef.current = false;
        }
    }, []);
    const fileIdRef = useRef<string>(fileId);
    useEffect(() => {
        fileIdRef.current = fileId;
    }, [fileId]);

    // Keep editor adapter synchronized with editorContentRef if adapter mounts post-hydration
    useEffect(() => {
        if (currentAdapter && editorContentRef.current) {
            const currentDoc = currentAdapter.getValue();
            if (!currentDoc && editorContentRef.current) {
                isProgrammaticUpdateRef.current = true;
                try {
                    currentAdapter.setValue(editorContentRef.current);
                } finally {
                    isProgrammaticUpdateRef.current = false;
                }
            }
        }
    }, [currentAdapter]);
    // File-identity tracking guard: the initial load pipeline (IDB paint + background server fetch
    // + reconciliation) must run exactly once per mounted fileId.
    const loadedFileIdRef = useRef<string | null>(null);
    // HYDRATION LIFECYCLE (sync-before-write): the editor surface stays frozen
    // until the offline-first pipeline settled. 'fatal' means NOTHING could be
    // loaded from either side (server failure AND no local snapshot).
    const hydratedRef = useRef(false);
    const loadFailureRef = useRef(false);
    const [hydration, setHydration] = useState<"hydrating" | "ready" | "fatal" | "vault_locked">("hydrating");

    // --- 5. Vault Encryption State ---
    const [isEncrypted, setIsEncrypted] = useState<boolean>(false);
    const [allowAIOnEncryptedFiles, setAllowAIOnEncryptedFiles] = useState<boolean>(false);
    const [isVaultLocked, setIsVaultLocked] = useState<boolean>(false);
    const [isUnlockModalOpen, setIsUnlockModalOpen] = useState<boolean>(false);
    const isEncryptedRef = useRef<boolean>(false);
    const allowAIOnEncryptedFilesRef = useRef<boolean>(false);
    const fileEncryptionMetadataRef = useRef<FileEncryptionMetadata | null>(null);

    useEffect(() => {
        allowAIOnEncryptedFilesRef.current = allowAIOnEncryptedFiles;
    }, [allowAIOnEncryptedFiles]);

    useEffect(() => {
        async function fetchVaultProfile() {
            try {
                const res = await getUserVaultProfile();
                if (res.success && res.data) {
                    const allowed = !!res.data.allowAIOnEncryptedFiles;
                    setAllowAIOnEncryptedFiles(allowed);
                    allowAIOnEncryptedFilesRef.current = allowed;
                }
            } catch {
                // Ignore profile load errors in offline mode
            }
        }
        fetchVaultProfile();
    }, [userId]);
    const pendingEncryptedPayloadRef = useRef<{
        content: string;
        metadata: FileEncryptionMetadata | null;
        title: string;
        version: number;
        etag: string | null;
    } | null>(null);
    // SINGLE-FLIGHT guard: the initial pipeline must never fork into competing
    // getFile server-action cycles when render-scoped identities change.
    const pipelineRef = useRef<Promise<void> | null>(null);
    const markServerPersisted = useCallback((updatedAt?: string | Date | null) => {
        setLastSaved(updatedAt ? new Date(updatedAt) : new Date());
    }, []);

    const resolveEffectiveUserId = useCallback(async (): Promise<string> => {
        let resolved = userId;
        if (!resolved || resolved.trim() === "") {
            try {
                const supabase = createClient();
                const { data: { user } } = await supabase.auth.getUser();
                resolved = user?.id || "";
            } catch {
                resolved = "";
            }
        }
        if (!resolved || resolved.trim() === "") {
            throw new Error("[Orchestrator] User ID is missing or empty; cannot derive file AAD for encrypted operations.");
        }
        return resolved.trim();
    }, [userId]);

    // --- Sync Hook Integration ---
    const syncHookRef = useRef<UseSyncReturn | null>(null);
    const pendingLocalSyncRef = useRef<boolean>(false);

    // --- AI Stream Hook Integration ---
    const aiStream = useAIStream({
        transformCommitPayload: async (content: string) => {
            if (!isEncryptedRef.current) {
                return { content };
            }
            if (!sessionKeyStore.isVaultUnlocked()) {
                setError("الخزنة مقفلة. يرجى فتح الخزنة لحفظ تعديلات الذكاء الاصطناعي المشفرة.");
                setIsVaultLocked(true);
                setIsUnlockModalOpen(true);
                throw new Error("Vault master key missing from volatile memory");
            }
            const effectiveUid = await resolveEffectiveUserId();
            const outbound = await SyncCryptoGateway.encryptOutbound(fileId, content, effectiveUid);
            fileEncryptionMetadataRef.current = outbound.encryptionMetadata;
            return {
                content: outbound.ciphertextBase64,
                encryptionMetadata: outbound.encryptionMetadata,
            };
        },
        onCommitSuccess: async ({ version, etag, committedContent, encryptionMetadata }) => {
            fileVersionRef.current = version;
            setServerVersion(version);
            fileEtagRef.current = etag;
            setServerEtag(etag);
            editorGenerationRef.current += 1;
            editorContentRef.current = adapterRef.current?.getValue() || committedContent || "";
            isDirtyRef.current = false;
            setLastSaved(new Date());

            if (syncHookRef.current?.isInitialized && adapterRef.current) {
                try {
                    await syncHookRef.current.saveLocal({
                        id: fileId,
                        content: isEncryptedRef.current && committedContent ? committedContent : adapterRef.current.getValue(),
                        title,
                        version,
                        etag: etag || "",
                        isEncrypted: isEncryptedRef.current,
                        encryptionMetadata: isEncryptedRef.current ? (encryptionMetadata ?? fileEncryptionMetadataRef.current) : null,
                        isDirty: false,
                    });
                    pendingLocalSyncRef.current = false;
                    markClean();
                } catch (saveErr) {
                    console.error("[Orchestrator] Post-commit local IndexedDB save error:", saveErr);
                    // Defensive durability: retain dirty flag and schedule retry on tab wakeup
                    pendingLocalSyncRef.current = true;
                    markDirty();
                }
            } else {
                markClean();
            }

            broadcastCrossTabEvent({
                type: "file_saved",
                fileId,
                version,
                etag,
            });
        },
        onConflict: (svrVersion) => {
            console.warn("[Orchestrator] AI commit version conflict:", svrVersion);
        },
        onError: (err) => {
            setError(err.message);
        },
        getLatestVersion: () => fileVersionRef.current,
        getLatestETag: () => fileEtagRef.current,
        onProgrammaticTransaction: (fn) => {
            isProgrammaticUpdateRef.current = true;
            try {
                fn();
            } finally {
                isProgrammaticUpdateRef.current = false;
            }
        },
    });

    // Vault Unlock Handler: Decrypts pending payload and hydrates editor
    const handleVaultUnlocked = useCallback(async () => {
        setIsVaultLocked(false);
        setIsUnlockModalOpen(false);

        let pending = pendingEncryptedPayloadRef.current;
        if (!pending && isEncryptedRef.current) {
            const localFile = syncHookRef.current?.isInitialized
                ? await syncHookRef.current.loadLocal(fileId)
                : null;
            if (localFile && localFile.content) {
                pending = {
                    content: localFile.content,
                    metadata: localFile.encryptionMetadata || fileEncryptionMetadataRef.current,
                    title: localFile.title || title,
                    version: localFile.version || fileVersionRef.current,
                    etag: localFile.etag || fileEtagRef.current,
                };
            } else {
                const remoteRes = await getFile(fileId);
                if (remoteRes.success && remoteRes.data) {
                    pending = {
                        content: remoteRes.data.content || "",
                        metadata: remoteRes.data.encryptionMetadata || fileEncryptionMetadataRef.current,
                        title: remoteRes.data.title || title,
                        version: remoteRes.data.version || fileVersionRef.current,
                        etag: remoteRes.data.etag || fileEtagRef.current,
                    };
                }
            }
        }

        if (!pending) {
            hydratedRef.current = true;
            setHydration("ready");
            if (adapterRef.current) adapterRef.current.setEditable(true);
            return;
        }

        const masterKey = sessionKeyStore.getMasterKeyRaw();
        let contentToDisplay = pending.content;

        if (masterKey && pending.content) {
            try {
                const effectiveUid = await resolveEffectiveUserId();
                const inbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: pending.content,
                    isEncrypted: true,
                    encryptionMetadata: pending.metadata,
                    userId: effectiveUid,
                });

                if (inbound.status === "decrypted") {
                    contentToDisplay = inbound.content;
                } else {
                    console.error("[Orchestrator] Decryption failed upon vault unlock (LUGX-048):", inbound.error);
                    setError("تعذّر فك تشفير محتوى الملف (بيانات تالفة أو مفتاح غير صالح).");
                    setHydration("fatal");
                    hydratedRef.current = false;
                    if (adapterRef.current) adapterRef.current.setEditable(false);
                    return;
                }
            } catch (err) {
                console.error("[Orchestrator] Decryption error upon vault unlock (LUGX-048):", err);
                setError("تعذّر فك تشفير محتوى الملف (بيانات تالفة أو مفتاح غير صالح).");
                setHydration("fatal");
                hydratedRef.current = false;
                if (adapterRef.current) adapterRef.current.setEditable(false);
                return;
            }
        }

        setTitle(pending.title);
        fileVersionRef.current = pending.version;
        setServerVersion(pending.version);
        fileEtagRef.current = pending.etag;
        setServerEtag(pending.etag);
        editorGenerationRef.current += 1;
        editorContentRef.current = contentToDisplay;

        isProgrammaticUpdateRef.current = true;
        try {
            adapterRef.current?.setValue(contentToDisplay);
        } finally {
            isProgrammaticUpdateRef.current = false;
        }

        hydratedRef.current = true;
        setHydration("ready");
        if (adapterRef.current) adapterRef.current.setEditable(true);
        pendingEncryptedPayloadRef.current = null;
    }, [fileId, resolveEffectiveUserId, title]);

    const conflictHook = useEditorConflict({
        fileId,
        userId,
        getTitle: () => title,
        setTitle,
        getVersion: () => fileVersionRef.current,
        setVersion: (v) => {
            fileVersionRef.current = v;
            setServerVersion(v);
        },
        getEtag: () => fileEtagRef.current,
        setEtag: (e) => {
            fileEtagRef.current = e;
            setServerEtag(e);
        },
        markServerPersisted,
        getEditorContent: () => editorContentRef.current,
        setEditorContent: (c) => {
            editorContentRef.current = c;
        },
        getAdapter: () => adapterRef.current,
        isProgrammaticUpdate: () => isProgrammaticUpdateRef.current,
        setProgrammaticUpdate: (val) => {
            isProgrammaticUpdateRef.current = val;
        },
        incrementEditorGeneration: () => {
            editorGenerationRef.current += 1;
        },
        isDirty: () => isDirtyRef.current,
        markClean,
        markDirty,
        cancelAutosave,
        isAIActive: () =>
            aiStream.isLoading ||
            aiStream.isStreaming ||
            aiStream.isCommitting ||
            aiStream.status === "reserved" ||
            aiStream.status === "preview_ready",
        isHydrated: () => hydratedRef.current,
        setHydration,
        setPendingRemoteUpdate: (p) => {
            pendingRemoteUpdateRef.current = p;
        },
        setPendingEncryptedPayload: (p) => {
            pendingEncryptedPayloadRef.current = p;
        },
        isEncrypted: () => isEncryptedRef.current,
        setIsEncrypted: (val) => {
            isEncryptedRef.current = val;
            setIsEncrypted(val);
        },
        getEncryptionMetadata: () => fileEncryptionMetadataRef.current,
        setEncryptionMetadata: (meta) => {
            fileEncryptionMetadataRef.current = meta;
        },
        setIsVaultLocked,
        setIsUnlockModalOpen,
        handleVaultUnlocked,
        saveLocal: async (payload) => {
            if (syncHookRef.current?.isInitialized) {
                await syncHookRef.current.saveLocal(payload);
            }
        },
        loadLocal: async (id) => {
            return syncHookRef.current?.isInitialized ? await syncHookRef.current.loadLocal(id) : null;
        },
        isSyncInitialized: () => syncHookRef.current?.isInitialized ?? false,
        setError,
        onNavigate,
        resolveEffectiveUserId,
    });
    const { isBlockedByConflict, handle412Conflict } = conflictHook;

    const syncHook = useSync({
        userId: userId || "",
        autoSyncInterval: 30000,
        onConflict: conflictHook.handleSyncConflict,
        onRemoteUpdate: conflictHook.handleRemoteUpdate,
    });
    useLayoutEffect(() => {
        syncHookRef.current = syncHook;
    }, [syncHook]);

    // Write State Computation
    const writeState: WriteStateType = conflictHook.isResolvingConflict
        ? "resolving_conflict"
        : aiStream.isCommitting
        ? "ai_committing"
        : isSaving
        ? "saving"
        : syncHook.status === "syncing"
        ? "syncing"
        : syncHook.status === "stopped"
        ? "stopped"
        : "idle";

    /**
     * AutoSave Suspension Invariants Gate & Callbacks (Phase 17)
     */
    const isBlocked = useCallback((): boolean => {
        if (isProgrammaticUpdateRef.current) return true;
        if (hydratedRef.current !== true) return true;
        if (isBlockedByConflict()) return true;
        if (syncHook.status === "stopped") return true;
        return false;
    }, [isBlockedByConflict, syncHook.status]);

    const isWriteLocked =
        aiStream.isLoading ||
        aiStream.isStreaming ||
        aiStream.isCommitting ||
        aiStream.status === "reserved" ||
        aiStream.status === "preview_ready";

    const flushOnUnmount = useCallback((content: string, targetFileId: string) => {
        if (!syncHookRef.current?.isInitialized) return;

        const performFlush = async () => {
            let contentToSave = content;
            let metaToSave = fileEncryptionMetadataRef.current;

            if (isEncryptedRef.current) {
                if (!sessionKeyStore.hasMasterKey()) {
                    console.warn(
                        `[Orchestrator] Unmount flush skipped for encrypted file ${targetFileId}: vault is locked, refusing to persist plaintext tagged as encrypted (LUGX-004).`
                    );
                    return;
                }

                try {
                    const effectiveUid = await resolveEffectiveUserId();
                    const encrypted = await SyncCryptoGateway.encryptOutbound(
                        targetFileId,
                        content,
                        effectiveUid
                    );
                    contentToSave = encrypted.ciphertextBase64;
                    metaToSave = encrypted.encryptionMetadata;
                } catch (err) {
                    console.error("[Orchestrator] Failed to encrypt outbound payload during unmount flush:", err);
                    return;
                }
            }

            try {
                await syncHookRef.current?.saveLocal({
                    id: targetFileId,
                    content: contentToSave,
                    title,
                    version: fileVersionRef.current,
                    etag: fileEtagRef.current || "",
                    isEncrypted: isEncryptedRef.current,
                    encryptionMetadata: metaToSave,
                    isDirty: true,
                });
            } catch (err) {
                console.warn("[Orchestrator] Unmount flush error:", err);
            }
        };

        performFlush();
    }, [title, resolveEffectiveUserId]);

    const onUserEdit = useCallback((content: string) => {
        const isAIActive =
            aiStream.isLoading ||
            aiStream.isStreaming ||
            aiStream.status === "reserved" ||
            aiStream.status === "preview_ready";

        if (isAIActive) {
            const ghostRange =
                typeof adapterRef.current?.getGhostRange === "function"
                    ? adapterRef.current.getGhostRange()
                    : null;

            if (!ghostRange) {
                console.warn(
                    "[Orchestrator] User manual edit collided with AI target range or entire document was modified. Aborting AI generation."
                );
                aiStream.stopStream();
            } else {
                console.log(
                    "[Orchestrator] User manual edit occurred outside AI target range. Retaining active stream at shifted range:",
                    ghostRange
                );
            }
        }

        // Touch inactivity timer upon user keystrokes / activity (AUD-04)
        sessionKeyStore.touch();

        editorContentRef.current = content;
        editorGenerationRef.current += 1;
    }, [aiStream]);

    /**
     * Centralized Server Write with ETag & Version Precondition Guard
     */
    const executeServerWrite = useCallback(
        async (content: string, targetFileId?: string) => {
            const activeTargetId = targetFileId || fileId;
            if (activeTargetId !== fileIdRef.current) {
                console.log("[Orchestrator] Auto-save skipped: target fileId mismatch with active file", {
                    activeTargetId,
                    currentFileId: fileIdRef.current,
                });
                return;
            }
            if (!hydratedRef.current) {
                console.log("[Orchestrator] Auto-save deferred: hydration not complete.");
                return;
            }
            if (isBlocked() || isWriteLocked) {
                console.log("[Orchestrator] Auto-save skipped due to active suspension gate invariant");
                return;
            }

            setIsSaving(true);

            let contentToSend = content ?? editorContentRef.current ?? "";
            let metaToSend = fileEncryptionMetadataRef.current;

            try {

                if (isEncryptedRef.current) {
                    const masterKey = sessionKeyStore.getMasterKeyRaw();
                    if (!masterKey) {
                        console.error("[Orchestrator] Cannot save encrypted file: Master key missing from memory");
                        setIsSaving(false);
                        setError("الخزنة مقفلة. يرجى فتح الخزنة لحفظ التعديلات المشفرة بأمان.");
                        setIsVaultLocked(true);
                        setIsUnlockModalOpen(true);
                        return;
                    }

                    const effectiveUid = await resolveEffectiveUserId();
                    const encResult = await SyncCryptoGateway.encryptOutbound(
                        fileId,
                        contentToSend,
                        effectiveUid
                    );
                    contentToSend = encResult.ciphertextBase64;
                    metaToSend = encResult.encryptionMetadata;
                    fileEncryptionMetadataRef.current = metaToSend;
                }

                const saveRes = isEncryptedRef.current
                    ? await toggleFileEncryption(fileId, true, contentToSend, metaToSend, {
                          expectedVersion: fileVersionRef.current,
                          expectedETag: fileEtagRef.current || undefined,
                      })
                    : await updateFileContent(fileId, contentToSend, {
                          expectedVersion: fileVersionRef.current,
                          expectedETag: fileEtagRef.current || undefined,
                      });

                if (saveRes.success && saveRes.version) {
                    fileVersionRef.current = saveRes.version;
                    setServerVersion(saveRes.version);
                    fileEtagRef.current = saveRes.etag || null;
                    setServerEtag(saveRes.etag || null);
                    editorGenerationRef.current += 1;
                    setLastSaved(new Date());
                    markClean();

                    // Update local storage clean first (always store ciphertext for encrypted files)
                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? contentToSend : content,
                            title,
                            version: saveRes.version,
                            etag: saveRes.etag || fileEtagRef.current || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: metaToSend,
                            isDirty: false,
                        });
                    }

                    // Broadcast cross-tab only AFTER IndexedDB commit settles
                    broadcastCrossTabEvent({
                        type: "file_saved",
                        fileId,
                        version: saveRes.version,
                        etag: saveRes.etag || undefined,
                    });
                } else if (saveRes.status === "conflict" && saveRes.serverVersion) {
                    await handle412Conflict(
                        saveRes.serverVersion,
                        content ?? editorContentRef.current ?? "",
                        {
                            contentToSend,
                            metaToSend,
                        }
                    );
                } else {
                    // Offline / Network failure -> save dirty locally with ciphertext
                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? contentToSend : content,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: metaToSend,
                            isDirty: true,
                        });
                    }
                }
            } catch (saveErr) {
                console.warn("[Orchestrator] Save failed, saving dirty to IndexedDB:", saveErr);
                if (syncHook.isInitialized) {
                    if (isEncryptedRef.current && (!metaToSend?.iv || contentToSend === content)) {
                        console.warn("[Orchestrator] Cannot save dirty encrypted file to IDB: content is not encrypted.");
                        return;
                    }
                    try {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? contentToSend : content,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: metaToSend,
                            isDirty: true,
                        });
                    } catch (dirtySaveErr) {
                        console.error("[Orchestrator] Fallback dirty save to IndexedDB failed:", dirtySaveErr);
                    }
                }
            } finally {
                setIsSaving(false);
            }
        },
        [fileId, title, isBlocked, isWriteLocked, syncHook, resolveEffectiveUserId, markClean, handle412Conflict]
    );

    const autosave = useEditorAutosave({
        fileId,
        isWriteLocked,
        isBlocked,
        persist: executeServerWrite,
        flushOnUnmount,
        getContent: () => {
            if (typeof editorContentRef.current === "string" && editorContentRef.current.length > 0) {
                return editorContentRef.current;
            }
            const adapterVal = adapterRef.current?.getValue();
            if (typeof adapterVal === "string" && adapterVal.length > 0) {
                return adapterVal;
            }
            return editorContentRef.current ?? adapterVal ?? null;
        },
        onUserEdit,
    });

    useLayoutEffect(() => {
        autosaveRef.current = autosave;
    });

    useEffect(() => {
        isDirtyRef.current = autosave.isDirty;
    }, [autosave.isDirty]);


    // Initial Load - Offline-First with Background Server Sync
    useEffect(() => {
        let cancelled = false;

        async function loadInitialFile() {
            if (loadedFileIdRef.current === fileId) return;

            // Freeze the editor surface so nothing can be typed pre-hydration.
            hydratedRef.current = false;
            loadFailureRef.current = false;
            setHydration("hydrating");
            if (adapterRef.current) {
                adapterRef.current.setEditable(false);
            }

            const sh = syncHookRef.current;
            let localBaseline: LocalBaseline | null = null;
            let isVaultLockedExit = false;
            let isFatalExit = false;

            try {
                // Step 1: instant paint from IndexedDB (offline-first).
                if (sh?.isInitialized) {
                    const localFile = await sh.loadLocal(fileId);
                    if (!cancelled && localFile) {
                        const fileIsEncrypted = !!localFile.isEncrypted;
                        isEncryptedRef.current = fileIsEncrypted;
                        setIsEncrypted(fileIsEncrypted);
                        fileEncryptionMetadataRef.current = localFile.encryptionMetadata || null;

                        if (fileIsEncrypted && !sessionKeyStore.hasMasterKey()) {
                            isVaultLockedExit = true;
                            pendingEncryptedPayloadRef.current = {
                                content: localFile.content || "",
                                metadata: localFile.encryptionMetadata || null,
                                title: localFile.title,
                                version: localFile.version || 1,
                                etag: localFile.etag || null,
                            };
                            setTitle(localFile.title);
                            setIsVaultLocked(true);
                            setIsUnlockModalOpen(true);
                            setHydration("vault_locked");
                            if (adapterRef.current) adapterRef.current.setEditable(false);
                            return;
                        }

                        let initialContent = localFile.content || "";
                        if (fileIsEncrypted && initialContent) {
                            try {
                                const effectiveUid = await resolveEffectiveUserId();
                                const inbound = await SyncCryptoGateway.decryptInbound({
                                    fileId,
                                    content: initialContent,
                                    isEncrypted: true,
                                    encryptionMetadata: localFile.encryptionMetadata || null,
                                    userId: effectiveUid,
                                });

                                if (inbound.status === "decrypted") {
                                    initialContent = inbound.content;
                                    if (inbound.encryptionMetadata) {
                                        fileEncryptionMetadataRef.current = inbound.encryptionMetadata;
                                    }
                                } else if (inbound.status === "locked") {
                                    isVaultLockedExit = true;
                                    pendingEncryptedPayloadRef.current = {
                                        content: localFile.content || "",
                                        metadata: localFile.encryptionMetadata || null,
                                        title: localFile.title,
                                        version: localFile.version || 1,
                                        etag: localFile.etag || null,
                                    };
                                    setTitle(localFile.title);
                                    setIsVaultLocked(true);
                                    setIsUnlockModalOpen(true);
                                    setHydration("vault_locked");
                                    if (adapterRef.current) adapterRef.current.setEditable(false);
                                    return;
                                } else {
                                    console.error("[Orchestrator] Local IDB decryption failure (LUGX-048):", inbound.error);
                                    setError("تعذّر فك تشفير محتوى الملف المحلي (بيانات تالفة أو مفتاح غير صالح).");
                                    isFatalExit = true;
                                    setHydration("fatal");
                                    hydratedRef.current = false;
                                    if (adapterRef.current) adapterRef.current.setEditable(false);
                                    return;
                                }
                            } catch (decErr) {
                                console.error("[Orchestrator] Local IDB decrypt error (LUGX-048):", decErr);
                                setError("تعذّر فك تشفير محتوى الملف المحلي (بيانات تالفة أو مفتاح غير صالح).");
                                isFatalExit = true;
                                setHydration("fatal");
                                hydratedRef.current = false;
                                if (adapterRef.current) adapterRef.current.setEditable(false);
                                return;
                            }
                        }

                        localBaseline = {
                            version: localFile.version || 1,
                            etag: localFile.etag || null,
                            content: initialContent,
                        };
                        setTitle(localFile.title);
                        fileVersionRef.current = localFile.version || 1;
                        setServerVersion(localFile.version || 1);
                        fileEtagRef.current = localFile.etag || null;
                        setServerEtag(localFile.etag || null);
                        editorGenerationRef.current += 1;
                        editorContentRef.current = initialContent;

                        isProgrammaticUpdateRef.current = true;
                        try {
                            adapterRef.current?.setValue(initialContent);
                        } finally {
                            isProgrammaticUpdateRef.current = false;
                        }
                    }
                }

                // Step 2: background authoritative fetch + reconciliation.
                const result = await getFile(fileId);
                if (cancelled) return;

                if (!(result.success && result.data)) {
                    const localNow = await sh?.loadLocal(fileId);
                    if (!localNow && !isDirtyRef.current) {
                        loadFailureRef.current = true;
                    }
                    if (!localNow && onNavigate) {
                        onNavigate("/workspace");
                    }
                } else {
                    const data = result.data;
                    const remoteIsEncrypted = !!data.isEncrypted;
                    isEncryptedRef.current = remoteIsEncrypted;
                    setIsEncrypted(remoteIsEncrypted);
                    fileEncryptionMetadataRef.current = data.encryptionMetadata || null;

                    setTitle(data.title);
                    const remoteVersion = data.version ?? 1;
                    const remoteEtag = data.etag ?? null;
                    let safeContent = data.content || "";

                    if (remoteIsEncrypted) {
                        if (!sessionKeyStore.hasMasterKey()) {
                            isVaultLockedExit = true;
                            pendingEncryptedPayloadRef.current = {
                                content: safeContent,
                                metadata: data.encryptionMetadata,
                                title: data.title,
                                version: remoteVersion,
                                etag: remoteEtag,
                            };
                            setIsVaultLocked(true);
                            setIsUnlockModalOpen(true);
                            setHydration("vault_locked");
                            if (adapterRef.current) adapterRef.current.setEditable(false);
                            return;
                        }

                        if (safeContent) {
                            try {
                                const effectiveUid = await resolveEffectiveUserId();
                                const inbound = await SyncCryptoGateway.decryptInbound({
                                    fileId,
                                    content: safeContent,
                                    isEncrypted: true,
                                    encryptionMetadata: data.encryptionMetadata || null,
                                    userId: effectiveUid,
                                });

                                if (inbound.status === "decrypted") {
                                    safeContent = inbound.content;
                                    if (inbound.encryptionMetadata) {
                                        fileEncryptionMetadataRef.current = inbound.encryptionMetadata;
                                    }
                                } else if (inbound.status === "locked") {
                                    isVaultLockedExit = true;
                                    pendingEncryptedPayloadRef.current = {
                                        content: data.content || "",
                                        metadata: data.encryptionMetadata,
                                        title: data.title,
                                        version: remoteVersion,
                                        etag: remoteEtag,
                                    };
                                    setIsVaultLocked(true);
                                    setIsUnlockModalOpen(true);
                                    setHydration("vault_locked");
                                    if (adapterRef.current) adapterRef.current.setEditable(false);
                                    return;
                                } else {
                                    console.error("[Orchestrator] Remote decryption failed (LUGX-048):", inbound.error);
                                    setError("تعذّر فك تشفير محتوى الملف من الخادم (بيانات تالفة أو مفتاح غير صالح).");
                                    isFatalExit = true;
                                    setHydration("fatal");
                                    hydratedRef.current = false;
                                    if (adapterRef.current) adapterRef.current.setEditable(false);
                                    return;
                                }
                            } catch (decErr) {
                                console.error("[Orchestrator] Remote decrypt error (LUGX-048):", decErr);
                                setError("تعذّر فك تشفير محتوى الملف من الخادم (بيانات تالفة أو مفتاح غير صالح).");
                                isFatalExit = true;
                                setHydration("fatal");
                                hydratedRef.current = false;
                                if (adapterRef.current) adapterRef.current.setEditable(false);
                                return;
                            }
                        }
                    }

                    const decision = classifyRemoteUpdate({
                        localBaseline,
                        isDirty: isDirtyRef.current,
                        remoteVersion,
                        remoteEtag,
                        remoteContent: safeContent,
                    });

                    const adoptAnchors = () => {
                        fileVersionRef.current = remoteVersion;
                        setServerVersion(remoteVersion);
                        fileEtagRef.current = remoteEtag;
                        setServerEtag(remoteEtag);
                    };
                    const paintServer = () => {
                        editorGenerationRef.current += 1;
                        editorContentRef.current = safeContent;
                        isProgrammaticUpdateRef.current = true;
                        try {
                            adapterRef.current?.setValue(safeContent);
                        } finally {
                            isProgrammaticUpdateRef.current = false;
                        }
                    };
                    const persistClean = async () => {
                        if (sh?.isInitialized) {
                            await sh.saveLocal({
                                id: fileId,
                                content: isEncryptedRef.current ? (data.content ?? "") : safeContent,
                                title: data.title,
                                version: remoteVersion,
                                etag: remoteEtag || "",
                                isEncrypted: isEncryptedRef.current,
                                encryptionMetadata: fileEncryptionMetadataRef.current,
                                isDirty: false,
                            });
                        }
                    };

                    switch (decision.action) {
                        case "bootstrap_server": {
                            adoptAnchors();
                            paintServer();
                            markServerPersisted(data.updatedAt);
                            markClean();
                            await persistClean();
                            break;
                        }
                        case "apply": {
                            adoptAnchors();
                            if (adapterRef.current?.getValue() !== safeContent) paintServer();
                            markServerPersisted(data.updatedAt);
                            await persistClean();
                            break;
                        }
                        case "adopt_metadata": {
                            adoptAnchors();
                            markServerPersisted(data.updatedAt);
                            await persistClean();
                            break;
                        }
                        case "adopt_metadata_keep_edits": {
                            adoptAnchors();
                            console.warn(
                                "[Orchestrator] Cold-start eager edits: adopted remote metadata anchors only; user text kept dirty."
                            );
                            break;
                        }
                        case "keep_local":
                        default:
                            console.warn(
                                `[Orchestrator] Remote update retained locally during initial load (reason: ${decision.reason}). Optimistic locking will surface a conflict if required.`
                            );
                            break;
                    }
                }
            } catch (fetchErr) {
                console.warn("[Orchestrator] Server fetch offline / failed:", fetchErr);
            } finally {
                if (cancelled) return;

                if (isVaultLockedExit) {
                    hydratedRef.current = false;
                    setHydration("vault_locked");
                    if (adapterRef.current) adapterRef.current.setEditable(false);
                    return;
                }

                if (isFatalExit) {
                    hydratedRef.current = false;
                    setHydration("fatal");
                    if (adapterRef.current) adapterRef.current.setEditable(false);
                    return;
                }

                loadedFileIdRef.current = fileId;

                const nothingUsable =
                    !localBaseline && !isDirtyRef.current && loadFailureRef.current;
                if (nothingUsable) {
                    setHydration("fatal");
                    setError(
                        "تعذّر تحميل الملف من الخادم ولا توجد نسخة محلية. تحقق من الاتصال ثم أعد المحاولة."
                    );
                    hydratedRef.current = false;
                    return;
                }

                hydratedRef.current = true;
                setHydration("ready");
                if (adapterRef.current) adapterRef.current.setEditable(true);

                if (pendingRemoteUpdateRef.current) {
                    const pending = pendingRemoteUpdateRef.current;
                    pendingRemoteUpdateRef.current = null;
                    conflictHook.handleRemoteUpdate(pending);
                }
            }
        }

        if (!fileId || !currentAdapter) return;
        if (loadedFileIdRef.current === fileId || pipelineRef.current) return;
        const run = loadInitialFile();
        pipelineRef.current = run.finally(() => {
            pipelineRef.current = null;
        });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fileId, currentAdapter]);

    // Local SessionKeyStore lock/unlock lifecycle listener
    useEffect(() => {
        const unsubscribe = sessionKeyStore.subscribe((isUnlocked) => {
            if (!isUnlocked && isEncryptedRef.current) {
                autosaveRef.current?.cancelAutosave();
                setIsVaultLocked(true);
                setIsUnlockModalOpen(true);
                setHydration("vault_locked");
                editorContentRef.current = "";
                if (adapterRef.current) {
                    runProgrammaticUpdate(() => adapterRef.current?.setValue(""));
                    adapterRef.current.setEditable(false);
                }
            }
        });
        return () => {
            unsubscribe();
        };
    }, [runProgrammaticUpdate]);


    // Navigation & Unload Guard
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (autosave.isDirty || aiStream.isCommitting || isSaving || aiStream.status === "preview_ready") {
                e.preventDefault();
                e.returnValue = "لديك تعديلات غير محفوظة، هل أنت متأكد من مغادرة الصفحة؟";
                return e.returnValue;
            }
        };

        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => {
            window.removeEventListener("beforeunload", handleBeforeUnload);
        };
    }, [autosave.isDirty, aiStream.isCommitting, isSaving, aiStream.status]);

    // Tab visibility & focus auto-healing for local IndexedDB durability
    useEffect(() => {
        const handleWakeup = async () => {
            if (
                typeof document !== "undefined" &&
                document.visibilityState === "visible" &&
                pendingLocalSyncRef.current &&
                syncHookRef.current?.isInitialized &&
                adapterRef.current
            ) {
                // Synchronously consume flag before await to eliminate dual-event burst race conditions (visibilitychange + focus)
                pendingLocalSyncRef.current = false;
                console.log("[Orchestrator] Tab became active; retrying pending local IndexedDB persistence...");
                try {
                    if (isEncryptedRef.current) {
                        if (!sessionKeyStore.isVaultUnlocked()) {
                            console.warn("[Orchestrator] Vault is locked during wakeup; deferring local persistence.");
                            pendingLocalSyncRef.current = true;
                            return;
                        }
                        const uid = await resolveEffectiveUserId();
                        const outbound = await SyncCryptoGateway.encryptOutbound(fileId, adapterRef.current.getValue(), uid);
                        await syncHookRef.current.saveLocal({
                            id: fileId,
                            content: outbound.ciphertextBase64,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isDirty: isDirtyRef.current,
                            isEncrypted: true,
                            encryptionMetadata: outbound.encryptionMetadata,
                        });
                    } else {
                        await syncHookRef.current.saveLocal({
                            id: fileId,
                            content: adapterRef.current.getValue(),
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isDirty: isDirtyRef.current,
                        });
                    }
                    console.log("[Orchestrator] Pending local IndexedDB persistence recovered successfully on wakeup.");
                } catch (err) {
                    console.error("[Orchestrator] Wakeup retry of local IndexedDB persistence failed:", err);
                    // Revert flag on failure so subsequent wakeup or focus can retry
                    pendingLocalSyncRef.current = true;
                }
            }
        };

        window.addEventListener("visibilitychange", handleWakeup);
        window.addEventListener("focus", handleWakeup);
        return () => {
            window.removeEventListener("visibilitychange", handleWakeup);
            window.removeEventListener("focus", handleWakeup);
        };
    }, [fileId, title, resolveEffectiveUserId]);

    // AI Operation Trigger
    const startAIOperation = useCallback(
        async (operation: AIOperationType) => {
            if (!adapterRef.current) return;

            // Zero-Knowledge AI Gatekeeper: block AI operations on encrypted files if user has not opted-in
            if (isEncryptedRef.current && !allowAIOnEncryptedFilesRef.current) {
                console.warn("[Orchestrator] AI operations are prohibited on encrypted files by vault privacy policy");
                return;
            }

            // Invariant: cancel any pending auto-save before launching AI stream
            autosave.cancelAutosave();

            await aiStream.startStream({
                editor: adapterRef.current,
                operation,
                fileId,
                expectedVersion: fileVersionRef.current,
                originalEtag: fileEtagRef.current,
                editorGeneration: editorGenerationRef.current,
            });
        },
        [aiStream, fileId, autosave]
    );


    // Title Change
    const handleTitleChange = useCallback(
        async (newTitle: string) => {
            setTitle(newTitle);
            await renameFile(fileId, newTitle);
        },
        [fileId]
    );

    // Delete File
    const handleDeleteFile = useCallback(async () => {
        if (confirm("Are you sure you want to delete this document?")) {
            await deleteFile(fileId);
            if (onNavigate) onNavigate("/workspace");
        }
    }, [fileId, onNavigate]);

    return {
        title,
        setTitle,
        handleTitleChange,
        handleDeleteFile,

        aiStatus: aiStream.status,
        previewText: aiStream.previewText,
        isStreaming: aiStream.isStreaming,
        isCommitting: aiStream.isCommitting,
        isAIActive: aiStream.isLoading,
        aiError: aiStream.error,
        isAIConflict: aiStream.isConflict,
        startAIOperation,
        stopAIOperation: aiStream.stopStream,
        resetAI: aiStream.reset,
        commitAIPreview: aiStream.commitPreview,
        rejectAIPreview: aiStream.rejectPreview,
        retryAIPreview: aiStream.retryPreview,

        isDirty: autosave.isDirty,
        isSaving,
        lastSaved,
        error,
        setError,

        serverVersion,
        serverEtag,

        activeConflict: conflictHook.activeConflict,
        isConflictDialogOpen: conflictHook.isConflictDialogOpen,
        setIsConflictDialogOpen: conflictHook.setIsConflictDialogOpen,
        isResolvingConflict: conflictHook.isResolvingConflict,
        handleResolveConflict: conflictHook.handleResolveConflict,

        writeState,
        canAutoSave: autosave.canAutoSave,
        hydration,
        syncHook,
        handleEditorChange: autosave.handleEditorChange,

        // 7. Vault State
        isEncrypted,
        allowAIOnEncryptedFiles,
        isVaultLocked,
        isUnlockModalOpen,
        setIsUnlockModalOpen,
        handleVaultUnlocked,
    };
}
