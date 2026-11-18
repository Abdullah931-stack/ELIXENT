import { useState, useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { AppLink as Link } from "@/components/ui/app-link";
import { navigateTo } from "@/client/navigation";
import { getRootFiles, getFolderChildren, createFile } from "@/client/rpc-client";
import { Button } from "@/components/ui/button";
import { Plus, FileText, Folder, Sparkles } from "lucide-react";
import {
    resolveLocalFirstAuthUser,
} from "@/lib/auth/client-identity";

interface WorkspaceFileItem {
    id: string;
    title: string;
    isFolder?: boolean;
    updatedAt?: string | Date | null;
}

function getActiveFolderIdFromLocation(): string | null {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("folderId");
    return id && id.trim().length > 0 ? id : null;
}

export default function WorkspacePage() {
    const router = useRouter({ warn: false });
    const [folderId, setFolderId] = useState<string | null>(() => getActiveFolderIdFromLocation());
    const [loading, setLoading] = useState(true);
    const [user, setUser] = useState<{ id: string } | null>(null);
    const [files, setFiles] = useState<WorkspaceFileItem[]>([]);
    const [creationError, setCreationError] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);

    useEffect(() => {
        const syncFolderFromLocation = () => {
            setFolderId(getActiveFolderIdFromLocation());
        };
        syncFolderFromLocation();
        window.addEventListener("popstate", syncFolderFromLocation);
        const unsubscribe = router?.subscribe?.("onResolved", syncFolderFromLocation);
        return () => {
            window.removeEventListener("popstate", syncFolderFromLocation);
            unsubscribe?.();
        };
    }, [router]);

    useEffect(() => {
        let isMounted = true;
        async function loadData() {
            try {
                const authUser = await resolveLocalFirstAuthUser({
                    onSessionExpired: () => {
                        if (isMounted) {
                            navigateTo("/login");
                        }
                    },
                });
                if (!isMounted) return;
                if (!authUser) {
                    navigateTo("/login");
                    return;
                }
                setUser(authUser);
                try {
                    const filesResult = folderId
                        ? await getFolderChildren(folderId)
                        : await getRootFiles();
                    if (!isMounted) return;
                    if (filesResult && filesResult.success) {
                        setFiles(filesResult.data || []);
                    } else {
                        console.warn("[Workspace] Failed to fetch workspace files:", filesResult?.error);
                        setFiles(filesResult?.data || []);
                    }
                } catch (err) {
                    console.error("[Workspace] Network error fetching workspace files:", err);
                }
            } catch {
                if (isMounted) {
                    navigateTo("/login");
                }
            } finally {
                if (isMounted) {
                    setLoading(false);
                }
            }
        }
        loadData();
        return () => {
            isMounted = false;
        };
    }, [folderId]);

    const triggerCreateDocument = async () => {
        if (isCreating) return;
        setIsCreating(true);
        setCreationError(null);
        try {
            const result = await createFile("Untitled Document", folderId, false);
            if (result && result.success && result.data) {
                navigateTo(`/workspace/editor/${result.data.id}`);
            } else {
                const msg = result?.error || "Failed to create document";
                console.error("[Workspace] createFile returned error:", msg);
                setCreationError(msg);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Network error creating document";
            console.error("[Workspace] createFile network error:", msg);
            setCreationError(msg);
        } finally {
            setIsCreating(false);
        }
    };

    if (loading || !user) {
        return (
            <div className="p-6">
                <div className="max-w-4xl mx-auto flex items-center justify-center py-20">
                    <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
                </div>
            </div>
        );
    }

    return (
        <div className="p-6">
            <div className="max-w-4xl mx-auto">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h1 className="text-2xl font-medium text-zinc-50">Workspace</h1>
                        <p className="text-zinc-500 mt-1">
                            Your documents and folders
                        </p>
                    </div>

                    <Button type="button" onClick={triggerCreateDocument} variant="ai" className="gap-2" disabled={isCreating}>
                        <Plus className="w-4 h-4" />
                        New Document
                    </Button>
                </div>

                {creationError && (
                    <div className="mb-6 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm flex items-center justify-between">
                        <span>{creationError}</span>
                        <button
                            type="button"
                            onClick={() => setCreationError(null)}
                            className="text-xs text-red-300 hover:text-white"
                        >
                            Dismiss
                        </button>
                    </div>
                )}

                {/* Files Grid */}
                {files.length === 0 ? (
                    <div className="text-center py-20">
                        <div className="w-16 h-16 rounded-full bg-zinc-800/50 flex items-center justify-center mx-auto mb-4">
                            <Sparkles className="w-8 h-8 text-zinc-500" />
                        </div>
                        <h2 className="text-lg font-medium text-zinc-400 mb-2">
                            No documents yet
                        </h2>
                        <p className="text-zinc-500 text-sm mb-6">
                            Create your first document to get started
                        </p>
                        <Button type="button" onClick={triggerCreateDocument} variant="primary" className="gap-2" disabled={isCreating}>
                            <Plus className="w-4 h-4" />
                            Create Document
                        </Button>
                    </div>
                ) : (
                    <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {files.map((file) => (
                            <Link
                                key={file.id}
                                to={
                                    file.isFolder
                                        ? `/workspace?folderId=${encodeURIComponent(file.id)}`
                                        : `/workspace/editor/${file.id}`
                                }
                                className="group block"
                            >
                                <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/50 hover:border-zinc-700 transition-all">
                                    <div className="w-10 h-10 rounded-lg bg-zinc-800/50 flex items-center justify-center mb-3 group-hover:bg-zinc-800 transition-colors">
                                        {file.isFolder ? (
                                             <Folder className="w-5 h-5 text-amber-500/70" />
                                        ) : (
                                            <FileText className="w-5 h-5 text-zinc-500" />
                                        )}
                                    </div>
                                    <h3 className="font-medium text-zinc-300 truncate group-hover:text-zinc-50 transition-colors">
                                        {file.title}
                                    </h3>
                                    <p className="text-xs text-zinc-500 mt-1">
                                        {file.updatedAt ? new Date(file.updatedAt).toLocaleDateString() : ""}
                                    </p>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export function WorkspaceRouteView() {
    return <WorkspacePage />;
}

