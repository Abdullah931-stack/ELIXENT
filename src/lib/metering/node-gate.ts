import crypto from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
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
 * Interrupt object returned to LangGraph runtime when credit balance is insufficient.
 */
export interface MeteredGateInterrupt {
  interrupt: true;
  code: "INSUFFICIENT_CREDITS";
  availableMicro: number;
  requiredMicro: number;
  targetNode: "pure_interrupt_node";
}

/**
 * Redis client shape compatible with stepDone reads and eval.
 */
export interface NodeGateRedisClient {
  get?(key: string): Promise<unknown>;
  stepDone?: Map<string, string>;
  eval?<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T>;
}

/**
 * Configuration options for withMeteredNodeGate.
 */
export interface MeteredNodeGateOptions {
  customRedis?: RedisEvalClient;
  pessimisticInputTokens?: number | ((state: unknown, config?: unknown) => number);
  discreteCeilingTokens?: number;
  calculateActualCostMicro?: (result: unknown, state: unknown) => bigint | number;
}

/**
 * Reads step_done receipt from Redis.
 */
async function getStepDoneReceipt(client: NodeGateRedisClient, key: string): Promise<string | null> {
  if (typeof client.get === "function") {
    const val = await client.get(key);
    return val ? (typeof val === "string" ? val : JSON.stringify(val)) : null;
  }
  if (client.stepDone instanceof Map) {
    return client.stepDone.get(key) ?? null;
  }
  if (typeof client.eval === "function") {
    const res = await client.eval("return redis.call('GET', KEYS[1])", [key], []);
    return res ? String(res) : null;
  }
  return null;
}

/**
 * Extracts pessimistic input token estimate from LangGraph state representations.
 */
function extractPessimisticInputTokens(state: unknown): number {
  if (!state || typeof state !== "object") return 0;
  const s = state as Record<string, unknown>;
  if (typeof s.prompt === "string") {
    return estimatePessimisticInputTokens(s.prompt);
  }
  if (typeof s.text === "string") {
    return estimatePessimisticInputTokens(s.text);
  }
  if (typeof s.input === "string") {
    return estimatePessimisticInputTokens(s.input);
  }
  if (Array.isArray(s.messages)) {
    const text = s.messages
      .map((m: unknown) => {
        if (typeof m === "string") return m;
        if (m && typeof m === "object") {
          const msg = m as Record<string, unknown>;
          return typeof msg.content === "string"
            ? msg.content
            : typeof msg.text === "string"
            ? msg.text
            : "";
        }
        return "";
      })
      .join("\n");
    return estimatePessimisticInputTokens(text);
  }
  return 0;
}

/**
 * Calculates actual micro-credit cost based on execution result and model registry.
 */
function calculateCost(
  nodeResult: unknown,
  modelId: string,
  inputTokens: number,
  fallbackReservedMicro: number
): bigint | number {
  if (nodeResult && typeof nodeResult === "object") {
    const res = nodeResult as Record<string, unknown>;
    if (res.actualTotalCostMicro !== undefined && res.actualTotalCostMicro !== null) {
      return res.actualTotalCostMicro as bigint | number;
    }
    if (res.usage && typeof res.usage === "object") {
      const usage = res.usage as Record<string, unknown>;
      const inTokens = Number(
        usage.inputTokens ?? usage.prompt_tokens ?? inputTokens
      );
      const outTokens = Number(
        usage.outputTokens ?? usage.completion_tokens ?? 0
      );
      try {
        const model = getModelRegistryEntry(modelId);
        const inMicro = tokensToMicroCredits(inTokens, model.creditsPer1kInput);
        const outMicro = tokensToMicroCredits(outTokens, model.creditsPer1kOutput);
        return inMicro + outMicro;
      } catch {
        // Fallback to reserved amount
      }
    }
  }
  return fallbackReservedMicro;
}

/**
 * Higher-order node wrapper for LangGraph-style graph nodes providing:
 * 1. Resumption idempotency check via `lugx:step_done:${stepKey}`
 * 2. Pre-flight credit reservation with Zero-Dust drain derivation
 * 3. Interruption routing (`INSUFFICIENT_CREDITS`)
 * 4. Post-execution settlement and refund via atomic Lua scripts
 */
export function withMeteredNodeGate<
  TState = unknown,
  TConfig extends RunnableConfig = RunnableConfig,
  TResult = unknown
>(
  nodeName: string,
  modelId: string,
  nodeFn: (state: TState, config?: TConfig) => Promise<TResult>,
  options?: MeteredNodeGateOptions
): (state: TState, config?: TConfig) => Promise<TResult | MeteredGateInterrupt> {
  return async (state: TState, config?: TConfig): Promise<TResult | MeteredGateInterrupt> => {
    const stateRecord = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : null;
    // 1. Resolve configurable parameters
    const threadId = String(
      config?.configurable?.thread_id ??
      config?.configurable?.threadId ??
      stateRecord?.threadId ??
      "default_thread"
    );
    const checkpointId = String(
      config?.configurable?.checkpoint_id ??
      config?.configurable?.checkpointId ??
      stateRecord?.checkpointId ??
      "default_checkpoint"
    );
    const stepAttempt = Number(
      config?.configurable?.step_attempt ??
      config?.configurable?.stepAttempt ??
      stateRecord?.stepAttempt ??
      stateRecord?.step_attempt ??
      1
    );

    const customRedis =
      options?.customRedis ||
      (config?.configurable?.customRedis as RedisEvalClient) ||
      (config?.configurable?.redis as RedisEvalClient);

    const client = customRedis || (isRedisConfigured() ? redis : null);
    if (!client) {
      throw new MeteringServiceUnavailableError();
    }

    // 2. Compute canonical stepKey for node execution idempotency
    const stepKey = crypto
      .createHash("sha256")
      .update(`${threadId}:${checkpointId}:${nodeName}:${stepAttempt}`)
      .digest("hex");

    // 3. Resumption check: if step was already completed, bypass billing
    const existingReceipt = await getStepDoneReceipt(
      client,
      REDIS_KEYS.stepDone(stepKey)
    );
    if (existingReceipt) {
      return await nodeFn(state, config);
    }

    // 4. Resolve authenticated user identity
    const userId = (
      config?.configurable?.userId ??
      config?.configurable?.user_id ??
      stateRecord?.userId ??
      stateRecord?.user_id
    ) as string | undefined;

    if (!userId) {
      throw new Error(
        `withMeteredNodeGate: userId could not be resolved from config.configurable or state for node "${nodeName}"`
      );
    }

    // 5. Ensure wallet is warm in Redis (executing flush-first if cold)
    const availableBalanceMicro = await ensureWalletLoadedFlushFirst(
      userId,
      customRedis
    );

    // 6. Determine pessimistic input tokens
    let inputTokens: number;
    if (typeof options?.pessimisticInputTokens === "function") {
      inputTokens = options.pessimisticInputTokens(state, config);
    } else if (typeof options?.pessimisticInputTokens === "number") {
      inputTokens = options.pessimisticInputTokens;
    } else {
      inputTokens = extractPessimisticInputTokens(state);
    }

    // 7. Derive mathematical reservation parameters
    const derived = deriveModelReservationParameters(
      modelId,
      inputTokens,
      availableBalanceMicro,
      options?.discreteCeilingTokens
    );

    // 8. Execute atomic reservation
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
      customRedis
    );

    // If cold start race occurred, reload once
    if (reserveResult.status === "COLD_START_REQUIRED") {
      const refreshedBal = await ensureWalletLoadedFlushFirst(
        userId,
        customRedis
      );
      const reDerived = deriveModelReservationParameters(
        modelId,
        inputTokens,
        refreshedBal,
        options?.discreteCeilingTokens
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
        customRedis
      );
    }

    if (reserveResult.status === "ALREADY_DONE") {
      return await nodeFn(state, config);
    }

    if (reserveResult.status === "INSUFFICIENT_CREDITS") {
      const interruptPayload: MeteredGateInterrupt = {
        interrupt: true,
        code: "INSUFFICIENT_CREDITS",
        availableMicro: reserveResult.available,
        requiredMicro: reserveResult.required,
        targetNode: "pure_interrupt_node",
      };
      return interruptPayload;
    }

    if (reserveResult.status !== "SUCCESS") {
      throw new MeteringServiceUnavailableError(
        `Failed to reserve quota for node "${nodeName}": unexpected reservation status "${(reserveResult as Record<string, unknown>).status}"`
      );
    }

    // 9. Execute node execution with failure rollback protection
    let nodeResult: TResult;
    try {
      nodeResult = await nodeFn(state, config);
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
              modelId,
              status: "ABORTED",
              actualTotalCostMicro: 0,
              error: error instanceof Error ? error.message : String(error),
              created_at_ms: Date.now(),
            },
          },
          customRedis
        );
      } catch {
        // Suppress cleanup failure to surface primary error
      }
      throw error;
    }

    // 10. Compute actual cost and finalize settlement
    let actualCostMicro: bigint | number;
    if (options?.calculateActualCostMicro) {
      actualCostMicro = options.calculateActualCostMicro(nodeResult, state);
    } else {
      actualCostMicro = calculateCost(
        nodeResult,
        modelId,
        inputTokens,
        reserveResult.totalReservedMicro
      );
    }

    const resultRecord =
      typeof nodeResult === "object" && nodeResult !== null
        ? (nodeResult as Record<string, unknown>)
        : null;
    const usage =
      resultRecord && typeof resultRecord.usage === "object" && resultRecord.usage !== null
        ? (resultRecord.usage as Record<string, unknown>)
        : null;
    const promptDetails =
      usage && typeof usage.prompt_tokens_details === "object" && usage.prompt_tokens_details !== null
        ? (usage.prompt_tokens_details as Record<string, unknown>)
        : null;
    const completionDetails =
      usage && typeof usage.completion_tokens_details === "object" && usage.completion_tokens_details !== null
        ? (usage.completion_tokens_details as Record<string, unknown>)
        : null;

    const settlementPayload = {
      operationId: stepKey,
      userId,
      threadId,
      nodeName,
      modelId,
      executionMode: derived.executionMode,
      inputTokens,
      cachedInputTokens: Number(
        usage?.cachedInputTokens ??
        promptDetails?.cached_tokens ??
        0
      ),
      outputTokens: Number(
        usage?.outputTokens ??
        usage?.completion_tokens ??
        0
      ),
      reasoningTokens: Number(
        usage?.reasoningTokens ??
        completionDetails?.reasoning_tokens ??
        0
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
      customRedis
    );

    return nodeResult;
  };
}
