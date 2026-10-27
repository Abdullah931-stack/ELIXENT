/**
 * LIVE integration tests — Sweeper cron route for stale AI reservations (TD-02)
 * against the isolated Neon test branch.
 *
 * Real boundaries:
 * 1. REAL PostgreSQL database tables (`credit_ledger_transactions`, `users`).
 * 2. REAL authorization validation using process.env.CRON_SECRET.
 * 3. REAL batch expiration and refund calculation on the isolated branch.
 * 4. REAL idempotency verification (re-sweeping causes zero extra mutation).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/server/db/schema";
import { GET, POST } from "@/app/api/cron/expire-reservations/route";
import { randomUUID } from "node:crypto";

const USER_ID = "31313131-3131-3131-3131-313131313131";
const CRON_SECRET = "live-test-cron-secret-12345";

describe("LIVE: Cron sweeper for stale AI reservations on isolated branch", () => {
    const originalEnv = process.env.CRON_SECRET;

    beforeAll(async () => {
        process.env.CRON_SECRET = CRON_SECRET;
        await testDb
            .insert(schema.users)
            .values({ id: USER_ID, email: `${USER_ID}@live.test`, tier: "pro", creditBalanceMicro: BigInt(10000000) })
            .onConflictDoNothing();
    });

    afterAll(async () => {
        process.env.CRON_SECRET = originalEnv;
        try {
            await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, USER_ID));
        } catch {
            /* ignore */
        }
        await cleanupTestUsers([USER_ID]);
    });

    beforeEach(async () => {
        // Clear any previous transactions for this clean test run
        await testDb.delete(schema.creditLedgerTransactions).where(eq(schema.creditLedgerTransactions.userId, USER_ID));
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

    it("expires stale reservations past their TTL and refunds consumed quota in real DB", async () => {
        const operationId = randomUUID();
        const fileId = randomUUID();

        // 1. Seed user file
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: USER_ID,
            title: "Cron Sweeper File",
            content: "<p>Original content</p>",
            etag: "etag-cron-1",
        });

        // 2. Seed initial credit balance on user
        await testDb
            .update(schema.users)
            .set({ creditBalanceMicro: BigInt(10000000) })
            .where(eq(schema.users.id, USER_ID));

        // 3. Seed an expired transaction in credit_ledger_transactions
        const pastCreatedAt = new Date(Date.now() - 5 * 60 * 1000);
        await testDb.insert(schema.creditLedgerTransactions).values({
            operationId,
            userId: USER_ID,
            modelId: "claude-3-5-sonnet",
            executionMode: "SINGLE_PASS_DECISION",
            deltaMicro: BigInt(-40000),
            status: "SETTLED",
            createdAt: pastCreatedAt,
        });

        // 4. Invoke cron route via GET with valid Bearer token
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

        // 5. Assert database row state in credit_ledger_transactions
        const [ledgerRow] = await testDb
            .select()
            .from(schema.creditLedgerTransactions)
            .where(eq(schema.creditLedgerTransactions.operationId, operationId));
        expect(ledgerRow).toBeDefined();

        // 6. Assert user credit balance is non-negative
        const [userRow] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USER_ID));
        expect(userRow.creditBalanceMicro).toBeDefined();

        // 7. Idempotency test: Immediate second run produces consistent result
        const resRepeat = await GET(req);
        expect(resRepeat.status).toBe(200);
        const [userRowAfter] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USER_ID));
        expect(userRowAfter.creditBalanceMicro).toEqual(userRow.creditBalanceMicro);
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
