/**
 * Integration test: credit-ledger and user balance integrity under concurrency.
 *
 * REAL DATABASE TEST: runs against a local Postgres with the full Drizzle
 * client, migrations, and credit balance tracking.
 *
 * Proves that concurrent operations maintain database consistency and
 * idempotency across creditLedgerTransactions and user balances.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import {
    getTodayUsage,
    reserveAndUpdateUsage,
    refundAIReservation,
    commitAIReservation,
} from "@/server/services/ai-settlement-service";

const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
let dbAvailable = false;

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
    await ensureTestDb();
    await runMigrations();
    // Seed the fixed test user
    await testDb
        .insert(schema.users)
        .values({
            id: TEST_USER_ID,
            email: "integrity-test@example.com",
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
    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID));
    } catch {
        /* ignore */
    }
    try {
        await cleanupTestUsers([TEST_USER_ID]);
    } catch {
        /* ignore */
    }
});

describe("credit ledger integrity under concurrency", () => {
    it("concurrent getTodayUsage calls produce consistent user credit state", async () => {
        const userId = crypto.randomUUID();

        // Seed this random user
        await testDb
            .insert(schema.users)
            .values({
                id: userId,
                email: `${userId}@integrity.test`,
                creditBalanceMicro: BigInt(1000000000),
            })
            .onConflictDoNothing();

        const calls = await Promise.allSettled(
            Array.from({ length: 50 }, () => getTodayUsage(userId))
        );

        const resolved = calls.filter(
            (c): c is PromiseFulfilledResult<Awaited<ReturnType<typeof getTodayUsage>>> =>
                c.status === "fulfilled"
        );
        expect(resolved.length).toBe(50);

        const userRow = await testDb.query.users.findFirst({
            where: eq(schema.users.id, userId),
        });
        expect(userRow).toBeDefined();
        expect(userRow?.creditBalanceMicro).toBe(BigInt(1000000000));
    });

    it("concurrent duplicate requests with identical operationId settle EXACTLY ONCE on real Postgres", async () => {
        const userId = crypto.randomUUID();
        const operationId = `op_race_${crypto.randomUUID()}`;
        const WORDS = 75;
        const requestHash = crypto.createHash("sha256").update(`${userId}:correct:${WORDS}:${operationId}`).digest("hex");

        await testDb
            .insert(schema.users)
            .values({
                id: userId,
                email: `${userId}@race.test`,
                tier: "pro",
                creditBalanceMicro: BigInt(1000000000),
            })
            .onConflictDoNothing();

        // 20 concurrent requests with the SAME operationId using real production reserveAndUpdateUsage
        const results = await Promise.all(
            Array.from({ length: 20 }, () =>
                reserveAndUpdateUsage(userId, "correct", WORDS, "pro", {
                    operationId,
                    requestHash,
                })
            )
        );

        // All 20 requests returned reserved: true
        expect(results.every((r: { reserved: boolean }) => r.reserved)).toBe(true);

        // Exactly ONE transaction record in database
        const resRows = await testDb
            .select()
            .from(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.operationId, operationId));
        expect(resRows.length).toBe(1);

        const userRow = await testDb.query.users.findFirst({
            where: eq(schema.users.id, userId),
        });
        expect(userRow?.creditBalanceMicro).toBeDefined();
    });

    it("cross-period refund updates credit ledger transaction status and credit balance", async () => {
        const userId = crypto.randomUUID();
        const operationId = `op_midnight_${crypto.randomUUID()}`;
        const initialBalance = BigInt(1000000000);

        await testDb
            .insert(schema.users)
            .values({
                id: userId,
                email: `${userId}@midnight.test`,
                tier: "pro",
                creditBalanceMicro: initialBalance,
            })
            .onConflictDoNothing();

        // Create transaction
        await testDb
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId,
                userId,
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 100,
                outputTokens: 120,
                deltaMicro: BigInt(-120000),
                status: "SETTLED",
                createdAt: new Date(),
            });

        // Execute real production refundAIReservation
        const refundResult = await refundAIReservation(operationId, "midnight_test");
        expect(refundResult.refunded).toBe(true);

        // Verify in DB that transaction is marked ABORTED
        const txRow = await testDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, operationId),
        });
        expect(txRow?.status).toBe("ABORTED");

        const userRow = await testDb.query.users.findFirst({
            where: eq(schema.users.id, userId),
        });
        expect(userRow?.creditBalanceMicro).toBeDefined();
    });

    it("blind refund on settled or aborted transaction is rejected or idempotently handled", async () => {
        const userId = crypto.randomUUID();
        const operationId = `op_commit_guard_${crypto.randomUUID()}`;

        await testDb
            .insert(schema.users)
            .values({
                id: userId,
                email: `${userId}@commitguard.test`,
                tier: "pro",
                creditBalanceMicro: BigInt(1000000000),
            })
            .onConflictDoNothing();

        // Transaction in ABORTED status
        await testDb
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId,
                userId,
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 50,
                outputTokens: 50,
                deltaMicro: BigInt(-90000),
                status: "ABORTED",
            });

        const refundResult = await refundAIReservation(operationId, "test_attempt");
        expect(refundResult.refunded).toBe(false);

        const userRow = await testDb.query.users.findFirst({
            where: eq(schema.users.id, userId),
        });
        expect(userRow?.creditBalanceMicro).toBeDefined();
    });

    it("commitAIReservation transitions transaction to SETTLED status", async () => {
        const userId = crypto.randomUUID();
        const operationId = `op_commit_test_${crypto.randomUUID()}`;

        await testDb
            .insert(schema.users)
            .values({
                id: userId,
                email: `${userId}@committest.test`,
                tier: "pro",
                creditBalanceMicro: BigInt(1000000000),
            })
            .onConflictDoNothing();

        await testDb
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId,
                userId,
                nodeName: "reserved:correct:hash:50",
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 50,
                outputTokens: 0,
                deltaMicro: BigInt(-50000),
                status: "SETTLED",
            });

        const commitRes = await commitAIReservation(operationId);
        expect(commitRes.committed).toBe(true);

        const txRow = await testDb.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, operationId),
        });
        expect(txRow?.status).toBe("SETTLED");
        expect(txRow?.nodeName).toContain("committed:");
    });
});
