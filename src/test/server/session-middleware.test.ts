/**
 * Comprehensive Test Suite for Web-Standard Session Middleware
 *
 * Verifies:
 * 1. `handleSessionProxy` (and `proxy` alias) with standard Web Request and Response objects:
 *    - OAuth code redirection on `/` and `/login` (307 to `/auth/callback` preserving query params and cookies).
 *    - Fast-Path Cookie Gate (`TD-12`): `getUser()` bypassed on public routes and on `/login` when no `sb-*` cookie exists.
 *    - Watchdog timeout (`AbortSignal.timeout(2500)`) and offline network error handling with `console.warn`.
 *    - Protected route gating (`/workspace`, `/account`, `/dashboard`): 401 JSON for `next-action` or `/api/*`, 307 redirect for page navigations.
 *    - Authenticated user visiting `/login` redirected to `/dashboard` (307).
 *    - Cookie serialization and `Set-Cookie` header generation on redirects, 401, and 200 responses.
 *    - Standard `Response` decorated `cookies` helper (`.get(name)`, `.getAll()`, `.set()`, `.delete()`).
 * 2. `sessionMiddleware` mounted on Hono (`new Hono()`):
 *    - Pass-through execution with downstream route handlers.
 *    - Context binding (`runWithServerRequestContext`) accessible to downstream handlers via `getActiveRequestContext()` and `resolveCookiesAndHeaders()`.
 *    - Mutated cookie propagation from downstream handlers to `c.res.headers`.
 *    - Direct intercept and short-circuit on unauthorized access, OAuth redirection, and logged-in user visits to `/login`.
 * 3. Route matcher configuration (`config.matcher`) against regular routes and excluded static assets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  handleSessionProxy,
  proxy,
  sessionMiddleware,
  config,
} from "@/server/middleware/session-middleware";
import {
  getActiveRequestContext,
  resolveCookiesAndHeaders,
} from "@/server/context/request-context";

interface ResponseWithCookies extends Response {
  cookies: {
    get(name: string): { name: string; value: string } | undefined;
    getAll(): Array<{ name: string; value: string }>;
    set(
      nameOrCookie: string | { name: string; value: string; options?: Record<string, unknown> },
      maybeValue?: string,
      maybeOptions?: Record<string, unknown>
    ): void;
    delete(name: string): void;
  };
}

function withCookies(res: Response): ResponseWithCookies {
  return res as ResponseWithCookies;
}

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
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.setCookiesOnCreate = false;
    mockState.mockCookiesToSet = [];
    process.env.VITE_SUPABASE_URL = "https://mock-supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "mock-anon-key";
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
        expect(withCookies(res).cookies.get("sb-oauth-state")?.value).toBe("state_val_789");
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
          expect(res.status).toBe(307);
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
        expect(res.status).toBe(307);
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

          expect(res.status).toBe(307);
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

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe(
          "https://lugx.app/login?redirectTo=%2Fworkspace%2Feditor%2Fdoc-99%3Ftab%3Drecent%26view%3Dsplit"
        );
      });

      it("returns JSON 401 Unauthorized for unauthenticated requests with next-action header on protected routes", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request("https://lugx.app/workspace", {
          headers: {
            "next-action": "action_id_abc123",
          },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(401);
        expect(res.headers.get("Content-Type")).toBe("application/json");
        const body = await res.json();
        expect(body).toEqual({ error: "Unauthorized" });
      });

      it("returns JSON 401 Unauthorized for unauthenticated requests targeting /api/* subpath", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request("https://lugx.app/workspace", {
          headers: {
            "next-action": "true",
          },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body).toEqual({ error: "Unauthorized" });
      });

      it("redirects unauthenticated subpath requests without next-action header to login (307) even with json accept header", async () => {
        mockState.getUser.mockResolvedValueOnce({
          data: { user: null },
          error: null,
        });

        const req = new Request("https://lugx.app/workspace/api/save", {
          headers: { accept: "application/json" },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(307);
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

    describe("Cookie Serialization & Response Cookies Helper", () => {
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

        expect(res.status).toBe(307);
        const setCookie = res.headers.get("set-cookie");
        expect(setCookie).toContain("sb-refresh-token=new_ref_token");
        expect(setCookie).toContain("Max-Age=3600");
        expect(setCookie).toContain("Path=/");
        expect(setCookie).toContain("Domain=lugx.app");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("Secure");
        expect(setCookie).toContain("SameSite=Lax");
        expect(withCookies(res).cookies.get("sb-refresh-token")?.value).toBe("new_ref_token");
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
          headers: { "next-action": "logout" },
        });
        const res = await handleSessionProxy(req);

        expect(res.status).toBe(401);
        expect(res.headers.get("set-cookie")).toContain("sb-cleared=; Max-Age=0; Path=/");
      });

      it("provides .get(name) and .getAll() on response cookies reflecting incoming and mutated cookies", async () => {
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
        const res = withCookies(await handleSessionProxy(req));

        expect(res.cookies.get("theme")?.value).toBe("light");
        expect(res.cookies.get("session_tag")?.value).toBe("stag_99");
        expect(res.cookies.get("mutated_cookie")?.value).toBe("mutated_val");
        expect(res.cookies.get("non_existent")).toBeUndefined();

        const all = res.cookies.getAll();
        expect(all).toEqual(
          expect.arrayContaining([
            { name: "theme", value: "light" },
            { name: "session_tag", value: "stag_99" },
            { name: "mutated_cookie", value: "mutated_val" },
          ])
        );
      });

      it("supports mutating response cookies via res.cookies.set() and res.cookies.delete()", async () => {
        const req = new Request("https://lugx.app/");
        const res = withCookies(await handleSessionProxy(req));

        // Mutate via object overload
        res.cookies.set({
          name: "client_exp",
          value: "val_exp",
          options: { path: "/app", secure: true },
        });

        // Mutate via parameter overload
        res.cookies.set("client_flag", "enabled", { httpOnly: true });

        // Delete cookie
        res.cookies.delete("old_cookie");

        expect(res.cookies.get("client_exp")?.value).toBe("val_exp");
        expect(res.cookies.get("client_flag")?.value).toBe("enabled");

        const setCookies = res.headers.get("set-cookie");
        expect(setCookies).toContain("client_exp=val_exp; Path=/app; Secure");
        expect(setCookies).toContain("client_flag=enabled; HttpOnly");
        expect(setCookies).toContain("old_cookie=; Max-Age=0; Path=/");
      });

      it("serializes SameSite variants correctly (Strict, None, Lax)", async () => {
        const req = new Request("https://lugx.app/");
        const res = withCookies(await handleSessionProxy(req));

        res.cookies.set("c_strict", "1", { sameSite: "strict" });
        res.cookies.set("c_none", "2", { sameSite: "NONE" });
        res.cookies.set("c_lax", "3", { sameSite: "Lax" });

        const setCookies = res.headers.get("set-cookie");
        expect(setCookies).toContain("c_strict=1; SameSite=Strict");
        expect(setCookies).toContain("c_none=2; SameSite=None");
        expect(setCookies).toContain("c_lax=3; SameSite=Lax");
      });

      it("serializes Date and timestamp expires options correctly and ignores invalid dates", async () => {
        const req = new Request("https://lugx.app/");
        const res = withCookies(await handleSessionProxy(req));

        const fixedDate = new Date("2035-12-31T23:59:59.000Z");
        res.cookies.set("c_date", "v1", { expires: fixedDate });
        res.cookies.set("c_time", "v2", { expires: fixedDate.getTime() });
        res.cookies.set("c_invalid", "v3", { expires: "not-a-valid-date" });

        const setCookies = res.headers.get("set-cookie");
        expect(setCookies).toContain(`c_date=v1; Expires=${fixedDate.toUTCString()}`);
        expect(setCookies).toContain(`c_time=v2; Expires=${fixedDate.toUTCString()}`);
        expect(setCookies).toContain("c_invalid=v3");
        expect(setCookies).not.toContain("Expires=Invalid Date");
      });

      it("parses cookies robustly with messy whitespace and missing values", async () => {
        const req = new Request("https://lugx.app/", {
          headers: {
            cookie: "  ; key1=val1 ; ; key2= ; key3 ; key4=val4=extra ; ",
          },
        });
        const res = withCookies(await handleSessionProxy(req));

        expect(res.cookies.get("key1")?.value).toBe("val1");
        expect(res.cookies.get("key2")?.value).toBe("");
        expect(res.cookies.get("key4")?.value).toBe("val4=extra");
      });

      it("gracefully falls back when request.cookies.getAll throws", async () => {
        const req = new Request("https://lugx.app/", {
          headers: { cookie: "fallback_token=ok" },
        });
        Object.defineProperty(req, "cookies", {
          value: {
            getAll() {
              throw new Error("Broken NextRequest mock");
            },
          },
        });

        const res = withCookies(await handleSessionProxy(req));
        expect(res.cookies.get("fallback_token")?.value).toBe("ok");
      });
    });

    describe("Backward Compatibility Alias", () => {
      it("exports proxy as an exact reference alias to handleSessionProxy", () => {
        expect(proxy).toBe(handleSessionProxy);
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
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(
        "https://lugx.app/login?redirectTo=%2Fworkspace"
      );
    });

    it("short-circuits downstream handlers when unauthenticated user sends next-action request", async () => {
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
        headers: { "next-action": "save_doc" },
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
  });

  describe("Matcher Configuration (config.matcher)", () => {
    it("matches all standard application pages and API routes", () => {
      const regex = new RegExp(`^${config.matcher[0]}$`);

      const validRoutes = [
        "/",
        "/login",
        "/auth/callback",
        "/dashboard",
        "/workspace",
        "/workspace/editor/doc-1",
        "/account",
        "/pricing",
        "/api/agent/stream",
        "/api/files/sync",
        "/api/stripe/webhook",
      ];

      for (const route of validRoutes) {
        expect(regex.test(route)).toBe(true);
      }
    });

    it("excludes Next.js static chunks, images, assets, favicon and common static file extensions", () => {
      const regex = new RegExp(`^${config.matcher[0]}$`);

      const excludedRoutes = [
        "/_next/static/chunks/main.js",
        "/_next/static/css/global.css",
        "/_next/image?url=%2Flogo.png",
        "/assets/bundle.js",
        "/assets/images/logo.png",
        "/favicon.ico",
        "/logo.svg",
        "/avatar.png",
        "/banner.jpg",
        "/photo.jpeg",
        "/loader.gif",
        "/preview.webp",
        "/custom.ico",
        "/fonts/inter.woff",
        "/fonts/inter.woff2",
      ];

      for (const route of excludedRoutes) {
        expect(regex.test(route)).toBe(false);
      }
    });
  });
});
