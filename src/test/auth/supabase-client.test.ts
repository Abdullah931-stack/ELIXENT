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

    it("resolves VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from environment", () => {
        process.env.VITE_SUPABASE_URL = "https://vite-client.supabase.co";
        process.env.VITE_SUPABASE_ANON_KEY = "vite-anon-key";

        const client = createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://vite-client.supabase.co",
            "vite-anon-key"
        );
        expect(client).toEqual({ mockClient: true });
    });

    it("falls back to canonical placeholder credentials when environment variables are absent", () => {
        delete process.env.VITE_SUPABASE_URL;
        delete process.env.VITE_SUPABASE_ANON_KEY;

        createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://placeholder.supabase.co",
            "placeholder-anon-key"
        );
    });

    it("allows independent fallback for url and key", () => {
        process.env.VITE_SUPABASE_URL = "https://vite-independent.supabase.co";
        delete process.env.VITE_SUPABASE_ANON_KEY;

        createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://vite-independent.supabase.co",
            "placeholder-anon-key"
        );
    });

    it("strictly ignores legacy NEXT_PUBLIC_* variables and falls back to placeholders", () => {
        delete process.env.VITE_SUPABASE_URL;
        delete process.env.VITE_SUPABASE_ANON_KEY;
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy-ignored.supabase.co";
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon-key";

        createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://placeholder.supabase.co",
            "placeholder-anon-key"
        );
    });

    it("falls back to placeholders when environment variables are empty strings", () => {
        process.env.VITE_SUPABASE_URL = "";
        process.env.VITE_SUPABASE_ANON_KEY = "";

        createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://placeholder.supabase.co",
            "placeholder-anon-key"
        );
    });

    it("allows independent fallback when URL is absent and key is present", () => {
        delete process.env.VITE_SUPABASE_URL;
        process.env.VITE_SUPABASE_ANON_KEY = "vite-only-key";

        createClient();

        expect(mockCreateBrowserClient).toHaveBeenCalledWith(
            "https://placeholder.supabase.co",
            "vite-only-key"
        );
    });
});
