import { useState, useEffect } from "react";
import { Folder, AlertCircle } from "lucide-react";
import { getUserFiles } from "@/client/rpc-client";

interface FileItem {
    id: string;
    title: string;
    isFolder: boolean;
    parentFolderId: string | null;
}

interface FolderPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (folderId: string | null) => void | Promise<void>;
    currentFileId?: string; // Prevent selecting the file itself or its children
    title: string; // "Copy to..." or "Move to..."
}

/**
 * Modal component for selecting a destination folder
 * Used for Copy and Move operations
 */
export function FolderPickerModal({
    isOpen,
    onClose,
    onSelect,
    currentFileId,
    title,
}: FolderPickerModalProps) {
    const [folders, setFolders] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Load folders when modal opens
    useEffect(() => {
        let isMounted = true;
        if (isOpen) {
            setLoading(true);
            setError(null);
            (async () => {
                try {
                    const result = await getUserFiles();
                    if (!isMounted) return;
                    if (result.success && result.data) {
                        const folderList = result.data.filter(
                            (f) => f.isFolder && f.id !== currentFileId
                        );
                        setFolders(folderList);
                    } else if (!result.success) {
                        setError(result.error || "Failed to load folders");
                    }
                } catch (err: unknown) {
                    if (!isMounted) return;
                    setError(err instanceof Error ? err.message : "Failed to load folders");
                } finally {
                    if (isMounted) {
                        setLoading(false);
                    }
                }
            })();
        } else {
            setError(null);
            setIsSubmitting(false);
        }
        return () => {
            isMounted = false;
        };
    }, [isOpen, currentFileId]);

    function handleSelect(folderId: string | null) {
        try {
            const result = onSelect(folderId);
            if (result && typeof (result as Promise<void>).then === "function") {
                setIsSubmitting(true);
                (result as Promise<void>)
                    .then(() => {
                        onClose();
                    })
                    .catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : "Failed to select folder");
                    })
                    .finally(() => {
                        setIsSubmitting(false);
                    });
            } else {
                onClose();
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to select folder");
        }
    }

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/50 z-30"
                onClick={isSubmitting ? undefined : onClose}
            />

            {/* Modal */}
            <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl w-full max-w-md">
                    {/* Header */}
                    <div className="px-4 py-3 border-b border-zinc-800">
                        <h3 className="text-lg font-medium text-zinc-100">
                            {title}
                        </h3>
                    </div>

                    {/* Content */}
                    <div className="p-4 max-h-96 overflow-y-auto custom-scrollbar">
                        {error && (
                            <div className="mb-3 p-2.5 rounded bg-red-950/40 border border-red-800/40 text-xs text-red-300 flex items-center gap-2">
                                <AlertCircle className="w-4 h-4 shrink-0" />
                                <span>{error}</span>
                            </div>
                        )}

                        {loading ? (
                            <div className="text-center text-zinc-500 py-8">
                                Loading...
                            </div>
                        ) : (
                            <div className="space-y-1">
                                {/* Root option */}
                                <button
                                    onClick={() => handleSelect(null)}
                                    disabled={isSubmitting}
                                    className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 rounded flex items-center gap-2 transition-colors disabled:opacity-50"
                                >
                                    <Folder className="w-4 h-4 text-amber-500/70" />
                                    Root (No folder)
                                </button>

                                {/* Folder list */}
                                {folders.map((folder) => (
                                    <button
                                        key={folder.id}
                                        onClick={() => handleSelect(folder.id)}
                                        disabled={isSubmitting}
                                        className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 rounded flex items-center gap-2 transition-colors disabled:opacity-50"
                                    >
                                        <Folder className="w-4 h-4 text-amber-500/70" />
                                        {folder.title}
                                    </button>
                                ))}

                                {folders.length === 0 && (
                                    <div className="text-center text-zinc-500 py-4 text-sm">
                                        No folders available. Create a folder first.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-3 border-t border-zinc-800 flex justify-end">
                        <button
                            onClick={onClose}
                            disabled={isSubmitting}
                            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
