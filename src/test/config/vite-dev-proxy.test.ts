/**
 * Unit & Contract Test Suite: Vite Dev Proxy & Hono Dev Server Middleware Plugin (FIND-01)
 *
 * Verifies:
 * 1. Path Normalization & Host Hijacking Prevention:
 *    - Leading double-slash (e.g. `//workspace`) and multi-slash paths (`///dashboard`)
 *      are normalized via `req.url.replace(/^\/+/, "/")` and securely guarded.
 * 2. Unification with `isGuardedPageNavigation`:
 *    - Unauthenticated `GET /workspace` receives a 303 redirect to `/login?redirectTo=%2Fworkspace`.
 *    - All protected sub-routes (`/workspace/editor/doc-456`, `/dashboard/overview`, `/account/security`)
 *      are guarded consistently for both GET and HEAD requests.
 * 3. Static Asset Exclusion Boundaries:
 *    - Genuine public static assets (`/assets/bundle.js`, `/favicon.ico`, `/robots.txt`) bypass
 *      the session gate and call downstream `next()`.
 *    - Protected sub-paths ending with static extensions (e.g. `/workspace/evil.png`) are strictly
 *      NOT bypassed and receive a 303 redirect.
 * 4. Response Header & Cookie Preservation:
 *    - Preserves 303 status, Location header, and Set-Cookie headers when proxying Hono responses.
 * 5. Direct Hono App Routing:
 *    - Routes `/api/*` and `/auth/callback*` directly to Hono `app.fetch`.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { Plugin, UserConfig, ViteDevServer } from "vite";
import viteConfig from "../../../vite.config";

type MiddlewareFn = (
  req: {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
  },
  res: {
    statusCode: number;
    statusMessage?: string;
    headersSent: boolean;
    setHeader: (key: string, value: string | string[]) => void;
    getHeader: (key: string) => string | string[] | undefined;
    getHeaders: () => Record<string, string | string[] | undefined>;
    flushHeaders?: () => void;
    write?: (chunk: unknown) => void;
    end: (chunk?: unknown) => void;
  },
  next: (err?: unknown) => void
) => Promise<void>;

interface MockHttpExchange {
  req: {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    on: Mock<(event: string, listener: (...args: unknown[]) => void) => void>;
  };
  res: {
    statusCode: number;
    statusMessage?: string;
    headersSent: boolean;
    setHeader: Mock<(key: string, value: string | string[]) => void>;
    getHeader: Mock<(key: string) => string | string[] | undefined>;
    getHeaders: Mock<() => Record<string, string | string[] | undefined>>;
    flushHeaders: Mock<() => void>;
    write: Mock<(chunk: unknown) => void>;
    end: Mock<(chunk?: unknown) => void>;
  };
  next: Mock<(err?: unknown) => void>;
  headers: Map<string, string | string[]>;
}

function createMockExchange(options: {
  url: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}): MockHttpExchange {
  const headers = new Map<string, string | string[]>();
  const req = {
    url: options.url,
    method: options.method || "GET",
    headers: {
      host: "localhost:5173",
      ...options.headers,
    },
    on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
  };

  const res = {
    statusCode: 200,
    statusMessage: "OK",
    headersSent: false,
    setHeader: vi.fn<(key: string, val: string | string[]) => void>((key: string, val: string | string[]) => {
      headers.set(key.toLowerCase(), val);
    }),
    getHeader: vi.fn<(key: string) => string | string[] | undefined>((key: string) =>
      headers.get(key.toLowerCase())
    ),
    getHeaders: vi.fn<() => Record<string, string | string[] | undefined>>(() =>
      Object.fromEntries(headers.entries())
    ),
    flushHeaders: vi.fn<() => void>(),
    write: vi.fn<(chunk: unknown) => void>(),
    end: vi.fn<(chunk?: unknown) => void>(),
  };

  const next = vi.fn<(err?: unknown) => void>();
  return { req, res, next, headers };
}

describe("Vite Dev Proxy Plugin (elixent-hono-dev-server) (FIND-01)", () => {
  let devMiddleware: MiddlewareFn;
  let mockSsrLoadModule: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cfg =
      typeof viteConfig === "function"
        ? await (viteConfig as (...args: unknown[]) => Promise<UserConfig> | UserConfig)({
            command: "serve",
            mode: "development",
          })
        : await viteConfig;

    const plugins = (cfg.plugins ?? []).flat();
    const proxyPlugin = plugins.find(
      (p): p is Plugin =>
        p !== null &&
        typeof p === "object" &&
        "name" in p &&
        p.name === "elixent-hono-dev-server"
    );

    if (!proxyPlugin || typeof proxyPlugin.configureServer !== "function") {
      throw new Error("elixent-hono-dev-server plugin with configureServer not found");
    }

    mockSsrLoadModule = vi.fn(async (modulePath: string) => {
      if (modulePath === "/src/server/middleware/session-middleware.ts") {
        return {
          handleSessionProxy: async (request: Request) => {
            const url = new URL(request.url);
            const pathname = url.pathname;

            // Simulate session proxy redirecting unauthenticated users on protected paths
            if (
              pathname === "/workspace" ||
              pathname.startsWith("/workspace/") ||
              pathname === "/dashboard" ||
              pathname.startsWith("/dashboard/") ||
              pathname === "/account" ||
              pathname.startsWith("/account/")
            ) {
              const redirectUrl = `/login?redirectTo=${encodeURIComponent(pathname + url.search)}`;
              const headers = new Headers();
              headers.set("Location", redirectUrl);
              headers.append("Set-Cookie", "sb-auth-token=deleted; Max-Age=0; Path=/");

              return new Response(null, {
                status: 303,
                statusText: "See Other",
                headers,
              });
            }

            // Normal pass-through for other checked routes
            return new Response(null, { status: 200, statusText: "OK" });
          },
        };
      }

      if (modulePath === "/src/server/app.ts") {
        return {
          app: {
            fetch: async (request: Request) => {
              const url = new URL(request.url);
              if (url.pathname.startsWith("/api/test")) {
                return new Response(JSON.stringify({ ok: true }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                });
              }
              if (url.pathname.startsWith("/auth/callback")) {
                return new Response(null, {
                  status: 302,
                  headers: { Location: "/workspace" },
                });
              }
              return new Response("Not Found", { status: 404 });
            },
          },
        };
      }

      throw new Error(`Unexpected ssrLoadModule path: ${modulePath}`);
    });

    const mockServer = {
      middlewares: {
        use: vi.fn((fn: MiddlewareFn) => {
          devMiddleware = fn;
        }),
      },
      ssrLoadModule: mockSsrLoadModule,
    } as unknown as ViteDevServer;

    proxyPlugin.configureServer(mockServer);

    if (!devMiddleware) {
      throw new Error("configureServer did not register a middleware");
    }
  });

  // -------------------------------------------------------------------------
  // 1. Unauthenticated Page Protection (GET /workspace receives 303)
  // -------------------------------------------------------------------------
  describe("1. Unauthenticated Route Protection & 303 Redirect", () => {
    it("intercepts GET /workspace and returns 303 See Other redirect to /login?redirectTo=%2Fworkspace", async () => {
      const exchange = createMockExchange({ url: "/workspace" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(303);
      expect(exchange.res.getHeader("location")).toBe("/login?redirectTo=%2Fworkspace");
      expect(exchange.res.getHeader("set-cookie")).toBeDefined();
      expect(exchange.res.end).toHaveBeenCalledTimes(1);
      expect(exchange.next).not.toHaveBeenCalled();
    });

    it("intercepts HEAD /workspace and returns 303 redirect", async () => {
      const exchange = createMockExchange({ url: "/workspace", method: "HEAD" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(303);
      expect(exchange.res.getHeader("location")).toBe("/login?redirectTo=%2Fworkspace");
      expect(exchange.res.end).toHaveBeenCalledTimes(1);
      expect(exchange.next).not.toHaveBeenCalled();
    });

    it("intercepts deep nested protected routes: /workspace/editor/doc-456", async () => {
      const exchange = createMockExchange({ url: "/workspace/editor/doc-456" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(303);
      expect(exchange.res.getHeader("location")).toBe(
        `/login?redirectTo=${encodeURIComponent("/workspace/editor/doc-456")}`
      );
      expect(exchange.res.end).toHaveBeenCalledTimes(1);
      expect(exchange.next).not.toHaveBeenCalled();
    });

    it("intercepts /dashboard and /account routes consistently", async () => {
      for (const guardedPath of ["/dashboard", "/dashboard/overview", "/account", "/account/security"]) {
        const exchange = createMockExchange({ url: guardedPath });
        await devMiddleware(exchange.req, exchange.res, exchange.next);

        expect(exchange.res.statusCode).toBe(303);
        expect(exchange.res.getHeader("location")).toBe(
          `/login?redirectTo=${encodeURIComponent(guardedPath)}`
        );
        expect(exchange.next).not.toHaveBeenCalled();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Path Normalization & Host Hijacking Prevention
  // -------------------------------------------------------------------------
  describe("2. Path Normalization & Host Hijacking Prevention", () => {
    it("normalizes leading double-slash //workspace and enforces protection", async () => {
      const exchange = createMockExchange({ url: "//workspace" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(303);
      expect(exchange.res.getHeader("location")).toBe("/login?redirectTo=%2Fworkspace");
      expect(exchange.res.end).toHaveBeenCalledTimes(1);
      expect(exchange.next).not.toHaveBeenCalled();
    });

    it("normalizes multi-slash paths: ///dashboard/overview", async () => {
      const exchange = createMockExchange({ url: "///dashboard/overview" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(303);
      expect(exchange.res.getHeader("location")).toBe(
        `/login?redirectTo=${encodeURIComponent("/dashboard/overview")}`
      );
      expect(exchange.next).not.toHaveBeenCalled();
    });

    it("preserves query parameters during path normalization: //workspace?draft=true", async () => {
      const exchange = createMockExchange({ url: "//workspace?draft=true" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(303);
      expect(exchange.res.getHeader("location")).toBe(
        `/login?redirectTo=${encodeURIComponent("/workspace?draft=true")}`
      );
      expect(exchange.next).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Protected Static Sub-Paths & Public Asset Discrimination
  // -------------------------------------------------------------------------
  describe("3. Protected Static Sub-Paths vs Public Assets", () => {
    it("does NOT bypass protected sub-paths ending in static extensions (/workspace/evil.png)", async () => {
      const exchange = createMockExchange({ url: "/workspace/evil.png" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(303);
      expect(exchange.res.getHeader("location")).toBe(
        `/login?redirectTo=${encodeURIComponent("/workspace/evil.png")}`
      );
      expect(exchange.res.end).toHaveBeenCalledTimes(1);
      expect(exchange.next).not.toHaveBeenCalled();
    });

    it("does NOT bypass /dashboard/script.js or /account/avatar.svg", async () => {
      for (const evilPath of ["/dashboard/script.js", "/account/avatar.svg"]) {
        const exchange = createMockExchange({ url: evilPath });
        await devMiddleware(exchange.req, exchange.res, exchange.next);

        expect(exchange.res.statusCode).toBe(303);
        expect(exchange.res.getHeader("location")).toBe(
          `/login?redirectTo=${encodeURIComponent(evilPath)}`
        );
        expect(exchange.next).not.toHaveBeenCalled();
      }
    });

    it.each([
      ["/assets/index-DdeSxCMx.js", "Vite asset bundle"],
      ["/favicon.ico", "Root favicon"],
      ["/robots.txt", "Root robots"],
      ["/logo.png", "Root public image"],
    ])("allows legitimate public static asset %s to pass to Vite dev server (%s)", async (assetPath) => {
      const exchange = createMockExchange({ url: assetPath });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(200);
      expect(exchange.next).toHaveBeenCalledTimes(1);
      expect(exchange.res.end).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. API and OAuth Callback Routing
  // -------------------------------------------------------------------------
  describe("4. API & OAuth Callback Direct Routing", () => {
    it("routes /api/test directly to Hono application", async () => {
      const exchange = createMockExchange({ url: "/api/test", method: "GET" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(200);
      expect(exchange.res.getHeader("content-type")).toBe("application/json");
      expect(exchange.res.end).toHaveBeenCalled();
      expect(exchange.next).not.toHaveBeenCalled();
    });

    it("routes /auth/callback directly to Hono application", async () => {
      const exchange = createMockExchange({ url: "/auth/callback?code=test-code", method: "GET" });
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(302);
      expect(exchange.res.getHeader("location")).toBe("/workspace");
      expect(exchange.res.end).toHaveBeenCalled();
      expect(exchange.next).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Edge Cases & Resilience
  // -------------------------------------------------------------------------
  describe("5. Edge Cases & Error Resilience", () => {
    it("calls next() if req.url is empty or undefined", async () => {
      const exchange = createMockExchange({ url: "" });
      exchange.req.url = undefined;
      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.next).toHaveBeenCalledTimes(1);
    });

    it("returns 500 Internal Server Error if an unhandled exception occurs in middleware", async () => {
      mockSsrLoadModule.mockRejectedValueOnce(new Error("SSR Load Failed"));
      const exchange = createMockExchange({ url: "/workspace" });

      await devMiddleware(exchange.req, exchange.res, exchange.next);

      expect(exchange.res.statusCode).toBe(500);
      expect(exchange.res.end).toHaveBeenCalledWith("Internal Server Error");
    });
  });
});
