/**
 * Comprehensive Test Suite for Web-Standard Session Middleware
 *
 * Verifies:
 * 1. `handleSessionProxy` with standard Web Request and Response objects:
 *    - OAuth code redirection on `/` and `/login` (307 to `/auth/callback` preserving query params and cookies).
 *    - Fast-Path Cookie Gate (`TD-12`): `getUser()` bypassed on public routes and on `/login` when no `sb-*` cookie exists.
 *    - Watchdog timeout (`AbortSignal.timeout(2500)`) and offline network error handling with `console.warn`.
 *    - Protected route gating (`/workspace`, `/account`, `/dashboard`): 401 JSON for mutations (`POST`/`PUT`/`PATCH`/`DELETE`), `Accept: application/json`, or `/api/*`; 303 See Other redirect for safe page navigations (`GET`/`HEAD`).
 *    - Static asset fast-path (`/assets/*`, `/favicon.ico`, `/robots.txt`, non-API static extensions) bypassing `createServerClient` and cookie cloning.
 *    - Credential Fail-Fast (`DEF-A04`): placeholder fallback restricted strictly to test runtimes.
 *    - Authenticated user visiting `/login` redirected to `/dashboard` (307).
 *    - Cookie serialization and `Set-Cookie` header generation on redirects, 401, and 200 responses.
 *    - Web standard Set-Cookie response header serialization and incoming cookie parsing.
 * 2. `sessionMiddleware` mounted on Hono (`new Hono()`):
 *    - Pass-through execution with downstream route handlers.
 *    - Context binding (`runWithServerRequestContext`) accessible to downstream handlers via `getActiveRequestContext()` and `resolveCookiesAndHeaders()`.
 *    - Mutated cookie propagation from downstream handlers to `c.res.headers`.
 *    - Direct intercept and short-circuit on unauthorized access, OAuth redirection, and logged-in user visits to `/login`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createServerClient } from "@supabase/ssr";
import {
  handleSessionProxy,
  sessionMiddleware,
} from "@/server/middleware/session-middleware";
import {
  getActiveRequestContext,
  resolveCookiesAndHeaders,
} from "@/server/context/request-context";

// Hoisted state for mocking `@supabase/ssr` `createServerClient`
const { mockState } = vi.hoisted(() => ({
  mockState: {
    getUser: vi.fn(),
    setCookiesOnCreate: false,
    mockCookiesToSet: [] as Array<{
      name: string;
      value: string;
      options?: Record<string, unknown>;
    }>,
  },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: any) => {
    if (options?.cookies?.getAll) {
      options.cookies.getAll();
    }
    if (mockState.setCookiesOnCreate && options?.cookies?.setAll) {
      options.cookies.setAll(mockState.mockCookiesToSet);
    }
    return {
      auth: {
        getUser: mockState.getUser,
      },
    };
  }),
}));

describe("Hono Web-Standard Session Middleware (src/server/middleware/session-middleware.ts)", () => {
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
    restoreProcessEnv();
    mockState.setCookiesOnCreate = false;
    mockState.mockCookiesToSet = [];
    process.env.VITE_SUPABASE_URL = "https://mock-supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "mock-anon-key";
  });

  afterEach(() => {
    restoreProcessEnv();
  });

  describe("handleSessionProxy — Standalone Web Standard Handler", () => {
    describe("OAuth Code Interception (LUGX-140)", () => {
      it("redirects request with code parameter on root (/) to /auth/callback preserving query params", async () => {
        const req = new Request("https://lugx.app/?code=oauth-sample-code");
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe(
          "https://lugx.app/auth/callback?code=oauth-sample-code"
        );
      });

      it("redirects request with code parameter on /login preserving all query params", async () => {
        const req = new Request(
          "https://lugx.app/login?code=oauth-code-456&state=state_abc&prompt=consent"
        );
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe(
          "https://lugx.app/auth/callback?code=oauth-code-456&state=state_abc&prompt=consent"
        );
      });

      it("does not intercept OAuth code if already on /auth/callback", async () => {
        const req = new Request("https://lugx.app/auth/callback?code=oauth-sample-code");
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(200);
        expect(mockState.getUser).not.toHaveBeenCalled();
      });

      it("does not intercept OAuth code if on an arbitrary non-landing route", async () => {
        const req = new Request("https://lugx.app/pricing?code=oauth-sample-code");
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(200);
        expect(mockState.getUser).not.toHaveBeenCalled();
      });

      it("propagates mutated cookies through OAuth 307 redirect", async () => {
        mockState.setCookiesOnCreate = true;
        mockState.mockCookiesToSet = [
          {
            name: "sb-oauth-state",
            value: "state_val_789",
            options: { path: "/", httpOnly: true, secure: true },
          },
        ];

        const req = new Request("https://lugx.app/?code=oauth-sample-code");
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe(
          "https://lugx.app/auth/callback?code=oauth-sample-code"
        );
        expect(res.headers.get("set-cookie")).toContain("sb-oauth-state=state_val_789");
      });
    });

    describe("Fast-Path Cookie Gate (TD-12)", () => {
      it("bypasses getUser on public homepage when no auth cookies exist", async () => {
        const req = new Request("https://lugx.app/");
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(200);
        expect(mockState.getUser).not.toHaveBeenCalled();
      });

      it("bypasses getUser on public homepage even when auth cookies exist", async () => {
        const req = new Request("https://lugx.app/", {
          headers: {
            cookie: "sb-access-token=dummy_token",
          },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(200);
        expect(mockState.getUser).not.toHaveBeenCalled();
      });

      it.each(["/pricing", "/about", "/terms", "/blog/first-post"])(
        "bypasses getUser on public route %s",
        async (publicPath) => {
          const req = new Request(`https://lugx.app${publicPath}`);
          const res = await handleSessionProxy(req);

          expect(res.status).toBe(200);
          expect(mockState.getUser).not.toHaveBeenCalled();
        }
      );

      it("bypasses getUser on /login when no sb-* cookie exists", async () => {
        const req = new Request("https://lugx.app/login");
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(200);
        expect(mockState.getUser).not.toHaveBeenCalled();
      });

      it("bypasses getUser on /login when non-auth cookies exist", async () => {
        const req = new Request("https://lugx.app/login", {
          headers: {
            cookie: "theme=dark; guest_session=g123",
          },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(200);
        expect(mockState.getUser).not.toHaveBeenCalled();
      });

      it("triggers getUser on /login when an sb-* cookie exists", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request("https://lugx.app/login", {
          headers: {
            cookie: "sb-access-token=session_jwt",
          },
        });
        const res = await handleSessionProxy(req);

        expect(mockState.getUser).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(200);
      });
    });

    describe("Watchdog Timeout & Offline Network Error Handling", () => {
      it("handles getUser watchdog timeout gracefully without hanging indefinitely", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        mockState.getUser.mockImplementationOnce(
          () => new Promise((resolve) => setTimeout(resolve, 5000))
        );

        vi.useFakeTimers();
        try {
          const req = new Request("https://lugx.app/workspace");
          const proxyPromise = handleSessionProxy(req);

          await vi.advanceTimersByTimeAsync(2600);

          const res = await proxyPromise;

          expect(warnSpy).toHaveBeenCalledWith(
            "[Proxy] supabase.auth.getUser error (network/offline):",
            expect.objectContaining({
              message: expect.stringContaining("watchdog timeout"),
            })
          );
          expect(res.status).toBe(303);
          expect(res.headers.get("location")).toBe(
            "https://lugx.app/login?redirectTo=%2Fworkspace"
          );
        } finally {
          vi.useRealTimers();
          warnSpy.mockRestore();
        }
      });

      it("handles Supabase network/offline errors gracefully without crashing", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        mockState.getUser.mockRejectedValueOnce(
          new Error("Supabase Network Connection Timeout")
        );

        const req = new Request("https://lugx.app/workspace");
        const res = await handleSessionProxy(req);

        expect(warnSpy).toHaveBeenCalledWith(
          "[Proxy] supabase.auth.getUser error (network/offline):",
          expect.any(Error)
        );
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(
          "https://lugx.app/login?redirectTo=%2Fworkspace"
        );

        warnSpy.mockRestore();
      });
    });

    describe("Protected Route Gating & Deep Link Preservation", () => {
      it.each(["/workspace", "/dashboard", "/account"])(
        "redirects unauthenticated visitor from %s to /login with redirectTo",
        async (protectedPath) => {
          mockState.getUser.mockResolvedValueOnce({
            data: { user: null },
            error: null,
          });

          const req = new Request(`https://lugx.app${protectedPath}`);
          const res = await handleSessionProxy(req);

          expect(res.status).toBe(303);
          expect(res.headers.get("location")).toBe(
            `https://lugx.app/login?redirectTo=${encodeURIComponent(protectedPath)}`
          );
        }
      );

      it("preserves nested subpaths and query parameters inside redirectTo on login redirect", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request(
          "https://lugx.app/workspace/editor/doc-99?tab=recent&view=split"
        );
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(
          "https://lugx.app/login?redirectTo=%2Fworkspace%2Feditor%2Fdoc-99%3Ftab%3Drecent%26view%3Dsplit"
        );
      });

      it("returns JSON 401 Unauthorized for unauthenticated requests with Accept: application/json header on protected routes", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request("https://lugx.app/workspace", {
          headers: {
            Accept: "application/json",
          },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(401);
        expect(res.headers.get("Content-Type")).toBe("application/json");
        const body = await res.json();
        expect(body).toEqual({ error: "Unauthorized" });
      });

      it("returns JSON 401 Unauthorized for unauthenticated subpath requests carrying accept: application/json header", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request("https://lugx.app/workspace/api/save", {
          headers: { accept: "application/json, text/plain, */*" },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body).toEqual({ error: "Unauthorized" });
      });

      it("redirects unauthenticated HTML navigation requests on protected subpaths to login (303)", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request("https://lugx.app/workspace/editor/doc-1", {
          headers: { accept: "text/html,application/xhtml+xml" },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(303);
      });

      describe("RFC 9110 Content Negotiation & Next.js Action Header Purge Matrix", () => {
        it("redirects unauthenticated GET request carrying legacy Next.js 'next-action' header to login with 303 when Accept is HTML", async () => {
          mockState.getUser.mockResolvedValueOnce({
            data: { user: null },
            error: null,
          });

          const req = new Request("https://lugx.app/workspace", {
            headers: {
              "next-action": "legacy_server_action_hash_123",
              accept: "text/html,application/xhtml+xml",
            },
          });
          const res = await handleSessionProxy(req);

          // With next-action purged, safe GET content negotiation falls through to 303 page navigation redirect
          expect(res.status).toBe(303);
          expect(res.headers.get("location")).toBe(
            "https://lugx.app/login?redirectTo=%2Fworkspace"
          );
        });

        it("returns JSON 401 for request carrying legacy Next.js 'next-action' header when Accept is application/json", async () => {
          mockState.getUser.mockResolvedValueOnce({
            data: { user: null },
            error: null,
          });

          const req = new Request("https://lugx.app/workspace", {
            headers: {
              "next-action": "legacy_server_action_hash_123",
              accept: "application/json",
            },
          });
          const res = await handleSessionProxy(req);

          expect(res.status).toBe(401);
          expect(res.headers.get("Content-Type")).toBe("application/json");
          const body = await res.json();
          expect(body).toEqual({ error: "Unauthorized" });
        });

        it.each([
          {
            accept: "application/json; charset=utf-8",
            expectedStatus: 401,
            desc: "parameterized application/json",
          },
          {
            accept: "application/json, text/plain, */*",
            expectedStatus: 401,
            desc: "compound media range with application/json",
          },
          {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            expectedStatus: 303,
            desc: "standard browser HTML Accept header",
          },
          {
            accept: "*/*",
            expectedStatus: 303,
            desc: "wildcard Accept header without explicit json",
          },
          {
            accept: "text/plain",
            expectedStatus: 303,
            desc: "text/plain non-json Accept header",
          },
          {
            accept: "",
            expectedStatus: 303,
            desc: "empty string Accept header",
          },
        ])(
          "evaluates RFC 9110 content negotiation for $desc on protected route",
          async ({ accept, expectedStatus }) => {
            mockState.getUser.mockResolvedValueOnce({
              data: { user: null },
              error: null,
            });

            const req = new Request("https://lugx.app/workspace", {
              headers: accept ? { accept } : {},
            });
            const res = await handleSessionProxy(req);

            expect(res.status).toBe(expectedStatus);
            if (expectedStatus === 401) {
              expect(res.headers.get("Content-Type")).toBe("application/json");
              const body = await res.json();
              expect(body).toEqual({ error: "Unauthorized" });
            } else {
              expect(res.headers.get("location")).toBe(
                "https://lugx.app/login?redirectTo=%2Fworkspace"
              );
            }
          }
        );
      });
    });

    describe("Authenticated User Navigation", () => {
      it.each(["/workspace", "/dashboard", "/account"])(
        "allows authenticated user to access %s",
        async (protectedPath) => {
          mockState.getUser.mockResolvedValueOnce({
            data: { user: { id: "usr_123", email: "user@example.com" } },
            error: null,
          });

          const req = new Request(`https://lugx.app${protectedPath}`);
          const res = await handleSessionProxy(req);

          expect(res.status).toBe(200);
        }
      );

      it("redirects authenticated user accessing /login to /dashboard", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: { id: "usr_123", email: "user@example.com" } },
          error: null,
        });

        const req = new Request("https://lugx.app/login?returnTo=/somewhere", {
          headers: {
            cookie: "sb-auth=jwt",
          },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://lugx.app/dashboard");
      });
    });

    describe("Cookie Serialization & Web Headers", () => {
      it("propagates Set-Cookie headers on redirect responses", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });
        mockState.setCookiesOnCreate = true;
        mockState.mockCookiesToSet = [
          {
            name: "sb-refresh-token",
            value: "new_ref_token",
            options: {
              path: "/",
              httpOnly: true,
              secure: true,
              maxAge: 3600,
              domain: "lugx.app",
              sameSite: "lax",
            },
          },
        ];

        const req = new Request("https://lugx.app/workspace");
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(303);
        const setCookie = res.headers.get("set-cookie");
        expect(setCookie).toContain("sb-refresh-token=new_ref_token");
        expect(setCookie).toContain("Max-Age=3600");
        expect(setCookie).toContain("Path=/");
        expect(setCookie).toContain("Domain=lugx.app");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("Secure");
        expect(setCookie).toContain("SameSite=Lax");
      });

      it("propagates Set-Cookie headers on 401 unauthorized responses", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });
        mockState.setCookiesOnCreate = true;
        mockState.mockCookiesToSet = [
          {
            name: "sb-cleared",
            value: "",
            options: { path: "/", maxAge: 0 },
          },
        ];

        const req = new Request("https://lugx.app/workspace", {
          headers: { Accept: "application/json" },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(401);
        expect(res.headers.get("set-cookie")).toContain("sb-cleared=; Max-Age=0; Path=/");
      });

      it("propagates mutated cookies into Set-Cookie headers on 200 responses", async () => {
        mockState.setCookiesOnCreate = true;
        mockState.mockCookiesToSet = [
          { name: "mutated_cookie", value: "mutated_val" },
          { name: "theme", value: "light" }, // Overrides incoming theme
        ];

        const req = new Request("https://lugx.app/", {
          headers: {
            cookie: "theme=dark; session_tag=stag_99",
          },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(200);
        const setCookies = res.headers.get("set-cookie");
        expect(setCookies).toContain("mutated_cookie=mutated_val");
        expect(setCookies).toContain("theme=light");
      });

      it("serializes multiple Set-Cookie options including path, httpOnly, secure, and maxAge", async () => {
        mockState.setCookiesOnCreate = true;
        mockState.mockCookiesToSet = [
          {
            name: "client_exp",
            value: "val_exp",
            options: { path: "/app", secure: true },
          },
          {
            name: "client_flag",
            value: "enabled",
            options: { httpOnly: true },
          },
          {
            name: "old_cookie",
            value: "",
            options: { maxAge: 0, path: "/" },
          },
        ];

        const req = new Request("https://lugx.app/");
        const res = await handleSessionProxy(req);

        const setCookies = res.headers.get("set-cookie");
        expect(setCookies).toContain("client_exp=val_exp; Path=/app; Secure");
        expect(setCookies).toContain("client_flag=enabled; HttpOnly");
        expect(setCookies).toContain("old_cookie=; Max-Age=0; Path=/");
      });

      it("serializes SameSite variants correctly (Strict, None, Lax)", async () => {
        mockState.setCookiesOnCreate = true;
        mockState.mockCookiesToSet = [
          { name: "c_strict", value: "1", options: { sameSite: "strict" } },
          { name: "c_none", value: "2", options: { sameSite: "NONE" } },
          { name: "c_lax", value: "3", options: { sameSite: "Lax" } },
        ];

        const req = new Request("https://lugx.app/");
        const res = await handleSessionProxy(req);

        const setCookies = res.headers.get("set-cookie");
        expect(setCookies).toContain("c_strict=1; SameSite=Strict");
        expect(setCookies).toContain("c_none=2; SameSite=None");
        expect(setCookies).toContain("c_lax=3; SameSite=Lax");
      });

      it("serializes Date and timestamp expires options correctly and ignores invalid dates", async () => {
        const fixedDate = new Date("2035-12-31T23:59:59.000Z");
        mockState.setCookiesOnCreate = true;
        mockState.mockCookiesToSet = [
          { name: "c_date", value: "v1", options: { expires: fixedDate } },
          { name: "c_time", value: "v2", options: { expires: fixedDate.getTime() } },
          { name: "c_invalid", value: "v3", options: { expires: "not-a-valid-date" } },
        ];

        const req = new Request("https://lugx.app/");
        const res = await handleSessionProxy(req);

        const setCookies = res.headers.get("set-cookie");
        expect(setCookies).toContain(`c_date=v1; Expires=${fixedDate.toUTCString()}`);
        expect(setCookies).toContain(`c_time=v2; Expires=${fixedDate.toUTCString()}`);
        expect(setCookies).toContain("c_invalid=v3");
        expect(setCookies).not.toContain("Expires=Invalid Date");
      });

      it("parses cookies robustly with messy whitespace and missing values into request context", async () => {
        const app = new Hono();
        app.use("*", sessionMiddleware);
        let capturedCookies: Array<{ name: string; value: string }> = [];
        app.get("/", (c) => {
          capturedCookies = getActiveRequestContext()?.cookies.getAll() ?? [];
          return c.text("ok");
        });

        await app.request("https://lugx.app/", {
          headers: {
            cookie: "  ; key1=val1 ; ; key2= ; key3 ; key4=val4=extra ; ",
          },
        });

        const cookieMap = new Map(capturedCookies.map((c) => [c.name, c.value]));
        expect(cookieMap.get("key1")).toBe("val1");
        expect(cookieMap.get("key2")).toBe("");
        expect(cookieMap.get("key4")).toBe("val4=extra");
      });

      it("relies strictly on standard request headers and ignores artificial request.cookies properties", async () => {
        const app = new Hono();
        app.use("*", sessionMiddleware);
        let capturedCookies: Array<{ name: string; value: string }> = [];
        app.get("/", (c) => {
          capturedCookies = getActiveRequestContext()?.cookies.getAll() ?? [];
          return c.text("ok");
        });

        const req = new Request("https://lugx.app/", {
          headers: { cookie: "fallback_token=ok" },
        });
        const throwingGetter = vi.fn(() => {
          throw new Error("Legacy request.cookies shim should not be accessed");
        });
        Object.defineProperty(req, "cookies", {
          get: throwingGetter,
        });

        const res = await app.request(req);
        expect(res.status).toBe(200);
        expect(throwingGetter).not.toHaveBeenCalled();
        expect(capturedCookies).toEqual(
          expect.arrayContaining([{ name: "fallback_token", value: "ok" }])
        );
      });
    });
  });

  describe("sessionMiddleware — Mounted on Hono Application", () => {
    it("allows request to pass through to downstream handlers with 200 OK", async () => {
      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.get("/public-route", (c) => c.text("hello from downstream"));

      const res = await app.request("https://lugx.app/public-route");

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello from downstream");
    });

    it("binds AsyncLocalStorage ServerRequestContext accessible to downstream route handlers", async () => {
      const app = new Hono();
      app.use("*", sessionMiddleware);

      let capturedContext = null;
      let capturedCookiesAndHeaders = null;

      app.get("/workspace/check-context", async (c) => {
        capturedContext = getActiveRequestContext();
        capturedCookiesAndHeaders = await resolveCookiesAndHeaders();
        return c.json({ contextBound: !!capturedContext });
      });

      mockState.getUser.mockResolvedValueOnce({
        data: { user: { id: "usr_context_test" } },
        error: null,
      });

      const res = await app.request("https://lugx.app/workspace/check-context", {
        headers: {
          "x-custom-tenant": "tenant-zeta",
          cookie: "sb-auth=active_token; theme=nord",
        },
      });

      expect(res.status).toBe(200);
      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.headers.get("x-custom-tenant")).toBe("tenant-zeta");
      expect(capturedContext!.cookies.getAll()).toEqual(
        expect.arrayContaining([
          { name: "sb-auth", value: "active_token" },
          { name: "theme", value: "nord" },
        ])
      );
      expect(capturedCookiesAndHeaders).toEqual(capturedContext);
    });

    it("propagates cookies mutated inside downstream handlers to outgoing response headers", async () => {
      const app = new Hono();
      app.use("*", sessionMiddleware);

      app.post("/api/settings/theme", async (c) => {
        const ctx = getActiveRequestContext();
        ctx?.cookies.set("user_theme", "dracula", {
          path: "/",
          httpOnly: true,
          maxAge: 86400,
        });
        return c.json({ updated: true });
      });

      const res = await app.request("https://lugx.app/api/settings/theme", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("user_theme=dracula");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Max-Age=86400");
    });

    it("short-circuits downstream handlers when unauthenticated user requests protected page", async () => {
      const downstreamSpy = vi.fn((c) => c.text("should-not-reach"));
      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.get("/workspace", downstreamSpy);

      mockState.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: null,
      });

      const res = await app.request("https://lugx.app/workspace");

      expect(downstreamSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        "https://lugx.app/login?redirectTo=%2Fworkspace"
      );
    });

    it("short-circuits downstream handlers when unauthenticated user sends Accept: application/json request", async () => {
      const downstreamSpy = vi.fn((c) => c.text("should-not-reach"));
      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.post("/workspace", downstreamSpy);

      mockState.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: null,
      });

      const res = await app.request("https://lugx.app/workspace", {
        method: "POST",
        headers: { Accept: "application/json" },
      });

      expect(downstreamSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
    });

    it("short-circuits downstream handlers when OAuth landing code arrives on root", async () => {
      const downstreamSpy = vi.fn((c) => c.text("should-not-reach"));
      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.get("/", downstreamSpy);

      const res = await app.request("https://lugx.app/?code=oauth-hono-code");

      expect(downstreamSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(
        "https://lugx.app/auth/callback?code=oauth-hono-code"
      );
    });

    it("short-circuits downstream handlers and redirects authenticated user away from /login to /dashboard", async () => {
      const downstreamSpy = vi.fn((c) => c.text("login-page"));
      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.get("/login", downstreamSpy);

      mockState.getUser.mockResolvedValueOnce({
        data: { user: { id: "usr_auth_hono" } },
        error: null,
      });

      const res = await app.request("https://lugx.app/login", {
        headers: { cookie: "sb-auth=token" },
      });

      expect(downstreamSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("https://lugx.app/dashboard");
    });

    it("short-circuits downstream handlers and returns 401 JSON for unauthenticated POST mutation even when Accept is text/html and next-action is set", async () => {
      const downstreamSpy = vi.fn((c) => c.text("secret-page"));
      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.post("/workspace", downstreamSpy);

      mockState.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: null,
      });

      const res = await app.request("https://lugx.app/workspace", {
        method: "POST",
        headers: {
          "next-action": "legacy_action_hash",
          accept: "text/html",
        },
      });

      expect(downstreamSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    });

    it("short-circuits downstream handlers and returns 401 JSON for unauthenticated request on protected route carrying next-action with Accept: application/json", async () => {
      const downstreamSpy = vi.fn((c) => c.json({ data: "ok" }));
      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.post("/workspace", downstreamSpy);

      mockState.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: null,
      });

      const res = await app.request("https://lugx.app/workspace", {
        method: "POST",
        headers: {
          "next-action": "legacy_action_hash",
          accept: "application/json",
        },
      });

      expect(downstreamSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(401);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      const body = await res.json();
      expect(body).toEqual({ error: "Unauthorized" });
    });
  });

  describe("DEF-A05: RFC 9110 Mutations, 303 Navigation & Static Asset Fast-Path", () => {
    it.each([
      ["POST", undefined],
      ["POST", "text/html,application/xhtml+xml"],
      ["PUT", undefined],
      ["PUT", "*/*"],
      ["PATCH", undefined],
      ["PATCH", "text/html"],
      ["DELETE", undefined],
      ["DELETE", "text/plain"],
    ] as const)(
      "returns 401 JSON for unauthenticated %s mutation on /workspace (Accept=%s) without redirecting",
      async (method, accept) => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });
        mockState.setCookiesOnCreate = true;
        mockState.mockCookiesToSet = [
          { name: "sb-cleared", value: "", options: { path: "/", maxAge: 0 } },
        ];

        const req = new Request("https://lugx.app/workspace", {
          method,
          headers: accept ? { accept } : {},
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(401);
        expect(res.headers.get("Content-Type")).toBe("application/json");
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("set-cookie")).toContain("sb-cleared=; Max-Age=0; Path=/");
        expect(await res.json()).toEqual({ error: "Unauthorized" });
      }
    );

    it.each(["GET", "HEAD"] as const)(
      "redirects unauthenticated safe %s HTML navigation on /workspace using 303 See Other",
      async (method) => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request("https://lugx.app/workspace?view=split", {
          method,
          headers: { accept: "text/html,application/xhtml+xml" },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(
          "https://lugx.app/login?redirectTo=%2Fworkspace%3Fview%3Dsplit"
        );
      }
    );

    it.each([
      "/assets/index-abc123.js",
      "/assets/styles/main.css",
      "/favicon.ico",
      "/robots.txt",
      "/public/logo.png",
      "/images/illustration.webp",
      "/fonts/font.woff2",
      "/@vite/client",
    ])(
      "bypasses Supabase client initialization, auth lookup, and production env fail-fast for public static asset %s",
      async (assetPath) => {
        process.env.NODE_ENV = "production";
        delete process.env.VITEST;
        delete process.env.VITE_SUPABASE_URL;
        delete process.env.VITE_SUPABASE_ANON_KEY;

        const res = await handleSessionProxy(
          new Request(`https://lugx.app${assetPath}`, {
            headers: { cookie: "sb-access-token=abc" },
          })
        );

        expect(res.status).toBe(200);
        expect(createServerClient).not.toHaveBeenCalled();
        expect(mockState.getUser).not.toHaveBeenCalled();
      }
    );

    it("passes public static asset requests through sessionMiddleware to downstream handlers without creating a Supabase client", async () => {
      const downstreamSpy = vi.fn((c) => c.text("asset-bytes"));
      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.get("/assets/logo.png", downstreamSpy);

      const res = await app.request("https://lugx.app/assets/logo.png");

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("asset-bytes");
      expect(downstreamSpy).toHaveBeenCalledTimes(1);
      expect(createServerClient).not.toHaveBeenCalled();
    });

    it.each([
      "/workspace/evil.png",
      "/workspace/logo.png",
      "/workspace/nested/icon.SVG",
      "/dashboard/font.woff2",
      "/account/avatar.jpg",
    ])(
      "CRITICAL SECURITY INVARIANT: never bypasses authentication for protected route %s even if ending with static extension",
      async (protectedAssetPath) => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const res = await handleSessionProxy(
          new Request(`https://lugx.app${protectedAssetPath}`)
        );

        // Safe browser navigation to protected path redirected to login with 303
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(
          `https://lugx.app/login?redirectTo=${encodeURIComponent(protectedAssetPath)}`
        );
      }
    );

    it("returns 204 No Content with CORS preflight headers for OPTIONS requests on protected routes rather than redirecting to login", async () => {
      const req = new Request("https://lugx.app/workspace", {
        method: "OPTIONS",
      });
      const res = await handleSessionProxy(req);

      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
      expect(res.headers.get("Location")).toBeNull();
    });

    it.each([
      "/api/files/icon.png",
      "/api/files/foo.js",
      "/api/assets/main.css",
    ])(
      "does NOT bypass Supabase initialization or credential checks for API path %s",
      async (apiPath) => {
        const res = await handleSessionProxy(
          new Request(`https://lugx.app${apiPath}`)
        );
        expect(res.status).toBe(200);
        expect(createServerClient).toHaveBeenCalledTimes(1);

        process.env.NODE_ENV = "production";
        delete process.env.VITEST;
        delete process.env.VITE_SUPABASE_URL;
        delete process.env.VITE_SUPABASE_ANON_KEY;

        await expect(
          handleSessionProxy(new Request(`https://lugx.app${apiPath}`))
        ).rejects.toThrow(/\[Session Middleware\] Missing required Supabase credentials/);
      }
    );
  });

  describe("DEF-A04: Supabase Credential Fail-Fast & Scoped Test Placeholders", () => {
    it("allows placeholder fallback when NODE_ENV=test even if VITEST is unset", async () => {
      process.env.NODE_ENV = "test";
      delete process.env.VITEST;
      delete process.env.VITE_SUPABASE_URL;
      delete process.env.VITE_SUPABASE_ANON_KEY;

      const res = await handleSessionProxy(new Request("https://lugx.app/"));

      expect(res.status).toBe(200);
      expect(createServerClient).toHaveBeenCalledWith(
        "https://placeholder.supabase.co",
        "placeholder-anon-key",
        expect.any(Object)
      );
    });

    it("allows placeholder fallback when VITEST=true even if NODE_ENV=production", async () => {
      process.env.NODE_ENV = "production";
      process.env.VITEST = "true";
      delete process.env.VITE_SUPABASE_URL;
      delete process.env.VITE_SUPABASE_ANON_KEY;

      const res = await handleSessionProxy(new Request("https://lugx.app/"));

      expect(res.status).toBe(200);
      expect(createServerClient).toHaveBeenCalledWith(
        "https://placeholder.supabase.co",
        "placeholder-anon-key",
        expect.any(Object)
      );
    });

    it.each([
      ["production", undefined, undefined, /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
      ["production", "", "", /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
      ["production", "   ", "   ", /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
      ["production", "https://real.supabase.co", undefined, /VITE_SUPABASE_ANON_KEY/],
      ["production", undefined, "real-key", /VITE_SUPABASE_URL/],
      ["development", undefined, undefined, /VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/],
      ["development", "https://real.supabase.co", "   ", /VITE_SUPABASE_ANON_KEY/],
      ["development", "", "real-key", /VITE_SUPABASE_URL/],
    ] as const)(
      "throws fail-fast error in %s runtime when url=%s key=%s and VITEST is unset",
      async (nodeEnv, url, key, expectedPattern) => {
        process.env.NODE_ENV = nodeEnv;
        delete process.env.VITEST;

        if (url === undefined) delete process.env.VITE_SUPABASE_URL;
        else process.env.VITE_SUPABASE_URL = url;

        if (key === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
        else process.env.VITE_SUPABASE_ANON_KEY = key;

        await expect(
          handleSessionProxy(new Request("https://lugx.app/"))
        ).rejects.toThrow(expectedPattern);
        expect(createServerClient).not.toHaveBeenCalled();
      }
    );

    it("treats VITEST='false' with missing credentials in production as non-test and fails fast", async () => {
      process.env.NODE_ENV = "production";
      process.env.VITEST = "false";
      delete process.env.VITE_SUPABASE_URL;
      delete process.env.VITE_SUPABASE_ANON_KEY;

      await expect(
        handleSessionProxy(new Request("https://lugx.app/api/files/icon.png"))
      ).rejects.toThrow(/\[Session Middleware\] Missing required Supabase credentials/);
      expect(createServerClient).not.toHaveBeenCalled();
    });

    it.each(["production", "development"] as const)(
      "succeeds in %s runtime when valid VITE_SUPABASE_* credentials exist",
      async (nodeEnv) => {
        process.env.NODE_ENV = nodeEnv;
        delete process.env.VITEST;
        process.env.VITE_SUPABASE_URL = "https://real-prod.supabase.co";
        process.env.VITE_SUPABASE_ANON_KEY = "real-prod-anon-key";

        const res = await handleSessionProxy(new Request("https://lugx.app/"));

        expect(res.status).toBe(200);
        expect(createServerClient).toHaveBeenCalledWith(
          "https://real-prod.supabase.co",
          "real-prod-anon-key",
          expect.any(Object)
        );
      }
    );
  });

  describe("Cookie Mutation Suppression (clearPendingAuthCookieMutations)", () => {
    it("suppresses trailing bare empty Set-Cookie headers when clearPendingAuthCookieMutations is invoked", async () => {
      const { clearPendingAuthCookieMutations } = await import(
        "@/server/middleware/session-middleware"
      );

      const downstreamHandler = vi.fn(async (c) => {
        clearPendingAuthCookieMutations();
        return c.json({ success: true });
      });

      const app = new Hono();
      app.use("*", sessionMiddleware);
      app.post("/test-logout", downstreamHandler);

      mockState.setCookiesOnCreate = true;
      mockState.mockCookiesToSet = [
        {
          name: "sb-access-token",
          value: "",
          options: { maxAge: 0, path: "/" },
        },
      ];

      const res = await app.request("https://lugx.app/test-logout", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).not.toContain("sb-access-token");
    });
  });

  describe("Pure Route Guard Module (src/lib/auth/route-guard.ts)", () => {
    it("normalizes request pathnames collapsing duplicate slashes and decoding percent-encoding safely", async () => {
      const { normalizeRequestPathname } = await import("@/lib/auth/route-guard");

      expect(normalizeRequestPathname("//workspace")).toBe("/workspace");
      expect(normalizeRequestPathname("///workspace///editor")).toBe("/workspace/editor");
      expect(normalizeRequestPathname("/workspace%2Fsub")).toBe("/workspace/sub");
      // Malformed percent-encoding should not throw:
      expect(normalizeRequestPathname("/workspace%zz")).toBe("/workspace%zz");
      expect(normalizeRequestPathname("")).toBe("/");
      expect(normalizeRequestPathname("https://example.com/workspace?tab=1#hash")).toBe("/workspace");
    });

    it("evaluates isProtectedAppPath with case insensitivity and trailing slashes", async () => {
      const { isProtectedAppPath } = await import("@/lib/auth/route-guard");

      expect(isProtectedAppPath("/workspace")).toBe(true);
      expect(isProtectedAppPath("/workspace/")).toBe(true);
      expect(isProtectedAppPath("/WORKSPACE/doc")).toBe(true);
      expect(isProtectedAppPath("/dashboard")).toBe(true);
      expect(isProtectedAppPath("/account")).toBe(true);
      expect(isProtectedAppPath("/account/billing")).toBe(true);
      expect(isProtectedAppPath("/workspaces")).toBe(false);
      expect(isProtectedAppPath("/accountant")).toBe(false);
      expect(isProtectedAppPath("/login")).toBe(false);
      expect(isProtectedAppPath("/")).toBe(false);
    });

    it("evaluates isPublicStaticAssetPath maintaining critical security invariant", async () => {
      const { isPublicStaticAssetPath } = await import("@/lib/auth/route-guard");

      // Critical guarded paths must NEVER be bypassed even with static extensions:
      expect(isPublicStaticAssetPath("/workspace/evil.png")).toBe(false);
      expect(isPublicStaticAssetPath("/dashboard/font.woff2")).toBe(false);
      expect(isPublicStaticAssetPath("/account/logo.svg")).toBe(false);
      expect(isPublicStaticAssetPath("/api/data.json")).toBe(false);
      expect(isPublicStaticAssetPath("/auth/callback/script.js")).toBe(false);

      // Public static assets must return true:
      expect(isPublicStaticAssetPath("/favicon.ico")).toBe(true);
      expect(isPublicStaticAssetPath("/robots.txt")).toBe(true);
      expect(isPublicStaticAssetPath("/assets/bundle.js")).toBe(true);
      expect(isPublicStaticAssetPath("/@vite/client")).toBe(true);
      expect(isPublicStaticAssetPath("/images/banner.png")).toBe(true);
    });

    it("evaluates isSupabaseAuthCookieName across prefix variants", async () => {
      const { isSupabaseAuthCookieName } = await import("@/lib/auth/route-guard");

      expect(isSupabaseAuthCookieName("sb-access-token")).toBe(true);
      expect(isSupabaseAuthCookieName("sb-refresh-token")).toBe(true);
      expect(isSupabaseAuthCookieName("__Host-sb-access-token")).toBe(true);
      expect(isSupabaseAuthCookieName("__Secure-sb-access-token")).toBe(true);
      expect(isSupabaseAuthCookieName("__host-sb-token")).toBe(true);
      expect(isSupabaseAuthCookieName("theme")).toBe(false);
      expect(isSupabaseAuthCookieName("sb")).toBe(false);
      expect(isSupabaseAuthCookieName("not-sb-token")).toBe(false);
    });
  });
});
