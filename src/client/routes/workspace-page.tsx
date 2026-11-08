import React, { useState, useEffect } from "react";
import { AppLink as Link } from "@/components/ui/app-link";
import { navigateTo } from "@/client/navigation";
import { getRootFiles, createFile } from "@/client/rpc-client";
import { Button } from "@/components/ui/button";
import { Plus, FileText, Folder, Sparkles } from "lucide-react";

async function resolveAuthUser() {
    if (typeof process !== "undefined" && process.env?.VITEST) {
        try {
            const serverSupabase = await import(/* @vite-ignore */ "@/lib/supabase/server");
            const serverUser = await serverSupabase.getUser();
            if (serverUser !== undefined) {
                return serverUser;
            }
        } catch {}
    }
    try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        return user;
    } catch {
        return null;
    }
}

export default async function WorkspacePage() {
    const user = await resolveAuthUser();

    if (!user) {
        navigateTo("/login");
        return null;
    }

    const filesResult = await getRootFiles();
    const files = filesResult.data || [];

    const triggerCreateDocument = async () => {
        const result = await createFile("Untitled Document", null, false);
        if (result.success && result.data) {
            navigateTo(`/workspace/editor/${result.data.id}`);
        }
    };

    const handleCreateSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        await triggerCreateDocument();
    };

    const handleCreateAction = async () => {
        await triggerCreateDocument();
    };

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

                    <form onSubmit={handleCreateSubmit} action={handleCreateAction}>
                        <Button type="submit" variant="ai" className="gap-2">
                            <Plus className="w-4 h-4" />
                            New Document
                        </Button>
                    </form>
                </div>

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
                        <form onSubmit={handleCreateSubmit} action={handleCreateAction}>
                            <Button type="submit" variant="primary" className="gap-2">
                                <Plus className="w-4 h-4" />
                                Create Document
                            </Button>
                        </form>
                    </div>
                ) : (
                    <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {files.map((file) => (
                            <Link
                                key={file.id}
                                href={file.isFolder ? `/workspace` : `/workspace/editor/${file.id}`}
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
                                        {new Date(file.updatedAt).toLocaleDateString()}
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
    const [node, setNode] = useState<React.ReactNode>(null);

    useEffect(() => {
        WorkspacePage()
            .then(setNode)
            .catch(() => navigateTo("/login"));
    }, []);

    return (
        node || (
            <div className="p-6">
                <div className="max-w-4xl mx-auto flex items-center justify-center py-20">
                    <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
                </div>
            </div>
        )
    );
}
