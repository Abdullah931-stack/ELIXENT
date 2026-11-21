import { Pool } from "pg";
import dotenv from "dotenv";
import path from "path";
import { assertSafeTestDatabaseUrl } from "../src/test/test-db-guard";

// Load isolated test environment in the exact same priority order as playwright.config.ts
dotenv.config({ path: path.resolve(process.cwd(), ".env.test.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.test") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const DEFAULT_FORBIDDEN_HOSTS =
    "ep-lucky-star-b1vlsh1f-pooler.c-5.eu-central-1.aws.neon.tech,ep-lucky-star-b1vlsh1f.c-5.eu-central-1.aws.neon.tech";

const REQUIRED_E2E_TABLES = [
    "users",
    "workspaces",
    "files",
    "agent_checkpoints",
    "credit_ledger_transactions",
    "user_vault_profiles",
] as const;

function extractPgErrorCode(error: unknown): string | undefined {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}

/**
 * Playwright fail-fast preflight check.
 * Verifies TEST_DATABASE_URL safety, PostgreSQL connectivity/auth (catching 28P01 early),
 * and required schema tables (catching 42P01 / schema drift) before launching browsers
 * or creating any test Supabase users.
 */
export default async function globalSetup(): Promise<void> {
    const testDbUrl = process.env.TEST_DATABASE_URL;
    if (!testDbUrl) {
        throw new Error(
            "[Playwright Global Setup] TEST_DATABASE_URL is not set. Refusing to run E2E suite against undefined database."
        );
    }

    assertSafeTestDatabaseUrl({
        databaseUrl: testDbUrl,
        testDatabaseUrl: testDbUrl,
        forbiddenHosts: process.env.TEST_DB_FORBIDDEN_HOSTS || DEFAULT_FORBIDDEN_HOSTS,
    });

    const isSsl =
        testDbUrl.includes("sslmode=require") ||
        testDbUrl.includes("neon.tech") ||
        testDbUrl.includes("supabase.co");

    const pool = new Pool({
        connectionString: testDbUrl,
        ssl: isSsl ? { rejectUnauthorized: false } : undefined,
        max: 2,
        connectionTimeoutMillis: 10_000,
    });

    try {
        try {
            await pool.query("SELECT 1");
        } catch (err) {
            const pgCode = extractPgErrorCode(err);
            const message = err instanceof Error ? err.message : String(err);
            if (pgCode === "28P01") {
                throw new Error(
                    `[Playwright Global Setup] PostgreSQL authentication failed (SQLSTATE 28P01) for TEST_DATABASE_URL: ${message}. ` +
                        "Verify TEST_DATABASE_URL credentials in .env.test.local before running E2E tests."
                );
            }
            throw new Error(
                `[Playwright Global Setup] Failed to connect to TEST_DATABASE_URL${pgCode ? ` (SQLSTATE ${pgCode})` : ""}: ${message}`
            );
        }

        const { rows } = await pool.query<{ table_name: string }>(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_name = ANY($1::text[])`,
            [[...REQUIRED_E2E_TABLES]]
        );

        const existingTables = new Set(rows.map((r) => r.table_name));
        const missingTables = REQUIRED_E2E_TABLES.filter((table) => !existingTables.has(table));

        if (missingTables.length > 0) {
            throw new Error(
                `[Playwright Global Setup] Schema drift / missing required tables (SQLSTATE 42P01 risk): ` +
                    `${missingTables.join(", ")}. Run \`node scripts/verify-migrations.mjs\` to initialize/migrate TEST_DATABASE_URL before running E2E tests.`
            );
        }
    } finally {
        await pool.end();
    }
}
