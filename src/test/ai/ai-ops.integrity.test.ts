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
    flushPendingSettlementsToPostgres,
    getTodayUsage,
    getUserCreditBalance,
} from "@/server/services/ai-settlement-service";
import { REDIS_KEYS } from "@/lib/metering/constants";

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

    it("concurrent duplicate settlement flushes with identical operationId settle EXACTLY ONCE on real Postgres", async () => {
        const userId = crypto.randomUUID();
        const operationId = `op_race_${crypto.randomUUID()}`;

        await testDb
            .insert(schema.users)
            .values({
                id: userId,
                email: `${userId}@race.test`,
                tier: "pro",
                creditBalanceMicro: BigInt(1000000000),
            })
            .onConflictDoNothing();

        const payloadJson = JSON.stringify({
            userId,
            nodeName: "agent:correct:hash:75",
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 75,
            outputTokens: 75,
            deltaMicro: -75000,
            status: "SETTLED",
            created_at_ms: Date.now() - 1000,
        });

        // 20 concurrent flushPendingSettlementsToPostgres calls with the SAME operationId
        const flushResults = await Promise.all(
            Array.from({ length: 20 }, () =>
                flushPendingSettlementsToPostgres(userId, {
                    customRedis: {
                        pendingSettlements: new Map([
                            [
                                REDIS_KEYS.pendingSettlements(userId),
                                new Map([[operationId, payloadJson]]),
                            ],
                        ]),
                        dirtyWallets: new Set([userId]),
                    },
                })
            )
        );

        // Exactly ONE flush applied the -75000 delta; the remaining 19 applied 0n
        const totalNetDelta = flushResults.reduce(
            (sum, r) => sum + r.netDeltaMicro,
            BigInt(0)
        );
        expect(totalNetDelta).toBe(BigInt(-75000));

        // Exactly ONE transaction record in database and exact single deduction on balance
        const resRows = await testDb
            .select()
            .from(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.operationId, operationId));
        expect(resRows.length).toBe(1);

        const balance = await getUserCreditBalance(userId);
        expect(balance).toBe(BigInt(999925000));
    });

    it("getTodayUsage excludes ABORTED transactions and aggregates SETTLED transactions", async () => {
        const userId = crypto.randomUUID();

        await testDb
            .insert(schema.users)
            .values({
                id: userId,
                email: `${userId}@usage.test`,
                tier: "pro",
                creditBalanceMicro: BigInt(1000000000),
            })
            .onConflictDoNothing();

        await testDb.insert(schema.creditLedgerTransactions).values([
            {
                operationId: `op_settled_${crypto.randomUUID()}`,
                userId,
                nodeName: "agent:correct:hash:100",
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 100,
                outputTokens: 120,
                deltaMicro: BigInt(-120000),
                status: "SETTLED",
                createdAt: new Date(),
            },
            {
                operationId: `op_aborted_${crypto.randomUUID()}`,
                userId,
                nodeName: "agent:correct:hash:50",
                modelId: "google/gemini-2.5-flash",
                executionMode: "STREAMING_GENERATIVE",
                inputTokens: 50,
                outputTokens: 0,
                deltaMicro: BigInt(0),
                status: "ABORTED",
                createdAt: new Date(),
            },
        ]);

        const usage = await getTodayUsage(userId);
        expect(usage.correctWords).toBe(100);
    });
});
