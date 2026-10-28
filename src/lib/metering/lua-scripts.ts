import { isRedisConfigured, redis } from "@/lib/redis";
import { LEASE_TTL_SECONDS, REDIS_KEYS } from "./constants";

/**
 * Service Unavailable error thrown when Redis is unreachable or unconfigured.
 * Enforces the strict Fail-Closed financial policy for credit metering.
 */
export class MeteringServiceUnavailableError extends Error {
  public readonly status = 503;
  public readonly code = "METERING_SERVICE_UNAVAILABLE";

  constructor(message = "Metering service unavailable (Fail-Closed policy enforced)") {
    super(message);
    this.name = "MeteringServiceUnavailableError";
  }
}

/**
 * Minimal evaluation interface compatible with Upstash Redis and testing mocks.
 */
export interface RedisEvalClient {
  eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T>;
}

/**
 * Atomic Lua script for pre-flight credit reservation and chunk extension.
 *
 * KEYS[1] = lugx:wallet:${userId}
 * KEYS[2] = lugx:lease:${operationId}
 * KEYS[3] = lugx:step_done:${stepKey}
 *
 * ARGV[1] = requiredInputMicro
 * ARGV[2] = desiredOutputMicro
 * ARGV[3] = minAllowedOutputMicro
 * ARGV[4] = isZeroDustAllowed ("1" | "0")
 * ARGV[5] = leaseTtlSeconds ("120")
 * ARGV[6] = userId
 * ARGV[7] = stepKey
 */
export const RESERVE_OR_EXTEND_LUA = `
local doneReceipt = redis.call('GET', KEYS[3])
if doneReceipt then
  return cjson.encode({ status = 'ALREADY_DONE', receipt = doneReceipt })
end

if redis.call('EXISTS', KEYS[1]) == 0 then
  return cjson.encode({ status = 'COLD_START_REQUIRED' })
end

local bal = tonumber(redis.call('GET', KEYS[1]) or '0')
local reqInput = tonumber(ARGV[1])
local desOutput = tonumber(ARGV[2])
local minOutput = tonumber(ARGV[3])
local zeroDust = tonumber(ARGV[4])
local leaseTtl = tonumber(ARGV[5])
local userId = ARGV[6]
local stepKey = ARGV[7]

if zeroDust == 1 then
  if bal < reqInput then
    return cjson.encode({ status = 'INSUFFICIENT_CREDITS', available = bal, required = reqInput })
  end
else
  if bal < (reqInput + minOutput) then
    return cjson.encode({ status = 'INSUFFICIENT_CREDITS', available = bal, required = (reqInput + minOutput) })
  end
end

local resOutput = 0
if desOutput > 0 then
  if bal >= (reqInput + desOutput) then
    resOutput = desOutput
  elseif zeroDust == 1 then
    resOutput = math.max(0, bal - reqInput)
  else
    resOutput = desOutput
  end
end

local totalRes = reqInput + resOutput
redis.call('DECRBY', KEYS[1], totalRes)
redis.call('EXPIRE', KEYS[1], 86400)

redis.call('HINCRBY', KEYS[2], 'totalReservedMicro', totalRes)
redis.call('HINCRBY', KEYS[2], 'reservedInputMicro', reqInput)
redis.call('HINCRBY', KEYS[2], 'reservedOutputMicro', resOutput)
redis.call('HSET', KEYS[2], 'userId', userId)
redis.call('HSET', KEYS[2], 'stepKey', stepKey)
redis.call('EXPIRE', KEYS[2], leaseTtl)

return cjson.encode({
  status = 'SUCCESS',
  reservedInputMicro = reqInput,
  reservedOutputMicro = resOutput,
  totalReservedMicro = totalRes,
  newBalanceMicro = bal - totalRes
})
`;

/**
 * Atomic Lua script for operation settlement, surplus refund, and durability staging.
 *
 * KEYS[1] = lugx:wallet:${userId}
 * KEYS[2] = lugx:lease:${operationId}
 * KEYS[3] = lugx:pending_settlements:${userId}
 * KEYS[4] = lugx:dirty_wallets
 * KEYS[5] = lugx:step_done:${stepKey}
 *
 * ARGV[1] = operationId
 * ARGV[2] = actualTotalCostMicro
 * ARGV[3] = settlementPayloadJson
 * ARGV[4] = userId
 */
export const SETTLE_OPERATION_LUA = `
local totalReserved = tonumber(redis.call('HGET', KEYS[2], 'totalReservedMicro') or '0')
local actualCost = tonumber(ARGV[2])
local refund = math.max(0, totalReserved - actualCost)

if refund > 0 then
  redis.call('INCRBY', KEYS[1], refund)
end
redis.call('EXPIRE', KEYS[1], 86400)

redis.call('DEL', KEYS[2])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
redis.call('SADD', KEYS[4], ARGV[4])
redis.call('SET', KEYS[5], ARGV[3], 'EX', 3600)

local newBal = tonumber(redis.call('GET', KEYS[1]) or '0')

return cjson.encode({
  status = 'SETTLED',
  refundMicro = refund,
  totalReservedMicro = totalReserved,
  actualCostMicro = actualCost,
  newBalanceMicro = newBal
})
`;

/**
 * Atomic Lua script for Stripe webhook top-up dual-write to warm Redis wallets.
 *
 * KEYS[1] = lugx:wallet:${userId}
 * ARGV[1] = topupMicro
 */
export const STRIPE_DUAL_WRITE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local newBal = redis.call('INCRBY', KEYS[1], ARGV[1])
  redis.call('EXPIRE', KEYS[1], 86400)
  return cjson.encode({ applied = true, newBalanceMicro = tonumber(newBal) })
else
  return cjson.encode({ applied = false, newBalanceMicro = nil })
end
`;

export interface ReserveOrExtendParams {
  userId: string;
  operationId: string;
  stepKey: string;
  requiredInputMicro: bigint | number;
  desiredOutputMicro: bigint | number;
  minAllowedOutputMicro: bigint | number;
  isZeroDustAllowed: boolean;
  leaseTtlSeconds?: number;
}

export type ReserveOrExtendResult =
  | {
      status: "SUCCESS";
      reservedInputMicro: number;
      reservedOutputMicro: number;
      totalReservedMicro: number;
      newBalanceMicro: number;
    }
  | {
      status: "INSUFFICIENT_CREDITS";
      available: number;
      required: number;
    }
  | {
      status: "COLD_START_REQUIRED";
    }
  | {
      status: "ALREADY_DONE";
      receipt: string;
    };

export interface SettleOperationParams {
  userId: string;
  operationId: string;
  stepKey: string;
  actualTotalCostMicro: bigint | number;
  settlementPayload: Record<string, unknown> | string;
}

export interface SettleOperationResult {
  status: "SETTLED";
  refundMicro: number;
  totalReservedMicro: number;
  actualCostMicro: number;
  newBalanceMicro: number;
}

export interface StripeDualWriteParams {
  userId: string;
  topupMicro: bigint | number;
}

export interface StripeDualWriteResult {
  applied: boolean;
  newBalanceMicro?: number | null;
}

function parseScriptResult<T>(result: unknown): T {
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as T;
    } catch {
      return result as unknown as T;
    }
  }
  return result as T;
}

function getClient(customRedis?: RedisEvalClient): RedisEvalClient {
  if (customRedis) {
    return customRedis;
  }
  if (!isRedisConfigured()) {
    throw new MeteringServiceUnavailableError();
  }
  return redis as unknown as RedisEvalClient;
}

/**
 * Executes the atomic reservation or chunk extension Lua script.
 */
export async function executeReserveOrExtend(
  params: ReserveOrExtendParams,
  customRedis?: RedisEvalClient
): Promise<ReserveOrExtendResult> {
  try {
    const client = getClient(customRedis);
    const keys = [
      REDIS_KEYS.wallet(params.userId),
      REDIS_KEYS.lease(params.operationId),
      REDIS_KEYS.stepDone(params.stepKey),
    ];
    const args = [
      String(params.requiredInputMicro),
      String(params.desiredOutputMicro),
      String(params.minAllowedOutputMicro),
      params.isZeroDustAllowed ? "1" : "0",
      String(params.leaseTtlSeconds ?? LEASE_TTL_SECONDS),
      params.userId,
      params.stepKey,
    ];

    const raw = await client.eval<string | ReserveOrExtendResult>(
      RESERVE_OR_EXTEND_LUA,
      keys,
      args
    );
    return parseScriptResult<ReserveOrExtendResult>(raw);
  } catch (error) {
    if (error instanceof MeteringServiceUnavailableError) {
      throw error;
    }
    throw new MeteringServiceUnavailableError(
      error instanceof Error ? error.message : "Redis reserve_or_extend execution failed"
    );
  }
}

/**
 * Executes the atomic operation settlement and durability staging Lua script.
 */
export async function executeSettleOperation(
  params: SettleOperationParams,
  customRedis?: RedisEvalClient
): Promise<SettleOperationResult> {
  try {
    const client = getClient(customRedis);
    const payloadJson =
      typeof params.settlementPayload === "string"
        ? params.settlementPayload
        : JSON.stringify(params.settlementPayload);

    const keys = [
      REDIS_KEYS.wallet(params.userId),
      REDIS_KEYS.lease(params.operationId),
      REDIS_KEYS.pendingSettlements(params.userId),
      REDIS_KEYS.dirtyWallets(),
      REDIS_KEYS.stepDone(params.stepKey),
    ];
    const args = [
      params.operationId,
      String(params.actualTotalCostMicro),
      payloadJson,
      params.userId,
    ];

    const raw = await client.eval<string | SettleOperationResult>(
      SETTLE_OPERATION_LUA,
      keys,
      args
    );
    return parseScriptResult<SettleOperationResult>(raw);
  } catch (error) {
    if (error instanceof MeteringServiceUnavailableError) {
      throw error;
    }
    throw new MeteringServiceUnavailableError(
      error instanceof Error ? error.message : "Redis settle_operation execution failed"
    );
  }
}

/**
 * Executes the atomic Stripe webhook dual-write Lua script.
 */
export async function executeStripeDualWrite(
  params: StripeDualWriteParams,
  customRedis?: RedisEvalClient
): Promise<StripeDualWriteResult> {
  try {
    const client = getClient(customRedis);
    const keys = [REDIS_KEYS.wallet(params.userId)];
    const args = [String(params.topupMicro)];

    const raw = await client.eval<string | StripeDualWriteResult>(
      STRIPE_DUAL_WRITE_LUA,
      keys,
      args
    );
    return parseScriptResult<StripeDualWriteResult>(raw);
  } catch (error) {
    if (error instanceof MeteringServiceUnavailableError) {
      throw error;
    }
    throw new MeteringServiceUnavailableError(
      error instanceof Error ? error.message : "Redis stripe_dual_write execution failed"
    );
  }
}
