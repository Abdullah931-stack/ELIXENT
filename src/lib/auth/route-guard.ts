/**
 * Route Guard and Authentication Request Validation Utilities
 *
 * Pure utility module providing path normalization, route classification,
 * static asset exclusion, and cookie name validation.
 */

const PROTECTED_PREFIXES = ["/workspace", "/dashboard", "/account"] as const;
const BLOCKED_ASSET_PREFIXES = [
  "/workspace",
  "/dashboard",
  "/account",
  "/api",
  "/auth/callback",
] as const;

const STATIC_ASSET_EXTENSION_REGEX =
  /\.(?:ico|png|jpg|jpeg|svg|webp|gif|woff|woff2|ttf|eot|css|js|mjs|map|json|txt|xml)$/i;

const SUPABASE_AUTH_COOKIE_REGEX = /^(?:__(?:host|secure)-)?sb-/i;

/**
 * Normalizes request pathnames:
 * - Collapses duplicate slashes (e.g., //workspace -> /workspace).
 * - Safely decodes URL percent-encoding without throwing on malformed URI sequences.
 * - Trims query strings and hash fragments if present.
 */
export function normalizeRequestPathname(rawPath: string): string {
  if (!rawPath) {
    return "/";
  }

  let path = rawPath.trim();

  // Strip origin/scheme if an absolute URL is passed
  if (path.includes("://")) {
    try {
      path = new URL(path).pathname;
    } catch {
      const slashIdx = path.indexOf("/", path.indexOf("://") + 3);
      path = slashIdx !== -1 ? path.slice(slashIdx) : "/";
    }
  }

  // Strip query string and fragment
  const queryIdx = path.indexOf("?");
  if (queryIdx !== -1) {
    path = path.slice(0, queryIdx);
  }
  const hashIdx = path.indexOf("#");
  if (hashIdx !== -1) {
    path = path.slice(0, hashIdx);
  }

  // Safe percent-decoding: catch malformed URI sequence errors and decode valid portions
  try {
    path = decodeURIComponent(path);
  } catch {
    path = path.replace(/(%[0-9a-fA-F]{2})+/g, (match) => {
      try {
        return decodeURIComponent(match);
      } catch {
        return match;
      }
    });
  }

  // Collapse consecutive slashes
  path = path.replace(/\/+/g, "/");

  // Ensure leading slash
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  return path;
}

/**
 * Returns true if path is equal to or starts with `/workspace`, `/dashboard`, or `/account`
 * (case-insensitive, accounting for trailing slashes).
 */
export function isProtectedAppPath(pathname: string): boolean {
  const normalized = normalizeRequestPathname(pathname).toLowerCase();

  for (const prefix of PROTECTED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true for public static assets like images, fonts, and Vite client scripts.
 *
 * CRITICAL SECURITY INVARIANT:
 * Must NEVER match or bypass any path under `/workspace/`, `/dashboard/`,
 * `/account/`, `/api/`, or `/auth/callback`, even if ending with static extensions
 * (e.g. `/workspace/evil.png` must be protected!).
 */
export function isPublicStaticAssetPath(pathname: string): boolean {
  const normalized = normalizeRequestPathname(pathname).toLowerCase();

  // Critical boundary: explicitly reject all guarded paths from static bypass
  for (const prefix of BLOCKED_ASSET_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return false;
    }
  }

  // Common root static assets
  if (
    normalized === "/favicon.ico" ||
    normalized === "/robots.txt" ||
    normalized === "/sitemap.xml" ||
    normalized.startsWith("/assets/") ||
    normalized.startsWith("/@vite/") ||
    normalized.startsWith("/@fs/") ||
    normalized.startsWith("/@id/")
  ) {
    return true;
  }

  return STATIC_ASSET_EXTENSION_REGEX.test(normalized);
}

/**
 * Checks if the request is a safe navigation (GET or HEAD) targeting a protected app path.
 */
export function isGuardedPageNavigation(
  pathname: string,
  method: string
): boolean {
  const upperMethod = method.toUpperCase();
  const isSafeMethod = upperMethod === "GET" || upperMethod === "HEAD";
  return isSafeMethod && isProtectedAppPath(pathname);
}

/**
 * Returns true if the cookie name matches Supabase auth cookie patterns:
 * sb-*, __Host-sb-*, __Secure-sb-*.
 */
export function isSupabaseAuthCookieName(name: string): boolean {
  if (!name || typeof name !== "string") {
    return false;
  }
  return SUPABASE_AUTH_COOKIE_REGEX.test(name.trim());
}
