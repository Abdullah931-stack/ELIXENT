import { Hono } from "hono";
import { createClient } from "@/lib/supabase/server";
import { syncUserToDatabase } from "@/server/actions/auth-actions";
import { resolveSafeRedirectPath } from "@/lib/auth/safe-redirect";
import {
  getActiveRequestContext,
  resolveCookiesAndHeaders,
  runWithServerRequestContext,
  type ServerCookieRecord,
  type ServerRequestContext,
} from "@/server/context/request-context";

function serializeCookie(
  name: string,
  value: string,
  options?: Record<string, unknown>
): string {
  let cookie = `${name}=${value}`;
  if (!options) return cookie;

  if (options.maxAge !== undefined && options.maxAge !== null) {
    cookie += `; Max-Age=${options.maxAge}`;
  }
  if (options.domain) cookie += `; Domain=${options.domain}`;
  if (options.path) cookie += `; Path=${options.path}`;
  if (options.expires) {
    const expiresDate =
      options.expires instanceof Date
        ? options.expires
        : new Date(options.expires as string | number);
    if (!Number.isNaN(expiresDate.getTime())) {
      cookie += `; Expires=${expiresDate.toUTCString()}`;
    }
  }
  if (options.httpOnly) cookie += `; HttpOnly`;
  if (options.secure) cookie += `; Secure`;
  if (options.sameSite) {
    const sameSiteStr = String(options.sameSite).toLowerCase();
    if (sameSiteStr === "lax") cookie += `; SameSite=Lax`;
    else if (sameSiteStr === "strict") cookie += `; SameSite=Strict`;
    else if (sameSiteStr === "none") cookie += `; SameSite=None`;
  }

  return cookie;
}

function parseRequestCookies(
  request: Request
): Array<{ name: string; value: string }> {
  const cookieMap = new Map<string, string>();
  const cookieHeader = request.headers.get("cookie");

  if (cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const trimmed = pair.trim();
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        cookieMap.set(
          trimmed.slice(0, eqIdx).trim(),
          trimmed.slice(eqIdx + 1).trim()
        );
      }
    }
  }

  return Array.from(cookieMap.entries()).map(([name, value]) => ({
    name,
    value,
  }));
}

function buildRedirectResponse(
  locationUrl: URL,
  mutatedCookies: Map<string, ServerCookieRecord>
): Response {
  const headers = new Headers({
    Location: locationUrl.toString(),
  });

  for (const cookie of mutatedCookies.values()) {
    headers.append(
      "Set-Cookie",
      serializeCookie(cookie.name, cookie.value, cookie.options)
    );
  }

  return new Response(null, {
    status: 307,
    headers,
  });
}

function createStandaloneCallbackContext(
  request: Request,
  baseContext: ServerRequestContext,
  standaloneMutatedCookies: Map<string, ServerCookieRecord>
): ServerRequestContext {
  const incomingCookies = parseRequestCookies(request);

  return {
    headers: request.headers,
    cookies: {
      getAll() {
        const merged = new Map<string, { name: string; value: string }>();
        for (const c of incomingCookies) {
          merged.set(c.name, { name: c.name, value: c.value });
        }
        for (const c of baseContext.cookies.getAll()) {
          merged.set(c.name, { name: c.name, value: c.value });
        }
        for (const [key, record] of standaloneMutatedCookies) {
          merged.set(key, { name: record.name, value: record.value });
        }
        return Array.from(merged.values());
      },
      set(name: string, value: string, options?: Record<string, unknown>) {
        baseContext.cookies.set(name, value, options);
        standaloneMutatedCookies.set(name, { name, value, options });
      },
      delete(name: string) {
        baseContext.cookies.delete(name);
        standaloneMutatedCookies.set(name, {
          name,
          value: "",
          options: { maxAge: 0, path: "/" },
        });
      },
    },
  };
}

/**
 * GET /auth/callback
 * Exchanges an OAuth authorization code for a Supabase user session,
 * synchronizes the user record to Neon PostgreSQL, and redirects to a validated internal path.
 */
export async function handleAuthCallbackGet(
  request: Request
): Promise<Response> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const safeRedirectPath = resolveSafeRedirectPath(
    searchParams.get("redirectTo"),
    "/dashboard"
  );

  // Enforce trusted origin: never trust spoofable x-forwarded-host headers blindly
  const trustedOrigin =
    process.env.VITE_APP_URL || process.env.NEXT_PUBLIC_APP_URL || origin;

  const standaloneMutatedCookies = new Map<string, ServerCookieRecord>();

  const executeExchange = async (): Promise<Response> => {
    if (code) {
      const supabase = await createClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);

      if (!error) {
        try {
          await syncUserToDatabase();
        } catch (syncErr) {
          console.error(
            "[Auth Callback] Failed to sync user to database:",
            syncErr
          );
        }

        return buildRedirectResponse(
          new URL(safeRedirectPath, trustedOrigin),
          standaloneMutatedCookies
        );
      }

      console.error(
        "[Auth Callback] exchangeCodeForSession error:",
        error.message
      );
    }

    return buildRedirectResponse(
      new URL("/login?error=auth_failed", trustedOrigin),
      standaloneMutatedCookies
    );
  };

  if (getActiveRequestContext() !== null) {
    return await executeExchange();
  }

  const baseContext = await resolveCookiesAndHeaders();
  const scopedContext = createStandaloneCallbackContext(
    request,
    baseContext,
    standaloneMutatedCookies
  );
  return await runWithServerRequestContext(scopedContext, executeExchange);
}

export const authCallbackRoutes = new Hono().get("/", (c) =>
  handleAuthCallbackGet(c.req.raw)
);
