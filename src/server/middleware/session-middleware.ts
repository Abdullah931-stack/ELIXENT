import { createServerClient } from "@supabase/ssr";
import { createMiddleware } from "hono/factory";
import {
  runWithServerRequestContext,
  type ServerRequestContext,
  type ServerCookieStore,
  type ServerCookieRecord,
} from "@/server/context/request-context";

/**
 * Cookie serialization helper producing standard Set-Cookie header strings.
 */
function serializeCookie(
  name: string,
  value: string,
  options?: Record<string, unknown>
): string {
  let cookie = `${name}=${value}`;

  if (!options) {
    return cookie;
  }

  if (options.maxAge !== undefined && options.maxAge !== null) {
    cookie += `; Max-Age=${options.maxAge}`;
  }
  if (options.domain) {
    cookie += `; Domain=${options.domain}`;
  }
  if (options.path) {
    cookie += `; Path=${options.path}`;
  }
  if (options.expires) {
    const expiresDate =
      options.expires instanceof Date
        ? options.expires
        : new Date(options.expires as string | number);
    if (!Number.isNaN(expiresDate.getTime())) {
      cookie += `; Expires=${expiresDate.toUTCString()}`;
    }
  }
  if (options.httpOnly) {
    cookie += `; HttpOnly`;
  }
  if (options.secure) {
    cookie += `; Secure`;
  }
  if (options.sameSite) {
    const sameSiteStr = String(options.sameSite).toLowerCase();
    if (sameSiteStr === "lax") {
      cookie += `; SameSite=Lax`;
    } else if (sameSiteStr === "strict") {
      cookie += `; SameSite=Strict`;
    } else if (sameSiteStr === "none") {
      cookie += `; SameSite=None`;
    }
  }

  return cookie;
}

/**
 * Parses cookies from incoming standard Request headers.
 */
function parseIncomingCookies(request: Request): Map<string, string> {
  const map = new Map<string, string>();

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const pairs = cookieHeader.split(";");
    for (const pair of pairs) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key) {
          map.set(key, val);
        }
      }
    }
  }

  return map;
}

/**
 * Applies Set-Cookie headers to a Web standard Response.
 */
function applyCookiesToResponse(
  response: Response,
  mutatedCookies: Map<string, ServerCookieRecord>
): Response {
  for (const cookie of mutatedCookies.values()) {
    response.headers.append(
      "Set-Cookie",
      serializeCookie(cookie.name, cookie.value, cookie.options)
    );
  }

  return response;
}

/**
 * Creates a 307 redirect response with mutated cookies applied.
 */
function createRedirectResponse(
  url: URL | string,
  mutatedCookies: Map<string, ServerCookieRecord>
): Response {
  const destination = typeof url === "string" ? url : url.toString();
  const response = new Response(null, {
    status: 307,
    headers: {
      Location: destination,
    },
  });
  return applyCookiesToResponse(response, mutatedCookies);
}

/**
 * Creates a request-scoped cookie store wired to incoming and mutated cookies.
 */
function createCookieStore(
  incomingCookies: Map<string, string>,
  mutatedCookies: Map<string, ServerCookieRecord>
): ServerCookieStore {
  return {
    getAll() {
      const all = new Map<string, { name: string; value: string }>();
      for (const [k, v] of incomingCookies) all.set(k, { name: k, value: v });
      for (const [k, m] of mutatedCookies) all.set(k, { name: m.name, value: m.value });
      return Array.from(all.values());
    },
    set(name: string, value: string, options?: Record<string, unknown>) {
      mutatedCookies.set(name, { name, value, options });
    },
    delete(name: string) {
      mutatedCookies.set(name, { name, value: "", options: { maxAge: 0, path: "/" } });
    },
  };
}

/**
 * Core session evaluation logic enforcing route authentication and session refresh invariants.
 * Returns an early Response (307 redirect or 401 unauthorized) or null if request is allowed to proceed.
 */
async function evaluateSession(
  request: Request,
  incomingCookies: Map<string, string>,
  mutatedCookies: Map<string, ServerCookieRecord>
): Promise<Response | null> {
  const supabaseUrl =
    process.env.VITE_SUPABASE_URL || "https://placeholder.supabase.co";
  const supabaseAnonKey =
    process.env.VITE_SUPABASE_ANON_KEY || "placeholder-anon-key";

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        const all = new Map<string, { name: string; value: string }>();
        for (const [k, v] of incomingCookies) all.set(k, { name: k, value: v });
        for (const [k, m] of mutatedCookies) all.set(k, { name: m.name, value: m.value });
        return Array.from(all.values());
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          mutatedCookies.set(name, { name, value, options });
        });
      },
    },
  });

  const parsedUrl = new URL(request.url);
  const pathname = parsedUrl.pathname;

  // Intercept OAuth callback codes strictly if they land on root or login landing paths (LUGX-140)
  const isOAuthLandingCandidate = pathname === "/" || pathname === "/login";
  if (parsedUrl.searchParams.has("code") && isOAuthLandingCandidate) {
    const url = new URL(request.url);
    url.pathname = "/auth/callback";
    return createRedirectResponse(url, mutatedCookies);
  }

  // Protected routes - require authentication
  const protectedPaths = ["/workspace", "/account", "/dashboard"];
  const isProtectedPath = protectedPaths.some((path) => pathname.startsWith(path));
  const isLoginPath = pathname === "/login";

  const allCookieNames = new Set([
    ...incomingCookies.keys(),
    ...mutatedCookies.keys(),
  ]);
  const hasAuthCookies = Array.from(allCookieNames).some((name) =>
    name.startsWith("sb-")
  );

  // Fast-Path: Bypass expensive getUser() network call on public non-auth routes (e.g. "/", public assets)
  // and on /login when no auth cookies exist.
  const shouldCheckUser = isProtectedPath || (isLoginPath && hasAuthCookies);

  // Refresh session if needed with watchdog timeout
  let user: unknown = null;
  if (shouldCheckUser) {
    try {
      const timeoutSignal = AbortSignal.timeout(2500);
      const timeoutPromise = new Promise<never>((_, reject) => {
        if (timeoutSignal.aborted) {
          reject(new Error("Supabase auth.getUser watchdog timeout after 2500ms"));
          return;
        }
        timeoutSignal.addEventListener(
          "abort",
          () => {
            reject(new Error("Supabase auth.getUser watchdog timeout after 2500ms"));
          },
          { once: true }
        );
      });

      const { data } = await Promise.race([
        supabase.auth.getUser(),
        timeoutPromise,
      ]);
      user = data?.user || null;
    } catch (err) {
      console.warn("[Proxy] supabase.auth.getUser error (network/offline):", err);
    }
  }

  // Enforce RFC 9110 Web content negotiation: return 401 JSON for Accept: application/json or /api/* requests
  const isJsonOrApi =
    Boolean(request.headers.get("accept")?.includes("application/json")) ||
    pathname.startsWith("/api/");

  if (isProtectedPath && !user) {
    if (isJsonOrApi) {
      const res = new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
      return applyCookiesToResponse(res, mutatedCookies);
    }

    // Redirect to login for page navigation
    const redirectTarget = `${pathname}${parsedUrl.search}`;
    const url = new URL(request.url);
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("redirectTo", redirectTarget);
    return createRedirectResponse(url, mutatedCookies);
  }

  // If user is logged in and tries to access login page, redirect to dashboard
  if (user && isLoginPath) {
    const url = new URL(request.url);
    url.pathname = "/dashboard";
    url.search = "";
    return createRedirectResponse(url, mutatedCookies);
  }

  return null;
}

/**
 * Standalone Web standard session proxy handler.
 * Evaluates session state and route access invariants for pure Request / Response consumers.
 */
export async function handleSessionProxy(request: Request): Promise<Response> {
  const incomingCookies = parseIncomingCookies(request);
  const mutatedCookies = new Map<string, ServerCookieRecord>();
  const cookieStore = createCookieStore(incomingCookies, mutatedCookies);
  const serverContext: ServerRequestContext = {
    cookies: cookieStore,
    headers: request.headers,
  };

  return await runWithServerRequestContext(serverContext, async () => {
    const earlyResponse = await evaluateSession(request, incomingCookies, mutatedCookies);
    if (earlyResponse) {
      return earlyResponse;
    }
    const passThroughResponse = new Response(null, { status: 200 });
    return applyCookiesToResponse(passThroughResponse, mutatedCookies);
  });
}

/**
 * Standard Hono middleware wrapping session validation, auth protection, and cookie synchronization.
 */
export const sessionMiddleware = createMiddleware(async (c, next) => {
  const request = c.req.raw;
  const incomingCookies = parseIncomingCookies(request);
  const mutatedCookies = new Map<string, ServerCookieRecord>();
  const cookieStore = createCookieStore(incomingCookies, mutatedCookies);
  const serverContext: ServerRequestContext = {
    cookies: cookieStore,
    headers: request.headers,
  };

  let earlyResponse: Response | null = null;
  await runWithServerRequestContext(serverContext, async () => {
    earlyResponse = await evaluateSession(request, incomingCookies, mutatedCookies);
    if (!earlyResponse) {
      await next();
    }
  });

  if (earlyResponse) {
    return earlyResponse;
  }

  if (c.res && c.res.headers) {
    for (const cookie of mutatedCookies.values()) {
      c.res.headers.append(
        "Set-Cookie",
        serializeCookie(cookie.name, cookie.value, cookie.options)
      );
    }
  }
});
