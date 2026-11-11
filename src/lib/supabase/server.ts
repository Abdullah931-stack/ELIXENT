import { createServerClient } from "@supabase/ssr";
import { resolveCookiesAndHeaders } from "@/server/context/request-context";

const TEST_PLACEHOLDER_SUPABASE_URL = "https://placeholder.supabase.co";
const TEST_PLACEHOLDER_SUPABASE_ANON_KEY = "placeholder-anon-key";

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

function resolveServerSupabaseCredentials(): {
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
            `[Supabase Server] Missing required Supabase credentials in non-test runtime: ${missingVars.join(", ")}. Placeholder fallback is restricted strictly to test environments.`
        );
    }

    return { supabaseUrl, supabaseAnonKey };
}

export async function createClient() {
    const { supabaseUrl, supabaseAnonKey } =
        resolveServerSupabaseCredentials();
    const { cookies: cookieStore } = await resolveCookiesAndHeaders();

    return createServerClient(
        supabaseUrl,
        supabaseAnonKey,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        );
                    } catch {
                        // Ignore cookie mutation errors in read-only or completed response contexts
                    }
                },
            },
        }
    );
}

// Get the current authenticated user
export async function getUser() {
    const supabase = await createClient();

    try {
        const { data: { user }, error } = await supabase.auth.getUser();

        if (error || !user) {
            return null;
        }

        return user;
    } catch (err) {
        console.warn('[Supabase Server] getUser network/auth exception:', err);
        return null;
    }
}

// Get the current session
export async function getSession() {
    const supabase = await createClient();

    try {
        const { data: { session }, error } = await supabase.auth.getSession();

        if (error || !session) {
            return null;
        }

        return session;
    } catch (err) {
        console.warn('[Supabase Server] getSession network/auth exception:', err);
        return null;
    }
}
