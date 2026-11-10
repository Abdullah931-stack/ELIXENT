import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    createInMemoryCookieStore,
    runWithServerRequestContext,
    type ServerRequestContext,
} from "@/server/context/request-context";

const { mockCreateServerClient, mockGetUser, mockGetSession } = vi.hoisted(() => ({
    mockCreateServerClient: vi.fn(),
    mockGetUser: vi.fn(),
    mockGetSession: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
    createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

import { createClient, getUser, getSession } from "@/lib/supabase/server";

describe("Supabase Server Client & Auth Resolution", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };

        mockCreateServerClient.mockImplementation((url: string, key: string, options: Record<string, unknown>) => ({
            _url: url,
            _key: key,
            _options: options,
            auth: {
                getUser: mockGetUser,
                getSession: mockGetSession,
            },
        }));
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("Environment Variable Configuration & Fallbacks", () => {
        it("resolves VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from environment", async () => {
            process.env.VITE_SUPABASE_URL = "https://vite-primary.supabase.co";
            process.env.VITE_SUPABASE_ANON_KEY = "vite-anon-key-123";

            await createClient();

            expect(mockCreateServerClient).toHaveBeenCalledWith(
                "https://vite-primary.supabase.co",
                "vite-anon-key-123",
                expect.any(Object)
            );
        });

        it("falls back to canonical placeholder credentials when no environment variables are set", async () => {
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;

            await createClient();

            expect(mockCreateServerClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "placeholder-anon-key",
                expect.any(Object)
            );
        });

        it("strictly ignores legacy NEXT_PUBLIC_* variables and falls back to placeholders", async () => {
            delete process.env.VITE_SUPABASE_URL;
            delete process.env.VITE_SUPABASE_ANON_KEY;
            process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy-server.supabase.co";
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-server-anon-key";

            await createClient();

            expect(mockCreateServerClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "placeholder-anon-key",
                expect.any(Object)
            );
        });

        it("allows independent fallback when URL is present but anon key is absent", async () => {
            process.env.VITE_SUPABASE_URL = "https://vite-only.supabase.co";
            delete process.env.VITE_SUPABASE_ANON_KEY;

            await createClient();

            expect(mockCreateServerClient).toHaveBeenCalledWith(
                "https://vite-only.supabase.co",
                "placeholder-anon-key",
                expect.any(Object)
            );
        });

        it("allows independent fallback when anon key is present but URL is absent", async () => {
            delete process.env.VITE_SUPABASE_URL;
            process.env.VITE_SUPABASE_ANON_KEY = "vite-only-key";

            await createClient();

            expect(mockCreateServerClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "vite-only-key",
                expect.any(Object)
            );
        });

        it("falls back to placeholders when environment variables are empty strings", async () => {
            process.env.VITE_SUPABASE_URL = "";
            process.env.VITE_SUPABASE_ANON_KEY = "";

            await createClient();

            expect(mockCreateServerClient).toHaveBeenCalledWith(
                "https://placeholder.supabase.co",
                "placeholder-anon-key",
                expect.any(Object)
            );
        });
    });

    describe("Cookies Adapter Behavior", () => {
        it("wires getAll() to the resolved cookie store", async () => {
            const ctx: ServerRequestContext = {
                cookies: createInMemoryCookieStore([
                    { name: "sb-auth-token", value: "sess_xyz" },
                    { name: "theme", value: "system" },
                ]),
                headers: new Headers(),
            };

            await runWithServerRequestContext(ctx, async () => {
                const client = (await createClient()) as unknown as {
                    _options: { cookies: { getAll: () => Array<{ name: string; value: string }> } };
                };

                const cookies = client._options.cookies.getAll();
                expect(cookies).toEqual([
                    { name: "sb-auth-token", value: "sess_xyz" },
                    { name: "theme", value: "system" },
                ]);
            });
        });

        it("wires setAll() to update the resolved cookie store with options", async () => {
            const ctx: ServerRequestContext = {
                cookies: createInMemoryCookieStore(),
                headers: new Headers(),
            };

            await runWithServerRequestContext(ctx, async () => {
                const client = (await createClient()) as unknown as {
                    _options: {
                        cookies: {
                            setAll: (
                                cookiesToSet: Array<{
                                    name: string;
                                    value: string;
                                    options?: Record<string, unknown>;
                                }>
                            ) => void;
                            getAll: () => Array<{ name: string; value: string }>;
                        };
                    };
                };

                client._options.cookies.setAll([
                    { name: "sb-access-token", value: "tok_1", options: { path: "/", httpOnly: true } },
                    { name: "sb-refresh-token", value: "tok_2", options: { path: "/", secure: true } },
                ]);

                expect(client._options.cookies.getAll()).toEqual([
                    { name: "sb-access-token", value: "tok_1" },
                    { name: "sb-refresh-token", value: "tok_2" },
                ]);
            });
        });

        it("silently swallows exceptions in setAll() when cookies are immutable (e.g. Server Component)", async () => {
            const throwingCookieStore = {
                getAll: () => [],
                set: () => {
                    throw new Error("Cookies can only be modified in a Server Action or Route Handler");
                },
                delete: () => {},
            };

            const ctx: ServerRequestContext = {
                cookies: throwingCookieStore,
                headers: new Headers(),
            };

            await runWithServerRequestContext(ctx, async () => {
                const client = (await createClient()) as unknown as {
                    _options: {
                        cookies: {
                            setAll: (
                                cookiesToSet: Array<{
                                    name: string;
                                    value: string;
                                    options?: Record<string, unknown>;
                                }>
                            ) => void;
                        };
                    };
                };

                expect(() => {
                    client._options.cookies.setAll([
                        { name: "sb-token", value: "tok", options: { path: "/" } },
                    ]);
                }).not.toThrow();
            });
        });
    });

    describe("getUser", () => {
        it("returns user object when Supabase auth.getUser() succeeds", async () => {
            const mockUser = { id: "usr_abc", email: "engineer@lugx.app" };
            mockGetUser.mockResolvedValue({
                data: { user: mockUser },
                error: null,
            });

            const user = await getUser();
            expect(user).toEqual(mockUser);
        });

        it("returns null when Supabase auth.getUser() returns an error", async () => {
            mockGetUser.mockResolvedValue({
                data: { user: null },
                error: { message: "Invalid session token", status: 401 },
            });

            const user = await getUser();
            expect(user).toBeNull();
        });

        it("returns null when Supabase auth.getUser() returns no error but null user", async () => {
            mockGetUser.mockResolvedValue({
                data: { user: null },
                error: null,
            });

            const user = await getUser();
            expect(user).toBeNull();
        });

        it("catches network or auth exceptions, logs warning, and returns null", async () => {
            const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            mockGetUser.mockRejectedValue(new Error("Supabase network socket timeout"));

            const user = await getUser();
            expect(user).toBeNull();
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                "[Supabase Server] getUser network/auth exception:",
                expect.any(Error)
            );

            consoleWarnSpy.mockRestore();
        });
    });

    describe("getSession", () => {
        it("returns session object when Supabase auth.getSession() succeeds", async () => {
            const mockSession = { access_token: "jwt_123", user: { id: "usr_1" } };
            mockGetSession.mockResolvedValue({
                data: { session: mockSession },
                error: null,
            });

            const session = await getSession();
            expect(session).toEqual(mockSession);
        });

        it("returns null when Supabase auth.getSession() returns an error", async () => {
            mockGetSession.mockResolvedValue({
                data: { session: null },
                error: { message: "Session expired", status: 400 },
            });

            const session = await getSession();
            expect(session).toBeNull();
        });

        it("returns null when Supabase auth.getSession() returns null session without error", async () => {
            mockGetSession.mockResolvedValue({
                data: { session: null },
                error: null,
            });

            const session = await getSession();
            expect(session).toBeNull();
        });

        it("catches network or auth exceptions, logs warning, and returns null", async () => {
            const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            mockGetSession.mockRejectedValue(new Error("Database connection refused"));

            const session = await getSession();
            expect(session).toBeNull();
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                "[Supabase Server] getSession network/auth exception:",
                expect.any(Error)
            );

            consoleWarnSpy.mockRestore();
        });
    });
});
