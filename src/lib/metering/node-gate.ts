import crypto from "node:crypto";
import type { AgentGraphState } from "@/core/agent/state";
import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import { isRedisConfigured, redis } from "@/lib/redis";
import { REDIS_KEYS } from "./constants";
import {
  executeReserveOrExtend,
  executeSettleOperation,
  MeteringServiceUnavailableError,
  type RedisEvalClient,
} from "./lua-scripts";
import {
  deriveModelReservationParameters,
  tokensToMicroCredits,
  getModelRegistryEntry,
} from "./derivation";
import { estimatePessimisticInputTokens } from "./tokenizer";
import { ensureWalletLoadedFlushFirst } from "./cold-start";

/**
 * Redis client shape compatible with stepDone reads and eval.
 */
export interface NodeGateRedisClient {
  get?(key: string): Promise<unknown>;
  stepDone?: Map<string, string>;
  eval?<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<T>;
}

/**
 * Configuration options for `withMeteredNodeGate`.
 */
export interface MeteredNodeGateOptions {
  customRedis?: RedisEvalClient;
  isSystem2Node?: boolean;
  checkpointId?: string;
  stepAttempt?: number;
  pessimisticInputTokens?:
    | number
    | ((state: Readonly<AgentGraphState>, ctx: AgentRuntimeContext) => number);
  discreteCeilingTokens?: number;
  calculateActualCostMicro?: (
    result: NodeExecutionResult,
    state: Readonly<AgentGraphState>,
  ) => bigint | number;
}

/**
 * Reads `step_done` receipt from Redis.
 */
async function getStepDoneReceipt(
  client: NodeGateRedisClient,
  key: string,
): Promise<string | null> {
  if (typeof client.get === "function") {
    const val = await client.get(key);
    return val ? (typeof val === "string" ? val : JSON.stringify(val)) : null;
  }
  if (client.stepDone instanceof Map) {
    return client.stepDone.get(key) ?? null;
  }
  if (typeof client.eval === "function") {
    const res = await client.eval(
      "return redis.call('GET', KEYS[1])",
      [key],
      [],
    );
    return res ? String(res) : null;
  }
  return null;
}

/**
 * Extracts pessimistic input token estimate from `AgentGraphState`.
 */
function extractPessimisticInputTokens(
  state: Readonly<AgentGraphState>,
): number {
  const parts: string[] = [];

  if (state.user_request?.prompt) {
    parts.push(state.user_request.prompt);
  }

  if (Array.isArray(state.messages) && state.messages.length > 0) {
    for (const msg of state.messages) {
      if (typeof msg.content === "string" && msg.content.length > 0) {
        parts.push(msg.content);
      }
    }
  }

  if (parts.length === 0) {
    return 0;
  }

  return estimatePessimisticInputTokens(parts.join("\n"));
}

/**
 * Calculates actual micro-credit cost based on execution result and model registry.
 */
function calculateCost(
  nodeResult: NodeExecutionResult,
  modelId: string,
  inputTokens: number,
  fallbackReservedMicro: number,
): bigint | number {
  const res = nodeResult as unknown as Record<string, unknown>;
  if (
    res.actualTotalCostMicro !== undefined &&
    res.actualTotalCostMicro !== null
  ) {
    return res.actualTotalCostMicro as bigint | number;
  }
  if (res.usage && typeof res.usage === "object") {
    const usage = res.usage as Record<string, unknown>;
    const inTokens = Number(
      usage.inputTokens ?? usage.prompt_tokens ?? inputTokens,
    );
    const outTokens = Number(
      usage.outputTokens ?? usage.completion_tokens ?? 0,
    );
    try {
      const model = getModelRegistryEntry(modelId);
      const inMicro = tokensToMicroCredits(inTokens, model.creditsPer1kInput);
      const outMicro = tokensToMicroCredits(
        outTokens,
        model.creditsPer1kOutput,
      );
      return inMicro + outMicro;
    } catch {
      // Fallback to reserved amount
    }
  }
  return fallbackReservedMicro;
}

/**
 * Higher-order node wrapper for Elixent Native Graph Engine nodes providing:
 * 1. Resumption idempotency check via `credit:step_done:${stepKey}`
 * 2. Pre-flight credit reservation with Zero-Dust drain derivation
 * 3. Native `NodeExecutionResult` interruption (`INSUFFICIENT_CREDITS`)
 * 4. Post-execution settlement and refund via atomic Lua scripts
 */
export function withMeteredNodeGate(
  nodeName: string,
  modelId: string,
  nodeFn: AgentGraphNodeFn,
  options?: MeteredNodeGateOptions,
): AgentGraphNodeFn {
  return async (
    state: Readonly<AgentGraphState>,
    ctx: AgentRuntimeContext,
  ): Promise<NodeExecutionResult> => {
    const effectiveModelId =
      options?.isSystem2Node || modelId === "system2"
        ? ctx.selectedSystem2ModelId || modelId
        : modelId;

    const threadId = ctx.threadId || "default_thread";
    const checkpointId =
      options?.checkpointId ?? (ctx.turnId || "default_checkpoint");
    const stepAttempt = options?.stepAttempt ?? 1;

    const customRedis = options?.customRedis;
    const client = customRedis || (isRedisConfigured() ? redis : null);
    if (!client) {
      throw new MeteringServiceUnavailableError();
    }

    // 1. Compute canonical stepKey for node execution idempotency
    const stepKey = crypto
      .createHash("sha256")
      .update(`${threadId}:${checkpointId}:${nodeName}:${stepAttempt}`)
      .digest("hex");

    // 2. Resumption check: if step was already completed, bypass billing
    const existingReceipt = await getStepDoneReceipt(
      client,
      REDIS_KEYS.stepDone(stepKey),
    );
    if (existingReceipt) {
      return await nodeFn(state, ctx);
    }

    // 3. Resolve authenticated user identity
    const userId = ctx.userId;
    if (!userId) {
      throw new Error(
        `withMeteredNodeGate: userId could not be resolved from AgentRuntimeContext for node "${nodeName}"`,
      );
    }

    // 4. Ensure wallet is warm in Redis (executing flush-first if cold)
    const availableBalanceMicro = await ensureWalletLoadedFlushFirst(
      userId,
      customRedis,
    );

    // 5. Determine pessimistic input tokens
    let inputTokens: number;
    if (typeof options?.pessimisticInputTokens === "function") {
      inputTokens = options.pessimisticInputTokens(state, ctx);
    } else if (typeof options?.pessimisticInputTokens === "number") {
      inputTokens = options.pessimisticInputTokens;
    } else {
      inputTokens = extractPessimisticInputTokens(state);
    }

    // 6. Derive mathematical reservation parameters
    const derived = deriveModelReservationParameters(
      effectiveModelId,
      inputTokens,
      availableBalanceMicro,
      options?.discreteCeilingTokens,
    );

    // 7. Execute atomic reservation
    let reserveResult = await executeReserveOrExtend(
      {
        userId,
        operationId: stepKey,
        stepKey,
        requiredInputMicro: derived.requiredInputMicro,
        desiredOutputMicro: derived.desiredOutputMicro,
        minAllowedOutputMicro: derived.minAllowedOutputMicro,
        isZeroDustAllowed: derived.isZeroDustAllowed,
      },
      customRedis,
    );

    // If cold start race occurred, reload once
    if (reserveResult.status === "COLD_START_REQUIRED") {
      const refreshedBal = await ensureWalletLoadedFlushFirst(
        userId,
        customRedis,
      );
      const reDerived = deriveModelReservationParameters(
        effectiveModelId,
        inputTokens,
        refreshedBal,
        options?.discreteCeilingTokens,
      );
      reserveResult = await executeReserveOrExtend(
        {
          userId,
          operationId: stepKey,
          stepKey,
          requiredInputMicro: reDerived.requiredInputMicro,
          desiredOutputMicro: reDerived.desiredOutputMicro,
          minAllowedOutputMicro: reDerived.minAllowedOutputMicro,
          isZeroDustAllowed: reDerived.isZeroDustAllowed,
        },
        customRedis,
      );
    }

    if (reserveResult.status === "ALREADY_DONE") {
      return await nodeFn(state, ctx);
    }

    if (reserveResult.status === "INSUFFICIENT_CREDITS") {
      return {
        status: "INTERRUPTED",
        interruptReason: "INSUFFICIENT_CREDITS",
        stateDelta: {},
        interruptPayload: {
          availableMicro: reserveResult.available,
          requiredMicro: reserveResult.required,
        },
      };
    }

    if (reserveResult.status !== "SUCCESS") {
      throw new MeteringServiceUnavailableError(
        `Failed to reserve quota for node "${nodeName}": unexpected reservation status "${(reserveResult as Record<string, unknown>).status}"`,
      );
    }

    // 8. Execute node execution with failure rollback protection
    let nodeResult: NodeExecutionResult;
    try {
      nodeResult = await nodeFn(state, ctx);
    } catch (error) {
      // Refund reservation on execution crash
      try {
        await executeSettleOperation(
          {
            userId,
            operationId: stepKey,
            stepKey,
            actualTotalCostMicro: 0,
            settlementPayload: {
              operationId: stepKey,
              userId,
              threadId,
              nodeName,
              modelId: effectiveModelId,
              status: "ABORTED",
              actualTotalCostMicro: 0,
              error: error instanceof Error ? error.message : String(error),
              created_at_ms: Date.now(),
            },
          },
          customRedis,
        );
      } catch {
        // Suppress cleanup failure to surface primary error
      }
      throw error;
    }

    // 9. Compute actual cost and finalize settlement
    let actualCostMicro: bigint | number;
    if (options?.calculateActualCostMicro) {
      actualCostMicro = options.calculateActualCostMicro(nodeResult, state);
    } else {
      actualCostMicro = calculateCost(
        nodeResult,
        effectiveModelId,
        inputTokens,
        reserveResult.totalReservedMicro,
      );
    }

    const resultRecord = nodeResult as unknown as Record<string, unknown>;
    const usage =
      typeof resultRecord.usage === "object" && resultRecord.usage !== null
        ? (resultRecord.usage as Record<string, unknown>)
        : null;
    const promptDetails =
      usage &&
      typeof usage.prompt_tokens_details === "object" &&
      usage.prompt_tokens_details !== null
        ? (usage.prompt_tokens_details as Record<string, unknown>)
        : null;
    const completionDetails =
      usage &&
      typeof usage.completion_tokens_details === "object" &&
      usage.completion_tokens_details !== null
        ? (usage.completion_tokens_details as Record<string, unknown>)
        : null;

    const settlementPayload = {
      operationId: stepKey,
      userId,
      threadId,
      nodeName,
      modelId: effectiveModelId,
      executionMode: derived.executionMode,
      inputTokens,
      cachedInputTokens: Number(
        usage?.cachedInputTokens ?? promptDetails?.cached_tokens ?? 0,
      ),
      outputTokens: Number(
        usage?.outputTokens ?? usage?.completion_tokens ?? 0,
      ),
      reasoningTokens: Number(
        usage?.reasoningTokens ?? completionDetails?.reasoning_tokens ?? 0,
      ),
      actualTotalCostMicro: Number(actualCostMicro),
      deltaMicro: -Number(actualCostMicro),
      status: "SETTLED",
      created_at_ms: Date.now(),
    };

    await executeSettleOperation(
      {
        userId,
        operationId: stepKey,
        stepKey,
        actualTotalCostMicro: actualCostMicro,
        settlementPayload,
      },
      customRedis,
    );

    return nodeResult;
  };
}
