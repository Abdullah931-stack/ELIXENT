/**
 * LIVE integration tests — Sweeper cron route for batch-draining pending credit settlements
 * against the isolated Neon test branch and live Redis.
 *
 * Real boundaries:
 * 1. REAL PostgreSQL database tables (`credit_ledger_transactions`, `users`).
 * 2. REAL authorization validation using process.env.CRON_SECRET.
 * 3. REAL Upstash Redis hash inspection (`lugx:pending_settlements:${userId}`) and set (`lugx:dirty_wallets`).
 * 4. REAL batch draining with grace period filtering (>30,000ms).
 * 5. REAL idempotency verification (re-sweeping causes zero extra mutation).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/server/db/schema";
import { GET, POST } from "@/app/api/cron/expire-reservations/route";
import { randomUUID } from "node:crypto";
import { redis, isRedisConfigured } from "@/lib/redis";
import { REDIS_KEYS, DIRTY_SETTLEMENT_GRACE_MS } from "@/lib/metering/constants";

const USER_ID = "31313131-3131-3131-3131-313131313131";
const CRON_SECRET = "live-test-cron-secret-12345";
const INITIAL_BALANCE = BigInt(10_000_000);

describe("LIVE: Cron sweeper for batch draining on isolated branch", () => {
    const originalEnv = process.env.CRON_SECRET;

    beforeAll(async () => {
        process.env.CRON_SECRET = CRON_SECRET;
        await testDb
            .insert(schema.users)
            .values({
                id: USER_ID,
                email: `${USER_ID}@live.test`,
                tier: "pro",
                creditBalanceMicro: INITIAL_BALANCE,
            })
            .onConflictDoNothing();

        if (isRedisConfigured()) {
            await redis.del(REDIS_KEYS.pendingSettlements(USER_ID));
            await redis.srem(REDIS_KEYS.dirtyWallets(), USER_ID);
        }
    });

    afterAll(async () => {
        process.env.CRON_SECRET = originalEnv;
        if (isRedisConfigured()) {
            await redis.del(REDIS_KEYS.pendingSettlements(USER_ID));
            await redis.srem(REDIS_KEYS.dirtyWallets(), USER_ID);
        }
        try {
            await testDb
                .delete(schema.creditLedgerTransactions)
                .where(eq(schema.creditLedgerTransactions.userId, USER_ID));
        } catch {
            /* ignore */
        }
        await cleanupTestUsers([USER_ID]);
    });

    beforeEach(async () => {
        await testDb
            .delete(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.userId, USER_ID));

        await testDb
            .update(schema.users)
            .set({ creditBalanceMicro: INITIAL_BALANCE })
            .where(eq(schema.users.id, USER_ID));

        if (isRedisConfigured()) {
            await redis.del(REDIS_KEYS.pendingSettlements(USER_ID));
            await redis.srem(REDIS_KEYS.dirtyWallets(), USER_ID);
        }
    });

    it("rejects unauthorized calls with HTTP 401 when Authorization header is missing or wrong", async () => {
        const noAuthReq = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "GET",
        });
        const res1 = await GET(noAuthReq);
        expect(res1.status).toBe(401);
        const body1 = await res1.json();
        expect(body1.success).toBe(false);
        expect(body1.error).toBe("Unauthorized");

        const wrongAuthReq = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "GET",
            headers: {
                Authorization: "Bearer wrong-secret-token",
            },
        });
        const res2 = await GET(wrongAuthReq);
        expect(res2.status).toBe(401);
    });

    it("drains pending settlements older than grace period from Redis into PostgreSQL and adjusts balance", async () => {
        const operationId = randomUUID();
        const deltaMicro = -40000;
        const pastCreatedAtMs = Date.now() - (DIRTY_SETTLEMENT_GRACE_MS + 5000);

        // 1. Seed pending settlement in Redis hash
        const pendingPayload = JSON.stringify({
            operationId,
            userId: USER_ID,
            modelId: "gemini-2.5-flash",
            executionMode: "STREAMING_GENERATIVE",
            deltaMicro,
            actualTotalCostMicro: Math.abs(deltaMicro),
            created_at_ms: pastCreatedAtMs,
            status: "SETTLED",
        });

        await redis.hset(REDIS_KEYS.pendingSettlements(USER_ID), {
            [operationId]: pendingPayload,
        });
        await redis.sadd(REDIS_KEYS.dirtyWallets(), USER_ID);

        // 2. Invoke cron route via GET with valid Bearer token
        const req = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${CRON_SECRET}`,
            },
        });

        const res = await GET(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.processedUsers).toBeGreaterThanOrEqual(1);
        expect(data.flushedOperations).toBeGreaterThanOrEqual(1);
        expect(BigInt(data.netDeltaMicro)).toBeLessThan(BigInt(0));

        // 3. Assert database row state in credit_ledger_transactions
        const [ledgerRow] = await testDb
            .select()
            .from(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.operationId, operationId));
        expect(ledgerRow).toBeDefined();
        expect(BigInt(ledgerRow.deltaMicro)).toBe(BigInt(deltaMicro));

        // 4. Assert user credit balance was adjusted
        const [userRow] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USER_ID));
        expect(userRow.creditBalanceMicro).toBeDefined();
        expect(BigInt(userRow.creditBalanceMicro!)).toBe(INITIAL_BALANCE + BigInt(deltaMicro));

        // 5. Assert Redis pending settlement is drained
        const remainingHashCount = await redis.hlen(REDIS_KEYS.pendingSettlements(USER_ID));
        expect(remainingHashCount).toBe(0);

        // 6. Idempotency test: Immediate second run produces consistent result (0 extra flushed)
        const resRepeat = await GET(req);
        expect(resRepeat.status).toBe(200);
        const [userRowAfter] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USER_ID));
        expect(userRowAfter.creditBalanceMicro).toEqual(userRow.creditBalanceMicro);
    });

    it("skips pending settlements younger than 30s grace window", async () => {
        const recentOpId = randomUUID();
        const recentPayload = JSON.stringify({
            operationId: recentOpId,
            userId: USER_ID,
            deltaMicro: -20000,
            actualTotalCostMicro: 20000,
            created_at_ms: Date.now(), // 0ms ago (< 30s)
            status: "SETTLED",
        });

        await redis.hset(REDIS_KEYS.pendingSettlements(USER_ID), {
            [recentOpId]: recentPayload,
        });
        await redis.sadd(REDIS_KEYS.dirtyWallets(), USER_ID);

        const req = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${CRON_SECRET}`,
            },
        });

        const res = await GET(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);

        // The recent operation was NOT flushed due to grace window
        const [ledgerRow] = await testDb
            .select()
            .from(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.operationId, recentOpId));
        expect(ledgerRow).toBeUndefined();

        // Clean up from Redis
        await redis.del(REDIS_KEYS.pendingSettlements(USER_ID));
        await redis.srem(REDIS_KEYS.dirtyWallets(), USER_ID);
    });

    it("POST handler is identical to GET handler and functions identically", async () => {
        const postReq = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${CRON_SECRET}`,
            },
        });

        const res = await POST(postReq);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
    });
});
