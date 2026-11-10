import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
    const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);
    const metaEnv = (
        import.meta as ImportMeta & {
            env?: Record<string, string | undefined>;
        }
    ).env;
    const nodeEnv = (
        globalThis as {
            process?: { env?: Record<string, string | undefined> };
        }
    ).process?.env;
    const supabaseUrl =
        (isNode ? nodeEnv?.VITE_SUPABASE_URL : metaEnv?.VITE_SUPABASE_URL) ||
        "https://placeholder.supabase.co";
    const supabaseAnonKey =
        (isNode ? nodeEnv?.VITE_SUPABASE_ANON_KEY : metaEnv?.VITE_SUPABASE_ANON_KEY) ||
        "placeholder-anon-key";

    return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
