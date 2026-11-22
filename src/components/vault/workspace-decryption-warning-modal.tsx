import React, { useState } from "react";
import { AlertTriangle, Loader2, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { decryptEntireWorkspaceRpc, getFile, getUserFiles } from "@/client/rpc-client";
import type { DecryptedWorkspaceFilePayload } from "@/types/rpc-contracts";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { resolveInitialClientUserIdSync, resolveLocalFirstAuthUser } from "@/lib/auth/client-identity";

export interface WorkspaceDecryptionWarningModalProps {
    readonly isOpen: boolean;
    readonly onClose: () => void;
    readonly workspaceId: string;
    readonly userId?: string;
    readonly onSuccess?: () => void;
}

const WARNING_COPY =
    "Decrypting any file inside an encrypted workspace requires decrypting the entire workspace and all of its files. Do you want to proceed?";

export function WorkspaceDecryptionWarningModal({
    isOpen,
    onClose,
    workspaceId,
    userId,
    onSuccess,
}: WorkspaceDecryptionWarningModalProps): React.JSX.Element | null {
    const [isDecrypting, setIsDecrypting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!isOpen) {
        return null;
    }

    const resolveEffectiveUid = async (): Promise<string> => {
        if (userId && userId.trim()) return userId.trim();
        const syncUid = resolveInitialClientUserIdSync();
        if (syncUid && syncUid.trim()) return syncUid.trim();
        const authUser = await resolveLocalFirstAuthUser();
        return authUser?.id ?? "";
    };

    const handleConfirmDecrypt = async () => {
        setError(null);

        if (!workspaceId) {
            setError("Workspace identifier is missing.");
            return;
        }

        if (!sessionKeyStore.hasMasterKey()) {
            setError("Vault is locked. Please unlock your vault before decrypting this workspace.");
            return;
        }

        setIsDecrypting(true);

        try {
            const effectiveUid = await resolveEffectiveUid();
            if (effectiveUid) {
                await indexedDBManager.init(effectiveUid).catch(() => undefined);
            }

            const filesRes = await getUserFiles();
            if (!filesRes.success || !Array.isArray(filesRes.data)) {
                throw new Error(filesRes.error || "Failed to load workspace files.");
            }

            const encryptedWorkspaceFiles = filesRes.data.filter(
                (file) =>
                    file.workspaceId === workspaceId &&
                    file.isEncrypted &&
                    !file.deletedAt &&
                    !file.isFolder
            );

            const decryptedFilesPayload: DecryptedWorkspaceFilePayload[] = [];

            for (const file of encryptedWorkspaceFiles) {
                let rawContent = file.content;
                let metadata = file.encryptionMetadata;
                let expectedVersion = file.version ?? undefined;
                let expectedETag = file.etag ?? undefined;

                if (rawContent === null || rawContent === undefined || !metadata) {
                    const detailRes = await getFile(file.id);
                    if (!detailRes.success || !detailRes.data) {
                        throw new Error(
                            detailRes.error || `Failed to load encrypted content for "${file.title}".`
                        );
                    }
                    rawContent = detailRes.data.content ?? "";
                    metadata = detailRes.data.encryptionMetadata;
                    expectedVersion = detailRes.data.version ?? expectedVersion;
                    expectedETag = detailRes.data.etag ?? expectedETag;
                }

                let plaintext = rawContent ?? "";
                if (plaintext.length > 0) {
                    const inbound = await SyncCryptoGateway.decryptInbound({
                        fileId: file.id,
                        content: plaintext,
                        isEncrypted: true,
                        encryptionMetadata: metadata,
                        userId: effectiveUid,
                    });

                    if (inbound.status === "error" || inbound.status === "locked") {
                        throw new Error(
                            inbound.error || `Failed to decrypt "${file.title}". Verify your vault key.`
                        );
                    }
                    plaintext = inbound.content;
                }

                decryptedFilesPayload.push({
                    fileId: file.id,
                    content: plaintext,
                    expectedVersion,
                    expectedETag,
                });
            }

            const rpcRes = await decryptEntireWorkspaceRpc(workspaceId, decryptedFilesPayload);
            if (!rpcRes.success) {
                throw new Error(rpcRes.error || "Failed to decrypt workspace.");
            }

            if (effectiveUid) {
                for (const item of decryptedFilesPayload) {
                    const existingLocal = await indexedDBManager
                        .getFile(item.fileId, effectiveUid)
                        .catch(() => null);
                    if (existingLocal) {
                        await indexedDBManager
                            .saveFile(
                                {
                                    ...existingLocal,
                                    content: item.content,
                                    isEncrypted: false,
                                    encryptionMetadata: null,
                                    isDirty: false,
                                    lastModified: Date.now(),
                                    lastSyncedAt: Date.now(),
                                },
                                effectiveUid
                            )
                            .catch(() => undefined);
                    }
                }
            }

            onSuccess?.();
            onClose();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to decrypt workspace.");
        } finally {
            setIsDecrypting(false);
        }
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-decrypt-warning-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
        >
            <div className="w-full max-w-md rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl p-6 space-y-4">
                <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 flex-shrink-0">
                        <AlertTriangle className="w-5 h-5" />
                    </div>
                    <div className="space-y-2">
                        <h2
                            id="workspace-decrypt-warning-title"
                            className="text-base font-semibold text-zinc-100"
                        >
                            Decrypt Entire Workspace
                        </h2>
                        <p className="text-sm text-zinc-300 leading-relaxed">{WARNING_COPY}</p>
                    </div>
                </div>

                {error && (
                    <div
                        role="alert"
                        className="rounded-lg bg-red-950/50 border border-red-800/60 px-3 py-2 text-xs text-red-200"
                    >
                        {error}
                    </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                    <Button
                        type="button"
                        variant="ghost"
                        disabled={isDecrypting}
                        onClick={onClose}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        disabled={isDecrypting}
                        onClick={() => void handleConfirmDecrypt()}
                    >
                        {isDecrypting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Unlock className="w-4 h-4" />
                        )}
                        <span>{isDecrypting ? "Decrypting Workspace..." : "Decrypt Workspace"}</span>
                    </Button>
                </div>
            </div>
        </div>
    );
}
