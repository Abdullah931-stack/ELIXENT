"use client";

import { useEffect } from "react";
import { Sidebar } from "@/components/layout/sidebar";

interface WorkspaceSidebarClientProps {
    userId?: string;
}

export function WorkspaceSidebarClient({ userId }: WorkspaceSidebarClientProps) {
    useEffect(() => {
        const handlePopState = () => {
            window.location.assign(window.location.href);
        };
        window.addEventListener("popstate", handlePopState);
        return () => {
            window.removeEventListener("popstate", handlePopState);
        };
    }, []);

    return <Sidebar userId={userId} />;
}
