import Image from "next/image";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { WorkspaceSidebarClient } from "./workspace-sidebar-client";
import { Button } from "@/components/ui/button";
import { Settings, Home } from "lucide-react";

export default async function WorkspaceLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const user = await getUser();

    if (!user) {
        redirect("/login");
    }

    return (
        <div className="h-screen bg-zinc-950 flex overflow-hidden">
            {/* Sidebar */}
            <WorkspaceSidebarClient userId={user.id} />

            {/* Main Area */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Top Bar */}
                <header className="h-14 border-b border-zinc-800/50 bg-zinc-950 flex items-center justify-between px-4 flex-shrink-0">
                    <a href="/dashboard" className="flex items-center gap-2">
                        <Image
                            src="/logo.png"
                            alt="LUGX"
                            width={80}
                            height={24}
                            className="h-6 w-auto"
                            style={{ width: "auto" }}
                        />
                    </a>

                    <div className="flex items-center gap-2">
                        <Button asChild variant="ghost" size="icon-sm">
                            <a href="/dashboard">
                                <Home className="w-4 h-4" />
                            </a>
                        </Button>
                        <Button asChild variant="ghost" size="icon-sm">
                            <a href="/account">
                                <Settings className="w-4 h-4" />
                            </a>
                        </Button>
                    </div>
                </header>

                {/* Content - Independent scrolling container */}
                <main className="flex-1 overflow-auto">
                    {children}
                </main>
            </div>
        </div>
    );
}
