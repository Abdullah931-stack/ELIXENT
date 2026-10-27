import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../../src/server/db/schema";
import dotenv from "dotenv";
import path from "path";

// Ensure test environment is loaded
dotenv.config({ path: path.resolve(process.cwd(), ".env.test.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.test") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl) {
    throw new Error("[E2E Test DB] TEST_DATABASE_URL is not set.");
}

// Ensure safety check
if (testDbUrl.includes("ep-lucky-star")) {
    throw new Error("[E2E Test DB Guard] Refusing to connect to production database!");
}

const pool = new Pool({
    connectionString: testDbUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
});

export const e2eDb = drizzle(pool, { schema });

/**
 * Seed an E2E user directly in the test database
 */
export async function seedE2EUser(userId: string, email: string, displayName = "E2E User") {
    await e2eDb
        .insert(schema.users)
        .values({
            id: userId,
            email,
            displayName,
            tier: "free",
        })
        .onConflictDoUpdate({
            target: schema.users.id,
            set: { displayName, updatedAt: new Date() },
        });

}

/**
 * Clean up all data associated with an E2E user
 */
export async function cleanupE2EUser(userId: string) {
    try {
        await e2eDb.delete(schema.files).where(eq(schema.files.userId, userId));
        await e2eDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, userId));
        await e2eDb.delete(schema.projectDecisionLedger).where(eq(schema.projectDecisionLedger.userId, userId));
        await e2eDb.delete(schema.checkpointWrites);
        await e2eDb.delete(schema.checkpointBlobs);
        await e2eDb.delete(schema.checkpoints);
        await e2eDb.delete(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, userId));
        await e2eDb.delete(schema.userVaultProfiles).where(eq(schema.userVaultProfiles.userId, userId));
        await e2eDb.delete(schema.users).where(eq(schema.users.id, userId));
    } catch (err) {
        console.warn(`[E2E Cleanup] Warning during cleanup for user ${userId}:`, err);
    }
}

/**
 * Retrieve file from database for assertions
 */
export async function getDbFile(fileId: string) {
    return e2eDb.query.files.findFirst({
        where: eq(schema.files.id, fileId),
    });
}

/**
 * Update file version directly in database (simulates concurrent writes from another client/tab)
 */
export async function simulateRemoteFileUpdate(fileId: string, newContent: string, newVersion: number) {
    return e2eDb
        .update(schema.files)
        .set({
            content: newContent,
            version: newVersion,
            updatedAt: new Date(),
        })
        .where(eq(schema.files.id, fileId));
}

/**
 * Retrieve user usage / credit balance row
 */
export async function getDbUsage(userId: string) {
    const user = await e2eDb.query.users.findFirst({
        where: eq(schema.users.id, userId),
    });
    return {
        userId,
        date: new Date().toISOString().split("T")[0],
        creditBalanceMicro: user?.creditBalanceMicro ?? BigInt(0),
    };
}

/**
 * Retrieve AI reservations / credit ledger transactions for user
 */
export async function getDbReservations(userId: string) {
    const rows = await e2eDb.query.creditLedgerTransactions.findMany({
        where: eq(schema.creditLedgerTransactions.userId, userId),
    });
    return rows.map((r) => ({
        id: r.operationId,
        operationId: r.operationId,
        userId: r.userId,
        status: r.status === "SETTLED" ? "committed" : r.status === "ABORTED" ? "refunded" : r.status,
        refundedUnits: r.status === "ABORTED" ? Math.abs(Number(r.deltaMicro)) : 0,
        committedUnits: r.status === "SETTLED" ? Math.abs(Number(r.deltaMicro)) : 0,
        raw: r,
    }));
}

/**
 * Retrieve subscription events
 */
export async function getDbSubscriptionEvents(userId: string) {
    return e2eDb.query.subscriptionEvents.findMany({
        where: eq(schema.subscriptionEvents.userId, userId),
    });
}
