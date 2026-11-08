import { AsyncLocalStorage } from "node:async_hooks";

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
 * 2. Ephemeral in-memory cookie store and empty `Headers` instance.
 */
export async function resolveCookiesAndHeaders(): Promise<ServerRequestContext> {
  const active = getActiveRequestContext();
  if (active) {
    return active;
  }

  return {
    cookies: createInMemoryCookieStore(),
    headers: new Headers(),
  };
}

export type ScheduleAfterResponseListener = (task: () => Promise<void> | void) => void;
let activeAfterListener: ScheduleAfterResponseListener | null = null;

export function setScheduleAfterResponseListener(listener: ScheduleAfterResponseListener | null): void {
  activeAfterListener = listener;
}

/**
 * Deterministic background task scheduler for post-response work (e.g. token settlement flush).
 * Supports test listeners to intercept background tasks deterministically.
 */
export function scheduleAfterResponse(task: () => Promise<void> | void): void {
  if (activeAfterListener) {
    activeAfterListener(task);
    return;
  }
  void Promise.resolve()
    .then(task)
    .catch((err) => {
      console.error("[AgentStream] Settlement flush error:", err);
    });
}
