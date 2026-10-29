/**
 * Phase 12: Authentication, OAuth & Open Redirect Hardening Test Suite
 *
 * Verifies:
 * 1. Safe redirect resolution algorithm against all canonical and obfuscated open redirect vectors.
 * 2. Unicode homographs (full-width slashes, small reverse solidus, zero-width spaces).
 * 3. ASCII control characters and null bytes (%00, \x00, CRLF).
 * 4. MAX_URL_LENGTH (2048) and universal backslash rejection.
 * 5. Auth callback route (/auth/callback):
 *    - Rejects open redirect payloads and falls back to /dashboard.
 *    - Rejects untrusted x-forwarded-host headers in favor of canonical trusted origin.
 *    - Handles session exchange success and failure deterministically.
 *    - Resists HTTP Parameter Pollution (HPP).
 */

import { describe, it, test, expect, vi, beforeEach } from "vitest";
import { resolveSafeRedirectPath } from "@/lib/auth/safe-redirect";
import { GET as authCallbackGET } from "@/app/auth/callback/route";
import { NextRequest } from "next/server";

// Mock supabase client and user sync
const mockExchangeCodeForSession = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({
        auth: {
            exchangeCodeForSession: mockExchangeCodeForSession,
        },
    })),
}));

const mockSyncUserToDatabase = vi.fn();
vi.mock("@/server/actions/auth-actions", () => ({
    syncUserToDatabase: () => mockSyncUserToDatabase(),
}));

describe("Phase 12: Safe Redirect Resolution (resolveSafeRedirectPath)", () => {
    describe("Valid Internal Routes", () => {
        test.each([
            "/dashboard",
            "/workspace",
            "/account",
            "/workspace/editor/doc-123",
        ])("allows standard internal path: %s", (path) => {
            expect(resolveSafeRedirectPath(path)).toBe(path);
        });

        test.each([
            ["/workspace?tab=recent", "/workspace?tab=recent"],
            ["/workspace/editor/123?view=split#section-2", "/workspace/editor/123?view=split#section-2"],
        ])("preserves query parameters and fragments on valid internal path: %s", (input, expected) => {
            expect(resolveSafeRedirectPath(input)).toBe(expected);
        });

        test.each([
            [null, "/workspace", "/workspace"],
            ["https://evil.com", "/workspace", "/workspace"],
        ])("respects custom valid defaultPath fallback (%s -> %s)", (input, fallback, expected) => {
            expect(resolveSafeRedirectPath(input, fallback)).toBe(expected);
        });
    });

    describe("Empty, Null, and Falsy Inputs", () => {
        test.each([
            [null, "null"],
            [undefined, "undefined"],
            ["", "empty string"],
            ["   ", "spaces"],
            ["\t\n\r", "whitespace control chars"],
        ])("returns /dashboard for falsy or whitespace input (%s)", (input, _label) => {
            expect(resolveSafeRedirectPath(input)).toBe("/dashboard");
        });

        test.each([
            "dashboard",
            "workspace/editor",
            "www.google.com",
        ])("returns /dashboard if target is not a relative path starting with slash: %s", (target) => {
            expect(resolveSafeRedirectPath(target)).toBe("/dashboard");
        });
    });

    describe("Open Redirect & Protocol-Relative Attack Vectors", () => {
        test.each([
            "https://evil.com",
            "http://evil.com",
            "https://evil.com/dashboard",
            "http://attacker.com/workspace",
        ])("blocks standard external absolute URL: %s", (url) => {
            expect(resolveSafeRedirectPath(url)).toBe("/dashboard");
        });

        test.each([
            "//evil.com",
            "//evil.com/path",
            "///evil.com",
            "////evil.com",
        ])("blocks protocol-relative URL: %s", (url) => {
            expect(resolveSafeRedirectPath(url)).toBe("/dashboard");
        });

        test.each([
            "/\\evil.com",
            "\\evil.com",
            "\\\\evil.com",
            "/\\\\evil.com",
            "/foo\\bar",
            "/workspace\\editor\\doc",
            "/sub\\..\\..\\evil.com",
        ])("blocks backslash in any position: %s", (path) => {
            expect(resolveSafeRedirectPath(path)).toBe("/dashboard");
        });

        test.each([
            "/%2F%2Fevil.com",
            "/%2f%2fevil.com",
            "/%5Cevil.com",
            "/%5c%5cevil.com",
            "/%252F%252Fevil.com",
        ])("blocks URL-encoded slashes and bypasses: %s", (path) => {
            expect(resolveSafeRedirectPath(path)).toBe("/dashboard");
        });

        test.each([
            "javascript:alert(1)",
            "/javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "/data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "/vbscript:msgbox(1)",
            "blob:http://localhost/uuid",
            "mailto:attacker@evil.com",
            "/mailto:attacker@evil.com",
            "tel:+1234567890",
            "/tel:+1234567890",
            "sms:+1234567890",
            "/sms:+1234567890",
            "urn:isbn:0-486-27557-4",
            "/urn:isbn:0-486-27557-4",
        ])("blocks pseudo-protocol and script schemes: %s", (scheme) => {
            expect(resolveSafeRedirectPath(scheme)).toBe("/dashboard");
        });
    });

    describe("Adversarial Evasion: Unicode Homographs, Control Chars, Null Bytes & Max Length", () => {
        test.each([
            "\uFF0F\uFF0Fevil.com",
            "/\uFF0Fevil.com",
            "\uFF3C\uFF3Cevil.com",
            "/\uFE68evil.com",
        ])("blocks Unicode slash homographs: %s", (payload) => {
            expect(resolveSafeRedirectPath(payload)).toBe("/dashboard");
        });

        test.each([
            "/\u200B/evil.com",
            "/\uFEFF/evil.com",
            "/\u200D/evil.com",
        ])("blocks zero-width spaces and invisible characters: %s", (payload) => {
            expect(resolveSafeRedirectPath(payload)).toBe("/dashboard");
        });

        test.each([
            "/%00//evil.com",
            "/\x00//evil.com",
            "/%0d%0a/evil.com",
            "/\r\n//evil.com",
        ])("blocks null bytes and control character injection: %s", (payload) => {
            expect(resolveSafeRedirectPath(payload)).toBe("/dashboard");
        });

        it("enforces MAX_URL_LENGTH (2048) to prevent ReDoS / CPU exhaustion", () => {
            const massiveUrl = `/workspace?param=${"x".repeat(3000)}`;
            expect(resolveSafeRedirectPath(massiveUrl)).toBe("/dashboard");
        });
    });
});

describe("Phase 12: Auth Callback Handler (/auth/callback)", () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...ORIGINAL_ENV };
        process.env.NEXT_PUBLIC_APP_URL = "https://app.lugx.com";
    });

    it("redirects to safe validated path upon successful OAuth code exchange", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=/workspace/editor/doc-abc");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307); // NextResponse.redirect default status
        expect(res.headers.get("location")).toBe("https://app.lugx.com/workspace/editor/doc-abc");
        expect(mockExchangeCodeForSession).toHaveBeenCalledWith("auth_code_123");
        expect(mockSyncUserToDatabase).toHaveBeenCalled();
    });

    it("sanitizes open redirect target to /dashboard upon successful code exchange", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=https://evil.com/steal-session");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/dashboard");
    });

    it("sanitizes encoded protocol-relative payload to /dashboard", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=/%2F%2Fattacker.com");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/dashboard");
    });

    it("rejects untrusted x-forwarded-host and anchors redirect to NEXT_PUBLIC_APP_URL", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=/dashboard", {
            headers: {
                "x-forwarded-host": "attacker-spoofed-host.com",
            },
        });
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        // Location MUST be on trusted NEXT_PUBLIC_APP_URL, NOT attacker-spoofed-host.com
        expect(res.headers.get("location")).toBe("https://app.lugx.com/dashboard");
    });

    it("redirects to login error page when exchangeCodeForSession fails", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: { message: "Invalid auth code" } });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=invalid_code&redirectTo=/workspace");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/login?error=auth_failed");
    });

    it("redirects to login error page when code parameter is missing", async () => {
        const req = new NextRequest("https://app.lugx.com/auth/callback?redirectTo=/workspace");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/login?error=auth_failed");
        expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    });

    it("resists HTTP Parameter Pollution (HPP) when duplicate redirectTo params are supplied", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=/workspace&redirectTo=https://evil.com");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/workspace");
    });
});
