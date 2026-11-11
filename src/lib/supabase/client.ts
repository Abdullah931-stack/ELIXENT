/// <reference types="vite/client" />
import { createBrowserClient } from "@supabase/ssr";

const TEST_PLACEHOLDER_SUPABASE_URL = "https://placeholder.supabase.co";
const TEST_PLACEHOLDER_SUPABASE_ANON_KEY = "placeholder-anon-key";

function isTruthyEnvFlag(value: unknown): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value !== "string") {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "false" && normalized !== "0";
}

function readNonEmptyEnv(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function resolveBrowserSupabaseCredentials(): {
    supabaseUrl: string;
    supabaseAnonKey: string;
} {
    const isNode =
        typeof process !== "undefined" && Boolean(process.versions?.node);
    const nodeEnv = isNode
        ? (
              globalThis as {
                  process?: { env?: Record<string, string | undefined> };
              }
          ).process?.env
        : undefined;

    const rawUrl = isNode
        ? nodeEnv?.VITE_SUPABASE_URL
        : typeof import.meta !== "undefined" && import.meta.env
          ? import.meta.env.VITE_SUPABASE_URL
          : undefined;
    const rawAnonKey = isNode
        ? nodeEnv?.VITE_SUPABASE_ANON_KEY
        : typeof import.meta !== "undefined" && import.meta.env
          ? import.meta.env.VITE_SUPABASE_ANON_KEY
          : undefined;

    const isTestRuntime = isNode
        ? nodeEnv?.NODE_ENV === "test" || isTruthyEnvFlag(nodeEnv?.VITEST)
        : typeof import.meta !== "undefined" &&
          Boolean(import.meta.env) &&
          (import.meta.env.MODE === "test" ||
              isTruthyEnvFlag(import.meta.env.VITEST));

    const supabaseUrl = readNonEmptyEnv(rawUrl);
    const supabaseAnonKey = readNonEmptyEnv(rawAnonKey);

    if (isTestRuntime) {
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
            `[Supabase Client] Missing required Supabase credentials in non-test runtime: ${missingVars.join(", ")}. Placeholder fallback is restricted strictly to test environments.`
        );
    }

    return { supabaseUrl, supabaseAnonKey };
}

export function createClient() {
    const { supabaseUrl, supabaseAnonKey } =
        resolveBrowserSupabaseCredentials();

    return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
