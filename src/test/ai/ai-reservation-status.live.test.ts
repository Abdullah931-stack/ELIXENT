/**
 * LIVE integration tests - user-scoped getUserCreditBalance & getTodayUsage
 * isolation reads against the ISOLATED Neon test branch. No mocks except the
 * Supabase session user (the only mocked boundary, matching the established
 * live-suite convention).
 *
 * Covered invariants:
 * 1. Existing user: returns authoritative creditBalanceMicro via getUserCreditBalance.
 * 2. Settled usage aggregation: getTodayUsage scopes daily usage strictly to owner.
 * 3. Cross-user isolation: another user's settled transactions do not leak into getTodayUsage.
 * 4. Unknown userId: getUserCreditBalance returns 0n.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/server/db/schema";
import {
    getUserCreditBalance,
    getTodayUsage,
} from "@/server/services/ai-settlement-service";
import { getUser } from "@/lib/supabase/server";

const { USER_ID, OTHER_USER_ID } = vi.hoisted(() => ({
    USER_ID: "18181818-1818-1818-1818-181818181818",
    OTHER_USER_ID: "19191919-1919-1919-1919-191919191919",
}));

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

const todayUtc = () => new Date().toISOString().slice(0, 10);

async function seed(): Promise<void> {
    await testDb
        .insert(schema.users)
        .values([
            { id: USER_ID, email: USER_ID + "@live.test", creditBalanceMicro: BigInt(1000000000) },
            { id: OTHER_USER_ID, email: OTHER_USER_ID + "@live.test", creditBalanceMicro: BigInt(1000000000) },
        ])
        .onConflictDoUpdate({
            target: schema.users.id,
            set: {
                creditBalanceMicro: BigInt(1000000000),
            },
        });
}

beforeEach(async () => {
    vi.mocked(getUser).mockResolvedValue({ id: USER_ID } as never);
});

afterAll(async () => {
    await cleanupTestUsers([USER_ID, OTHER_USER_ID]);
});

describe("LIVE: User-scoped Credit Balance & Usage Isolation on isolated branch", () => {
    it("returns the authoritative creditBalanceMicro for an existing user", async () => {
        await seed();
        const balance = await getUserCreditBalance(USER_ID);
        expect(balance).toBe(BigInt(1000000000));
    });

    it("aggregates today's SETTLED usage scoped strictly to the requested user", async () => {
        await seed();
        const opId = "live-res-" + randomUUID();
        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId: opId,
            userId: USER_ID,
            nodeName: "agent:improve:hash:150",
            modelId: "google/gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            inputTokens: 150,
            outputTokens: 150,
            deltaMicro: BigInt(-150000),
            status: "SETTLED",
            createdAt: new Date(),
        });

        const ownerUsage = await getTodayUsage(USER_ID);
        expect(ownerUsage.userId).toBe(USER_ID);
        expect(ownerUsage.date).toBe(todayUtc());
        expect(ownerUsage.improveWords).toBeGreaterThanOrEqual(150);

        const otherUsage = await getTodayUsage(OTHER_USER_ID);
        expect(otherUsage.userId).toBe(OTHER_USER_ID);
        expect(otherUsage.improveWords).toBe(0);
    });

    it("returns 0n for an unknown userId", async () => {
        const balance = await getUserCreditBalance("00000000-0000-0000-0000-000000000999");
        expect(balance).toBe(BigInt(0));
    });
});
