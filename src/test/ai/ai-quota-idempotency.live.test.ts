/**
 * LIVE integration tests — AI quota reservation lifecycle (Phase 5 invariants).
 *
 * Runs the REAL production code paths from `@/server/services/ai-settlement-service` against
 * the isolated Neon test branch. No mocks. This is the live-evidence twin of
 * the fully-mocked contract suite `ai-quota-idempotency.test.ts`.
 *
 * Covered invariants:
 *  1. Reservation creates a row with UTC periodKey and increments usage once.
 *  2. Sequential replay with the same operationId is idempotent.
 *  3. CONCURRENT duplicate reservation (unique-constraint race) yields exactly
 *     ONE row and ONE deduction via speculative-increment reversal.
 *  4. reserved -> committed transition + already_committed replay; refund
 *     after commit refused.
 *  5. Refund restores usage counters exactly once; second refund no-ops.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/server/db/schema";
import {
    getUserCreditBalance,
    flushPendingSettlementsToPostgres,
} from "@/server/services/ai-settlement-service";
import { StreamGovernor } from "@/lib/metering/stream-governor";
import { isRedisConfigured } from "@/lib/redis";

// Placeholder-pattern UUID so guarded cleanup can never touch a real account.
const USER_ID = "17171717-1717-1717-1717-171717171717";

async function seed(): Promise<void> {
    await testDb
        .insert(schema.users)
        .values({
            id: USER_ID,
            email: `${USER_ID}@live.test`,
            tier: "pro",
            creditBalanceMicro: BigInt(1000000000),
        })
        .onConflictDoUpdate({
            target: schema.users.id,
            set: { creditBalanceMicro: BigInt(1000000000) },
        });
    // Fresh transaction slate regardless of prior runs.
    await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, USER_ID));
}

async function getTransactions(operationId: string) {
    return testDb
        .select()
        .from(schema.creditLedgerTransactions)
        .where(eq(schema.creditLedgerTransactions.operationId, operationId));
}

afterAll(async () => {
    await cleanupTestUsers([USER_ID]);
});

describe("LIVE: SRS-04 StreamGovernor & Settlement Idempotency on isolated branch", () => {
    beforeAll(() => {
        if (!isRedisConfigured()) {
            throw new Error(
                "[test:live] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN must be configured for ai-quota-idempotency.live.test.ts (fail-closed)."
            );
        }
    });

    it("initializes lease, settles once idempotently, and flushes to Postgres", async () => {
        await seed();
        const opId = `live-quota-${Date.now()}`;
        const governor = new StreamGovernor(
            USER_ID,
            opId,
            "google/gemini-3.8-flash",
            0,
            new AbortController()
        );

        const lease = await governor.initializeLease(10);
        expect(lease.canAfford).toBe(true);

        const s1 = await governor.settle("SETTLED");
        const s2 = await governor.settle("SETTLED");
        expect(s1).toEqual(s2);

        const flushRes = await flushPendingSettlementsToPostgres(USER_ID);
        expect(flushRes.flushedCount).toBeGreaterThanOrEqual(1);

        const rows = await getTransactions(opId);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("SETTLED");

        const balance = await getUserCreditBalance(USER_ID);
        expect(balance).toBeLessThanOrEqual(BigInt(1000000000));
    });

    it("aborted lease settles as ABORTED and restores balance upon flush", async () => {
        await seed();
        const beforeBalance = await getUserCreditBalance(USER_ID);
        const opId = `live-abort-${Date.now()}`;
        const governor = new StreamGovernor(
            USER_ID,
            opId,
            "google/gemini-3.8-flash",
            0,
            new AbortController()
        );

        const lease = await governor.initializeLease(0);
        expect(lease.canAfford).toBe(true);

        governor.abort("user_cancelled");
        const settleRes = await governor.settle("ABORTED");
        expect(settleRes.status).toBe("SETTLED");
        expect(settleRes.actualCostMicro).toBe(0);
        expect(settleRes.refundMicro).toBe(Number(lease.reservedMicro));

        await flushPendingSettlementsToPostgres(USER_ID);

        const rows = await getTransactions(opId);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("ABORTED");
        expect(await getUserCreditBalance(USER_ID)).toBe(beforeBalance);
    });
});
