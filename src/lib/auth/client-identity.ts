import type { createClient } from "@/lib/supabase/client";
import { resolveSafeRedirectPath } from "@/lib/auth/safe-redirect";

export interface LocalClientUserIdentity {
    id: string;
    source: "cookie" | "storage" | "server";
}

/**
 * Builds a safe `/login?redirectTo=...` path from the current or provided relative path.
 * Falls back to `"/login"` when no valid non-`/login`, non-root internal path is available.
 */
export function buildLoginRedirectPath(currentPath?: string): string {
    const rawPath =
        currentPath !== undefined
            ? currentPath
            : typeof window !== "undefined" && window.location
              ? `${window.location.pathname}${window.location.search}`
              : "";

    if (!rawPath) {
        return "/login";
    }

    const safePath = resolveSafeRedirectPath(rawPath, "/login");
    if (
        !safePath ||
        safePath === "/" ||
        safePath === "/login" ||
        safePath.startsWith("/login?") ||
        safePath.startsWith("/login/")
    ) {
        return "/login";
    }

    return `/login?redirectTo=${encodeURIComponent(safePath)}`;
}

function safeBase64Decode(str: string): string | null {
    try {
        if (!str || typeof str !== "string") return null;
        let normalized = str.replace(/-/g, "+").replace(/_/g, "/");
        while (normalized.length % 4 !== 0) {
            normalized += "=";
        }
        if (typeof atob === "function") {
            const binary = atob(normalized);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return new TextDecoder().decode(bytes);
        } else if (typeof Buffer !== "undefined") {
            return Buffer.from(normalized, "base64").toString("utf-8");
        }
    } catch {
        return null;
    }
    return null;
}

function extractSubFromJwt(token: string): string | null {
    if (!token || typeof token !== "string") return null;
    const parts = token.trim().split(".");
    if (parts.length < 2) return null;
    const payloadSegment = parts[1];
    const decodedPayload = safeBase64Decode(payloadSegment);
    if (!decodedPayload) return null;
    try {
        const parsed = JSON.parse(decodedPayload);
        if (parsed && typeof parsed.sub === "string" && parsed.sub.trim().length > 0) {
            return parsed.sub.trim();
        }
    } catch {
        return null;
    }
    return null;
}

function parseUserIdFromJson(jsonStr: string): string | null {
    try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== "object") return null;

        if (parsed.user && typeof parsed.user === "object" && typeof parsed.user.id === "string") {
            const uid = parsed.user.id.trim();
            if (uid) return uid;
        }

        if (typeof parsed.id === "string") {
            const uid = parsed.id.trim();
            if (uid) return uid;
        }

        if (typeof parsed.access_token === "string") {
            const uid = extractSubFromJwt(parsed.access_token);
            if (uid) return uid;
        }

        if (Array.isArray(parsed) && typeof parsed[0] === "string") {
            const uid = extractSubFromJwt(parsed[0]);
            if (uid) return uid;
        }

        if (parsed.session && typeof parsed.session === "object") {
            if (parsed.session.user && typeof parsed.session.user.id === "string") {
                const uid = parsed.session.user.id.trim();
                if (uid) return uid;
            }
            if (typeof parsed.session.access_token === "string") {
                const uid = extractSubFromJwt(parsed.session.access_token);
                if (uid) return uid;
            }
        }
    } catch {
        return null;
    }
    return null;
}

function extractUserIdFromRawSession(raw: string): string | null {
    if (!raw || typeof raw !== "string") return null;

    let processed = raw.trim();
    if (processed.startsWith('"') && processed.endsWith('"') && processed.length >= 2) {
        processed = processed.slice(1, -1).trim();
    }

    try {
        processed = decodeURIComponent(processed);
    } catch {
        // Fall back to undecoded string
    }

    if (processed.startsWith("base64-")) {
        const base64Data = processed.slice(7);
        const decodedJson = safeBase64Decode(base64Data);
        if (decodedJson) {
            const uid = parseUserIdFromJson(decodedJson);
            if (uid) return uid;
        }
    }

    const directUid = parseUserIdFromJson(processed);
    if (directUid) return directUid;

    const decodedEntire = safeBase64Decode(processed);
    if (decodedEntire) {
        const uid = parseUserIdFromJson(decodedEntire);
        if (uid) return uid;
    }

    const jwtUid = extractSubFromJwt(processed);
    if (jwtUid) return jwtUid;

    return null;
}

function parseCookieMap(cookieStr: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!cookieStr) return map;
    const parts = cookieStr.split(";");
    for (const part of parts) {
        const trimmed = part.trim();
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            map.set(key, val);
        }
    }
    return map;
}

interface ChunkedCookie {
    index: number;
    value: string;
}

function parseSupabaseCookies(cookieMap: Map<string, string>): string | null {
    const grouped = new Map<string, ChunkedCookie[]>();
    const sbRegex = /^(sb-.*-auth-token)(?:\.(\d+))?$/;

    for (const [name, value] of cookieMap.entries()) {
        const match = sbRegex.exec(name);
        if (match) {
            const baseName = match[1];
            const chunkIndex = match[2] !== undefined ? parseInt(match[2], 10) : -1;
            if (!grouped.has(baseName)) {
                grouped.set(baseName, []);
            }
            grouped.get(baseName)!.push({ index: chunkIndex, value });
        }
    }

    for (const [, chunks] of grouped.entries()) {
        chunks.sort((a, b) => a.index - b.index);
        const assembled = chunks.map((c) => c.value).join("");
        const uid = extractUserIdFromRawSession(assembled);
        if (uid) {
            return uid;
        }
    }

    return null;
}

function isExplicitAuthRejection(error: unknown, status?: number): boolean {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return false;
    }
    if (status === 401 || status === 403) {
        return true;
    }
    if (error && typeof error === "object") {
        const errObj = error as { status?: number; code?: string; message?: string; name?: string };
        if (errObj.status === 401 || errObj.status === 403) {
            return true;
        }
        const message = (errObj.message || "").toLowerCase();
        if (
            errObj.name === "AbortError" ||
            message.includes("abort") ||
            message.includes("fetch") ||
            message.includes("network") ||
            message.includes("offline") ||
            message.includes("timeout") ||
            message.includes("load failed") ||
            message.includes("failed to fetch")
        ) {
            return false;
        }
        if (
            errObj.code === "session_expired" ||
            errObj.code === "invalid_jwt" ||
            message.includes("jwt expired") ||
            message.includes("session expired") ||
            message.includes("invalid refresh token") ||
            message.includes("refresh_token_not_found")
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Synchronously extracts the verified user ID (0ms) from local browser cookies
 * (elixent_uid or sb-*-auth-token including chunked .0/.1 cookies) or localStorage fallback.
 */
export function resolveInitialClientUserIdSync(): string | null {
    if (typeof document !== "undefined") {
        try {
            const cookieMap = parseCookieMap(document.cookie);

            const elixentUid = cookieMap.get("elixent_uid");
            if (elixentUid) {
                try {
                    const decoded = decodeURIComponent(elixentUid).trim();
                    if (decoded.length > 0) {
                        return decoded;
                    }
                } catch {
                    const trimmed = elixentUid.trim();
                    if (trimmed.length > 0) {
                        return trimmed;
                    }
                }
            }

            const supabaseUid = parseSupabaseCookies(cookieMap);
            if (supabaseUid) {
                persistLocalClientUserId(supabaseUid);
                return supabaseUid;
            }
        } catch {
            // Non-blocking fallback
        }
    }

    if (typeof window !== "undefined" && window.localStorage) {
        try {
            const localUid = window.localStorage.getItem("elixent_uid");
            if (localUid && localUid.trim().length > 0) {
                const trimmed = localUid.trim();
                persistLocalClientUserId(trimmed);
                return trimmed;
            }

            for (let i = 0; i < window.localStorage.length; i++) {
                const key = window.localStorage.key(i);
                if (key && key.startsWith("sb-") && key.includes("auth-token")) {
                    const storedVal = window.localStorage.getItem(key);
                    if (storedVal) {
                        const extracted = extractUserIdFromRawSession(storedVal);
                        if (extracted) {
                            persistLocalClientUserId(extracted);
                            return extracted;
                        }
                    }
                }
            }
        } catch {
            // Ignore storage security restrictions
        }
    }

    return null;
}

/**
 * Persists the verified user ID in a readable first-party cookie (elixent_uid)
 * for offline cold starts and Better Auth HttpOnly compatibility.
 */
export function persistLocalClientUserId(userId: string): void {
    if (!userId || typeof userId !== "string") return;
    const trimmed = userId.trim();
    if (!trimmed) return;

    if (typeof document !== "undefined") {
        try {
            document.cookie = `elixent_uid=${encodeURIComponent(trimmed)}; Path=/; SameSite=Lax; Max-Age=2592000`;
        } catch {
            // Ignore cookie write failure in restricted environments
        }
    }

    if (typeof window !== "undefined" && window.localStorage) {
        try {
            window.localStorage.setItem("elixent_uid", trimmed);
        } catch {
            // Ignore localStorage quota or access errors
        }
    }
}

/**
 * Clears local identity artifacts upon sign-out or explicit server session expiration.
 */
export function clearLocalClientUserId(): void {
    if (typeof document !== "undefined") {
        try {
            document.cookie = "elixent_uid=; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
        } catch {
            // Ignore cookie removal failure
        }
    }

    if (typeof window !== "undefined" && window.localStorage) {
        try {
            window.localStorage.removeItem("elixent_uid");
        } catch {
            // Ignore localStorage removal failure
        }
    }
}

/**
 * Executes dual-mode Local-First identity verification:
 * - Returns local cookie identity immediately when present.
 * - When online, verifies the session against the server in the background and invokes
 *   onSessionExpired only on explicit server auth rejection (never on network errors).
 * - When offline, trusts the local cookie identity and defers server verification until online.
 */
export async function resolveLocalFirstAuthUser(options?: {
    onSessionExpired?: () => void;
    signal?: AbortSignal;
}): Promise<{ id: string; [key: string]: unknown } | null> {
    const signal = options?.signal;
    const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;

    let client: ReturnType<typeof createClient> | null = null;
    try {
        const mod = await import("@/lib/supabase/client");
        client = mod.createClient();
    } catch {
        client = null;
    }

    const localUserId = resolveInitialClientUserIdSync();

    if (localUserId) {
        if (!isOffline && !signal?.aborted && client && typeof client.auth?.getUser === "function") {
            void (async () => {
                try {
                    if (signal?.aborted) return;
                    const { data, error } = await client.auth.getUser();
                    if (signal?.aborted) return;
                    if (data?.user?.id) {
                        persistLocalClientUserId(data.user.id);
                    } else if (error) {
                        const status = (error as { status?: number })?.status;
                        const isStillOnline = typeof navigator === "undefined" || navigator.onLine !== false;
                        if (!signal?.aborted && isStillOnline && isExplicitAuthRejection(error, status)) {
                            clearLocalClientUserId();
                            options?.onSessionExpired?.();
                        }
                    }
                } catch (err) {
                    if (signal?.aborted) return;
                    const isStillOnline = typeof navigator === "undefined" || navigator.onLine !== false;
                    if (isStillOnline && isExplicitAuthRejection(err)) {
                        clearLocalClientUserId();
                        options?.onSessionExpired?.();
                    }
                }
            })();
        }
        return { id: localUserId };
    }

    if (signal?.aborted || isOffline || !client || typeof client.auth?.getUser !== "function") {
        return null;
    }

    try {
        const { data, error } = await client.auth.getUser();
        if (signal?.aborted) {
            return null;
        }
        if (data?.user?.id) {
            persistLocalClientUserId(data.user.id);
            return { ...data.user, id: data.user.id };
        }

        const status = (error as { status?: number })?.status;
        const isStillOnline = typeof navigator === "undefined" || navigator.onLine !== false;
        if (
            !signal?.aborted &&
            isStillOnline &&
            (isExplicitAuthRejection(error, status) || (!error && data?.user === null))
        ) {
            clearLocalClientUserId();
            options?.onSessionExpired?.();
        }
        return null;
    } catch (err) {
        if (signal?.aborted) {
            return null;
        }
        const isStillOnline = typeof navigator === "undefined" || navigator.onLine !== false;
        if (isStillOnline && isExplicitAuthRejection(err)) {
            clearLocalClientUserId();
            options?.onSessionExpired?.();
        }
        return null;
    }
}
