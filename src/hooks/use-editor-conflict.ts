"use client";

/**
 * useEditorConflict
 *
 * Conflict, Cross-Tab Synchronization & Reconciliation Controller for Standalone Markdown Editor.
 *
 * Enforces:
 * 1. Pure Dependency Injection (DI) through options interface, with latest-ref optsRef pattern (React 19 discipline).
 * 2. Invariant: Synchronous conflict blocking gate (isBlockedByConflict) to suspend autosave and writes.
 * 3. Cross-tab event synchronization for multi-tab collaboration and vault state propagation.
 * 4. Transparent cryptographic decryption/encryption for conflict inspection and resolution.
 * 5. LUGX-010: Post-resolution dirty check with normalizeMarkdownSource.
 * 6. LUGX-013: Non-destructive conflict handling (never overwrites editor content on 412 or resolution failure).
 * 7. LUGX-020: Synchronous dirty-read on cross-tab file_saved; atomic adoption when clean, anchor retention when dirty.
 * 8. LUGX-049: Pre-lock local flush on cross-tab vault_locked when dirty.
 * 9. LUGX-051: Preserves dirty state on cross-tab encryption/decryption toggle.
 * 10. LUGX-053: Consistent normalizeMarkdownSource for all markdown content comparisons.
 */

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import type { EditorAdapter } from "@/components/editor/markdown/types";
import { updateFileContent, toggleFileEncryption, renameFile, deleteFile } from "@/server/actions/file-ops";
import type { FileEncryptionMetadata } from "@/types/storage-payload";
import type { SyncConflict, IDBFile } from "@/lib/sync/idb-types";
import type { ConflictResolutionPayload } from "@/components/sync/conflict-dialog";
import { broadcastCrossTabEvent, subscribeCrossTabSync } from "@/lib/sync/cross-tab-sync";
import { classifyRemoteUpdate, type LocalBaseline } from "@/lib/sync/reconciliation";
import { normalizeMarkdownSource } from "@/lib/sync/etag-generator";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { conflictResolver } from "@/lib/sync/conflict-resolver";
import { createClient } from "@/lib/supabase/client";

export interface RemoteUpdatePayload {
    fileId: string;
    content: string;
    etag: string;
    version: number;
    title?: string;
    parentFolderId?: string | null;
    updatedAt: string;
    isEncrypted?: boolean;
    isVaultLocked?: boolean;
    encryptionMetadata?: FileEncryptionMetadata | null;
}

export interface ServerVersionPayload {
    version?: number | null;
    etag?: string | null;
    updatedAt?: string;
    content?: string | null;
    isEncrypted?: boolean | null;
    encryptionMetadata?: FileEncryptionMetadata | null;
}

export interface UseEditorConflictOptions {
    fileId: string;
    userId: string | null;

    // Document state
    getTitle: () => string;
    setTitle: (title: string) => void;

    // Version & ETag anchors
    getVersion: () => number;
    setVersion: (version: number) => void;
    getEtag: () => string | null;
    setEtag: (etag: string | null) => void;
    markServerPersisted?: (updatedAt?: string | Date | null) => void;

    // Content & Adapter
    getEditorContent: () => string;
    setEditorContent: (content: string) => void;
    getAdapter: () => EditorAdapter | null;
    isProgrammaticUpdate: () => boolean;
    setProgrammaticUpdate: (val: boolean) => void;
    incrementEditorGeneration: () => void;

    // Dirty & Autosave state
    isDirty: () => boolean;
    markClean: () => void;
    markDirty: () => void;
    cancelAutosave: () => void;

    // AI & Hydration gates
    isAIActive: () => boolean;
    isHydrated: () => boolean;
    setHydration?: (val: "hydrating" | "ready" | "fatal" | "vault_locked") => void;
    setPendingRemoteUpdate?: (payload: RemoteUpdatePayload | null) => void;
    setPendingEncryptedPayload?: (payload: {
        content: string;
        metadata: FileEncryptionMetadata | null;
        title: string;
        version: number;
        etag: string | null;
    } | null) => void;

    // Encryption & Vault
    isEncrypted: () => boolean;
    setIsEncrypted: (val: boolean) => void;
    getEncryptionMetadata: () => FileEncryptionMetadata | null;
    setEncryptionMetadata: (meta: FileEncryptionMetadata | null) => void;
    setIsVaultLocked: (val: boolean) => void;
    setIsUnlockModalOpen: (val: boolean) => void;
    handleVaultUnlocked?: () => Promise<void>;

    // Storage / Sync
    saveLocal: (payload: {
        id: string;
        content: string;
        title?: string;
        version: number;
        etag: string;
        isEncrypted: boolean;
        encryptionMetadata?: FileEncryptionMetadata | null;
        isDirty: boolean;
    }) => Promise<void>;
    loadLocal: (fileId: string) => Promise<IDBFile | null>;
    isSyncInitialized: () => boolean;

    // UI feedback & navigation
    setError: (error: string | null) => void;
    onNavigate?: (path: string) => void;

    // User derivation / AAD
    resolveEffectiveUserId?: () => Promise<string>;
}

export interface UseEditorConflictReturn {
    activeConflict: SyncConflict | null;
    isConflictDialogOpen: boolean;
    setIsConflictDialogOpen: (open: boolean) => void;
    isResolvingConflict: boolean;
    handleResolveConflict: (resolution: ConflictResolutionPayload) => Promise<void>;
    handleSyncConflict: (conflict: SyncConflict) => Promise<"local" | "server" | "merge">;
    handleRemoteUpdate: (event: RemoteUpdatePayload) => Promise<void>;
    handle412Conflict: (
        serverVersion: ServerVersionPayload,
        localContent: string,
        payloadToSend?: { contentToSend?: string; metaToSend?: FileEncryptionMetadata | null }
    ) => Promise<void>;
    isBlockedByConflict: () => boolean;
}

export function useEditorConflict(options: UseEditorConflictOptions): UseEditorConflictReturn {
    const { fileId } = options;
    const [activeConflict, setActiveConflict] = useState<SyncConflict | null>(null);
    const [isConflictDialogOpen, setIsConflictDialogOpen] = useState<boolean>(false);
    const [isResolvingConflict, setIsResolvingConflict] = useState<boolean>(false);

    const activeConflictRef = useRef<SyncConflict | null>(null);
    const isResolvingConflictRef = useRef<boolean>(false);

    useEffect(() => {
        activeConflictRef.current = activeConflict;
    }, [activeConflict]);

    useEffect(() => {
        isResolvingConflictRef.current = isResolvingConflict;
    }, [isResolvingConflict]);

    // Latest ref pattern to avoid render-time stale closures (React 19 discipline)
    const optsRef = useRef(options);
    useLayoutEffect(() => {
        optsRef.current = options;
    });

    const getEffectiveUserId = useCallback(async (): Promise<string> => {
        if (optsRef.current.resolveEffectiveUserId) {
            return optsRef.current.resolveEffectiveUserId();
        }
        let resolved = optsRef.current.userId;
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
            throw new Error("[Conflict] User ID is missing or empty; cannot derive file AAD for encrypted operations.");
        }
        return resolved.trim();
    }, []);

    const isBlockedByConflict = useCallback((): boolean => {
        return activeConflictRef.current !== null || isResolvingConflictRef.current;
    }, []);

    const handleSyncConflict = useCallback(
        async (conflict: SyncConflict): Promise<"local" | "server" | "merge"> => {
            const { fileId } = optsRef.current;
            const effectiveUid = await getEffectiveUserId();

            const rawServerContent = conflict.serverVersion.content;
            const rawServerMeta = conflict.serverVersion.encryptionMetadata || optsRef.current.getEncryptionMetadata();
            let decryptedServerContent = rawServerContent;

            // Decrypt server version if encrypted and not yet decrypted
            if (optsRef.current.isEncrypted() || conflict.serverVersion.isEncrypted) {
                const serverInbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: rawServerContent,
                    isEncrypted: true,
                    encryptionMetadata: rawServerMeta,
                    userId: effectiveUid,
                });
                if (serverInbound.status === "decrypted") {
                    decryptedServerContent = serverInbound.content;
                }
            }

            // Decrypt base version if present and encrypted
            if (conflict.baseVersion?.content && (optsRef.current.isEncrypted() || conflict.baseVersion.isEncrypted)) {
                const baseInbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: conflict.baseVersion.content,
                    isEncrypted: true,
                    encryptionMetadata: conflict.baseVersion.encryptionMetadata || optsRef.current.getEncryptionMetadata(),
                    userId: effectiveUid,
                });
                if (baseInbound.status === "decrypted") {
                    conflict.baseVersion.content = baseInbound.content;
                }
            }

            // LUGX-053: Auto-resolve if identical markdown content (using normalizeMarkdownSource) or identical ETags
            const isIdentical =
                normalizeMarkdownSource(conflict.localVersion.content) ===
                    normalizeMarkdownSource(decryptedServerContent) ||
                (conflict.localVersion.etag &&
                    conflict.serverVersion.etag &&
                    conflict.localVersion.etag === conflict.serverVersion.etag);

            if (isIdentical) {
                console.log("[Conflict] Auto-resolving identical conflict without modal");
                if (optsRef.current.isSyncInitialized()) {
                    await optsRef.current.saveLocal({
                        id: fileId,
                        content: optsRef.current.isEncrypted() ? rawServerContent : decryptedServerContent,
                        version: conflict.serverVersion.version,
                        etag: conflict.serverVersion.etag || "",
                        isEncrypted: optsRef.current.isEncrypted(),
                        encryptionMetadata: rawServerMeta,
                        isDirty: false,
                    });
                }
                optsRef.current.setVersion(conflict.serverVersion.version);
                if (conflict.serverVersion.etag) {
                    optsRef.current.setEtag(conflict.serverVersion.etag);
                }
                activeConflictRef.current = null;
                setActiveConflict(null);
                setIsConflictDialogOpen(false);
                return "server";
            }

            conflict.serverVersion.content = decryptedServerContent;
            activeConflictRef.current = conflict;
            setActiveConflict(conflict);
            setIsConflictDialogOpen(true);
            return "local";
        },
        [getEffectiveUserId]
    );

    const handleRemoteUpdate = useCallback(
        async (event: RemoteUpdatePayload) => {
            const { fileId } = optsRef.current;
            if (event.fileId !== fileId) return;

            // Invariant Guards:
            // 1. Never overwrite during active unresolved conflict or active conflict resolution
            if (activeConflictRef.current !== null || isResolvingConflictRef.current) {
                return;
            }

            // 2. Never overwrite during AI generation / reservation / commit
            if (optsRef.current.isAIActive()) {
                return;
            }

            // 3. Never overwrite during programmatic transactions or before hydration completes
            if (optsRef.current.isProgrammaticUpdate() || !optsRef.current.isHydrated()) {
                if (!optsRef.current.isHydrated()) {
                    optsRef.current.setPendingRemoteUpdate?.(event);
                }
                return;
            }

            let safeContent = event.content;
            if (optsRef.current.isEncrypted() || event.isEncrypted) {
                if (event.isVaultLocked || !sessionKeyStore.hasMasterKey()) {
                    console.warn("[Conflict] Remote update received for encrypted file while vault is locked. Preserving locked state.");
                    optsRef.current.setPendingEncryptedPayload?.({
                        content: event.content,
                        metadata: event.encryptionMetadata || optsRef.current.getEncryptionMetadata(),
                        title: event.title || optsRef.current.getTitle(),
                        version: event.version,
                        etag: event.etag,
                    });
                    optsRef.current.setIsVaultLocked(true);
                    optsRef.current.setIsUnlockModalOpen(true);
                    return;
                }

                const effectiveUid = await getEffectiveUserId();
                const inbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: event.content,
                    isEncrypted: true,
                    encryptionMetadata: event.encryptionMetadata || optsRef.current.getEncryptionMetadata(),
                    userId: effectiveUid,
                });

                if (inbound.status === "decrypted") {
                    safeContent = inbound.content;
                    if (inbound.encryptionMetadata) {
                        optsRef.current.setEncryptionMetadata(inbound.encryptionMetadata);
                    }
                } else if (inbound.status === "locked") {
                    optsRef.current.setIsVaultLocked(true);
                    optsRef.current.setIsUnlockModalOpen(true);
                    return;
                } else {
                    console.error("[Conflict] Remote update decryption failed:", inbound.error);
                    optsRef.current.setError("فشل فك تشفير التحديث الوارد من الخادم.");
                    return;
                }
            }

            const adapter = optsRef.current.getAdapter();
            const currentLocalContent = adapter?.getValue() ?? optsRef.current.getEditorContent() ?? "";
            const localBaseline: LocalBaseline = {
                version: optsRef.current.getVersion(),
                etag: optsRef.current.getEtag(),
                content: currentLocalContent,
            };

            const decision = classifyRemoteUpdate({
                localBaseline,
                isDirty: optsRef.current.isDirty(),
                remoteVersion: event.version,
                remoteEtag: event.etag,
                remoteContent: safeContent,
            });

            if (decision.action === "apply") {
                // 1. Invariant: Cancel any pending debounced auto-save timer so in-flight stale typing does not overwrite server content
                optsRef.current.cancelAutosave();

                // 2. Synchronously reset dirty flags
                optsRef.current.markClean();

                // 3. Generation guard: apply remote update cleanly without disrupting user
                optsRef.current.setVersion(event.version);
                optsRef.current.setEtag(event.etag);
                optsRef.current.incrementEditorGeneration();

                // 4. Synchronously update memory ref
                optsRef.current.setEditorContent(safeContent);

                const prevSelection = adapter?.getSelection();
                const hadFocus = adapter?.hasFocus() ?? false;

                optsRef.current.setProgrammaticUpdate(true);
                try {
                    adapter?.setValue(safeContent);
                    if (prevSelection && hadFocus) {
                        const maxLen = safeContent.length;
                        adapter?.setSelection(
                            Math.min(prevSelection.from, maxLen),
                            Math.min(prevSelection.to, maxLen)
                        );
                    }
                } finally {
                    optsRef.current.setProgrammaticUpdate(false);
                }

                if (event.title && event.title !== optsRef.current.getTitle()) {
                    optsRef.current.setTitle(event.title);
                }

                optsRef.current.markServerPersisted?.(event.updatedAt);

                // 5. Atomically persist clean state and baseSnapshot into local IndexedDB
                if (optsRef.current.isSyncInitialized()) {
                    try {
                        await optsRef.current.saveLocal({
                            id: fileId,
                            content: optsRef.current.isEncrypted() ? event.content : safeContent,
                            title: event.title || optsRef.current.getTitle(),
                            version: event.version,
                            etag: event.etag || "",
                            isEncrypted: optsRef.current.isEncrypted(),
                            encryptionMetadata: optsRef.current.getEncryptionMetadata(),
                            isDirty: false,
                        });
                    } catch (idbErr) {
                        console.error("[Conflict] Error updating local IDB during remote update:", idbErr);
                    }
                }
            } else if (decision.action === "adopt_metadata") {
                optsRef.current.setVersion(event.version);
                optsRef.current.setEtag(event.etag);
                optsRef.current.markServerPersisted?.(event.updatedAt);
                if (optsRef.current.isSyncInitialized()) {
                    try {
                        await optsRef.current.saveLocal({
                            id: fileId,
                            content: optsRef.current.isEncrypted() ? event.content : safeContent,
                            title: event.title || optsRef.current.getTitle(),
                            version: event.version,
                            etag: event.etag || "",
                            isEncrypted: optsRef.current.isEncrypted(),
                            encryptionMetadata: optsRef.current.getEncryptionMetadata(),
                            isDirty: false,
                        });
                    } catch (idbErr) {
                        console.error("[Conflict] Error updating local IDB during adopt_metadata:", idbErr);
                    }
                }
            } else if (decision.action === "keep_local") {
                console.log(
                    `[Conflict] Remote update retained locally (reason: ${decision.reason}). Local edits preserved.`
                );
            }
        },
        [getEffectiveUserId]
    );

    const handle412Conflict = useCallback(
        async (
            serverVersion: ServerVersionPayload,
            localContent: string,
            payloadToSend?: { contentToSend?: string; metaToSend?: FileEncryptionMetadata | null }
        ) => {
            const { fileId } = optsRef.current;
            const effectiveUid = await getEffectiveUserId();

            let decryptedServerContent = serverVersion.content || "";
            const isEncrypted = optsRef.current.isEncrypted();

            if (isEncrypted || serverVersion.isEncrypted) {
                const serverInbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: serverVersion.content || "",
                    isEncrypted: true,
                    encryptionMetadata: serverVersion.encryptionMetadata || optsRef.current.getEncryptionMetadata(),
                    userId: effectiveUid,
                });
                if (serverInbound.status === "decrypted") {
                    decryptedServerContent = serverInbound.content;
                }
            }

            // LUGX-053: False conflict check using normalizeMarkdownSource
            const isIdenticalContent =
                normalizeMarkdownSource(decryptedServerContent) === normalizeMarkdownSource(localContent);

            let contentToSend = payloadToSend?.contentToSend;
            let metaToSend = payloadToSend?.metaToSend ?? optsRef.current.getEncryptionMetadata();

            if (isEncrypted && !contentToSend) {
                if (sessionKeyStore.hasMasterKey()) {
                    const enc = await SyncCryptoGateway.encryptOutbound(fileId, localContent, effectiveUid);
                    contentToSend = enc.ciphertextBase64;
                    metaToSend = enc.encryptionMetadata;
                    optsRef.current.setEncryptionMetadata(metaToSend);
                }
            }

            if (
                isIdenticalContent ||
                (serverVersion.etag && serverVersion.etag === optsRef.current.getEtag())
            ) {
                console.log("[Conflict] Server conflict has identical content, auto-synchronizing version");
                const newVersion = serverVersion.version || optsRef.current.getVersion();
                optsRef.current.setVersion(newVersion);
                optsRef.current.setEtag(serverVersion.etag || null);

                if (optsRef.current.isSyncInitialized()) {
                    await optsRef.current.saveLocal({
                        id: fileId,
                        content: isEncrypted ? (contentToSend ?? localContent) : localContent,
                        title: optsRef.current.getTitle(),
                        version: serverVersion.version ?? optsRef.current.getVersion(),
                        etag: serverVersion.etag || "",
                        isEncrypted,
                        encryptionMetadata: metaToSend,
                        isDirty: false,
                    });
                }
                optsRef.current.markClean();
                activeConflictRef.current = null;
                setActiveConflict(null);
                setIsConflictDialogOpen(false);
                return;
            }

            // True conflict (412 Precondition Failed)
            // LUGX-013: Never overwrite editor content with stale snapshot on 412 conflict
            console.warn("[Conflict] 412 Sync conflict detected during save:", serverVersion);
            const localFile = optsRef.current.isSyncInitialized() ? await optsRef.current.loadLocal(fileId) : null;

            let baseContent = localFile?.baseSnapshot?.content;
            if (baseContent && (isEncrypted || localFile?.baseSnapshot?.isEncrypted)) {
                const baseInbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: baseContent,
                    isEncrypted: true,
                    encryptionMetadata: localFile?.encryptionMetadata || optsRef.current.getEncryptionMetadata(),
                    userId: effectiveUid,
                });
                if (baseInbound.status === "decrypted") {
                    baseContent = baseInbound.content;
                }
            }

            const conflictObj: SyncConflict = {
                fileId,
                localVersion: {
                    content: localContent,
                    etag: optsRef.current.getEtag() || "",
                    lastModified: Date.now(),
                    version: optsRef.current.getVersion(),
                    title: optsRef.current.getTitle(),
                    parentFolderId: null,
                    deleted: false,
                    isEncrypted,
                    encryptionMetadata: optsRef.current.getEncryptionMetadata(),
                },
                serverVersion: {
                    content: decryptedServerContent,
                    etag: serverVersion.etag || "",
                    lastModified: serverVersion.updatedAt
                        ? new Date(serverVersion.updatedAt).getTime()
                        : Date.now(),
                    version: serverVersion.version || 0,
                    title: optsRef.current.getTitle(),
                    parentFolderId: null,
                    deleted: false,
                    isEncrypted: serverVersion.isEncrypted ?? isEncrypted,
                    encryptionMetadata: serverVersion.encryptionMetadata || optsRef.current.getEncryptionMetadata(),
                },
                baseVersion: localFile?.baseSnapshot
                    ? {
                          content: baseContent || "",
                          etag: localFile.baseSnapshot.etag,
                          lastModified: localFile.lastSyncedAt || 0,
                          version: localFile.baseSnapshot.version,
                          title: localFile.baseSnapshot.title,
                          parentFolderId: localFile.baseSnapshot.parentFolderId,
                          deleted: false,
                          isEncrypted,
                          encryptionMetadata: localFile.encryptionMetadata,
                      }
                    : undefined,
                operations: [],
                detectedAt: Date.now(),
                type: "content",
            };

            // LUGX-054: Attempt silent automated 3-way merge for non-overlapping offline/concurrent edits
            if (conflictObj.baseVersion) {
                const mergeResult = conflictResolver.attemptThreeWayMerge({
                    base: conflictObj.baseVersion,
                    local: conflictObj.localVersion,
                    remote: conflictObj.serverVersion,
                });

                if (mergeResult.success && mergeResult.status === "merged_clean" && typeof mergeResult.content === "string") {
                    console.log("[Conflict] 412 resolved via silent automated 3-way merge:", mergeResult);
                    const mergedText = mergeResult.content;

                    let mergedContentToSend = mergedText;
                    let mergedMetaToSend = metaToSend;

                    if (isEncrypted) {
                        if (sessionKeyStore.hasMasterKey()) {
                            const enc = await SyncCryptoGateway.encryptOutbound(fileId, mergedText, effectiveUid);
                            mergedContentToSend = enc.ciphertextBase64;
                            mergedMetaToSend = enc.encryptionMetadata;
                            optsRef.current.setEncryptionMetadata(mergedMetaToSend);
                        }
                    }

                    const targetExpectedVersion = serverVersion.version ?? optsRef.current.getVersion();
                    const targetExpectedETag = serverVersion.etag || undefined;

                    const pushRes = isEncrypted
                        ? await toggleFileEncryption(fileId, true, mergedContentToSend, mergedMetaToSend, {
                              expectedVersion: targetExpectedVersion,
                              expectedETag: targetExpectedETag,
                          })
                        : await updateFileContent(fileId, mergedContentToSend, {
                              expectedVersion: targetExpectedVersion,
                              expectedETag: targetExpectedETag,
                          });

                    if (pushRes.success && pushRes.version) {
                        const newVersion = pushRes.version;
                        const newEtag = pushRes.etag || null;

                        optsRef.current.setVersion(newVersion);
                        optsRef.current.setEtag(newEtag);
                        optsRef.current.incrementEditorGeneration();

                        optsRef.current.setEditorContent(mergedText);
                        optsRef.current.setProgrammaticUpdate(true);
                        try {
                            optsRef.current.getAdapter()?.setValue(mergedText);
                        } finally {
                            optsRef.current.setProgrammaticUpdate(false);
                        }

                        optsRef.current.cancelAutosave();

                        // Commit to local IndexedDB first
                        if (optsRef.current.isSyncInitialized()) {
                            await optsRef.current.saveLocal({
                                id: fileId,
                                content: isEncrypted ? mergedContentToSend : mergedText,
                                title: optsRef.current.getTitle(),
                                version: newVersion,
                                etag: newEtag || "",
                                isEncrypted,
                                encryptionMetadata: mergedMetaToSend,
                                isDirty: false,
                            });
                        }

                        // Broadcast cross-tab only after IDB commit
                        broadcastCrossTabEvent({
                            type: "file_saved",
                            fileId,
                            version: newVersion,
                            etag: newEtag || undefined,
                        });

                        optsRef.current.markServerPersisted?.(new Date());
                        optsRef.current.markClean();
                        activeConflictRef.current = null;
                        setActiveConflict(null);
                        setIsConflictDialogOpen(false);
                        return;
                    }
                }
            }

            activeConflictRef.current = conflictObj;
            setActiveConflict(conflictObj);
            setIsConflictDialogOpen(true);

            if (optsRef.current.isSyncInitialized()) {
                await optsRef.current.saveLocal({
                    id: fileId,
                    content: isEncrypted ? (contentToSend ?? localContent) : localContent,
                    title: optsRef.current.getTitle(),
                    version: optsRef.current.getVersion(),
                    etag: optsRef.current.getEtag() || "",
                    isEncrypted,
                    encryptionMetadata: metaToSend,
                    isDirty: true,
                });
            }
        },
        [getEffectiveUserId]
    );

    const handleResolveConflict = useCallback(
        async (resolution: ConflictResolutionPayload) => {
            if (!activeConflictRef.current) return;
            const currentConflict = activeConflictRef.current;
            const { fileId } = optsRef.current;

            // LUGX-010: Capture startSnapshot BEFORE in-flight resolution to detect concurrent typing during network call
            const startSnapshot = optsRef.current.getAdapter()?.getValue() ?? optsRef.current.getEditorContent();

            setIsResolvingConflict(true);
            isResolvingConflictRef.current = true;
            optsRef.current.setError(null);

            try {
                if (resolution.strategy === "delete") {
                    if (confirm("هل أنت متأكد من تأكيد حذف الملف؟")) {
                        await deleteFile(fileId);
                        if (optsRef.current.onNavigate) optsRef.current.onNavigate("/workspace");
                    }
                    setIsResolvingConflict(false);
                    isResolvingConflictRef.current = false;
                    return;
                }

                let contentToSend = resolution.content;
                let metaToSend = optsRef.current.getEncryptionMetadata();
                const isEncrypted = optsRef.current.isEncrypted();

                if (isEncrypted) {
                    const masterKey = sessionKeyStore.getMasterKeyRaw();
                    if (!masterKey) {
                        optsRef.current.setError("الخزنة مقفلة. يرجى فتح الخزنة لحفظ حل التعارض المشفر بأمان.");
                        setIsResolvingConflict(false);
                        isResolvingConflictRef.current = false;
                        return;
                    }
                    const effectiveUid = await getEffectiveUserId();
                    const encResult = await SyncCryptoGateway.encryptOutbound(
                        fileId,
                        resolution.content,
                        effectiveUid
                    );
                    contentToSend = encResult.ciphertextBase64;
                    metaToSend = encResult.encryptionMetadata;
                    optsRef.current.setEncryptionMetadata(metaToSend);
                }

                const targetExpectedVersion = currentConflict.serverVersion.version;
                const targetExpectedETag = currentConflict.serverVersion.etag || undefined;

                const saveRes = isEncrypted
                    ? await toggleFileEncryption(fileId, true, contentToSend, metaToSend, {
                          expectedVersion: targetExpectedVersion,
                          expectedETag: targetExpectedETag,
                      })
                    : await updateFileContent(fileId, contentToSend, {
                          expectedVersion: targetExpectedVersion,
                          expectedETag: targetExpectedETag,
                      });

                if (saveRes.success && saveRes.version) {
                    optsRef.current.setVersion(saveRes.version);
                    optsRef.current.setEtag(saveRes.etag || null);
                    optsRef.current.incrementEditorGeneration();

                    // LUGX-010: Read live content after async network call settled to detect concurrent edits
                    const liveNow = optsRef.current.getAdapter()?.getValue() ?? optsRef.current.getEditorContent();
                    const noConcurrentEdits = normalizeMarkdownSource(liveNow) === normalizeMarkdownSource(startSnapshot);

                    if (noConcurrentEdits) {
                        // Case 1: No concurrent edits during flight. Apply resolution cleanly.
                        optsRef.current.setEditorContent(resolution.content);

                        optsRef.current.setProgrammaticUpdate(true);
                        try {
                            optsRef.current.getAdapter()?.setValue(resolution.content);
                        } finally {
                            optsRef.current.setProgrammaticUpdate(false);
                        }

                        optsRef.current.cancelAutosave();

                        if (resolution.title && resolution.title !== optsRef.current.getTitle()) {
                            optsRef.current.setTitle(resolution.title);
                            await renameFile(fileId, resolution.title);
                        }

                        if (optsRef.current.isSyncInitialized()) {
                            await optsRef.current.saveLocal({
                                id: fileId,
                                content: isEncrypted ? contentToSend : resolution.content,
                                title: resolution.title || optsRef.current.getTitle(),
                                version: saveRes.version,
                                etag: saveRes.etag || optsRef.current.getEtag() || "",
                                isEncrypted,
                                encryptionMetadata: metaToSend,
                                isDirty: false,
                            });
                        }

                        optsRef.current.markServerPersisted?.(new Date());
                        optsRef.current.markClean();
                    } else {
                        // Case 2: User typed during flight. LUGX-013: Do NOT overwrite editor with resolution.content!
                        // Preserve live edits in editor and memory ref.
                        optsRef.current.setEditorContent(liveNow);

                        if (resolution.title && resolution.title !== optsRef.current.getTitle()) {
                            optsRef.current.setTitle(resolution.title);
                            await renameFile(fileId, resolution.title);
                        }

                        let liveContentToSave = liveNow;
                        let liveMetaToSave = metaToSend;

                        if (isEncrypted) {
                            if (sessionKeyStore.hasMasterKey()) {
                                const effectiveUid = await getEffectiveUserId();
                                const enc = await SyncCryptoGateway.encryptOutbound(fileId, liveNow, effectiveUid);
                                liveContentToSave = enc.ciphertextBase64;
                                liveMetaToSave = enc.encryptionMetadata;
                                optsRef.current.setEncryptionMetadata(liveMetaToSave);
                            } else {
                                console.warn("[Conflict] Vault locked: preserving live draft in memory without plaintext IDB write (LUGX-004).");
                            }
                        }

                        if (optsRef.current.isSyncInitialized()) {
                            await optsRef.current.saveLocal({
                                id: fileId,
                                content: liveContentToSave,
                                title: resolution.title || optsRef.current.getTitle(),
                                version: saveRes.version,
                                etag: saveRes.etag || optsRef.current.getEtag() || "",
                                isEncrypted,
                                encryptionMetadata: liveMetaToSave,
                                isDirty: true,
                            });
                        }

                        optsRef.current.markServerPersisted?.(new Date());
                        // LUGX-010: Keep dirty so autosave will persist concurrent edits on top of new server version
                        optsRef.current.markDirty();
                    }

                    // Reverted to HEAD parity: broadcast on ambient channel to match other modules
                    broadcastCrossTabEvent({
                        type: "conflict_resolved",
                        fileId,
                        version: saveRes.version,
                        etag: saveRes.etag || undefined,
                    });

                    activeConflictRef.current = null;
                    setActiveConflict(null);
                    setIsConflictDialogOpen(false);
                } else if (saveRes.status === "conflict" && saveRes.serverVersion) {
                    // LUGX-013: Never overwrite editor content with stale snapshot on resolution failure or repeated 412
                    let newServerContent = saveRes.serverVersion.content || "";
                    if (isEncrypted || saveRes.serverVersion.isEncrypted) {
                        const effectiveUid = await getEffectiveUserId();
                        const inbound = await SyncCryptoGateway.decryptInbound({
                            fileId,
                            content: newServerContent,
                            isEncrypted: true,
                            encryptionMetadata: saveRes.serverVersion.encryptionMetadata || optsRef.current.getEncryptionMetadata(),
                            userId: effectiveUid,
                        });
                        if (inbound.status === "decrypted") {
                            newServerContent = inbound.content;
                        }
                    }

                    const updatedConflict: SyncConflict = {
                        ...currentConflict,
                        serverVersion: {
                            content: newServerContent,
                            etag: saveRes.serverVersion.etag || "",
                            lastModified: saveRes.serverVersion.updatedAt
                                ? new Date(saveRes.serverVersion.updatedAt).getTime()
                                : Date.now(),
                            version: saveRes.serverVersion.version || 0,
                            title: currentConflict.serverVersion.title,
                            parentFolderId: currentConflict.serverVersion.parentFolderId,
                            deleted: false,
                            isEncrypted: saveRes.serverVersion.isEncrypted ?? isEncrypted,
                            encryptionMetadata: saveRes.serverVersion.encryptionMetadata || optsRef.current.getEncryptionMetadata(),
                        },
                        detectedAt: Date.now(),
                    };
                    activeConflictRef.current = updatedConflict;
                    setActiveConflict(updatedConflict);
                    optsRef.current.setError("حدث تعديل جديد على الخادم أثناء حل التعارض. يرجى المراجعة والتأكيد مجدداً.");
                } else {
                    // LUGX-013: Resolution failure: preserve editor content, do not overwrite with stale snapshot
                    optsRef.current.setError(saveRes.error || "فشل تأكيد حفظ حل التعارض على الخادم");
                }
            } catch (err) {
                // LUGX-013: Exception during resolution: preserve editor content, do not overwrite with stale snapshot
                console.error("[Conflict] Conflict resolution error:", err);
                const detailMessage = err instanceof Error
                    ? err.message
                    : "حدث خطأ غير متوقع أثناء حل التعارض";
                optsRef.current.setError(detailMessage);
            } finally {
                setIsResolvingConflict(false);
                isResolvingConflictRef.current = false;
            }
        },
        [getEffectiveUserId]
    );

    // Cross-tab synchronization effect
    useEffect(() => {
        const unsubscribe = subscribeCrossTabSync(async (event) => {
            if (event.type === "vault_unlocked") {
                if (optsRef.current.isEncrypted() && sessionKeyStore.hasMasterKey()) {
                    optsRef.current.setIsVaultLocked(false);
                    optsRef.current.setIsUnlockModalOpen(false);
                    optsRef.current.handleVaultUnlocked?.();
                }
                return;
            }

            if (event.type === "vault_locked") {
                // LUGX-049: On cross-tab vault_locked, if dirty, flush current content to IDB BEFORE cancelAutosave and key clearing.
                if (optsRef.current.isDirty()) {
                    const liveContent = optsRef.current.getEditorContent();
                    let contentToSave = liveContent;
                    let metaToSave = optsRef.current.getEncryptionMetadata();
                    let canSave = true;

                    if (optsRef.current.isEncrypted()) {
                        if (!sessionKeyStore.hasMasterKey()) {
                            // LUGX-049: Encryption key is gone; refusing to persist plaintext as encrypted (LUGX-004 violation).
                            // Keep edits in editor memory/adapter and do not markClean().
                            console.warn("[Conflict] Cross-tab vault_locked flush skipped: vault master key missing from memory. Retaining dirty edits in editor.");
                            canSave = false;
                        } else {
                            try {
                                const effectiveUid = await getEffectiveUserId();
                                const encrypted = await SyncCryptoGateway.encryptOutbound(fileId, liveContent, effectiveUid);
                                contentToSave = encrypted.ciphertextBase64;
                                metaToSave = encrypted.encryptionMetadata;
                                optsRef.current.setEncryptionMetadata(metaToSave);
                            } catch (encErr) {
                                console.error("[Conflict] Failed to encrypt outbound payload during vault_locked flush:", encErr);
                                canSave = false;
                            }
                        }
                    }

                    if (canSave && optsRef.current.isSyncInitialized()) {
                        try {
                            await optsRef.current.saveLocal({
                                id: fileId,
                                content: contentToSave,
                                title: optsRef.current.getTitle(),
                                version: optsRef.current.getVersion(),
                                etag: optsRef.current.getEtag() || "",
                                isEncrypted: optsRef.current.isEncrypted(),
                                encryptionMetadata: metaToSave,
                                isDirty: true,
                            });
                        } catch (saveErr) {
                            console.error("[Conflict] Error flushing dirty content to IDB on vault_locked:", saveErr);
                        }
                    }
                }

                // 1. Cancel pending auto-save immediately
                optsRef.current.cancelAutosave();
                // 2. Purge RAM immediately (no re-broadcast)
                sessionKeyStore.lock(false);
                // 3. Update UI state
                if (optsRef.current.isEncrypted()) {
                    optsRef.current.setIsVaultLocked(true);
                    optsRef.current.setIsUnlockModalOpen(true);
                    optsRef.current.setHydration?.("vault_locked");
                    optsRef.current.getAdapter()?.setEditable(false);
                }
                return;
            }

            if (event.fileId === fileId) {
                if (event.type === "file_encrypted") {
                    optsRef.current.cancelAutosave();
                    optsRef.current.setIsEncrypted(true);
                    if (event.metadata) {
                        optsRef.current.setEncryptionMetadata(event.metadata as FileEncryptionMetadata);
                    }
                    if (event.version) {
                        optsRef.current.setVersion(event.version);
                    }
                    if (event.etag) {
                        optsRef.current.setEtag(event.etag);
                    }
                    // LUGX-051: Do NOT call markClean() if dirty; preserve dirty edits.
                    if (!optsRef.current.isDirty()) {
                        optsRef.current.markClean();
                    }
                    activeConflictRef.current = null;
                    setActiveConflict(null);
                    setIsConflictDialogOpen(false);
                    return;
                }

                if (event.type === "file_decrypted") {
                    optsRef.current.cancelAutosave();
                    optsRef.current.setIsEncrypted(false);
                    optsRef.current.setEncryptionMetadata(null);
                    if (event.version) {
                        optsRef.current.setVersion(event.version);
                    }
                    if (event.etag) {
                        optsRef.current.setEtag(event.etag);
                    }
                    // LUGX-051: Do NOT call markClean() if dirty; preserve dirty edits.
                    if (!optsRef.current.isDirty()) {
                        optsRef.current.markClean();
                    }
                    activeConflictRef.current = null;
                    setActiveConflict(null);
                    setIsConflictDialogOpen(false);
                    return;
                }

                // LUGX-020: Read dirty state via synchronous getter (autosave ref isDirty / ref), not React state.
                const localFile = optsRef.current.isSyncInitialized() ? await optsRef.current.loadLocal(fileId) : null;
                const isLocalDirty = localFile?.isDirty || activeConflictRef.current !== null || optsRef.current.isDirty();

                if (!isLocalDirty && localFile) {
                    optsRef.current.cancelAutosave();
                    optsRef.current.markClean();

                    // LUGX-020: When clean, adopt version+etag(+content via reload path) atomically
                    if (event.version && event.version > optsRef.current.getVersion()) {
                        optsRef.current.setVersion(event.version);
                    }
                    if (event.etag) {
                        optsRef.current.setEtag(event.etag);
                    }
                    optsRef.current.incrementEditorGeneration();

                    let incomingContent = localFile.content || "";
                    if (optsRef.current.isEncrypted() && sessionKeyStore.hasMasterKey() && localFile.encryptionMetadata?.iv && incomingContent) {
                        try {
                            const effectiveUid = await getEffectiveUserId();
                            const inbound = await SyncCryptoGateway.decryptInbound({
                                fileId,
                                content: incomingContent,
                                isEncrypted: true,
                                encryptionMetadata: localFile.encryptionMetadata,
                                userId: effectiveUid,
                            });
                            if (inbound.status === "decrypted") {
                                incomingContent = inbound.content;
                            } else {
                                console.error("[Conflict] Cross-tab decryption failed (LUGX-048):", inbound.error);
                                return;
                            }
                        } catch (decErr) {
                            console.warn("[Conflict] Cross-tab decryption error (LUGX-048):", decErr);
                            return;
                        }
                    }

                    optsRef.current.setEditorContent(incomingContent);
                    optsRef.current.setProgrammaticUpdate(true);
                    try {
                        optsRef.current.getAdapter()?.setValue(incomingContent);
                    } finally {
                        optsRef.current.setProgrammaticUpdate(false);
                    }
                } else if (isLocalDirty) {
                    // LUGX-020: When dirty, retain old expectedVersion anchors for optimistic conflict guard
                    console.warn("[Conflict] Sibling tab saved file while local tab is dirty. Retaining local expectedVersion for optimistic conflict guard.");
                }
            }
        });

        return () => {
            unsubscribe();
        };
    }, [fileId, getEffectiveUserId]);

    return {
        activeConflict,
        isConflictDialogOpen,
        setIsConflictDialogOpen,
        isResolvingConflict,
        handleResolveConflict,
        handleSyncConflict,
        handleRemoteUpdate,
        handle412Conflict,
        isBlockedByConflict,
    };
}
