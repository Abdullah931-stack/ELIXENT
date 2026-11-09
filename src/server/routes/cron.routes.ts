/**
 * Hono Router: Cron Maintenance Routes
 *
 * - GET | POST /api/cron/expire-reservations -> handleExpireReservationsCron
 * - GET | POST /api/cron/purge-deleted       -> handlePurgeDeletedCron
 */

import { Hono } from "hono";
import { timingSafeEqual } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { acquireCronLock } from "@/lib/cron/lock";
import { redis, isRedisConfigured } from "@/lib/redis";
import { REDIS_KEYS, DIRTY_SETTLEMENT_GRACE_MS } from "@/lib/metering/constants";
import { flushPendingSettlementsToPostgres } from "@/server/services/ai-settlement-service";
import { MeteringServiceUnavailableError } from "@/lib/metering/lua-scripts";

const RETENTION_DAYS = 30;
const BATCH_LIMIT = 500;

function isCronRequestAuthorized(request: Request): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    const header = request.headers.get("Authorization") ?? "";
    const expected = `Bearer ${secret}`;
    const headerBuf = Buffer.from(header);
    const expectedBuf = Buffer.from(expected);
    if (headerBuf.length !== expectedBuf.length) {
        return false;
    }
    return timingSafeEqual(headerBuf, expectedBuf);
}

/**
 * Periodic Batch-Draining Sweeper for Pending Credit Settlements.
 *
 * Scans `lugx:dirty_wallets` in Redis and drains pending settlements older than
 * the safety grace period (DIRTY_SETTLEMENT_GRACE_MS = 30,000ms) into PostgreSQL
 * `credit_ledger_transactions` and synchronizes `users.creditBalanceMicro`.
 *
 * AUTH: Protected by shared cron secret (CRON_SECRET env).
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://app/api/cron/expire-reservations
 *
 * IDEMPOTENT: Uses distributed lock to prevent overlapping sweeps and drains
 * pending hashes via atomic database transactions with ON CONFLICT DO NOTHING.
 */
export async function handleExpireReservationsCron(request: Request): Promise<Response> {
    if (!isCronRequestAuthorized(request)) {
        return Response.json(
            { success: false, error: "Unauthorized" },
            { status: 401 }
        );
    }

    const lock = await acquireCronLock("expire-reservations", 300);
    if (!lock.acquired) {
        return Response.json({
            success: true,
            skipped: true,
            reason: "Overlapping execution prevented by distributed lock",
            timestamp: new Date().toISOString(),
        });
    }

    try {
        if (!isRedisConfigured()) {
            return Response.json(
                { success: false, error: "Redis service unavailable" },
                { status: 503 }
            );
        }

        const dirtyWalletsKey =
            typeof REDIS_KEYS.dirtyWallets === "function"
                ? REDIS_KEYS.dirtyWallets()
                : (REDIS_KEYS.dirtyWallets as string);

        const dirtyMembers = await redis.smembers(dirtyWalletsKey);
        const dirtyUsers: string[] = Array.isArray(dirtyMembers)
            ? dirtyMembers
            : dirtyMembers
              ? Array.from(dirtyMembers as Iterable<string>)
              : [];

        let processedUsers = 0;
        let flushedOperations = 0;
        let totalNetDeltaMicro = BigInt(0);

        for (const userId of dirtyUsers) {
            if (!userId || typeof userId !== "string") continue;
            const res = await flushPendingSettlementsToPostgres(userId, {
                onlyOlderThanMs: DIRTY_SETTLEMENT_GRACE_MS,
            });
            processedUsers++;
            flushedOperations += res.flushedCount;
            totalNetDeltaMicro += res.netDeltaMicro;
        }

        return Response.json({
            success: true,
            processedUsers,
            flushedOperations,
            netDeltaMicro: totalNetDeltaMicro.toString(),
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Batch draining cron error:", error);
        const isRedisError =
            error instanceof MeteringServiceUnavailableError ||
            (error instanceof Error &&
                (error.message.includes("Redis") ||
                 error.message.includes("redis") ||
                 error.name.includes("Redis")));

        return Response.json(
            {
                success: false,
                error: error instanceof Error ? error.message : "Batch draining failed",
            },
            { status: isRedisError ? 503 : 500 }
        );
    } finally {
        await lock.release();
    }
}

/**
 * Purge expired tombstones — 30-day soft-delete retention.
 *
 * Permanently deletes file rows whose `deleted_at` is older than
 * RETENTION_DAYS, in bounded batches to keep each run short and cheap.
 *
 * AUTH: Protected by a shared cron secret (CRON_SECRET env). Call from
 * a scheduler (cron, GitHub Actions, Vercel cron) with:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://app/api/cron/purge-deleted
 *
 * IDEMPOTENT: running it extra times only deletes what is already past
 * the retention window — nothing else.
 */
export async function handlePurgeDeletedCron(request: Request): Promise<Response> {
    if (!isCronRequestAuthorized(request)) {
        return Response.json(
            { success: false, error: "Unauthorized" },
            { status: 401 }
        );
    }

    const lock = await acquireCronLock("purge-deleted", 600);
    if (!lock.acquired) {
        return Response.json({
            success: true,
            skipped: true,
            reason: "Overlapping execution prevented by distributed lock",
            timestamp: new Date().toISOString(),
        });
    }

    try {
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);

        // Bounded batch: one route run deletes at most BATCH_LIMIT rows so
        // long-running purges never hold a connection indefinitely.
        // Drizzle's PgDelete builder has no .limit(), and parameterized LIMIT
        // is rejected by prepared statements, so the bound is expressed as a
        // CTE subquery (portable across PG versions and platforms).
        const result = await db.execute(sql`
            WITH doomed AS (
                SELECT id FROM files
                WHERE deleted_at <= ${cutoff}
                LIMIT ${BATCH_LIMIT}
            )
            DELETE FROM files USING doomed
            WHERE files.id = doomed.id
        `);

        const deleted = result?.rowCount ?? 0;

        return Response.json({
            success: true,
            deleted,
            cutoff: cutoff.toISOString(),
            retentionDays: RETENTION_DAYS,
            batchLimit: BATCH_LIMIT,
            done: deleted < BATCH_LIMIT, // client can stop scheduling once done
        });
    } catch (error) {
        console.error("Purge deleted files error:", error);
        return Response.json(
            { success: false, error: "Purge failed" },
            { status: 500 }
        );
    } finally {
        await lock.release();
    }
}

export const cronRoutes = new Hono()
  .get("/expire-reservations", (c) => handleExpireReservationsCron(c.req.raw))
  .post("/expire-reservations", (c) => handleExpireReservationsCron(c.req.raw))
  .get("/purge-deleted", (c) => handlePurgeDeletedCron(c.req.raw))
  .post("/purge-deleted", (c) => handlePurgeDeletedCron(c.req.raw));
