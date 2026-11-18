import { db } from "@/server/db";
import { txDb } from "@/server/db/transactional";
import * as schema from "@/server/db/schema";
import crypto from "node:crypto";
import { TierName } from "@/config/tiers.config";
import { eq, and, sql } from "drizzle-orm";
import { isRedisConfigured, redis } from "@/lib/redis";
import { REDIS_KEYS } from "@/lib/metering/constants";
import {
  MeteringServiceUnavailableError,
  type RedisEvalClient,
} from "@/lib/metering/lua-scripts";

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

/**
 * Redis client shape compatible with hash and set operations.
 */
export interface SettlementRedisClient {
  hgetall?(key: string): Promise<Record<string, unknown> | null>;
  hdel?(key: string, ...fields: string[]): Promise<number>;
  hlen?(key: string): Promise<number>;
  srem?(key: string, ...members: string[]): Promise<number>;
  pendingSettlements?: Map<string, Map<string, unknown> | Record<string, unknown>>;
  dirtyWallets?: Set<string>;
  eval?<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T>;
}

/**
 * Options for flushing pending settlements to PostgreSQL.
 */
export interface FlushPendingSettlementsOptions {
  onlyOlderThanMs?: number;
  customRedis?: RedisEvalClient | SettlementRedisClient | null;
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
  client: SettlementRedisClient,
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
    return (val as Record<string, unknown>) ?? null;
  }
  if (typeof client.eval === "function") {
    const res = await client.eval("return redis.call('HGETALL', KEYS[1])", [key], []);
    if (Array.isArray(res)) {
      const result: Record<string, unknown> = {};
      for (let i = 0; i < res.length; i += 2) {
        result[String(res[i])] = res[i + 1];
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
  client: SettlementRedisClient,
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
async function redisHLen(client: SettlementRedisClient, key: string): Promise<number> {
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
  client: SettlementRedisClient,
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
 * Flushes pending settlements from Redis hash `credit:pending_settlements:${userId}`
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
    const eligibleEntries: Array<{ opId: string; data: Record<string, unknown> }> = [];

    for (const [opId, rawVal] of Object.entries(entriesMap)) {
      let data: Record<string, unknown> =
        typeof rawVal === "object" && rawVal !== null
          ? (rawVal as Record<string, unknown>)
          : {};
      if (typeof rawVal === "string") {
        try {
          const parsed = JSON.parse(rawVal);
          if (parsed && typeof parsed === "object") {
            data = parsed as Record<string, unknown>;
          }
        } catch {
          // Keep fallback
        }
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
            deltaMicro = BigInt(data.deltaMicro as bigint | number | string);
          } else if (
            data.actualTotalCostMicro !== undefined &&
            data.actualTotalCostMicro !== null
          ) {
            deltaMicro = -BigInt(data.actualTotalCostMicro as bigint | number | string);
          } else if (
            data.actualCostMicro !== undefined &&
            data.actualCostMicro !== null
          ) {
            deltaMicro = -BigInt(data.actualCostMicro as bigint | number | string);
          }

          return {
            operationId: opId,
            userId: (data.userId as string) || userId,
            threadId: (data.threadId as string | null) ?? null,
            nodeName: (data.nodeName as string | null) ?? null,
            modelId: (data.modelId as string) ?? "gemini-2.5-flash",
            executionMode:
              (data.executionMode as typeof schema.executionModeEnum.enumValues[number]) ??
              "STREAMING_GENERATIVE",
            inputTokens: Number(data.inputTokens ?? 0),
            cachedInputTokens: Number(data.cachedInputTokens ?? 0),
            outputTokens: Number(data.outputTokens ?? 0),
            reasoningTokens: Number(data.reasoningTokens ?? 0),
            deltaMicro,
            status:
              (data.status as typeof schema.ledgerSettlementStatusEnum.enumValues[number]) ??
              "SETTLED",
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
