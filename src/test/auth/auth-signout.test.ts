/**
 * Authentication Sign-Out Test Suite
 *
 * Verifies:
 * 1. signOut() triggers supabase.auth.signOut().
 * 2. Proactively clears all "sb-*" auth cookies from cookieStore.
 * 3. Preserves non-auth cookies (e.g. theme, prefs).
 * 4. Returns { success: true, redirectUrl: "/" }.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithServerRequestContext, type ServerCookieStore } from "@/server/context/request-context";

const mockSignOut = vi.fn();
const mockCookieDelete = vi.fn();

const mockCookies: Array<{ name: string; value: string }> = [];

const mockCookieStore: ServerCookieStore = {
    getAll: () => [...mockCookies],
    set: vi.fn(),
    delete: (name: string) => mockCookieDelete(name),
};

vi.mock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({
        auth: {
            signOut: mockSignOut,
        },
    })),
    getUser: vi.fn(),
}));

import { signOut } from "@/server/actions/auth-actions";

describe("signOut() Cookie Wiping and Structured Redirect", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCookies.length = 0;
    });

    it("wipes all sb-* cookies and returns structured redirect to /", async () => {
        mockCookies.push(
            { name: "sb-access-token", value: "tok_123" },
            { name: "sb-refresh-token", value: "ref_456" },
            { name: "theme_preference", value: "dark" },
            { name: "sb-provider-token", value: "prov_789" }
        );

        const result = await runWithServerRequestContext(
            { cookies: mockCookieStore, headers: new Headers() },
            () => signOut()
        );
        expect(result).toEqual({ success: true, redirectUrl: "/" });

        // 1. Supabase auth.signOut() was invoked
        expect(mockSignOut).toHaveBeenCalledTimes(1);

        // 2. Only sb-* cookies are deleted
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-access-token");
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-refresh-token");
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-provider-token");
        expect(mockCookieDelete).not.toHaveBeenCalledWith("theme_preference");
        expect(mockCookieDelete).toHaveBeenCalledTimes(3);
    });

    it("handles sign-out when no sb-* cookies are present", async () => {
        mockCookies.push({ name: "app_locale", value: "en" });

        const result = await runWithServerRequestContext(
            { cookies: mockCookieStore, headers: new Headers() },
            () => signOut()
        );
        expect(result).toEqual({ success: true, redirectUrl: "/" });

        expect(mockSignOut).toHaveBeenCalledTimes(1);
        expect(mockCookieDelete).not.toHaveBeenCalled();
    });

    it("strictly returns structured redirect even if unexpected arguments are provided (purged FormData overload)", async () => {
        mockCookies.push({ name: "sb-auth-token", value: "token-abc" });

        // Purged overload: passing FormData or arguments should not return void
        const dummyFormData = new FormData();
        dummyFormData.append("action", "signout");

        const result = await runWithServerRequestContext(
            { cookies: mockCookieStore, headers: new Headers() },
            () => (signOut as any)(dummyFormData)
        );

        expect(result).toEqual({ success: true, redirectUrl: "/" });
        expect(result).not.toBeUndefined();
        expect(mockSignOut).toHaveBeenCalledTimes(1);
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-auth-token");
    });

    it("wipes diverse sb-* auth cookies (access, refresh, code-verifier) while preserving non-auth cookies", async () => {
        mockCookies.push(
            { name: "sb-token-12345", value: "val1" },
            { name: "sb-refresh-token", value: "val2" },
            { name: "sb-code-verifier", value: "val3" },
            { name: "theme", value: "dark" },
            { name: "analytics_consent", value: "true" }
        );

        const result = await runWithServerRequestContext(
            { cookies: mockCookieStore, headers: new Headers() },
            () => signOut()
        );

        expect(result).toEqual({ success: true, redirectUrl: "/" });
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-token-12345");
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-refresh-token");
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-code-verifier");
        expect(mockCookieDelete).not.toHaveBeenCalledWith("theme");
        expect(mockCookieDelete).not.toHaveBeenCalledWith("analytics_consent");
        expect(mockCookieDelete).toHaveBeenCalledTimes(3);
    });
});
