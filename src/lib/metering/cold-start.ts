import { isRedisConfigured, redis } from "@/lib/redis";
import { REDIS_KEYS, WALLET_TTL_SECONDS } from "./constants";
import {
  MeteringServiceUnavailableError,
  type RedisEvalClient,
} from "./lua-scripts";
import {
  getUserCreditBalance,
  flushPendingSettlementsToPostgres,
} from "@/server/services/ai-settlement-service";

/**
 * Checks if key exists in Redis.
 * Supports Upstash Redis, in-memory test mocks, and Lua fallback.
 */
async function redisKeyExists(client: any, key: string): Promise<boolean> {
  if (typeof client.exists === "function") {
    const res = await client.exists(key);
    return res === 1 || res === true;
  }
  if (client.wallets instanceof Map) {
    return client.wallets.has(key);
  }
  if (typeof client.eval === "function") {
    const res = await client.eval("return redis.call('EXISTS', KEYS[1])", [key], []);
    return res === 1 || res === "1" || res === true;
  }
  return false;
}

/**
 * Gets string value from Redis.
 */
async function redisGet(client: any, key: string): Promise<string | number | null> {
  if (typeof client.get === "function") {
    return await client.get(key);
  }
  if (client.wallets instanceof Map) {
    return client.wallets.has(key) ? client.wallets.get(key) : null;
  }
  if (typeof client.eval === "function") {
    return await client.eval("return redis.call('GET', KEYS[1])", [key], []);
  }
  return null;
}

/**
 * Checks hash length in Redis.
 */
async function redisHLen(client: any, key: string): Promise<number> {
  if (typeof client.hlen === "function") {
    return await client.hlen(key);
  }
  if (client.pendingSettlements instanceof Map) {
    const map = client.pendingSettlements.get(key);
    if (map instanceof Map) {
      return map.size;
    }
    return map ? Object.keys(map).length : 0;
  }
  if (typeof client.eval === "function") {
    const res = await client.eval("return redis.call('HLEN', KEYS[1])", [key], []);
    return Number(res || 0);
  }
  return 0;
}

/**
 * Atomically sets key if not exists and sets TTL.
 */
async function redisSetnxExpire(
  client: any,
  key: string,
  value: string | number,
  ttlSeconds: number
): Promise<void> {
  if (typeof client.set === "function") {
    await client.set(key, value.toString(), { nx: true, ex: ttlSeconds });
    return;
  }
  if (typeof client.setnx === "function") {
    const res = await client.setnx(key, value.toString());
    if (res && typeof client.expire === "function") {
      await client.expire(key, ttlSeconds);
    }
    return;
  }
  if (client.wallets instanceof Map) {
    if (!client.wallets.has(key)) {
      client.wallets.set(key, Number(value));
    }
    return;
  }
  if (typeof client.eval === "function") {
    const script = `
      local set = redis.call('SETNX', KEYS[1], ARGV[1])
      if set == 1 then
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
      end
      return set
    `;
    await client.eval(script, [key], [value.toString(), ttlSeconds]);
    return;
  }
}

/**
 * Ensures user credit wallet is loaded into Redis with a flush-first policy.
 *
 * 1. Checks if wallet key is warm in Redis. If warm, returns cached balance.
 * 2. If cold (absent):
 *    a. Flushes any pending settlements to PostgreSQL first to avoid reading stale balances.
 *    b. Queries current PostgreSQL credit balance.
 *    c. Populates Redis with SETNX and 24-hour TTL (WALLET_TTL_SECONDS = 86400).
 *    d. Returns the confirmed balance.
 *
 * Fails closed with MeteringServiceUnavailableError if Redis is unavailable or unconfigured.
 */
export async function ensureWalletLoadedFlushFirst(
  userId: string,
  customRedis?: RedisEvalClient
): Promise<bigint> {
  const client = customRedis || (isRedisConfigured() ? redis : null);
  if (!client) {
    throw new MeteringServiceUnavailableError();
  }

  try {
    const walletKey = REDIS_KEYS.wallet(userId);
    const pendingKey = REDIS_KEYS.pendingSettlements(userId);

    // 1. Warm check
    const isWarm = await redisKeyExists(client, walletKey);
    if (isWarm) {
      const rawBal = await redisGet(client, walletKey);
      if (rawBal !== null && rawBal !== undefined) {
        return BigInt(rawBal.toString());
      }
    }

    // 2. Cold start sequence
    const pendingCount = await redisHLen(client, pendingKey);
    if (pendingCount > 0) {
      await flushPendingSettlementsToPostgres(userId, { customRedis: client });
    }

    const currentBalance = await getUserCreditBalance(userId);

    await redisSetnxExpire(
      client,
      walletKey,
      currentBalance.toString(),
      WALLET_TTL_SECONDS
    );

    return currentBalance;
  } catch (error) {
    if (error instanceof MeteringServiceUnavailableError) {
      throw error;
    }
    throw new MeteringServiceUnavailableError(
      error instanceof Error ? error.message : "Failed to ensure wallet loaded"
    );
  }
}
