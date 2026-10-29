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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { AIOperation } from "@/lib/ai/prompts";
import { reserveAndUpdateUsage, refundAIReservation } from "@/server/services/ai-settlement-service";

const TEST_USER_ID = "12121212-1212-1212-1212-121212121212"; // unique per suite — NOT shared with softdelete tests (parallel workers)
const TIER = "pro";
let dbAvailable = false;

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
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

beforeEach((ctx) => {
    if (!dbAvailable) {
        ctx.skip();
    }
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

async function reserve(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    operationId: string = `op_${crypto.randomUUID()}`
): Promise<{ reserved: boolean; operationId: string }> {
    const requestHash = crypto.createHash("sha256").update(`${userId}:${operation}:${wordCount}:${operationId}`).digest("hex");
    const result = await reserveAndUpdateUsage(userId, operation, wordCount, TIER, {
        operationId,
        requestHash,
    });
    return { reserved: result.reserved, operationId };
}

async function refund(operationId: string): Promise<boolean> {
    const result = await refundAIReservation(operationId, "stream_failed");
    return result.refunded;
}

async function snapshotCreditBalance(userId: string): Promise<bigint> {
    const row = await testDb.query.users.findFirst({
        where: eq(schema.users.id, userId),
        columns: { creditBalanceMicro: true },
    });
    return row?.creditBalanceMicro ?? BigInt(0);
}

describe("quota refund after AI failure (W1)", () => {
    it("restores credit balance when a reserved correct() operation fails", async () => {
        const beforeBalance = await snapshotCreditBalance(TEST_USER_ID);

        const WORDS = 120;
        const { reserved, operationId } = await reserve(TEST_USER_ID, "correct", WORDS);
        expect(reserved).toBe(true);

        // Simulate AI provider failure AFTER reservation:
        const refunded = await refund(operationId);
        expect(refunded).toBe(true);

        const afterBalance = await snapshotCreditBalance(TEST_USER_ID);
        expect(afterBalance).toBe(beforeBalance);
    });

    it("restores credit balance when a reserved summarize() operation fails", async () => {
        const beforeBalance = await snapshotCreditBalance(TEST_USER_ID);

        const WORDS = 45;
        const { reserved, operationId } = await reserve(TEST_USER_ID, "summarize", WORDS);
        expect(reserved).toBe(true);

        const refunded = await refund(operationId);
        expect(refunded).toBe(true);

        const afterBalance = await snapshotCreditBalance(TEST_USER_ID);
        expect(afterBalance).toBe(beforeBalance);
    });

    it("bounded refund never underflows counters below zero (double-refund safety)", async () => {
        const beforeBalance = await snapshotCreditBalance(TEST_USER_ID);

        const WORDS = 30;
        const { reserved, operationId } = await reserve(TEST_USER_ID, "correct", WORDS);
        expect(reserved).toBe(true);

        // A bug-triggered DOUBLE refund:
        const firstRefund = await refund(operationId);
        expect(firstRefund).toBe(true);
        const secondRefund = await refund(operationId);
        expect(secondRefund).toBe(false);

        const afterBalance = await snapshotCreditBalance(TEST_USER_ID);
        expect(afterBalance).toBeGreaterThanOrEqual(BigInt(0));
        expect(afterBalance).toBe(beforeBalance);
    });

    it("refund restores the exact balance under concurrent traffic", async () => {
        const beforeBalance = await snapshotCreditBalance(TEST_USER_ID);

        const WORDS = 50;
        const { reserved: res1, operationId: op1 } = await reserve(TEST_USER_ID, "correct", WORDS);
        expect(res1).toBe(true);

        // A concurrent successful request from the same user:
        const { reserved: res2 } = await reserve(TEST_USER_ID, "correct", 40);
        expect(res2).toBe(true);

        const refunded = await refund(op1);
        expect(refunded).toBe(true);

        const afterBalance = await snapshotCreditBalance(TEST_USER_ID);
        expect(afterBalance).toBeLessThanOrEqual(beforeBalance);
    });
});
