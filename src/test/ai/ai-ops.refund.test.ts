/**
 * Regression test: quota REFUND after AI failure (W1 fix).
 *
 * REAL DATABASE TEST: runs against a local Postgres with the full Drizzle
 * client, migrations applied, and credit balance tracking.
 *
 * Proves that when an AI operation fails AFTER its quota was atomically
 * reserved, the credit balance and transaction states are restored —
 * the exact failure mode the old code suffered from: a failed
 * processWithAI call permanently consumed quota the user never received.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import {
    getUserCreditBalance,
    flushPendingSettlementsToPostgres,
} from "@/server/services/ai-settlement-service";
import { StreamGovernor } from "@/lib/metering/stream-governor";
import { isRedisConfigured } from "@/lib/redis";

const TEST_USER_ID = "12121212-1212-1212-1212-121212121212"; // unique per suite — NOT shared with softdelete tests (parallel workers)
let dbAvailable = false;

beforeAll(async () => {
    if (!isRedisConfigured()) {
        throw new Error(
            "[test:live] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN must be configured for ai-ops.refund.test.ts (fail-closed)."
        );
    }
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) {
        throw new Error(
            "[test:live] Test database is unreachable for ai-ops.refund.test.ts (fail-closed)."
        );
    }
    await ensureTestDb();
    await runMigrations();
    await testDb
        .insert(schema.users)
        .values({
            id: TEST_USER_ID,
            email: "refund-test@example.com",
            tier: "pro",
            creditBalanceMicro: BigInt(1000000000),
        })
        .onConflictDoNothing();
});

afterAll(async () => {
    if (!dbAvailable) return;
    try {
        await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, TEST_USER_ID));
    } catch {
        /* ignore */
    }
    // Remove this suite's seeded test account; CASCADE cleans dependents.
    try { await cleanupTestUsers([TEST_USER_ID]); } catch { /* ignore */ }
});

describe("SRS-04 lease abort & settlement flush after AI failure", () => {
    it("releases unused reserved credits and records ABORTED settlement when governor aborts before output", async () => {
        const beforeBalance = await getUserCreditBalance(TEST_USER_ID);
        const operationId = `op_${crypto.randomUUID()}`;
        const abortController = new AbortController();

        const governor = new StreamGovernor(
            TEST_USER_ID,
            operationId,
            "google/gemini-3.8-flash",
            0,
            abortController
        );

        const lease = await governor.initializeLease(0);
        expect(lease.canAfford).toBe(true);

        // Simulate AI provider failure BEFORE producing tokens:
        governor.abort("stream_failed");
        const settleRes = await governor.settle("ABORTED");
        expect(settleRes.status).toBe("SETTLED");
        expect(settleRes.actualCostMicro).toBe(0);
        expect(settleRes.refundMicro).toBe(Number(lease.reservedMicro));

        await flushPendingSettlementsToPostgres(TEST_USER_ID);

        const afterBalance = await getUserCreditBalance(TEST_USER_ID);
        expect(afterBalance).toBe(beforeBalance);

        const txRow = await testDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, operationId),
        });
        expect(txRow?.status).toBe("ABORTED");
    });

    it("settle() is idempotent on double-abort and never underflows balance", async () => {
        const beforeBalance = await getUserCreditBalance(TEST_USER_ID);
        const operationId = `op_${crypto.randomUUID()}`;
        const abortController = new AbortController();

        const governor = new StreamGovernor(
            TEST_USER_ID,
            operationId,
            "google/gemini-3.8-flash",
            0,
            abortController
        );

        const lease = await governor.initializeLease(0);
        expect(lease.canAfford).toBe(true);

        const firstSettle = await governor.settle("ABORTED");
        const secondSettle = await governor.settle("ABORTED");
        expect(firstSettle).toEqual(secondSettle);

        await flushPendingSettlementsToPostgres(TEST_USER_ID);

        const afterBalance = await getUserCreditBalance(TEST_USER_ID);
        expect(afterBalance).toBeGreaterThanOrEqual(BigInt(0));
        expect(afterBalance).toBe(beforeBalance);
    });
});
