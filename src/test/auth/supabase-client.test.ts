import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
    mockCreateBrowserClient,
    mockCreateServerClient,
    mockServerGetUser,
    mockServerGetSession,
} = vi.hoisted(() => ({
    mockCreateBrowserClient: vi.fn(),
    mockCreateServerClient: vi.fn(),
    mockServerGetUser: vi.fn(),
    mockServerGetSession: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
    createBrowserClient: (...args: unknown[]) => mockCreateBrowserClient(...args),
    createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

import { createClient } from "@/lib/supabase/client";
import {
    createClient as createServerSupabaseClient,
    getUser,
    getSession,
} from "@/lib/supabase/server";

describe("Supabase Client & Server Credential Hardening (DEF-A04)", () => {
    const originalEnvSnapshot = { ...process.env };

    function restoreProcessEnv(): void {
        for (const key of Object.keys(process.env)) {
            if (!(key in originalEnvSnapshot)) {
                delete process.env[key];
            }
        }
        Object.assign(process.env, originalEnvSnapshot);
    }

    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        restoreProcessEnv();

        mockCreateBrowserClient.mockReturnValue({ mockClient: true });
        mockCreateServerClient.mockImplementation((url: string, key: string) => ({
            _url: url,
            _key: key,
            auth: {
                getUser: mockServerGetUser,
                getSession: mockServerGetSession,
            },
        }));
        mockServerGetUser.mockResolvedValue({
            data: { user: { id: "user-1" } },
            error: null,
        });
        mockServerGetSession.mockResolvedValue({
            data: { session: { access_token: "token-1" } },
            error: null,
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        restoreProcessEnv();
    });

    describe("Browser Client (src/lib/supabase/client.ts) — Test Runtime Placeholders", () => {
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

        it("allows placeholder fallback when VITEST is set even if NODE_ENV is production", () => {
            process.env.NODE_ENV = "production";
            process.env.VITEST = "true";
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;

            createClient();

            expect(mockCreateBrowserClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "placeholder-anon-key"
            );
        });

        it("allows placeholder fallback when NODE_ENV is test even if VITEST is unset", () => {
            process.env.NODE_ENV = "test";
            delete process.env.VITEST;
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;

            createClient();

            expect(mockCreateBrowserClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "placeholder-anon-key"
            );
        });
    });

    describe("Browser Client (src/lib/supabase/client.ts) — Non-Test Fail-Fast (Node Runtime)", () => {
        it.each([
            ["production"],
            ["development"],
        ] as const)("succeeds in %s mode when valid VITE_SUPABASE_* credentials exist", (nodeEnv) => {
            process.env.NODE_ENV = nodeEnv;
            delete process.env.VITEST;
            process.env.VITE_SUPABASE_URL = "https://real-project.supabase.co";
            process.env.VITE_SUPABASE_ANON_KEY = "real-anon-key";

            const client = createClient();

            expect(mockCreateBrowserClient).toHaveBeenCalledWith(
                "https://real-project.supabase.co",
                "real-anon-key"
            );
            expect(client).toEqual({ mockClient: true });
        });

        it.each([
            ["production", undefined, undefined, /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
            ["production", "", "", /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
            ["production", "   ", "   ", /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
            ["production", "https://real.supabase.co", undefined, /VITE_SUPABASE_ANON_KEY/],
            ["production", undefined, "real-key", /VITE_SUPABASE_URL/],
            ["development", undefined, undefined, /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
            ["development", "https://real.supabase.co", "", /VITE_SUPABASE_ANON_KEY/],
            ["development", "", "real-key", /VITE_SUPABASE_URL/],
        ] as const)(
            "throws fail-fast in %s when url=%s key=%s and VITEST is unset",
            (nodeEnv, url, key, expectedPattern) => {
                process.env.NODE_ENV = nodeEnv;
                delete process.env.VITEST;

                if (url === undefined) delete process.env.VITE_SUPABASE_URL;
                else process.env.VITE_SUPABASE_URL = url;

                if (key === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
                else process.env.VITE_SUPABASE_ANON_KEY = key;

                expect(() => createClient()).toThrow(expectedPattern);
                expect(mockCreateBrowserClient).not.toHaveBeenCalled();
            }
        );

        it("treats VITEST='false' and missing NODE_ENV as non-test runtime and fails fast", () => {
            delete process.env.NODE_ENV;
            process.env.VITEST = "false";
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;

            expect(() => createClient()).toThrow(
                /\[Supabase Client\] Missing required Supabase credentials/
            );
            expect(mockCreateBrowserClient).not.toHaveBeenCalled();
        });

        it("still fails fast in production when only legacy NEXT_PUBLIC_* variables exist", () => {
            process.env.NODE_ENV = "production";
            delete process.env.VITEST;
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;
            process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy.supabase.co";
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-key";

            expect(() => createClient()).toThrow(
                /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/
            );
            expect(mockCreateBrowserClient).not.toHaveBeenCalled();
        });
    });

    describe("Browser Client (src/lib/supabase/client.ts) — Browser import.meta.env Branch (!isNode)", () => {
        function simulateBrowserRuntime(): void {
            vi.stubGlobal("process", {
                env: process.env,
                versions: {},
            });
        }

        it("resolves valid credentials from import.meta.env in browser production mode", () => {
            simulateBrowserRuntime();
            vi.stubEnv("MODE", "production");
            vi.stubEnv("VITEST", undefined);
            vi.stubEnv("VITE_SUPABASE_URL", "https://browser-bundle.supabase.co");
            vi.stubEnv("VITE_SUPABASE_ANON_KEY", "browser-anon-key");

            const client = createClient();

            expect(mockCreateBrowserClient).toHaveBeenCalledWith(
                "https://browser-bundle.supabase.co",
                "browser-anon-key"
            );
            expect(client).toEqual({ mockClient: true });
        });

        it.each([
            ["production"],
            ["development"],
        ] as const)(
            "throws fail-fast in browser %s mode via import.meta.env even if process.env.NODE_ENV='test'",
            (mode) => {
                process.env.NODE_ENV = "test";
                simulateBrowserRuntime();
                vi.stubEnv("MODE", mode);
                vi.stubEnv("VITEST", undefined);
                vi.stubEnv("VITE_SUPABASE_URL", undefined);
                vi.stubEnv("VITE_SUPABASE_ANON_KEY", undefined);

                expect(() => createClient()).toThrow(
                    /\[Supabase Client\] Missing required Supabase credentials in non-test runtime: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/
                );
                expect(mockCreateBrowserClient).not.toHaveBeenCalled();
            }
        );

        it("throws fail-fast in browser mode when only one import.meta.env credential is missing", () => {
            simulateBrowserRuntime();
            vi.stubEnv("MODE", "production");
            vi.stubEnv("VITEST", undefined);
            vi.stubEnv("VITE_SUPABASE_URL", "https://browser-only-url.supabase.co");
            vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");

            expect(() => createClient()).toThrow(/VITE_SUPABASE_ANON_KEY/);
            expect(mockCreateBrowserClient).not.toHaveBeenCalled();
        });

        it("allows placeholder fallback in browser branch only when import.meta.env.MODE === 'test'", () => {
            process.env.NODE_ENV = "production";
            simulateBrowserRuntime();
            vi.stubEnv("MODE", "test");
            vi.stubEnv("VITEST", undefined);
            vi.stubEnv("VITE_SUPABASE_URL", undefined);
            vi.stubEnv("VITE_SUPABASE_ANON_KEY", undefined);

            createClient();

            expect(mockCreateBrowserClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "placeholder-anon-key"
            );
        });

        it("allows placeholder fallback in browser branch when import.meta.env.VITEST is truthy", () => {
            simulateBrowserRuntime();
            vi.stubEnv("MODE", "production");
            vi.stubEnv("VITEST", "true");
            vi.stubEnv("VITE_SUPABASE_URL", undefined);
            vi.stubEnv("VITE_SUPABASE_ANON_KEY", undefined);

            createClient();

            expect(mockCreateBrowserClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "placeholder-anon-key"
            );
        });

        it("strictly ignores legacy NEXT_PUBLIC_* variables in browser non-test mode", () => {
            simulateBrowserRuntime();
            vi.stubEnv("MODE", "production");
            vi.stubEnv("VITEST", undefined);
            vi.stubEnv("VITE_SUPABASE_URL", undefined);
            vi.stubEnv("VITE_SUPABASE_ANON_KEY", undefined);
            vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://legacy-browser.supabase.co");
            vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "legacy-browser-key");

            expect(() => createClient()).toThrow(
                /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/
            );
            expect(mockCreateBrowserClient).not.toHaveBeenCalled();
        });
    });

    describe("Server Client (src/lib/supabase/server.ts) — Placeholder Scoping & Non-Test Fail-Fast", () => {
        it("allows placeholder fallback in test runtime when VITE_SUPABASE_* are absent", async () => {
            process.env.NODE_ENV = "test";
            delete process.env.VITEST;
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;

            await createServerSupabaseClient();

            expect(mockCreateServerClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "placeholder-anon-key",
                expect.any(Object)
            );
        });

        it.each([
            ["production"],
            ["development"],
        ] as const)(
            "resolves valid VITE_SUPABASE_* credentials in %s server runtime",
            async (nodeEnv) => {
                process.env.NODE_ENV = nodeEnv;
                delete process.env.VITEST;
                process.env.VITE_SUPABASE_URL = "https://server-prod.supabase.co";
                process.env.VITE_SUPABASE_ANON_KEY = "server-prod-key";

                await createServerSupabaseClient();

                expect(mockCreateServerClient).toHaveBeenCalledWith(
                    "https://server-prod.supabase.co",
                    "server-prod-key",
                    expect.any(Object)
                );
            }
        );

        it.each([
            ["production", undefined, undefined, /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
            ["production", "https://server.supabase.co", "", /VITE_SUPABASE_ANON_KEY/],
            ["production", "   ", "server-key", /VITE_SUPABASE_URL/],
            ["development", undefined, undefined, /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
            ["development", undefined, "server-key", /VITE_SUPABASE_URL/],
        ] as const)(
            "throws fail-fast in %s server runtime when url=%s key=%s",
            async (nodeEnv, url, key, expectedPattern) => {
                process.env.NODE_ENV = nodeEnv;
                delete process.env.VITEST;

                if (url === undefined) delete process.env.VITE_SUPABASE_URL;
                else process.env.VITE_SUPABASE_URL = url;

                if (key === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
                else process.env.VITE_SUPABASE_ANON_KEY = key;

                await expect(createServerSupabaseClient()).rejects.toThrow(expectedPattern);
                expect(mockCreateServerClient).not.toHaveBeenCalled();
            }
        );

        it("still fails fast in server production mode when only legacy NEXT_PUBLIC_* variables exist", async () => {
            process.env.NODE_ENV = "production";
            delete process.env.VITEST;
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;
            process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy-server.supabase.co";
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-server-key";

            await expect(createServerSupabaseClient()).rejects.toThrow(
                /\[Supabase Server\] Missing required Supabase credentials/
            );
            expect(mockCreateServerClient).not.toHaveBeenCalled();
        });

        it("propagates fail-fast credential errors from getUser() and getSession() instead of returning null", async () => {
            process.env.NODE_ENV = "production";
            delete process.env.VITEST;
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;

            await expect(getUser()).rejects.toThrow(
                /\[Supabase Server\] Missing required Supabase credentials/
            );
            await expect(getSession()).rejects.toThrow(
                /\[Supabase Server\] Missing required Supabase credentials/
            );
            expect(mockCreateServerClient).not.toHaveBeenCalled();
        });

        it("still catches runtime auth exceptions in getUser() and getSession() when credentials are configured", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            process.env.NODE_ENV = "production";
            delete process.env.VITEST;
            process.env.VITE_SUPABASE_URL = "https://server-prod.supabase.co";
            process.env.VITE_SUPABASE_ANON_KEY = "server-prod-key";
            mockServerGetUser.mockRejectedValueOnce(new Error("Auth socket timeout"));
            mockServerGetSession.mockRejectedValueOnce(new Error("Session socket timeout"));

            await expect(getUser()).resolves.toBeNull();
            await expect(getSession()).resolves.toBeNull();
            expect(warnSpy).toHaveBeenCalledTimes(2);
            warnSpy.mockRestore();
        });
    });
});
