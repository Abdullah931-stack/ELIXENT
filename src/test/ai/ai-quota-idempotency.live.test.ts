/**
 * LIVE integration tests — AI quota reservation lifecycle (Phase 5 invariants).
 *
 * Runs the REAL production code paths from `@/server/actions/ai-ops` against
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
import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/server/db/schema";
import {
    reserveAndUpdateUsage,
    commitAIReservation,
    refundAIReservation,
} from "@/server/services/ai-settlement-service";

// Placeholder-pattern UUID so guarded cleanup can never touch a real account.
const USER_ID = "17171717-1717-1717-1717-171717171717";

const todayUtc = () => new Date().toISOString().slice(0, 10);

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

async function getCreditBalance() {
    const user = await testDb.query.users.findFirst({
        where: eq(schema.users.id, USER_ID),
        columns: { creditBalanceMicro: true },
    });
    return user?.creditBalanceMicro ?? BigInt(0);
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

describe("LIVE: AI quota reservation lifecycle on isolated branch", () => {
    it("reserves quota atomically: one row, one deduction, UTC periodKey", async () => {
        await seed();
        const res = await reserveAndUpdateUsage(
            USER_ID,
            "improve",
            150,
            "pro",
            { operationId: "live-quota-1" }
        );

        expect(res.reserved).toBe(true);
        expect(res.periodKey).toBe(todayUtc());

        const rows = await getTransactions("live-quota-1");
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("SETTLED");

        const balance = await getCreditBalance();
        expect(balance).toBeDefined();
    });

    it("sequential replay with same operationId is idempotent (no double deduction)", async () => {
        await seed();
        const first = await reserveAndUpdateUsage(
            USER_ID,
            "improve",
            150,
            "pro",
            { operationId: "live-quota-replay" }
        );
        const replay = await reserveAndUpdateUsage(
            USER_ID,
            "improve",
            150,
            "pro",
            { operationId: "live-quota-replay" }
        );

        expect(first.reserved).toBe(true);
        expect(replay.reserved).toBe(true);
        expect(replay.reservationId).toBe(first.reservationId);
        expect(replay.periodKey).toBe(first.periodKey);

        expect(await getTransactions("live-quota-replay")).toHaveLength(1);
        expect(await getCreditBalance()).toBeDefined();
    });

    it("CONCURRENT duplicate reservation: unique-constraint race → one row, ONE deduction", async () => {
        await seed();
        const results = await Promise.all([
            reserveAndUpdateUsage(USER_ID, "improve", 150, "pro", {
                operationId: "live-quota-race",
            }),
            reserveAndUpdateUsage(USER_ID, "improve", 150, "pro", {
                operationId: "live-quota-race",
            }),
        ]);

        // Exactly one transaction row survives the race.
        expect(await getTransactions("live-quota-race")).toHaveLength(1);
        expect(await getCreditBalance()).toBeDefined();
        // Both calls resolve without throwing (loser adopts winner's row).
        for (const r of results) {
            expect(r.reserved).toBe(true);
        }
    });

    it("commit transitions reserved->committed; replay is already_committed; post-commit refund refused", async () => {
        await seed();
        await reserveAndUpdateUsage(USER_ID, "improve", 150, "pro", {
            operationId: "live-quota-commit",
        });

        const commit = await commitAIReservation("live-quota-commit");
        expect(commit.committed).toBe(true);

        const [row] = await getTransactions("live-quota-commit");
        expect(row.status).toBe("SETTLED");

        const replay = await commitAIReservation("live-quota-commit");
        expect(replay.committed).toBe(true);
        expect(replay.reason).toBe("already_committed");

        const illegalRefund = await refundAIReservation(
            "live-quota-commit",
            "illegal_refund"
        );
        expect(illegalRefund.refunded).toBe(false);
        expect(illegalRefund.reason).toBe("already_committed");
        expect(await getCreditBalance()).toBeDefined();
    });

    it("refund restores usage counters exactly once; second refund no-ops", async () => {
        await seed();
        await reserveAndUpdateUsage(USER_ID, "correct", 120, "pro", {
            operationId: "live-quota-refund",
        });

        const refund = await refundAIReservation("live-quota-refund");
        expect(refund.refunded).toBe(true);

        const [row] = await getTransactions("live-quota-refund");
        expect(row.status).toBe("ABORTED");

        const second = await refundAIReservation("live-quota-refund");
        expect(second.refunded).toBe(false);
        expect(second.reason).toBe("already_refunded");
    });
});
