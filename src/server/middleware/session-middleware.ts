import { createServerClient } from "@supabase/ssr";
import { createMiddleware } from "hono/factory";
import {
  runWithServerRequestContext,
  getActiveRequestContext,
  type ServerRequestContext,
  type ServerCookieStore,
  type ServerCookieRecord,
} from "@/server/context/request-context";
import {
  isProtectedAppPath,
  isPublicStaticAssetPath,
  isSupabaseAuthCookieName,
  normalizeRequestPathname,
} from "@/lib/auth/route-guard";

const TEST_PLACEHOLDER_SUPABASE_URL = "https://placeholder.supabase.co";
const TEST_PLACEHOLDER_SUPABASE_ANON_KEY = "placeholder-anon-key";

const activeMutatedCookiesMap = new WeakMap<
  ServerRequestContext,
  Map<string, ServerCookieRecord>
>();

/**
 * Suppresses pending auth cookie mutations in the active request context.
 * Used during sign-out or cookie clearing to avoid re-appending bare empty/attribute cookies.
 */
export function clearPendingAuthCookieMutations(
  ctx?: ServerRequestContext | null
): void {
  const activeCtx = ctx ?? getActiveRequestContext();
  if (!activeCtx) {
    return;
  }
  const mutated = activeMutatedCookiesMap.get(activeCtx);
  if (!mutated) {
    return;
  }
  for (const name of Array.from(mutated.keys())) {
    if (isSupabaseAuthCookieName(name)) {
      mutated.delete(name);
    }
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "false" && normalized !== "0";
}

function readNonEmptyEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTestRuntime(): boolean {
  if (typeof process === "undefined") {
    return false;
  }
  return (
    process.env?.NODE_ENV === "test" || isTruthyEnvFlag(process.env?.VITEST)
  );
}

function resolveMiddlewareSupabaseCredentials(): {
  supabaseUrl: string;
  supabaseAnonKey: string;
} {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const supabaseUrl = readNonEmptyEnv(env?.VITE_SUPABASE_URL);
  const supabaseAnonKey = readNonEmptyEnv(env?.VITE_SUPABASE_ANON_KEY);

  if (isTestRuntime()) {
    return {
      supabaseUrl: supabaseUrl ?? TEST_PLACEHOLDER_SUPABASE_URL,
      supabaseAnonKey:
        supabaseAnonKey ?? TEST_PLACEHOLDER_SUPABASE_ANON_KEY,
    };
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    const missingVars: string[] = [];
    if (!supabaseUrl) missingVars.push("VITE_SUPABASE_URL");
    if (!supabaseAnonKey) missingVars.push("VITE_SUPABASE_ANON_KEY");
    throw new Error(
      `[Session Middleware] Missing required Supabase credentials in non-test runtime: ${missingVars.join(", ")}. Placeholder fallback is restricted strictly to test environments.`
    );
  }

  return { supabaseUrl, supabaseAnonKey };
}

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
 * Creates a redirect response (303 See Other or 307 Temporary Redirect) with mutated cookies applied.
 */
function createRedirectResponse(
  url: URL | string,
  mutatedCookies: Map<string, ServerCookieRecord>,
  status: 303 | 307 = 303
): Response {
  const destination = typeof url === "string" ? url : url.toString();
  const response = new Response(null, {
    status,
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
 * Returns an early Response (303/307 redirect, 401 unauthorized, or 204 options) or null if request is allowed to proceed.
 */
async function evaluateSession(
  request: Request,
  incomingCookies: Map<string, string>,
  mutatedCookies: Map<string, ServerCookieRecord>
): Promise<Response | null> {
  const parsedUrl = new URL(request.url);
  const pathname = normalizeRequestPathname(parsedUrl.pathname);

  // Bypass static asset requests on non-guarded paths before env validation, client creation, or cookie cloning
  if (isPublicStaticAssetPath(pathname)) {
    return null;
  }

  const { supabaseUrl, supabaseAnonKey } =
    resolveMiddlewareSupabaseCredentials();

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

  // Intercept OAuth callback codes strictly if they land on root or login landing paths (LUGX-140)
  const isOAuthLandingCandidate = pathname === "/" || pathname === "/login";
  if (parsedUrl.searchParams.has("code") && isOAuthLandingCandidate) {
    const url = new URL(request.url);
    url.pathname = "/auth/callback";
    return createRedirectResponse(url, mutatedCookies, 307);
  }

  // Protected routes - require authentication
  const isProtectedPath = isProtectedAppPath(pathname);
  const isLoginPath = pathname === "/login";

  const allCookieNames = new Set([
    ...incomingCookies.keys(),
    ...mutatedCookies.keys(),
  ]);
  const hasAuthCookies = Array.from(allCookieNames).some((name) =>
    isSupabaseAuthCookieName(name)
  );

  const method = request.method.toUpperCase();

  // Prevent OPTIONS preflight requests from triggering auth lookups or redirecting to /login via 303.
  // Return standard 204 No Content with CORS preflight allowance headers.
  if (method === "OPTIONS" && isProtectedPath) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

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

  if (isProtectedPath && !user) {
    const isMutationMethod = method !== "GET" && method !== "HEAD";
    const acceptHeader = request.headers.get("accept")?.toLowerCase() ?? "";
    const isJsonOrApi =
      isMutationMethod ||
      acceptHeader.includes("application/json") ||
      pathname.startsWith("/api/");

    if (isJsonOrApi) {
      const res = new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
      return applyCookiesToResponse(res, mutatedCookies);
    }

    // Redirect to login for safe page navigation (303 See Other)
    const redirectTarget = `${pathname}${parsedUrl.search}`;
    const url = new URL(request.url);
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("redirectTo", redirectTarget);
    return createRedirectResponse(url, mutatedCookies, 303);
  }

  // If user is logged in and tries to access login page, redirect to dashboard
  if (user && isLoginPath) {
    const url = new URL(request.url);
    url.pathname = "/dashboard";
    url.search = "";
    return createRedirectResponse(url, mutatedCookies, 307);
  }

  return null;
}

/**
 * Standalone Web standard session proxy handler.
 * Evaluates session state and route access invariants for pure Request / Response consumers.
 */
export async function handleSessionProxy(request: Request): Promise<Response> {
  const pathname = normalizeRequestPathname(new URL(request.url).pathname);
  if (isPublicStaticAssetPath(pathname)) {
    return new Response(null, { status: 200 });
  }

  const incomingCookies = parseIncomingCookies(request);
  const mutatedCookies = new Map<string, ServerCookieRecord>();
  const cookieStore = createCookieStore(incomingCookies, mutatedCookies);
  const serverContext: ServerRequestContext = {
    cookies: cookieStore,
    headers: request.headers,
  };

  return await runWithServerRequestContext(serverContext, async () => {
    activeMutatedCookiesMap.set(serverContext, mutatedCookies);
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
  const pathname = normalizeRequestPathname(new URL(request.url).pathname);
  if (isPublicStaticAssetPath(pathname)) {
    await next();
    return;
  }

  const incomingCookies = parseIncomingCookies(request);
  const mutatedCookies = new Map<string, ServerCookieRecord>();
  const cookieStore = createCookieStore(incomingCookies, mutatedCookies);
  const serverContext: ServerRequestContext = {
    cookies: cookieStore,
    headers: request.headers,
  };

  let earlyResponse: Response | null = null;
  await runWithServerRequestContext(serverContext, async () => {
    activeMutatedCookiesMap.set(serverContext, mutatedCookies);
    earlyResponse = await evaluateSession(request, incomingCookies, mutatedCookies);
    if (!earlyResponse) {
      await next();
    }
  });

  if (earlyResponse) {
    return earlyResponse;
  }

  if (c.res && c.res.headers) {
    const existingSetCookie = c.res.headers.get("set-cookie") || "";
    for (const cookie of mutatedCookies.values()) {
      // Avoid re-appending bare empty/deleted cookies if already deleted in response headers
      if (
        isSupabaseAuthCookieName(cookie.name) &&
        (!cookie.value || cookie.options?.maxAge === 0) &&
        existingSetCookie.includes(`${cookie.name}=;`)
      ) {
        continue;
      }
      c.res.headers.append(
        "Set-Cookie",
        serializeCookie(cookie.name, cookie.value, cookie.options)
      );
    }
  }
});
