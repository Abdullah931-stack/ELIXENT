/**
 * Unit Test Suite: Auth Actions Rate Limiting Enforcement
 *
 * Verifies:
 * 1. signInWithGoogle enforces authRateLimiter on client IP (`signin:${ip}`).
 * 2. signInWithGoogle short-circuits with error when rate limit is exceeded.
 * 3. syncUserToDatabase enforces authRateLimiter on authenticated user ID (`sync:${user.id}`).
 * 4. syncUserToDatabase short-circuits with error and halts DB mutations when rate limit is exceeded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSignInWithOAuth = vi.fn();
const mockRedirect = vi.fn();
const mockDbInsert = vi.fn();
const mockRateLimit = vi.fn();
const mockRequireAuthenticatedUser = vi.fn();

let mockHeadersMap = new Map<string, string>();

vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        mockRedirect(url);
        throw new Error(`NEXT_REDIRECT:${url}`);
    },
}));

vi.mock("next/cache", () => ({
    revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({
    headers: vi.fn(async () => ({
        get: (headerName: string) => mockHeadersMap.get(headerName.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
        getAll: () => [],
        delete: vi.fn(),
    })),
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
        },
    })),
}));

vi.mock("@/server/auth/session", () => ({
    requireAuthenticatedUser: () => mockRequireAuthenticatedUser(),
}));

vi.mock("@/server/db", () => {
    const chain = {
        values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn().mockResolvedValue([]),
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
        })),
    };
    return {
        db: {
            insert: (...args: unknown[]) => {
                mockDbInsert(...args);
                return chain;
            },
        },
        schema: {
            users: { id: "id", email: "email", displayName: "displayName", avatarUrl: "avatarUrl" },
        },
    };
});

import { signInWithGoogle, syncUserToDatabase } from "@/server/actions/auth-actions";

describe("Auth Actions Rate Limiting", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockHeadersMap = new Map<string, string>();
    });

    describe("signInWithGoogle", () => {
        it("rejects request and returns controlled error when IP rate limit is exceeded", async () => {
            mockHeadersMap.set("x-forwarded-for", "203.0.113.195, 10.0.0.1");
            mockRateLimit.mockResolvedValueOnce({
                success: false,
                remaining: 0,
                reset: Math.ceil(Date.now() / 1000) + 900,
                limit: 20,
            });

            const result = await signInWithGoogle("/workspace");

            expect(mockRateLimit).toHaveBeenCalledWith("signin:203.0.113.195");
            expect(result).toEqual({ error: "Rate limit exceeded. Please try again later." });
            expect(mockSignInWithOAuth).not.toHaveBeenCalled();
            expect(mockRedirect).not.toHaveBeenCalled();
        });

        it("extracts x-real-ip when x-forwarded-for is missing", async () => {
            mockHeadersMap.set("x-real-ip", "198.51.100.42");
            mockRateLimit.mockResolvedValueOnce({
                success: false,
                remaining: 0,
                reset: 1000,
                limit: 20,
            });

            const result = await signInWithGoogle();

            expect(mockRateLimit).toHaveBeenCalledWith("signin:198.51.100.42");
            expect(result).toEqual({ error: "Rate limit exceeded. Please try again later." });
        });

        it("proceeds to OAuth flow when rate limit check passes", async () => {
            mockHeadersMap.set("x-forwarded-for", "192.0.2.1");
            mockRateLimit.mockResolvedValueOnce({
                success: true,
                remaining: 19,
                reset: Math.ceil(Date.now() / 1000) + 900,
                limit: 20,
            });
            mockSignInWithOAuth.mockResolvedValueOnce({
                data: { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" },
                error: null,
            });

            await expect(signInWithGoogle("/dashboard")).rejects.toThrow("NEXT_REDIRECT:https://accounts.google.com");
            expect(mockRateLimit).toHaveBeenCalledWith("signin:192.0.2.1");
            expect(mockSignInWithOAuth).toHaveBeenCalled();
            expect(mockRedirect).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=test");
        });
    });

    describe("syncUserToDatabase", () => {
        const testUser = {
            id: "user-sync-test-uuid",
            email: "sync-rate@example.com",
            user_metadata: { full_name: "Sync Tester" },
        };

        it("rejects sync and halts DB mutations when user rate limit is exceeded", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce(testUser);
            mockRateLimit.mockResolvedValueOnce({
                success: false,
                remaining: 0,
                reset: Math.ceil(Date.now() / 1000) + 900,
                limit: 20,
            });

            const result = await syncUserToDatabase();

            expect(mockRequireAuthenticatedUser).toHaveBeenCalled();
            expect(mockRateLimit).toHaveBeenCalledWith(`sync:${testUser.id}`);
            expect(result).toEqual({
                success: false,
                error: "Rate limit exceeded. Please try again later.",
            });
            expect(mockDbInsert).not.toHaveBeenCalled();
        });

        it("proceeds with database upsert when rate limit check passes", async () => {
            mockRequireAuthenticatedUser.mockResolvedValueOnce(testUser);
            mockRateLimit.mockResolvedValueOnce({
                success: true,
                remaining: 19,
                reset: Math.ceil(Date.now() / 1000) + 900,
                limit: 20,
            });

            const result = await syncUserToDatabase();

            expect(mockRequireAuthenticatedUser).toHaveBeenCalled();
            expect(mockRateLimit).toHaveBeenCalledWith(`sync:${testUser.id}`);
            expect(mockDbInsert).toHaveBeenCalled();
            expect(result).toEqual({ success: true });
        });

        it("returns unauthenticated error without invoking rate limiter if session is missing", async () => {
            mockRequireAuthenticatedUser.mockRejectedValueOnce(new Error("Unauthorized"));

            const result = await syncUserToDatabase();

            expect(result).toEqual({
                success: false,
                error: "No authenticated user",
            });
            expect(mockRateLimit).not.toHaveBeenCalled();
            expect(mockDbInsert).not.toHaveBeenCalled();
        });
    });
});
