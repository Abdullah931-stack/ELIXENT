import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreateBrowserClient } = vi.hoisted(() => ({
    mockCreateBrowserClient: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
    createBrowserClient: (...args: unknown[]) => mockCreateBrowserClient(...args),
}));

import { createClient } from "@/lib/supabase/client";

describe("Supabase Browser Client Factory (src/lib/supabase/client.ts)", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        mockCreateBrowserClient.mockReturnValue({ mockClient: true });
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("prioritizes VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY when both Vite and Next env are present", () => {
        process.env.VITE_SUPABASE_URL = "https://vite-client.supabase.co";
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://next-client.supabase.co";
        process.env.VITE_SUPABASE_ANON_KEY = "vite-anon-key";
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "next-anon-key";

        const client = createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://vite-client.supabase.co",
            "vite-anon-key"
        );
        expect(client).toEqual({ mockClient: true });
    });

    it("falls back to NEXT_PUBLIC_* variables when VITE_* variables are omitted", () => {
        delete process.env.VITE_SUPABASE_URL;
        delete process.env.VITE_SUPABASE_ANON_KEY;
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://next-only.supabase.co";
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "next-anon-only";

        createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://next-only.supabase.co",
            "next-anon-only"
        );
    });

    it("falls back to canonical placeholder credentials when all environment variables are absent", () => {
        delete process.env.VITE_SUPABASE_URL;
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.VITE_SUPABASE_ANON_KEY;
        delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

        createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://placeholder.supabase.co",
            "placeholder-anon-key"
        );
    });

    it("allows independent fallback for url and key (e.g. Vite URL with Next key)", () => {
        process.env.VITE_SUPABASE_URL = "https://vite-independent.supabase.co";
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.VITE_SUPABASE_ANON_KEY;
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "next-independent-key";

        createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://vite-independent.supabase.co",
            "next-independent-key"
        );
    });
});
