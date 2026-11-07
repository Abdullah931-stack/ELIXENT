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
 * Parses cookies from incoming Request headers or request.cookies helper (if present).
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

  const reqWithCookies = request as unknown as {
    cookies?: {
      getAll?: () => Array<{ name: string; value: string }>;
    };
  };

  if (typeof reqWithCookies.cookies?.getAll === "function") {
    try {
      const list = reqWithCookies.cookies.getAll();
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item.name === "string" && typeof item.value === "string") {
            map.set(item.name, item.value);
          }
        }
      }
    } catch {
      // Fallback silently if cookies.getAll throws
    }
  }

  return map;
}

/**
 * Decorates a Web standard Response with Set-Cookie headers and attaches a non-enumerable
 * cookies helper property compatible with Next.js NextResponse.cookies test assertions.
 */
function applyCookiesToResponse(
  response: Response,
  mutatedCookies: Map<string, ServerCookieRecord>,
  incomingCookies: Map<string, string>
): Response {
  for (const cookie of mutatedCookies.values()) {
    response.headers.append(
      "Set-Cookie",
      serializeCookie(cookie.name, cookie.value, cookie.options)
    );
  }

  Object.defineProperty(response, "cookies", {
    enumerable: false,
    configurable: true,
    value: {
      get(name: string) {
        const mutated = mutatedCookies.get(name);
        if (mutated) return { name: mutated.name, value: mutated.value };
        const val = incomingCookies.get(name);
        return val !== undefined ? { name, value: val } : undefined;
      },
      getAll() {
        const all = new Map<string, { name: string; value: string }>();
        for (const [k, v] of incomingCookies) all.set(k, { name: k, value: v });
        for (const [k, m] of mutatedCookies) all.set(k, { name: m.name, value: m.value });
        return Array.from(all.values());
      },
      set(
        nameOrCookie: string | { name: string; value: string; options?: Record<string, unknown> },
        maybeValue?: string,
        maybeOptions?: Record<string, unknown>
      ) {
        if (typeof nameOrCookie === "object" && nameOrCookie !== null) {
          mutatedCookies.set(nameOrCookie.name, {
            name: nameOrCookie.name,
            value: nameOrCookie.value,
            options: nameOrCookie.options,
          });
          response.headers.append(
            "Set-Cookie",
            serializeCookie(nameOrCookie.name, nameOrCookie.value, nameOrCookie.options)
          );
        } else {
          const name = String(nameOrCookie);
          const value = String(maybeValue ?? "");
          mutatedCookies.set(name, { name, value, options: maybeOptions });
          response.headers.append(
            "Set-Cookie",
            serializeCookie(name, value, maybeOptions)
          );
        }
      },
      delete(name: string) {
        mutatedCookies.set(name, { name, value: "", options: { maxAge: 0, path: "/" } });
        response.headers.append(
          "Set-Cookie",
          serializeCookie(name, "", { maxAge: 0, path: "/" })
        );
      },
    },
  });

  return response;
}

/**
 * Creates a 307 redirect response with mutated cookies applied.
 */
function createRedirectResponse(
  url: URL | string,
  mutatedCookies: Map<string, ServerCookieRecord>,
  incomingCookies: Map<string, string>
): Response {
  const destination = typeof url === "string" ? url : url.toString();
  const response = new Response(null, {
    status: 307,
    headers: {
      Location: destination,
    },
  });
  return applyCookiesToResponse(response, mutatedCookies, incomingCookies);
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
 * Core session evaluation logic porting src/proxy.ts invariants.
 * Returns an early Response (307 redirect or 401 unauthorized) or null if request is allowed to proceed.
 */
async function evaluateSession(
  request: Request,
  incomingCookies: Map<string, string>,
  mutatedCookies: Map<string, ServerCookieRecord>
): Promise<Response | null> {
  const supabaseUrl =
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "https://placeholder.supabase.co";
  const supabaseAnonKey =
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "placeholder-anon-key";

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        const all = new Map<string, { name: string; value: string }>();
        for (const [k, v] of incomingCookies) all.set(k, { name: k, value: v });
        for (const [k, m] of mutatedCookies) all.set(k, { name: m.name, value: m.value });
        return Array.from(all.values());
      },
      setAll(cookiesToSet) {
        const reqWithCookies = request as unknown as {
          cookies?: { set?: (name: string, value: string) => void };
        };
        cookiesToSet.forEach(({ name, value, options }) => {
          if (typeof reqWithCookies.cookies?.set === "function") {
            reqWithCookies.cookies.set(name, value);
          }
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
    return createRedirectResponse(url, mutatedCookies, incomingCookies);
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

  // If it's a Server Action or API request, never redirect to HTML login page (which breaks Server Action client runtime)
  const isActionOrApi =
    request.headers.has("next-action") || pathname.startsWith("/api/");

  if (isProtectedPath && !user) {
    if (isActionOrApi) {
      const res = new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
      return applyCookiesToResponse(res, mutatedCookies, incomingCookies);
    }

    // Redirect to login for page navigation
    const redirectTarget = `${pathname}${parsedUrl.search}`;
    const url = new URL(request.url);
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("redirectTo", redirectTarget);
    return createRedirectResponse(url, mutatedCookies, incomingCookies);
  }

  // If user is logged in and tries to access login page, redirect to dashboard
  if (user && isLoginPath) {
    const url = new URL(request.url);
    url.pathname = "/dashboard";
    url.search = "";
    return createRedirectResponse(url, mutatedCookies, incomingCookies);
  }

  return null;
}

/**
 * Standalone Web standard session proxy handler.
 * Provides identical semantics to src/proxy.ts for pure Request / Response consumers.
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
    return applyCookiesToResponse(passThroughResponse, mutatedCookies, incomingCookies);
  });
}

/**
 * Backward compatibility alias for handleSessionProxy.
 */
export const proxy = handleSessionProxy;

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

/**
 * Route matcher configuration for static asset exclusion.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|assets/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)",
  ],
};
