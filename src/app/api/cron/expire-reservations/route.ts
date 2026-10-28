import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { acquireCronLock } from "@/lib/cron/lock";
import { redis, isRedisConfigured } from "@/lib/redis";
import { REDIS_KEYS, DIRTY_SETTLEMENT_GRACE_MS } from "@/lib/metering/constants";
import { flushPendingSettlementsToPostgres } from "@/server/services/ai-settlement-service";
import { MeteringServiceUnavailableError } from "@/lib/metering/lua-scripts";

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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
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

export async function GET(request: NextRequest) {
    if (!authorized(request)) {
        return NextResponse.json(
            { success: false, error: "Unauthorized" },
            { status: 401 }
        );
    }

    const lock = await acquireCronLock("expire-reservations", 300);
    if (!lock.acquired) {
        return NextResponse.json({
            success: true,
            skipped: true,
            reason: "Overlapping execution prevented by distributed lock",
            timestamp: new Date().toISOString(),
        });
    }

    try {
        if (!isRedisConfigured()) {
            return NextResponse.json(
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

        return NextResponse.json({
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

        return NextResponse.json(
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

export const POST = GET;
