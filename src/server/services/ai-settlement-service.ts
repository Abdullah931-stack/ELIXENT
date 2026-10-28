import "server-only";

import { db } from "@/server/db";
import { txDb } from "@/server/db/transactional";
import * as schema from "@/server/db/schema";
import crypto from "node:crypto";
import { AIOperation } from "@/lib/ai/prompts";
import { TIER_LIMITS, TierName, isToPromptEnabled } from "@/config/tiers.config";
import { eq, and, sql } from "drizzle-orm";
import { isRedisConfigured, redis } from "@/lib/redis";
import { REDIS_KEYS } from "@/lib/metering/constants";
import { MeteringServiceUnavailableError } from "@/lib/metering/lua-scripts";

/**
 * Compute canonical deterministic request fingerprint for replay attack prevention.
 * Formula: sha256(userId + ":" + operation + ":" + fileId + ":" + text)
 */
export function computeRequestHash(
    userId: string,
    operation: string,
    fileId: string,
    text: string
): string {
    return crypto
        .createHash("sha256")
        .update(`${userId}:${operation}:${fileId}:${text}`)
        .digest("hex");
}

function getToday(): string {
    return new Date().toISOString().split("T")[0];
}

function getActiveDb() {
    return txDb && typeof txDb.transaction === "function" ? txDb : db;
}

export async function getUserTier(userId: string): Promise<TierName> {
    const user = await db.query.users.findFirst({
        where: eq(schema.users.id, userId),
        columns: { tier: true },
    });

    return (user?.tier as TierName) || "free";
}

export async function getTodayUsage(userId: string) {
    const today = getToday();
    const todayStart = new Date(`${today}T00:00:00.000Z`);

    const txs = await db.query.creditLedgerTransactions.findMany({
        where: and(
            eq(schema.creditLedgerTransactions.userId, userId),
            sql`${schema.creditLedgerTransactions.createdAt} >= ${todayStart}`
        ),
    });

    let correctWords = 0;
    let improveWords = 0;
    let translateWords = 0;
    let summarizeCount = 0;
    let summarizeWords = 0;
    let toPromptCount = 0;

    for (const tx of txs) {
        if (tx.status === "ABORTED") continue;
        const parts = (tx.nodeName || "").split(":");
        const op = parts.length >= 2 ? parts[1] : (tx.nodeName || "");
        const words = tx.inputTokens || (parts[3] ? parseInt(parts[3], 10) : 0) || 0;

        if (op === "correct") correctWords += words;
        else if (op === "improve") improveWords += words;
        else if (op === "translate") translateWords += words;
        else if (op === "summarize") {
            summarizeCount += 1;
            summarizeWords += words;
        } else if (op === "toPrompt") {
            toPromptCount += 1;
        }
    }

    return {
        id: `usage_${userId}_${today}`,
        userId,
        date: today,
        correctWords,
        improveWords,
        translateWords,
        summarizeCount,
        summarizeWords,
        toPromptCount,
        createdAt: new Date(),
    };
}

function getLimitsForOperation(
    operation: AIOperation,
    tier: TierName,
    wordCount: number
): { maxWords: number; period: string; allowed: boolean; reason?: string } {
    const limits = TIER_LIMITS[tier];

    if (operation === "toPrompt") {
        const allowed = isToPromptEnabled(tier);
        return {
            maxWords: 0,
            period: "daily",
            allowed,
            reason: allowed ? undefined : "ToPrompt is only available for Pro and Ultra plans",
        };
    }

    if (operation === "summarize") {
        const allowed = wordCount <= limits.summarize.maxWordsPerRequest;
        return {
            maxWords: limits.summarize.maxWordsPerRequest,
            period: "daily",
            allowed,
            reason: allowed ? undefined : `Text exceeds maximum ${limits.summarize.maxWordsPerRequest} words for summarization`,
        };
    }

    return {
        maxWords: limits.correctImproveTranslate.words,
        period: limits.correctImproveTranslate.period,
        allowed: true,
    };
}

export interface ReserveAIQuotaOptions {
    operationId?: string;
    fileId?: string;
    requestHash?: string;
    ttlMs?: number;
    deltaMicro?: bigint;
    modelId?: string;
    executionMode?: "SINGLE_PASS_DECISION" | "DISCRETE_THINKING" | "STREAMING_GENERATIVE" | "CREDIT_TOPUP";
}

export interface ReserveAIQuotaResult {
    reserved: boolean;
    reason?: string;
    reservationId?: string;
    operationId?: string;
    periodKey?: string;
    isReplayConflict?: boolean;
}

/**
 * Server-Authoritative atomic quota reservation with credit balance deduction and replay-attack protection.
 */
export async function reserveAIQuota(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    tier: TierName,
    options?: ReserveAIQuotaOptions
): Promise<ReserveAIQuotaResult> {
    const operationId = options?.operationId || crypto.randomUUID();
    const fileId = options?.fileId || "f_default";
    const requestHash = options?.requestHash || computeRequestHash(userId, operation, fileId, "");
    const today = getToday();
    const limitsInfo = getLimitsForOperation(operation, tier, wordCount);

    if (!limitsInfo.allowed) {
        return { reserved: false, reason: limitsInfo.reason };
    }

    const delta = options?.deltaMicro ?? (BigInt(Math.max(1, wordCount)) * BigInt(1000));
    const targetDb = getActiveDb();

    const executeReservation = async (client: typeof db): Promise<ReserveAIQuotaResult> => {
        // 1. Replay Attack & Idempotency Check
        const existing = await client.query.creditLedgerTransactions.findFirst({
            where: eq(schema.creditLedgerTransactions.operationId, operationId),
        });

        if (existing) {
            // Anti-Replay: Verify user ownership
            if (existing.userId !== userId) {
                return {
                    reserved: false,
                    reason: "Unauthorized: operationId belongs to another account",
                    isReplayConflict: true,
                };
            }

            const parts = (existing.nodeName || "").split(":");
            const existingStatus = parts[0];
            const legacyRecord = existing as { requestHash?: string };
            const existingHash = legacyRecord.requestHash || parts[2] || "";

            // Anti-Replay: Verify requestHash integrity
            if (existingHash && requestHash && existingHash !== requestHash) {
                return {
                    reserved: false,
                    reason: "Replay attack detected: operationId reused with divergent payload",
                    isReplayConflict: true,
                };
            }

            if (existing.status === "ABORTED" || existingStatus === "refunded" || existingStatus === "expired") {
                return {
                    reserved: false,
                    reason: `Operation already ${existingStatus || "aborted"}`,
                    isReplayConflict: true,
                };
            }

            if (existingStatus === "committed") {
                return {
                    reserved: false,
                    reason: "Operation already committed",
                    isReplayConflict: true,
                };
            }

            if (existingStatus === "reserved" || existing.status === "SETTLED") {
                const createdDate = (existing.createdAt instanceof Date ? existing.createdAt : (existing.createdAt ? new Date(existing.createdAt) : new Date())).toISOString().slice(0, 10);
                return {
                    reserved: true,
                    reservationId: existing.operationId,
                    operationId: existing.operationId,
                    periodKey: createdDate,
                };
            }
        }

        // 2. Atomic credit balance check & deduction
        const [updatedUser] = await client
            .update(schema.users)
            .set({
                creditBalanceMicro: sql`${schema.users.creditBalanceMicro} - ${delta}`,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(schema.users.id, userId),
                    sql`${schema.users.creditBalanceMicro} >= ${delta}`
                )
            )
            .returning({ id: schema.users.id });

        if (!updatedUser) {
            return {
                reserved: false,
                reason: "Insufficient credit balance",
            };
        }

        // 3. Insert credit ledger transaction record
        const nodeName = `reserved:${operation}:${requestHash}:${wordCount}`;
        const [newTx] = await client
            .insert(schema.creditLedgerTransactions)
            .values({
                operationId,
                userId,
                threadId: fileId,
                nodeName,
                modelId: options?.modelId || "gemini-2.5-flash",
                executionMode: options?.executionMode || "STREAMING_GENERATIVE",
                inputTokens: wordCount,
                cachedInputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                deltaMicro: -delta,
                status: "SETTLED",
            })
            .returning();

        return {
            reserved: true,
            reservationId: newTx?.operationId ?? operationId,
            operationId,
            periodKey: today,
        };
    };

    if (typeof targetDb.transaction === "function") {
        try {
            return await (targetDb.transaction as unknown as (cb: (tx: typeof db) => Promise<ReserveAIQuotaResult>) => Promise<ReserveAIQuotaResult>)(executeReservation);
        } catch (error) {
            // Concurrent race check on operationId
            const existing = await db.query.creditLedgerTransactions.findFirst({
                where: eq(schema.creditLedgerTransactions.operationId, operationId),
            });
            if (existing) {
                const parts = (existing.nodeName || "").split(":");
                const existingStatus = parts[0];
                const existingHash = parts[2] || "";

                if (existingHash && requestHash && existingHash !== requestHash) {
                    return {
                        reserved: false,
                        reason: "Replay attack detected: operationId reused with divergent payload",
                        isReplayConflict: true,
                    };
                }
                if (existingStatus === "reserved" || existing.status === "SETTLED") {
                    const createdDate = (existing.createdAt instanceof Date ? existing.createdAt : (existing.createdAt ? new Date(existing.createdAt) : new Date())).toISOString().slice(0, 10);
                    return {
                        reserved: true,
                        reservationId: existing.operationId,
                        operationId: existing.operationId,
                        periodKey: createdDate,
                    };
                }
                return {
                    reserved: false,
                    reason: `Operation already ${existingStatus || existing.status}`,
                    isReplayConflict: true,
                };
            }
            throw error;
        }
    }

    return await executeReservation(db);
}

/**
 * Server-Authoritative commit: transitions reservation from reserved -> committed and sets status to SETTLED.
 * Idempotent: repeated calls safely return { committed: true, reason: "already_committed" }.
 */
export async function commitAIReservation(
    operationId: string,
    consumedUnits?: number
): Promise<{ committed: boolean; reason?: string }> {
    const tx = await db.query.creditLedgerTransactions.findFirst({
        where: eq(schema.creditLedgerTransactions.operationId, operationId),
    });

    if (!tx) {
        return { committed: false, reason: "not_found" };
    }

    if (tx.status === "ABORTED" || tx.nodeName?.startsWith("refunded:") || tx.nodeName?.startsWith("expired:")) {
        return { committed: false, reason: "already_refunded" };
    }

    if (tx.nodeName?.startsWith("committed:")) {
        return { committed: true, reason: "already_committed" };
    }

    const parts = (tx.nodeName || "").split(":");
    const op = parts.length >= 2 ? parts[1] : (tx.nodeName || "general");
    const hash = parts[2] || "";
    const reservedWords = tx.inputTokens || (parts[3] ? parseInt(parts[3], 10) : 0) || 0;
    const actualConsumed = consumedUnits ?? reservedWords;

    // If consumedUnits is less than reserved, refund difference to user
    if (consumedUnits !== undefined && consumedUnits < reservedWords) {
        const refundUnits = reservedWords - consumedUnits;
        const refundMicro = BigInt(refundUnits) * BigInt(1000);
        await db
            .update(schema.users)
            .set({
                creditBalanceMicro: sql`${schema.users.creditBalanceMicro} + ${refundMicro}`,
                updatedAt: new Date(),
            })
            .where(eq(schema.users.id, tx.userId));
    }

    await db
        .update(schema.creditLedgerTransactions)
        .set({
            status: "SETTLED",
            nodeName: `committed:${op}:${hash}:${reservedWords}`,
            outputTokens: actualConsumed,
        })
        .where(eq(schema.creditLedgerTransactions.operationId, operationId));

    return { committed: true };
}

/**
 * Server-Authoritative refund: reverts credit deduction on users.creditBalanceMicro and updates status to ABORTED.
 */
export async function refundAIReservation(
    operationId: string,
    _reason: string = "stream_failed"
): Promise<{ refunded: boolean; reason?: string }> {
    const tx = await db.query.creditLedgerTransactions.findFirst({
        where: eq(schema.creditLedgerTransactions.operationId, operationId),
    });

    if (!tx) {
        return { refunded: false, reason: "reservation_not_found" };
    }

    if (tx.nodeName?.startsWith("committed:")) {
        return { refunded: false, reason: "already_committed" };
    }

    if (tx.status === "ABORTED" || tx.nodeName?.startsWith("refunded:")) {
        return { refunded: false, reason: "already_refunded" };
    }

    if (tx.nodeName?.startsWith("expired:")) {
        return { refunded: false, reason: "already_expired" };
    }

    const parts = (tx.nodeName || "").split(":");
    const op = parts.length >= 2 ? parts[1] : (tx.nodeName || "general");
    const hash = parts[2] || "";
    const reservedWords = tx.inputTokens || (parts[3] ? parseInt(parts[3], 10) : 0) || 0;

    // tx.deltaMicro was negative (debit), so -tx.deltaMicro is positive refund
    const refundAmount = tx.deltaMicro < BigInt(0) ? -tx.deltaMicro : BigInt(reservedWords) * BigInt(1000);
    const targetDb = getActiveDb();

    const executeRefund = async (client: typeof db): Promise<{ refunded: boolean; reason?: string }> => {
        await client
            .update(schema.creditLedgerTransactions)
            .set({
                status: "ABORTED",
                nodeName: `refunded:${op}:${hash}:${reservedWords}`,
            })
            .where(eq(schema.creditLedgerTransactions.operationId, operationId));

        await client
            .update(schema.users)
            .set({
                creditBalanceMicro: sql`${schema.users.creditBalanceMicro} + ${refundAmount}`,
                updatedAt: new Date(),
            })
            .where(eq(schema.users.id, tx.userId));

        return { refunded: true };
    };

    if (typeof targetDb.transaction === "function") {
        return await (targetDb.transaction as unknown as (cb: (tx: typeof db) => Promise<{ refunded: boolean; reason?: string }>) => Promise<{ refunded: boolean; reason?: string }>)(executeRefund);
    }

    return await executeRefund(db);
}

/**
 * Revert usage quota (unregistered legacy wrapper without reservation row).
 */
export async function refundUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number
): Promise<void> {
    const delta = BigInt(Math.max(1, wordCount)) * BigInt(1000);
    await db
        .update(schema.users)
        .set({
            creditBalanceMicro: sql`${schema.users.creditBalanceMicro} + ${delta}`,
            updatedAt: new Date(),
        })
        .where(eq(schema.users.id, userId));
}

/**
 * Sweep and expire stale reservations that passed their TTL.
 */
export async function expireStaleReservations(): Promise<number> {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);
    const staleTxs = await db.query.creditLedgerTransactions.findMany({
        where: and(
            sql`${schema.creditLedgerTransactions.status} = 'SETTLED'`,
            sql`${schema.creditLedgerTransactions.nodeName} LIKE 'reserved:%'`,
            sql`${schema.creditLedgerTransactions.createdAt} <= ${cutoff}`
        ),
        limit: 100,
    });

    let expiredCount = 0;
    const targetDb = getActiveDb();

    for (const tx of staleTxs) {
        const parts = (tx.nodeName || "").split(":");
        const op = parts.length >= 2 ? parts[1] : (tx.nodeName || "general");
        const hash = parts[2] || "";
        const reservedWords = tx.inputTokens || (parts[3] ? parseInt(parts[3], 10) : 0) || 0;
        const refundAmount = tx.deltaMicro < BigInt(0) ? -tx.deltaMicro : BigInt(reservedWords) * BigInt(1000);

        const executeExpireItem = async (client: typeof db): Promise<boolean> => {
            const [updated] = await client
                .update(schema.creditLedgerTransactions)
                .set({
                    status: "ABORTED",
                    nodeName: `expired:${op}:${hash}:${reservedWords}`,
                })
                .where(
                    and(
                        eq(schema.creditLedgerTransactions.operationId, tx.operationId),
                        sql`${schema.creditLedgerTransactions.nodeName} LIKE 'reserved:%'`
                    )
                )
                .returning();

            if (updated) {
                await client
                    .update(schema.users)
                    .set({
                        creditBalanceMicro: sql`${schema.users.creditBalanceMicro} + ${refundAmount}`,
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.users.id, tx.userId));

                return true;
            }
            return false;
        };

        const itemExpired = typeof targetDb.transaction === "function"
            ? await (targetDb.transaction as unknown as (cb: (tx: typeof db) => Promise<boolean>) => Promise<boolean>)(executeExpireItem)
            : await executeExpireItem(db);

        if (itemExpired) {
            expiredCount++;
        }
    }

    return expiredCount;
}

/**
 * Query an AI reservation lifecycle status by operationId (read-only).
 */
export async function getAIReservationStatus(
    operationId: string,
    userId?: string
): Promise<
    | {
          found: true;
          operationId: string;
          status: "reserved" | "committed" | "refunded" | "expired";
          operation: string;
          periodKey: string;
          reservedUnits: number;
          committedUnits: number;
          refundedUnits: number;
          expiresAt: string;
      }
    | { found: false; reason: "unauthorized" | "not_found" }
> {
    const tx = await db.query.creditLedgerTransactions.findFirst({
        where: eq(schema.creditLedgerTransactions.operationId, operationId),
    });

    if (!tx) return { found: false, reason: "not_found" };

    if (userId && tx.userId !== userId) {
        return { found: false, reason: "not_found" };
    }

    const parts = (tx.nodeName || "").split(":");
    let status: "reserved" | "committed" | "refunded" | "expired" = "reserved";
    let operation = "general";
    let reservedUnits = tx.inputTokens || 0;

    if (parts.length >= 2) {
        const prefix = parts[0];
        if (prefix === "reserved" || prefix === "committed" || prefix === "refunded" || prefix === "expired") {
            status = prefix;
            operation = parts[1] || "general";
            if (parts[3]) {
                reservedUnits = parseInt(parts[3], 10) || reservedUnits;
            }
        } else {
            operation = parts[0];
        }
    } else if (tx.nodeName) {
        operation = tx.nodeName;
    }

    if (tx.status === "ABORTED" && status !== "expired") {
        status = "refunded";
    }

    const committedUnits = status === "committed" ? (tx.outputTokens || reservedUnits) : 0;
    const refundedUnits = status === "refunded" || status === "expired" ? reservedUnits : (reservedUnits > committedUnits && status === "committed" ? reservedUnits - committedUnits : 0);

    const ttlMs = 5 * 60 * 1000;
    const expiresAt = new Date(tx.createdAt.getTime() + ttlMs).toISOString();

    return {
        found: true,
        operationId: tx.operationId,
        status,
        operation,
        periodKey: tx.createdAt.toISOString().slice(0, 10),
        reservedUnits,
        committedUnits,
        refundedUnits,
        expiresAt,
    };
}

/**
 * Convenient wrapper for reserving AI quota resolving user tier automatically.
 * Supports both 4-argument and 5-argument calls for backward compatibility.
 */
export async function reserveAndUpdateUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    tierOrOptions?: TierName | ReserveAIQuotaOptions,
    maybeOptions?: ReserveAIQuotaOptions
): Promise<ReserveAIQuotaResult> {
    let tier: TierName;
    let options: ReserveAIQuotaOptions | undefined;

    if (typeof tierOrOptions === "string") {
        tier = tierOrOptions as TierName;
        options = maybeOptions;
    } else {
        tier = await getUserTier(userId);
        options = tierOrOptions;
    }

    return reserveAIQuota(userId, operation, wordCount, tier, options);
}

/**
 * Options for flushing pending settlements to PostgreSQL.
 */
export interface FlushPendingSettlementsOptions {
  onlyOlderThanMs?: number;
  customRedis?: any;
}

/**
 * Result summary of flushing pending settlements.
 */
export interface FlushPendingSettlementsResult {
  flushedCount: number;
  netDeltaMicro: bigint;
}

/**
 * Helper to retrieve all hash keys and values from Redis.
 * Supports Upstash Redis, InMemory test clients, and Lua fallback.
 */
async function redisHGetAll(
  client: any,
  key: string
): Promise<Record<string, unknown> | null> {
  if (typeof client.hgetall === "function") {
    return await client.hgetall(key);
  }
  if (client.pendingSettlements instanceof Map) {
    const val = client.pendingSettlements.get(key);
    if (val instanceof Map) {
      return Object.fromEntries(val.entries());
    }
    return val ?? null;
  }
  if (typeof client.eval === "function") {
    const res = await client.eval("return redis.call('HGETALL', KEYS[1])", [key], []);
    if (Array.isArray(res)) {
      const result: Record<string, unknown> = {};
      for (let i = 0; i < res.length; i += 2) {
        result[res[i]] = res[i + 1];
      }
      return result;
    }
    return res as Record<string, unknown>;
  }
  return null;
}

/**
 * Helper to delete fields from Redis hash.
 */
async function redisHDel(
  client: any,
  key: string,
  ...fields: string[]
): Promise<number> {
  if (fields.length === 0) return 0;
  if (typeof client.hdel === "function") {
    return await client.hdel(key, ...fields);
  }
  if (client.pendingSettlements instanceof Map) {
    const val = client.pendingSettlements.get(key);
    if (val instanceof Map) {
      let count = 0;
      for (const f of fields) {
        if (val.delete(f)) count++;
      }
      return count;
    }
  }
  if (typeof client.eval === "function") {
    const res = await client.eval(
      "return redis.call('HDEL', KEYS[1], unpack(ARGV))",
      [key],
      fields
    );
    return Number(res || 0);
  }
  return 0;
}

/**
 * Helper to inspect Redis hash length.
 */
async function redisHLen(client: any, key: string): Promise<number> {
  if (typeof client.hlen === "function") {
    return await client.hlen(key);
  }
  if (client.pendingSettlements instanceof Map) {
    const val = client.pendingSettlements.get(key);
    if (val instanceof Map) {
      return val.size;
    }
    return val ? Object.keys(val).length : 0;
  }
  if (typeof client.eval === "function") {
    const res = await client.eval("return redis.call('HLEN', KEYS[1])", [key], []);
    return Number(res || 0);
  }
  return 0;
}

/**
 * Helper to remove member from Redis set.
 */
async function redisSRem(
  client: any,
  key: string,
  ...members: string[]
): Promise<number> {
  if (members.length === 0) return 0;
  if (typeof client.srem === "function") {
    return await client.srem(key, ...members);
  }
  if (client.dirtyWallets instanceof Set) {
    let count = 0;
    for (const m of members) {
      if (client.dirtyWallets.delete(m)) count++;
    }
    return count;
  }
  if (typeof client.eval === "function") {
    const res = await client.eval(
      "return redis.call('SREM', KEYS[1], unpack(ARGV))",
      [key],
      members
    );
    return Number(res || 0);
  }
  return 0;
}

/**
 * Reads user's current creditBalanceMicro directly from the database users table.
 * Defaults to 0n if user not found or field is null/undefined.
 */
export async function getUserCreditBalance(userId: string): Promise<bigint> {
  const targetDb = getActiveDb();
  const user = await targetDb.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { creditBalanceMicro: true },
  });

  if (!user || user.creditBalanceMicro == null) {
    return BigInt(0);
  }
  return BigInt(user.creditBalanceMicro);
}

/**
 * Flushes pending settlements from Redis hash `lugx:pending_settlements:${userId}`
 * to PostgreSQL `credit_ledger_transactions` and adjusts `users.creditBalanceMicro`
 * in a single atomic database transaction.
 */
export async function flushPendingSettlementsToPostgres(
  userId: string,
  options?: FlushPendingSettlementsOptions
): Promise<FlushPendingSettlementsResult> {
  const redisClient = options?.customRedis || (isRedisConfigured() ? redis : null);
  if (!redisClient) {
    throw new MeteringServiceUnavailableError();
  }

  try {
    const pendingKey = REDIS_KEYS.pendingSettlements(userId);
    const rawEntries = await redisHGetAll(redisClient, pendingKey);

    const entriesMap: Record<string, unknown> =
      rawEntries instanceof Map
        ? Object.fromEntries(rawEntries.entries())
        : (rawEntries as Record<string, unknown>) || {};

    const keys = Object.keys(entriesMap);
    if (keys.length === 0) {
      await redisSRem(redisClient, REDIS_KEYS.dirtyWallets(), userId);
      return { flushedCount: 0, netDeltaMicro: BigInt(0) };
    }

    const now = Date.now();
    const eligibleEntries: Array<{ opId: string; data: any }> = [];

    for (const [opId, rawVal] of Object.entries(entriesMap)) {
      let data: any = rawVal;
      if (typeof rawVal === "string") {
        try {
          data = JSON.parse(rawVal);
        } catch {
          data = rawVal;
        }
      }
      if (!data || typeof data !== "object") {
        data = {};
      }

      const createdAtMs = Number(
        data.created_at_ms ?? data.createdAtMs ?? data.createdAt ?? now
      );

      if (
        options?.onlyOlderThanMs !== undefined &&
        now - createdAtMs < options.onlyOlderThanMs
      ) {
        continue;
      }

      eligibleEntries.push({ opId, data });
    }

    if (eligibleEntries.length === 0) {
      return { flushedCount: 0, netDeltaMicro: BigInt(0) };
    }

    const targetDb = getActiveDb();
    let returningRows: Array<typeof schema.creditLedgerTransactions.$inferSelect> = [];
    let calculatedNetDeltaMicro = BigInt(0);

    const executeFlush = async (tx: typeof db) => {
      const rowsToInsert: Array<typeof schema.creditLedgerTransactions.$inferInsert> =
        eligibleEntries.map(({ opId, data }) => {
          let deltaMicro = BigInt(0);
          if (data.deltaMicro !== undefined && data.deltaMicro !== null) {
            deltaMicro = BigInt(data.deltaMicro);
          } else if (
            data.actualTotalCostMicro !== undefined &&
            data.actualTotalCostMicro !== null
          ) {
            deltaMicro = -BigInt(data.actualTotalCostMicro);
          } else if (
            data.actualCostMicro !== undefined &&
            data.actualCostMicro !== null
          ) {
            deltaMicro = -BigInt(data.actualCostMicro);
          }

          return {
            operationId: opId,
            userId: data.userId || userId,
            threadId: data.threadId ?? null,
            nodeName: data.nodeName ?? null,
            modelId: data.modelId ?? "gemini-2.5-flash",
            executionMode: (data.executionMode as any) ?? "STREAMING_GENERATIVE",
            inputTokens: Number(data.inputTokens ?? 0),
            cachedInputTokens: Number(data.cachedInputTokens ?? 0),
            outputTokens: Number(data.outputTokens ?? 0),
            reasoningTokens: Number(data.reasoningTokens ?? 0),
            deltaMicro,
            status: (data.status as any) ?? "SETTLED",
            createdAt: data.created_at_ms
              ? new Date(Number(data.created_at_ms))
              : new Date(),
          };
        });

      returningRows = await tx
        .insert(schema.creditLedgerTransactions)
        .values(rowsToInsert)
        .onConflictDoNothing({
          target: schema.creditLedgerTransactions.operationId,
        })
        .returning();

      calculatedNetDeltaMicro = returningRows.reduce(
        (acc, row) => acc + BigInt(row.deltaMicro),
        BigInt(0)
      );

      if (calculatedNetDeltaMicro !== BigInt(0)) {
        await tx
          .update(schema.users)
          .set({
            creditBalanceMicro: sql`${schema.users.creditBalanceMicro} + ${calculatedNetDeltaMicro}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, userId));
      }
    };

    if (typeof targetDb.transaction === "function") {
      await (
        targetDb.transaction as unknown as (
          cb: (tx: typeof db) => Promise<void>
        ) => Promise<void>
      )(executeFlush);
    } else {
      await executeFlush(db);
    }

    const flushedOpIds = eligibleEntries.map((e) => e.opId);
    if (flushedOpIds.length > 0) {
      await redisHDel(redisClient, pendingKey, ...flushedOpIds);
      const remaining = await redisHLen(redisClient, pendingKey);
      if (remaining === 0) {
        await redisSRem(redisClient, REDIS_KEYS.dirtyWallets(), userId);
      }
    }

    return {
      flushedCount: eligibleEntries.length,
      netDeltaMicro: calculatedNetDeltaMicro,
    };
  } catch (error) {
    if (error instanceof MeteringServiceUnavailableError) {
      throw error;
    }
    throw new MeteringServiceUnavailableError(
      error instanceof Error ? error.message : "Failed to flush pending settlements"
    );
  }
}
