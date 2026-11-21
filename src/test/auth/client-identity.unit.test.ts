/**
 * @vitest-environment jsdom
 *
 * Exhaustive Unit Test Suite: Local-First Client Identity Module (`src/lib/auth/client-identity.ts`)
 * Reference: REQ-LF-AUTH (Phase 0.20.5)
 *
 * Verifies the 3 core functions:
 * 1. resolveInitialClientUserIdSync (0ms synchronous cookie & storage extraction)
 * 2. persistLocalClientUserId & clearLocalClientUserId (bidirectional sync with cookies & localStorage)
 * 3. resolveLocalFirstAuthUser (Dual-mode Local-First authentication with offline resilience and explicit-rejection guards)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    buildLoginRedirectPath,
    resolveInitialClientUserIdSync,
    persistLocalClientUserId,
    clearLocalClientUserId,
    resolveLocalFirstAuthUser,
} from "@/lib/auth/client-identity";

// Mock Supabase client boundary
const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
    createClient: () => ({
        auth: {
            getUser: () => mockGetUser(),
        },
    }),
}));

function clearAllCookiesAndStorage() {
    clearLocalClientUserId();
    if (typeof document !== "undefined" && document.cookie) {
        const cookies = document.cookie.split(";");
        for (const c of cookies) {
            const eqPos = c.indexOf("=");
            const name = eqPos > -1 ? c.substring(0, eqPos).trim() : c.trim();
            if (name) {
                document.cookie = `${name}=; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
            }
        }
    }
    if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.clear();
    }
}

describe("Local-First Client Identity (`src/lib/auth/client-identity.ts`)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearAllCookiesAndStorage();
    });

    afterEach(() => {
        clearAllCookiesAndStorage();
    });

    // =========================================================================
    // 1. Synchronous Client User ID Extraction (`resolveInitialClientUserIdSync`)
    // =========================================================================
    describe("1. Synchronous Client User ID Extraction (`resolveInitialClientUserIdSync`)", () => {
        it("returns null when no cookies or localStorage items exist", () => {
            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBeNull();
        });

        it("extracts plain user ID directly from elixent_uid cookie", () => {
            document.cookie = "elixent_uid=usr_alpha_999; Path=/";
            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBe("usr_alpha_999");
        });

        it("extracts and decodes URI-encoded user ID from elixent_uid cookie", () => {
            const rawId = "user:test/special+chars=";
            document.cookie = `elixent_uid=${encodeURIComponent(rawId)}; Path=/`;
            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBe(rawId);
        });

        it("extracts user ID from standard JSON sb-*-auth-token cookie containing user object", () => {
            const sessionData = JSON.stringify({
                user: { id: "sb_user_direct_123" },
                access_token: "mock.token.jwt",
            });
            document.cookie = `sb-project-ref-auth-token=${encodeURIComponent(sessionData)}; Path=/`;

            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBe("sb_user_direct_123");
        });

        it("extracts user ID from base64- prefixed Supabase session cookie", () => {
            const sessionObj = {
                user: { id: "sb_base64_user_456" },
            };
            const b64 = btoa(JSON.stringify(sessionObj));
            document.cookie = `sb-project-auth-token=base64-${b64}; Path=/`;

            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBe("sb_base64_user_456");
        });

        it("extracts user ID from JWT sub claim inside access_token string array cookie", () => {
            // Header: {"alg":"HS256","typ":"JWT"}, Payload: {"sub":"jwt_sub_user_789"}
            const headerB64 = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
            const payloadB64 = btoa(JSON.stringify({ sub: "jwt_sub_user_789" }));
            const jwt = `${headerB64}.${payloadB64}.signature`;

            const cookieValue = JSON.stringify([jwt, "refresh_token_abc"]);
            document.cookie = `sb-tenant-auth-token=${encodeURIComponent(cookieValue)}; Path=/`;

            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBe("jwt_sub_user_789");
        });

        it("assembles chunked Supabase cookies (chunk .0 and chunk .1) in order and extracts user ID", () => {
            const sessionPayload = JSON.stringify({
                user: { id: "chunked_user_999" },
            });
            const b64Payload = "base64-" + btoa(sessionPayload);
            const mid = Math.floor(b64Payload.length / 2);
            const chunk0 = b64Payload.slice(0, mid);
            const chunk1 = b64Payload.slice(mid);

            // Set chunks in reverse order to verify numerical sorting
            document.cookie = `sb-multi-auth-token.1=${chunk1}; Path=/`;
            document.cookie = `sb-multi-auth-token.0=${chunk0}; Path=/`;

            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBe("chunked_user_999");
        });

        it("falls back to localStorage elixent_uid when cookies are absent", () => {
            window.localStorage.setItem("elixent_uid", "storage_user_333");

            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBe("storage_user_333");
            // Also verifies it synchronized back to cookie
            expect(document.cookie).toContain("elixent_uid=storage_user_333");
        });

        it("falls back to localStorage sb-*-auth-token when elixent_uid is absent", () => {
            const sessionData = JSON.stringify({
                user: { id: "storage_sb_user_777" },
            });
            window.localStorage.setItem("sb-app-auth-token", sessionData);

            const userId = resolveInitialClientUserIdSync();
            expect(userId).toBe("storage_sb_user_777");
            expect(document.cookie).toContain("elixent_uid=storage_sb_user_777");
        });
    });

    // =========================================================================
    // 2. Local Identity Persistence & Clearing (`persist` and `clear`)
    // =========================================================================
    describe("2. Local Identity Persistence & Clearing", () => {
        it("persists user ID to both document.cookie and localStorage", () => {
            persistLocalClientUserId("usr_persist_123");

            expect(document.cookie).toContain("elixent_uid=usr_persist_123");
            expect(window.localStorage.getItem("elixent_uid")).toBe("usr_persist_123");
        });

        it("safely ignores empty, null, or whitespace-only inputs without writing", () => {
            persistLocalClientUserId("");
            persistLocalClientUserId("   ");
            persistLocalClientUserId(null as any);

            expect(document.cookie).not.toContain("elixent_uid=");
            expect(window.localStorage.getItem("elixent_uid")).toBeNull();
        });

        it("clears user ID from both document.cookie and localStorage", () => {
            persistLocalClientUserId("usr_to_be_cleared");
            expect(window.localStorage.getItem("elixent_uid")).toBe("usr_to_be_cleared");

            clearLocalClientUserId();

            expect(window.localStorage.getItem("elixent_uid")).toBeNull();
            // In JSDOM, expiring a cookie removes it from document.cookie string
            expect(document.cookie).not.toContain("elixent_uid=usr_to_be_cleared");
        });
    });

    // =========================================================================
    // 3. Local-First Auth User Resolution (`resolveLocalFirstAuthUser`)
    // =========================================================================
    describe("3. Local-First Auth User Resolution (`resolveLocalFirstAuthUser`)", () => {
        it("returns local cookie identity immediately without waiting for server network response", async () => {
            persistLocalClientUserId("cached_user_instant");
            let serverResolved = false;
            mockGetUser.mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                serverResolved = true;
                return { data: { user: { id: "cached_user_instant" } }, error: null };
            });

            const user = await resolveLocalFirstAuthUser();

            expect(user).toEqual({ id: "cached_user_instant" });
            // Immediate return (0ms) happened before background promise finished
            expect(serverResolved).toBe(false);
            await vi.waitFor(() => {
                expect(serverResolved).toBe(true);
            });
        });

        it("does NOT invoke onSessionExpired on network failure or offline state", async () => {
            persistLocalClientUserId("offline_resilient_user");
            const onSessionExpired = vi.fn();

            mockGetUser.mockRejectedValue(new Error("Failed to fetch"));

            const user = await resolveLocalFirstAuthUser({ onSessionExpired });

            expect(user).toEqual({ id: "offline_resilient_user" });
            // Wait for background promise to reject
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(onSessionExpired).not.toHaveBeenCalled();
            expect(document.cookie).toContain("elixent_uid=offline_resilient_user");
        });

        it("invokes onSessionExpired and clears cookie when server explicitly rejects with HTTP 401/403", async () => {
            persistLocalClientUserId("expired_user_401");
            const onSessionExpired = vi.fn();

            mockGetUser.mockResolvedValue({
                data: { user: null },
                error: { status: 401, message: "Unauthorized", code: "session_expired" },
            });

            const user = await resolveLocalFirstAuthUser({ onSessionExpired });

            expect(user).toEqual({ id: "expired_user_401" });

            // Allow background async verification to settle
            await vi.waitFor(() => {
                expect(onSessionExpired).toHaveBeenCalledTimes(1);
            });

            expect(document.cookie).not.toContain("elixent_uid=expired_user_401");
            expect(window.localStorage.getItem("elixent_uid")).toBeNull();
        });

        it("invokes onSessionExpired when error message includes 'jwt expired'", async () => {
            persistLocalClientUserId("expired_jwt_user");
            const onSessionExpired = vi.fn();

            mockGetUser.mockRejectedValue({
                message: "JWT expired: token has passed its expiration time",
            });

            const user = await resolveLocalFirstAuthUser({ onSessionExpired });
            expect(user).toEqual({ id: "expired_jwt_user" });

            await vi.waitFor(() => {
                expect(onSessionExpired).toHaveBeenCalledTimes(1);
            });

            expect(window.localStorage.getItem("elixent_uid")).toBeNull();
        });

        it("cold-start with no local identity queries server and persists verified user", async () => {
            mockGetUser.mockResolvedValue({
                data: { user: { id: "server_fresh_user_888", email: "fresh@elixent.com" } },
                error: null,
            });

            const user = await resolveLocalFirstAuthUser();

            expect(user).toEqual(
                expect.objectContaining({ id: "server_fresh_user_888", email: "fresh@elixent.com" })
            );
            expect(document.cookie).toContain("elixent_uid=server_fresh_user_888");
            expect(window.localStorage.getItem("elixent_uid")).toBe("server_fresh_user_888");
        });

        it("cold-start with no local identity invokes onSessionExpired and returns null if server returns user: null", async () => {
            const onSessionExpired = vi.fn();
            mockGetUser.mockResolvedValue({
                data: { user: null },
                error: null,
            });

            const user = await resolveLocalFirstAuthUser({ onSessionExpired });

            expect(user).toBeNull();
            expect(onSessionExpired).toHaveBeenCalledTimes(1);
        });

        it("cold-start with no local identity does NOT invoke onSessionExpired on transient network error", async () => {
            const onSessionExpired = vi.fn();
            mockGetUser.mockRejectedValue(new Error("Failed to fetch"));

            const user = await resolveLocalFirstAuthUser({ onSessionExpired });

            expect(user).toBeNull();
            expect(onSessionExpired).not.toHaveBeenCalled();
        });

        it("does NOT clear local identity or invoke onSessionExpired when AbortSignal aborts before background 401 settles", async () => {
            persistLocalClientUserId("cached_abort_user");
            const onSessionExpired = vi.fn();
            const controller = new AbortController();

            let resolveGetUser!: (val: unknown) => void;
            mockGetUser.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveGetUser = resolve;
                    })
            );

            const user = await resolveLocalFirstAuthUser({
                onSessionExpired,
                signal: controller.signal,
            });
            expect(user).toEqual({ id: "cached_abort_user" });

            controller.abort();
            resolveGetUser({
                data: { user: null },
                error: { status: 401, message: "Unauthorized", code: "session_expired" },
            });

            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(onSessionExpired).not.toHaveBeenCalled();
            expect(document.cookie).toContain("elixent_uid=cached_abort_user");
        });

        it("does NOT invoke onSessionExpired when AbortSignal aborts during cold-start getUser", async () => {
            const onSessionExpired = vi.fn();
            const controller = new AbortController();

            let resolveGetUser!: (val: unknown) => void;
            mockGetUser.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveGetUser = resolve;
                    })
            );

            const promise = resolveLocalFirstAuthUser({
                onSessionExpired,
                signal: controller.signal,
            });

            await vi.waitFor(() => {
                expect(mockGetUser).toHaveBeenCalledTimes(1);
            });
            controller.abort();
            resolveGetUser({ data: { user: null }, error: null });

            const user = await promise;
            expect(user).toBeNull();
            expect(onSessionExpired).not.toHaveBeenCalled();
        });

        it("trusts local identity offline without calling getUser and returns null offline on cold-start without eviction", async () => {
            const originalOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
            Object.defineProperty(Navigator.prototype, "onLine", {
                configurable: true,
                get: () => false,
            });

            try {
                // Cached offline user
                persistLocalClientUserId("offline_cached_user");
                const onExpiredCached = vi.fn();
                const cached = await resolveLocalFirstAuthUser({ onSessionExpired: onExpiredCached });
                expect(cached).toEqual({ id: "offline_cached_user" });
                expect(mockGetUser).not.toHaveBeenCalled();
                expect(onExpiredCached).not.toHaveBeenCalled();
                expect(window.localStorage.getItem("elixent_uid")).toBe("offline_cached_user");

                // Cold-start offline (no local identity)
                clearAllCookiesAndStorage();
                const onExpiredCold = vi.fn();
                const cold = await resolveLocalFirstAuthUser({ onSessionExpired: onExpiredCold });
                expect(cold).toBeNull();
                expect(mockGetUser).not.toHaveBeenCalled();
                expect(onExpiredCold).not.toHaveBeenCalled();
            } finally {
                if (originalOnLine) {
                    Object.defineProperty(Navigator.prototype, "onLine", originalOnLine);
                }
            }
        });

        it.each([
            ["DOMException AbortError", () => new DOMException("The operation was aborted", "AbortError")],
            ["Error with name AbortError", () => Object.assign(new Error("Request aborted"), { name: "AbortError" })],
            ["network timeout error", () => new Error("Request timeout while refreshing token")],
        ])("does NOT evict local identity or invoke onSessionExpired on transient %s", async (_label, makeErr) => {
            persistLocalClientUserId("resilient_abort_user");
            const onSessionExpired = vi.fn();
            mockGetUser.mockRejectedValueOnce(makeErr());

            const user = await resolveLocalFirstAuthUser({ onSessionExpired });
            expect(user).toEqual({ id: "resilient_abort_user" });
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(onSessionExpired).not.toHaveBeenCalled();
            expect(window.localStorage.getItem("elixent_uid")).toBe("resilient_abort_user");

            // Also verify cold-start does not trigger onSessionExpired on AbortError
            clearAllCookiesAndStorage();
            mockGetUser.mockRejectedValueOnce(makeErr());
            const cold = await resolveLocalFirstAuthUser({ onSessionExpired });
            expect(cold).toBeNull();
            expect(onSessionExpired).not.toHaveBeenCalled();
        });

        it("skips getUser completely when passed a pre-aborted AbortSignal", async () => {
            const controller = new AbortController();
            controller.abort();
            const onSessionExpired = vi.fn();

            persistLocalClientUserId("pre_aborted_user");
            const cached = await resolveLocalFirstAuthUser({
                onSessionExpired,
                signal: controller.signal,
            });
            expect(cached).toEqual({ id: "pre_aborted_user" });
            expect(mockGetUser).not.toHaveBeenCalled();
            expect(onSessionExpired).not.toHaveBeenCalled();

            clearAllCookiesAndStorage();
            const cold = await resolveLocalFirstAuthUser({
                onSessionExpired,
                signal: controller.signal,
            });
            expect(cold).toBeNull();
            expect(mockGetUser).not.toHaveBeenCalled();
            expect(onSessionExpired).not.toHaveBeenCalled();
        });

        it("does NOT evict identity when connectivity drops offline mid-request before a 401 settles", async () => {
            const originalOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
            let isOnline = true;
            Object.defineProperty(Navigator.prototype, "onLine", {
                configurable: true,
                get: () => isOnline,
            });

            try {
                persistLocalClientUserId("mid_flight_offline_user");
                const onSessionExpired = vi.fn();
                let resolveGetUser!: (val: unknown) => void;
                mockGetUser.mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            resolveGetUser = resolve;
                        })
                );

                await resolveLocalFirstAuthUser({ onSessionExpired });
                await vi.waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(1));

                isOnline = false;
                resolveGetUser({
                    data: { user: null },
                    error: { status: 401, message: "Unauthorized" },
                });

                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(onSessionExpired).not.toHaveBeenCalled();
                expect(window.localStorage.getItem("elixent_uid")).toBe("mid_flight_offline_user");
            } finally {
                if (originalOnLine) {
                    Object.defineProperty(Navigator.prototype, "onLine", originalOnLine);
                }
            }
        });
    });

    // =========================================================================
    // 4. Login Redirect Path Builder (`buildLoginRedirectPath`)
    // =========================================================================
    describe("4. Login Redirect Path Builder (`buildLoginRedirectPath`)", () => {
        it("preserves valid relative pathname and search query in redirectTo", () => {
            expect(buildLoginRedirectPath("/workspace/editor/doc-123?tab=notes")).toBe(
                "/login?redirectTo=%2Fworkspace%2Feditor%2Fdoc-123%3Ftab%3Dnotes"
            );
        });

        it("reads window.location pathname + search when currentPath argument is omitted", () => {
            const originalLocation = window.location;
            Object.defineProperty(window, "location", {
                configurable: true,
                writable: true,
                value: {
                    ...originalLocation,
                    pathname: "/workspace/editor/doc-win",
                    search: "?mode=focus",
                },
            });
            try {
                expect(buildLoginRedirectPath()).toBe(
                    "/login?redirectTo=%2Fworkspace%2Feditor%2Fdoc-win%3Fmode%3Dfocus"
                );
            } finally {
                Object.defineProperty(window, "location", {
                    configurable: true,
                    writable: true,
                    value: originalLocation,
                });
            }
        });

        it.each([
            ["empty string", ""],
            ["root path", "/"],
            ["/login exact", "/login"],
            ["/login with query loop", "/login?redirectTo=%2Fworkspace"],
            ["/login nested subpath", "/login/callback"],
            ["external https URL", "https://evil.com/phish"],
            ["protocol-relative URL", "//evil.com/phish"],
            ["backslash protocol bypass", "/\\evil.com"],
            ["percent-encoded double slash", "/%2F%2Fevil.com"],
            ["javascript pseudo-protocol", "/javascript:alert(1)"],
        ])("falls back to /login for unsafe or loop path (%s)", (_label, candidate) => {
            expect(buildLoginRedirectPath(candidate)).toBe("/login");
        });
    });
});
