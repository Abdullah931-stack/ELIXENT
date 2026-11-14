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
    });
});
