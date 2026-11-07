import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
    const supabaseUrl =
        (typeof process !== "undefined" &&
            (process.env?.VITE_SUPABASE_URL || process.env?.NEXT_PUBLIC_SUPABASE_URL)) ||
        (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_SUPABASE_URL ||
        (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.NEXT_PUBLIC_SUPABASE_URL ||
        "https://placeholder.supabase.co";

    const supabaseAnonKey =
        (typeof process !== "undefined" &&
            (process.env?.VITE_SUPABASE_ANON_KEY || process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY)) ||
        (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_SUPABASE_ANON_KEY ||
        (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        "placeholder-anon-key";

    return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
