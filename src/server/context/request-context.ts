import { AsyncLocalStorage } from "node:async_hooks";
import * as nextServer from "next/server";

export interface ServerCookieRecord {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

export interface ServerCookieStore {
  getAll(): Array<{ name: string; value: string }>;
  set(name: string, value: string, options?: Record<string, unknown>): void;
  delete(name: string): void;
}

export interface ServerRequestContext {
  cookies: ServerCookieStore;
  headers: Headers;
}

const requestContextStorage = new AsyncLocalStorage<ServerRequestContext>();

/**
 * Executes `fn` within an active request-scoped `ServerRequestContext` bound via `AsyncLocalStorage`.
 */
export async function runWithServerRequestContext<T>(
  ctx: ServerRequestContext,
  fn: () => Promise<T> | T
): Promise<T> {
  return await requestContextStorage.run(ctx, fn);
}

/**
 * Returns the currently active `ServerRequestContext` from `AsyncLocalStorage`, or `null` if outside a bound request.
 */
export function getActiveRequestContext(): ServerRequestContext | null {
  return requestContextStorage.getStore() ?? null;
}

/**
 * Creates a clean in-memory `ServerCookieStore` backed by a `Map`.
 */
export function createInMemoryCookieStore(
  initialCookies?: Array<{ name: string; value: string }>
): ServerCookieStore {
  const map = new Map<string, string>();
  if (initialCookies) {
    for (const c of initialCookies) {
      map.set(c.name, c.value);
    }
  }
  return {
    getAll() {
      return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
    },
    set(name: string, value: string) {
      map.set(name, value);
    },
    delete(name: string) {
      map.delete(name);
    },
  };
}

/**
 * Resolves the request-scoped `cookies` and `headers`.
 *
 * Priority:
 * 1. Active `AsyncLocalStorage` context populated by Hono middleware (`runWithServerRequestContext`).
 * 2. Transitional fallback to `next/headers` (for unit/live tests that mock `next/headers` and invoke server functions directly during Phases 1..5).
 * 3. Ephemeral in-memory cookie store and empty `Headers` instance.
 */
export async function resolveCookiesAndHeaders(): Promise<ServerRequestContext> {
  const active = getActiveRequestContext();
  if (active) {
    return active;
  }

  let resolvedCookies: ServerCookieStore | null = null;
  let resolvedHeaders: Headers | null = null;

  try {
    const nextHeaders = await import("next/headers");

    if (typeof nextHeaders.cookies === "function") {
      try {
        const rawCookieStore = await nextHeaders.cookies();
        if (rawCookieStore && typeof rawCookieStore === "object") {
          const fallbackStore = createInMemoryCookieStore();
          resolvedCookies = {
            getAll() {
              if (typeof rawCookieStore.getAll === "function") {
                return rawCookieStore.getAll();
              }
              return fallbackStore.getAll();
            },
            set(name: string, value: string, options?: Record<string, unknown>) {
              if (typeof rawCookieStore.set === "function") {
                rawCookieStore.set(name, value, options as never);
              } else {
                fallbackStore.set(name, value, options);
              }
            },
            delete(name: string) {
              if (typeof rawCookieStore.delete === "function") {
                rawCookieStore.delete(name);
              } else {
                fallbackStore.delete(name);
              }
            },
          };
        }
      } catch {
        // `cookies()` called outside Next.js request context or unmocked in test
      }
    }

    if (typeof nextHeaders.headers === "function") {
      try {
        const rawHeaders = await nextHeaders.headers();
        if (rawHeaders) {
          resolvedHeaders = rawHeaders as unknown as Headers;
        }
      } catch {
        // `headers()` called outside Next.js request context or unmocked in test
      }
    }
  } catch {
    // `next/headers` unavailable
  }

  return {
    cookies: resolvedCookies ?? createInMemoryCookieStore(),
    headers: resolvedHeaders ?? new Headers(),
  };
}

/**
 * Deterministic background task scheduler for post-response work (e.g. token settlement flush).
 *
 * During Phases 1..5, delegates to `next/server`'s `after()` when available and within a valid scope
 * (or when intercepted by `vi.mock("next/server")` in unit tests), and falls back to an asynchronous
 * microtask promise chain otherwise.
 */
export function scheduleAfterResponse(task: () => Promise<void> | void): void {
  try {
    if (typeof nextServer.after === "function") {
      nextServer.after(task);
      return;
    }
  } catch {
    // `after()` throws when invoked outside a Next.js request context (e.g. Hono runtime or standalone test)
  }

  void Promise.resolve()
    .then(task)
    .catch((err) => {
      console.error("[AgentStream] Settlement flush error:", err);
    });
}
