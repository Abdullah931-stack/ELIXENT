import { Hono } from "hono";
import { createServerClient } from "@supabase/ssr";
import {
  createClient as createAdminClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { db, schema } from "@/server/db";

interface SessionCookieRecord {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

interface E2EUserTierInput {
  userId: string;
  email: string;
  displayName: string;
  tier: "free" | "pro" | "ultra";
}

function isAllowedEnvironment(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return process.env.NODE_ENV === "test" || process.env.PLAYWRIGHT === "1";
}

function resolveSupabaseCredentials(): {
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
} {
  return {
    supabaseUrl: process.env.VITE_SUPABASE_URL!,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

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

async function resolveOrCreateAuthUser(
  admin: SupabaseClient,
  email: string,
  password: string,
  displayName: string
): Promise<{ user: User | null; errorMessage?: string }> {
  const { data: listData } = await admin.auth.admin.listUsers();
  const existing = listData?.users.find((u) => u.email === email);
  if (existing) {
    return { user: existing };
  }

  const { data: createData, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: displayName },
    });

  if (createError) {
    return { user: null, errorMessage: createError.message };
  }
  return { user: createData.user };
}

async function upsertE2EUserRecord(input: E2EUserTierInput): Promise<void> {
  const creditBalanceMicro =
    input.tier === "ultra"
      ? BigInt(3500000000)
      : input.tier === "pro"
        ? BigInt(1000000000)
        : BigInt(50000000);

  await db
    .insert(schema.users)
    .values({
      id: input.userId,
      email: input.email,
      displayName: input.displayName,
      tier: input.tier,
      creditBalanceMicro,
    })
    .onConflictDoUpdate({
      target: schema.users.id,
      set: {
        displayName: input.displayName,
        tier: input.tier,
        creditBalanceMicro,
        updatedAt: new Date(),
      },
    });
}

async function establishSsrSessionCookies(
  request: Request,
  accessToken: string,
  refreshToken: string
): Promise<Array<{ name: string; value: string; path: string }>> {
  const { supabaseUrl, anonKey } = resolveSupabaseCredentials();
  const incomingCookies = parseRequestCookies(request);
  const sessionCookiesMap = new Map<string, SessionCookieRecord>();

  const ssrClient = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        const merged = new Map<string, { name: string; value: string }>();
        for (const c of incomingCookies) {
          merged.set(c.name, { name: c.name, value: c.value });
        }
        for (const [key, record] of sessionCookiesMap) {
          merged.set(key, { name: record.name, value: record.value });
        }
        return Array.from(merged.values());
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          sessionCookiesMap.set(name, {
            name,
            value,
            options: options as Record<string, unknown> | undefined,
          });
        });
      },
    },
  });

  await ssrClient.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  return Array.from(sessionCookiesMap.values()).map((c) => ({
    name: c.name,
    value: c.value,
    path: (c.options?.path as string) || "/",
  }));
}

/**
 * POST /api/test/e2e-auth
 * Establishes an authentic Supabase test session and syncs the user to the isolated Neon database.
 */
export async function handleE2EAuthPost(request: Request): Promise<Response> {
  if (!isAllowedEnvironment()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  try {
    const body = await request.json();
    const email = body.email || "e2e-runner@lugx.test";
    const password = body.password || "E2E_Secure_Pass_2026!";
    const displayName = body.displayName || "E2E Test User";
    const tier = (body.tier || "free") as "free" | "pro" | "ultra";

    const { supabaseUrl, anonKey, serviceKey } = resolveSupabaseCredentials();
    const admin = createAdminClient(supabaseUrl, serviceKey);
    const anon = createAdminClient(supabaseUrl, anonKey);

    const { user, errorMessage } = await resolveOrCreateAuthUser(
      admin,
      email,
      password,
      displayName
    );
    if (errorMessage || !user) {
      return Response.json(
        { error: errorMessage || "Failed to create user" },
        { status: 400 }
      );
    }

    const { data: sessionData, error: signInError } =
      await anon.auth.signInWithPassword({ email, password });

    if (signInError || !sessionData.session) {
      return Response.json(
        { error: signInError?.message || "Failed to establish session" },
        { status: 400 }
      );
    }

    await upsertE2EUserRecord({
      userId: user.id,
      email: user.email || email,
      displayName,
      tier,
    });

    const cookiesForClient = await establishSsrSessionCookies(
      request,
      sessionData.session.access_token,
      sessionData.session.refresh_token
    );

    const headers = new Headers({
      "Content-Type": "application/json",
    });

    for (const c of cookiesForClient) {
      headers.append(
        "Set-Cookie",
        serializeCookie(c.name, c.value, {
          path: c.path,
          sameSite: "lax",
          httpOnly: false,
          secure: false,
        })
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        success: true,
        user: {
          id: user.id,
          email: user.email,
          displayName,
        },
        session: {
          accessToken: sessionData.session.access_token,
          expiresAt: sessionData.session.expires_at,
        },
        cookies: cookiesForClient,
      }),
      { status: 200, headers }
    );
  } catch (error) {
    console.error("[E2E Auth API] Error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/test/e2e-auth
 * Signs out and clears all Supabase session cookies.
 */
export async function handleE2EAuthDelete(request: Request): Promise<Response> {
  if (!isAllowedEnvironment()) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  const { supabaseUrl, anonKey } = resolveSupabaseCredentials();
  const incomingCookies = parseRequestCookies(request);
  const mutatedCookies = new Map<string, SessionCookieRecord>();

  const ssrClient = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return incomingCookies;
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          mutatedCookies.set(name, {
            name,
            value,
            options: options as Record<string, unknown> | undefined,
          });
        });
      },
    },
  });

  await ssrClient.auth.signOut();

  for (const c of incomingCookies) {
    if (c.name.startsWith("sb-")) {
      mutatedCookies.set(c.name, {
        name: c.name,
        value: "",
        options: { maxAge: 0, path: "/" },
      });
    }
  }

  const headers = new Headers({
    "Content-Type": "application/json",
  });

  for (const cookie of mutatedCookies.values()) {
    headers.append(
      "Set-Cookie",
      serializeCookie(cookie.name, cookie.value, cookie.options)
    );
  }

  return new Response(
    JSON.stringify({ ok: true, success: true, message: "Logged out" }),
    { status: 200, headers }
  );
}

export const e2eAuthRoutes = new Hono()
  .post("/", (c) => handleE2EAuthPost(c.req.raw))
  .delete("/", (c) => handleE2EAuthDelete(c.req.raw));
