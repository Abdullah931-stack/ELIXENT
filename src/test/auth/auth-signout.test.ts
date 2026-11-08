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

    it("handles form action invocation when FormData is passed", async () => {
        mockCookies.push({ name: "sb-access-token", value: "tok_form" });
        const formData = new FormData();

        const result = await runWithServerRequestContext(
            { cookies: mockCookieStore, headers: new Headers() },
            () => signOut(formData)
        );
        expect(result).toBeUndefined();

        expect(mockSignOut).toHaveBeenCalledTimes(1);
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-access-token");
    });
});
