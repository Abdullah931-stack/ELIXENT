/**
 * Canonical Application URL Resolution
 *
 * Centralizes server-side base URL resolution, environment-aware TLS checks,
 * and safe path joining while preserving Stripe Checkout template placeholders.
 */

const DEFAULT_DEV_APP_URL = "http://localhost:3000";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const STRIPE_TEMPLATE_TOKEN_RE = /\{[A-Za-z0-9_]+\}/g;
const EXPLICIT_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const UNSAFE_PATH_CHARS_RE =
    /[\u0000-\u001F\u007F\\\uFF0F\uFE68\uFF3C\u200B-\u200D\uFEFF\u2028\u2029]/;

function applyProtocolPolicy(parsed: URL, isProduction: boolean): void {
    if (isProduction) {
        if (parsed.protocol !== "https:") {
            throw new Error(
                `Invalid APP_URL / VITE_APP_URL in production: expected https:// protocol, received "${parsed.protocol}".`
            );
        }
        return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
            `Invalid APP_URL / VITE_APP_URL protocol "${parsed.protocol}": expected http:// or https://.`
        );
    }

    // Downgrade only exact loopback hosts in non-production so remote hosts containing
    // "localhost" as a substring never lose TLS protection.
    if (parsed.protocol === "https:" && LOOPBACK_HOSTS.has(parsed.hostname)) {
        parsed.protocol = "http:";
    }
}

function parseConfiguredBaseUrl(rawUrl: string, isProduction: boolean): URL {
    if (UNSAFE_PATH_CHARS_RE.test(rawUrl)) {
        throw new Error(
            "Invalid APP_URL / VITE_APP_URL configuration: contains unsafe control characters or backslashes."
        );
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(
            `Invalid APP_URL / VITE_APP_URL configuration: "${rawUrl}" is not a valid URL.`
        );
    }

    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(
            "Invalid APP_URL / VITE_APP_URL configuration: base URL must not contain credentials, query parameters, or hash fragments."
        );
    }

    applyProtocolPolicy(parsed, isProduction);
    return parsed;
}

function preserveTemplateTokens(rawPath: string): {
    encodedPath: string;
    restore: (url: string) => string;
} {
    let sentinelPrefix = "__ELIXENT_URL_TPL_";
    while (rawPath.includes(sentinelPrefix)) {
        sentinelPrefix += "X_";
    }

    const tokens: Array<{ sentinel: string; original: string }> = [];
    const encodedPath = rawPath.replace(STRIPE_TEMPLATE_TOKEN_RE, (match) => {
        const sentinel = `${sentinelPrefix}${tokens.length}__`;
        tokens.push({ sentinel, original: match });
        return sentinel;
    });

    const restore = (url: string): string => {
        let restored = url;
        for (const { sentinel, original } of tokens) {
            restored = restored.replaceAll(sentinel, original);
        }
        return restored;
    };

    return { encodedPath, restore };
}

function assertSameOrigin(candidate: URL, base: URL, originalPath: string): void {
    if (
        candidate.origin !== base.origin ||
        candidate.protocol !== base.protocol ||
        candidate.pathname.startsWith("//")
    ) {
        throw new Error(`Resolved app URL escaped configured origin for path: "${originalPath}".`);
    }
}

/**
 * Resolves and validates the canonical application base URL without trailing slashes.
 * Precedence: APP_URL -> VITE_APP_URL (never reads legacy NEXT_PUBLIC_APP_URL).
 */
export function getAppBaseUrl(): string {
    const isProduction = process.env.NODE_ENV === "production";
    const rawUrl =
        process.env.APP_URL?.trim() ||
        process.env.VITE_APP_URL?.trim() ||
        "";

    if (!rawUrl) {
        if (isProduction) {
            throw new Error(
                "APP_URL (or VITE_APP_URL) must be configured with an https:// URL in production."
            );
        }
        return DEFAULT_DEV_APP_URL;
    }

    const parsed = parseConfiguredBaseUrl(rawUrl, isProduction);
    const cleanPathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${cleanPathname}`;
}

/**
 * Resolves an internal relative path against the validated application base URL.
 * Preserves literal Stripe template tokens such as `{CHECKOUT_SESSION_ID}` while
 * blocking protocol-relative, path-traversal, and cross-origin open redirects.
 */
export function resolveAppUrl(path?: string): string {
    const baseUrl = getAppBaseUrl();
    const trimmedPath = path?.trim() ?? "";
    if (!trimmedPath) {
        return baseUrl;
    }

    if (
        UNSAFE_PATH_CHARS_RE.test(trimmedPath) ||
        trimmedPath.startsWith("//") ||
        EXPLICIT_SCHEME_RE.test(trimmedPath)
    ) {
        throw new Error(`Refusing unsafe or non-relative app URL path: "${path}".`);
    }

    // Block path traversal escapes (e.g. /../admin or ../admin or sub/../)
    const rawSegments = trimmedPath.split(/[\\/]/);
    if (rawSegments.some((seg) => seg === ".." || seg === ".")) {
        throw new Error(`Refusing path traversal in app URL path: "${path}".`);
    }

    const { encodedPath, restore } = preserveTemplateTokens(trimmedPath);
    const baseParsed = new URL(baseUrl);

    // Validate structure directly against origin before relative joining to catch URL-parser escapes
    assertSameOrigin(new URL(encodedPath, baseParsed.origin), baseParsed, path ?? "");

    const relativeTarget = encodedPath.replace(/^\/+/, "");
    const resolved = new URL(relativeTarget, `${baseUrl}/`);
    assertSameOrigin(resolved, baseParsed, path ?? "");

    const basePath = baseParsed.pathname.replace(/\/+$/, "");
    if (basePath && basePath !== "/") {
        const requiredPrefix = `${basePath}/`;
        if (resolved.pathname !== basePath && !resolved.pathname.startsWith(requiredPrefix)) {
            throw new Error(`Resolved app URL escaped configured base path for path: "${path}".`);
        }
    }

    return restore(resolved.toString());
}

/**
 * Resolves and validates that an input URL (either a relative path or an absolute URL)
 * strictly matches the canonical application origin and HTTPS security policy.
 *
 * Rejects cross-origin URLs, protocol downgrades, credentials, and path traversals.
 */
export function resolveSameOriginAppUrl(inputUrl: string): string {
    if (!inputUrl || typeof inputUrl !== "string") {
        throw new Error("Invalid app URL: URL string is empty or missing.");
    }

    const trimmed = inputUrl.trim();
    if (!trimmed) {
        throw new Error("Invalid app URL: URL string cannot be blank.");
    }

    if (UNSAFE_PATH_CHARS_RE.test(trimmed)) {
        throw new Error(`Refusing unsafe app URL: contains control characters or backslashes: "${inputUrl}".`);
    }

    if (trimmed.startsWith("//")) {
        throw new Error(`Refusing protocol-relative app URL: "${inputUrl}".`);
    }

    const baseUrl = getAppBaseUrl();
    const baseParsed = new URL(baseUrl);
    const isProduction = process.env.NODE_ENV === "production";

    // If it has an explicit scheme (e.g. https://, http://, javascript:), parse as absolute URL
    if (EXPLICIT_SCHEME_RE.test(trimmed)) {
        let parsed: URL;
        try {
            parsed = new URL(trimmed);
        } catch {
            throw new Error(`Invalid absolute app URL: "${inputUrl}".`);
        }

        if (parsed.username || parsed.password) {
            throw new Error(`Refusing app URL containing user credentials: "${inputUrl}".`);
        }

        // Enforce HTTPS policy
        applyProtocolPolicy(parsed, isProduction);

        // Enforce strict origin match
        if (parsed.origin !== baseParsed.origin) {
            throw new Error(
                `Cross-origin app URL rejected: "${parsed.origin}" does not match configured base origin "${baseParsed.origin}".`
            );
        }

        // Verify pathname starts with configured base path
        const basePath = baseParsed.pathname.replace(/\/+$/, "");
        if (basePath && basePath !== "/") {
            const requiredPrefix = `${basePath}/`;
            if (parsed.pathname !== basePath && !parsed.pathname.startsWith(requiredPrefix)) {
                throw new Error(
                    `Resolved app URL escaped configured base path "${basePath}": "${inputUrl}".`
                );
            }
        }

        return parsed.toString();
    }

    // Relative path: resolve through resolveAppUrl
    return resolveAppUrl(trimmed);
}
