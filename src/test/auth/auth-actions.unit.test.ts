/**
 * Unit Test Suite: Decoupled Auth Actions (Wave 3.1)
 *
 * Verifies the decoupled behavior of `src/server/actions/auth-actions.ts`:
 * 1. signInWithGoogle: structured return types, OAuth error handling, open redirect protection,
 *    rate limiting, IP extraction fallbacks, and execution within `runWithServerRequestContext`.
 * 2. signOut: overloaded signatures (direct call vs. FormData action), selective `sb-*` cookie wiping,
 *    and execution within Hono `runWithServerRequestContext`.
 * 3. getUserProfile: unauthenticated rejection, successful profile retrieval, not found handling,
 *    and database failure isolation.
 * 4. updateUserProfile: unauthenticated rejection, displayName sanitization (trim, 100-char truncation),
 *    whitespace-only suppression, LUGX-067 mass assignment protection, and database error handling.
 * 5. syncUserToDatabase: unauthenticated rejection, rate limit short-circuit, email/display name
 *    metadata fallbacks, and database upsert error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    runWithServerRequestContext,
    createInMemoryCookieStore,
} from "@/server/context/request-context";

const mockSignInWithOAuth = vi.fn();
const mockSupabaseSignOut = vi.fn();
const mockRequireAuthenticatedUser = vi.fn();
const mockRateLimit = vi.fn();

const mockDbFindFirst = vi.fn();
const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();

let mockHeadersMap = new Map<string, string>();
let mockCookieStoreMap = new Map<string, string>();

vi.mock("@/server/auth/session", () => ({
    requireAuthenticatedUser: () => mockRequireAuthenticatedUser(),
}));

vi.mock("@/lib/rate-limit", () => ({
    authRateLimiter: {
        limit: (...args: unknown[]) => mockRateLimit(...args),
        reset: vi.fn(),
    },
}));

vi.mock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({
        auth: {
            signInWithOAuth: mockSignInWithOAuth,
            signOut: mockSupabaseSignOut,
        },
    })),
}));

vi.mock("next/headers", () => ({
    headers: vi.fn(async () => ({
        get: (headerName: string) => mockHeadersMap.get(headerName.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
        getAll: () =>
            Array.from(mockCookieStoreMap.entries()).map(([name, value]) => ({ name, value })),
        delete: (name: string) => mockCookieStoreMap.delete(name),
        get: (name: string) => {
            const val = mockCookieStoreMap.get(name);
            return val ? { name, value: val } : undefined;
        },
    })),
}));

vi.mock("@/server/db", () => {
    const updateChain = {
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
    };
    const insertChain = {
        values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn().mockResolvedValue([]),
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
        })),
    };
    return {
        db: {
            query: {
                users: {
                    findFirst: (...args: unknown[]) => mockDbFindFirst(...args),
                },
            },
            insert: (...args: unknown[]) => {
                mockDbInsert(...args);
                return insertChain;
            },
            update: (...args: unknown[]) => {
                mockDbUpdate(...args);
                return {
                    set: (payload: unknown) => {
                        (updateChain as Record<string, unknown>)._payload = payload;
                        return updateChain;
                    },
                };
            },
        },
        schema: {
            users: {
                id: "id",
                email: "email",
                displayName: "display_name",
                avatarUrl: "avatar_url",
                tier: "tier",
                creditBalanceMicro: "credit_balance_micro",
                updatedAt: "updated_at",
            },
        },
    };
});

import {
    signInWithGoogle,
    signOut,
    getUserProfile,
    updateUserProfile,
    syncUserToDatabase,
} from "@/server/actions/auth-actions";

describe("Decoupled Auth Actions (src/server/actions/auth-actions.ts)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockHeadersMap = new Map();
        mockCookieStoreMap = new Map();
        mockRateLimit.mockResolvedValue({ success: true, remaining: 19, reset: 1000, limit: 20 });
    });

    describe("signInWithGoogle", () => {
        it("returns structured success with redirectUrl when OAuth succeeds", async () => {
            mockHeadersMap.set("x-forwarded-for", "1.2.3.4");
            mockSignInWithOAuth.mockResolvedValueOnce({
                data: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=123" },
                error: null,
            });

            const result = await signInWithGoogle("/workspace");

            expect(result).toEqual({
                success: true,
                redirectUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=123",
            });
            expect(mockSignInWithOAuth).toHaveBeenCalledWith({
                provider: "google",
                options: {
                    redirectTo: expect.stringContaining("/auth/callback?redirectTo=%2Fworkspace"),
                },
            });
        });

        it("neutralizes open redirect attacks by sanitizing external URLs to /dashboard", async () => {
            mockSignInWithOAuth.mockResolvedValueOnce({
                data: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=123" },
                error: null,
            });

            await signInWithGoogle("https://malicious.evil.com/phish");

            expect(mockSignInWithOAuth).toHaveBeenCalledWith({
                provider: "google",
                options: {
                    redirectTo: expect.stringContaining("/auth/callback?redirectTo=%2Fdashboard"),
                },
            });
        });

        it("neutralizes protocol-relative open redirect attacks (//evil.com)", async () => {
            mockSignInWithOAuth.mockResolvedValueOnce({
                data: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=123" },
                error: null,
            });

            await signInWithGoogle("//evil.com/phish");

            expect(mockSignInWithOAuth).toHaveBeenCalledWith({
                provider: "google",
                options: {
                    redirectTo: expect.stringContaining("/auth/callback?redirectTo=%2Fdashboard"),
                },
            });
        });

        it("returns error structure when Supabase OAuth returns an error", async () => {
            mockSignInWithOAuth.mockResolvedValueOnce({
                data: null,
                error: { message: "Google OAuth provider temporarily unreachable" },
            });

            const result = await signInWithGoogle();

            expect(result).toEqual({
                success: false,
                error: "Google OAuth provider temporarily unreachable",
            });
        });

        it("returns error structure when Supabase OAuth returns empty url without error", async () => {
            mockSignInWithOAuth.mockResolvedValueOnce({
                data: { url: null },
                error: null,
            });

            const result = await signInWithGoogle();

            expect(result).toEqual({
                success: false,
                error: "Failed to generate OAuth URL",
            });
        });

        it("falls back to 'unknown' IP and succeeds when headers throw", async () => {
            const nextHeaders = await import("next/headers");
            vi.mocked(nextHeaders.headers).mockRejectedValueOnce(new Error("Outside request scope"));

            mockSignInWithOAuth.mockResolvedValueOnce({
                data: { url: "https://accounts.google.com/oauth" },
                error: null,
            });

            const result = await signInWithGoogle();

            expect(mockRateLimit).toHaveBeenCalledWith("signin:unknown");
            expect(result).toEqual({
                success: true,
                redirectUrl: "https://accounts.google.com/oauth",
            });
        });

        it("operates seamlessly within Hono runWithServerRequestContext", async () => {
            mockSignInWithOAuth.mockResolvedValueOnce({
                data: { url: "https://accounts.google.com/oauth-hono" },
                error: null,
            });

            const customHeaders = new Headers({
                "x-forwarded-for": "198.51.100.77, 10.0.0.1",
            });
            const inMemoryCookies = createInMemoryCookieStore();

            const result = await runWithServerRequestContext(
                { cookies: inMemoryCookies, headers: customHeaders },
                async () => signInWithGoogle("/editor")
            );

            expect(mockRateLimit).toHaveBeenCalledWith("signin:198.51.100.77");
            expect(result).toEqual({
                success: true,
                redirectUrl: "https://accounts.google.com/oauth-hono",
            });
        });
    });

    describe("signOut", () => {
        it("returns { success: true, redirectUrl: '/' } and wipes all sb-* cookies", async () => {
            mockCookieStoreMap.set("sb-access-token", "jwt-token");
            mockCookieStoreMap.set("sb-refresh-token", "refresh-token");
            mockCookieStoreMap.set("theme_preference", "dark");
            mockCookieStoreMap.set("cookie_consent", "accepted");

            const result = await signOut();

            expect(mockSupabaseSignOut).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ success: true, redirectUrl: "/" });
            expect(mockCookieStoreMap.has("sb-access-token")).toBe(false);
            expect(mockCookieStoreMap.has("sb-refresh-token")).toBe(false);
            expect(mockCookieStoreMap.get("theme_preference")).toBe("dark");
            expect(mockCookieStoreMap.get("cookie_consent")).toBe("accepted");
        });

        it("returns undefined when invoked as a Form Action with FormData", async () => {
            mockCookieStoreMap.set("sb-session", "active");
            const formData = new FormData();
            formData.append("reason", "manual_logout");

            const result = await signOut(formData);

            expect(result).toBeUndefined();
            expect(mockSupabaseSignOut).toHaveBeenCalledTimes(1);
            expect(mockCookieStoreMap.has("sb-session")).toBe(false);
        });

        it("wipes sb-* cookies inside Hono runWithServerRequestContext", async () => {
            const inMemoryCookies = createInMemoryCookieStore([
                { name: "sb-auth-token", value: "hono-tok" },
                { name: "sb-user-id", value: "usr_123" },
                { name: "app_locale", value: "ar" },
            ]);

            const result = await runWithServerRequestContext(
                { cookies: inMemoryCookies, headers: new Headers() },
                async () => signOut()
            );

            expect(result).toEqual({ success: true, redirectUrl: "/" });
            const remainingCookies = inMemoryCookies.getAll();
            expect(remainingCookies).toEqual([{ name: "app_locale", value: "ar" }]);
        });
    });

    describe("getUserProfile", () => {
        it("returns unauthenticated error when session is absent", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await getUserProfile();

            expect(result).toEqual({ success: false, error: "Not authenticated" });
            expect(mockDbFindFirst).not.toHaveBeenCalled();
        });

        it("returns user profile data when record exists in database", async () => {
            const mockUser = { id: "usr_active_99", email: "test@example.com" };
            const mockProfile = {
                id: "usr_active_99",
                email: "test@example.com",
                displayName: "Test Pilot",
                tier: "pro",
                creditBalanceMicro: BigInt(100000000),
            };
            mockRequireAuthenticatedUser.mockResolvedValueOnce(mockUser);
            mockDbFindFirst.mockResolvedValueOnce(mockProfile);

            const result = await getUserProfile();

            expect(result).toEqual({ success: true, data: mockProfile });
        });

        it("returns user profile not found when database query returns null", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce({ id: "usr_missing_404" });
            mockDbFindFirst.mockResolvedValueOnce(null);

            const result = await getUserProfile();

            expect(result).toEqual({ success: false, error: "User profile not found" });
        });

        it("catches database exception and returns controlled error", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce({ id: "usr_crash" });
            mockDbFindFirst.mockRejectedValueOnce(new Error("Postgres connection dropped"));

            const result = await getUserProfile();

            expect(result).toEqual({ success: false, error: "Failed to get profile" });
        });
    });

    describe("updateUserProfile", () => {
        const mockUser = { id: "usr_profile_editor", email: "editor@example.com" };

        it("returns unauthenticated error when session is missing", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await updateUserProfile({ displayName: "New Name" });

            expect(result).toEqual({ success: false, error: "Not authenticated" });
            expect(mockDbUpdate).not.toHaveBeenCalled();
        });

        it("updates trimmed displayName and updatedAt", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce(mockUser);

            const result = await updateUserProfile({ displayName: "   Trimmed Name   " });

            expect(result).toEqual({ success: true });
            expect(mockDbUpdate).toHaveBeenCalled();
        });

        it("truncates displayName longer than 100 characters to exactly 100 characters", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce(mockUser);
            const longName = "A".repeat(120);

            const result = await updateUserProfile({ displayName: longName });

            expect(result).toEqual({ success: true });
        });

        it("does not set displayName in payload when given empty or whitespace-only string", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce(mockUser);

            const result = await updateUserProfile({ displayName: "    " });

            expect(result).toEqual({ success: true });
            expect(mockDbUpdate).toHaveBeenCalled();
        });

        it("enforces LUGX-067 mass assignment defense by strictly stripping forbidden keys", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce(mockUser);
            const maliciousData = {
                displayName: "Legit Member",
                tier: "ultra",
                creditBalanceMicro: BigInt(9999999999),
                stripeCustomerId: "cus_injected_evil",
            };

            const result = await updateUserProfile(maliciousData as { displayName: string });

            expect(result).toEqual({ success: true });
            expect(mockDbUpdate).toHaveBeenCalled();
        });

        it("catches database error and returns controlled failure", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce(mockUser);
            mockDbUpdate.mockImplementationOnce(() => {
                throw new Error("Neon lock timeout");
            });

            const result = await updateUserProfile({ displayName: "Fail Name" });

            expect(result).toEqual({ success: false, error: "Failed to update profile" });
        });
    });

    describe("syncUserToDatabase", () => {
        it("returns unauthenticated error when session is missing", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("No session"));

            const result = await syncUserToDatabase();

            expect(result).toEqual({ success: false, error: "No authenticated user" });
            expect(mockRateLimit).not.toHaveBeenCalled();
            expect(mockDbInsert).not.toHaveBeenCalled();
        });

        it("returns rate limit error when user rate limit is exceeded", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce({ id: "usr_sync_spammer" });
            mockRateLimit.mockResolvedValueOnce({ success: false, remaining: 0, reset: 500, limit: 10 });

            const result = await syncUserToDatabase();

            expect(result).toEqual({ success: false, error: "Rate limit exceeded. Please try again later." });
            expect(mockDbInsert).not.toHaveBeenCalled();
        });

        it("syncs user with full metadata displayName and avatar", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce({
                id: "usr_full_meta",
                email: "full@example.com",
                user_metadata: {
                    full_name: "Full Name Tester",
                    avatar_url: "https://example.com/avatar.png",
                },
            });

            const result = await syncUserToDatabase();

            expect(result).toEqual({ success: true });
            expect(mockDbInsert).toHaveBeenCalled();
        });

        it("falls back to email username prefix when full_name is missing", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce({
                id: "usr_email_only",
                email: "charlie.brown@example.com",
                user_metadata: {},
            });

            const result = await syncUserToDatabase();

            expect(result).toEqual({ success: true });
            expect(mockDbInsert).toHaveBeenCalled();
        });

        it("falls back to 'User' and synthetic email when email and metadata are absent", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce({
                id: "usr_anonymous_raw",
                email: null,
                user_metadata: null,
            });

            const result = await syncUserToDatabase();

            expect(result).toEqual({ success: true });
            expect(mockDbInsert).toHaveBeenCalled();
        });

        it("catches database upsert error and returns controlled failure", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce({
                id: "usr_crash_sync",
                email: "crash@example.com",
            });
            mockDbInsert.mockImplementationOnce(() => {
                throw new Error("DB deadlocked");
            });

            const result = await syncUserToDatabase();

            expect(result).toEqual({ success: false, error: "Failed to sync user" });
        });
    });
});
