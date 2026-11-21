/**
 * Unit Test Suite: Higher-Order Metered Node Gate (`src/lib/metering/node-gate.ts`)
 *
 * Verifies the native `(AgentGraphState, AgentRuntimeContext) => Promise<NodeExecutionResult>`
 * metering contract across:
 * 1. Resumption idempotency (`credit:step_done:${stepKey}` pre-read & Lua `ALREADY_DONE`,
 *    custom `checkpointId` / `stepAttempt` options).
 * 2. Pre-flight validation (`ctx.userId` missing, unconfigured Redis, unexpected Lua status).
 * 3. Native `INSUFFICIENT_CREDITS` `NodeExecutionResult` interruption (`BUG-06` regression).
 * 4. Cold-start flush-first race recovery (`COLD_START_REQUIRED`).
 * 5. Reservation, actual cost derivation (`usage`, `actualTotalCostMicro`, `calculateActualCostMicro`),
 *    unconsumed refund, and `pendingSettlements`/`dirtyWallets`/`stepDone` persistence.
 * 6. Execution crash rollback (`ABORTED`, full wallet refund, primary error preservation).
 * 7. Input token extraction variants (`user_request.prompt`, `messages[]`, function/numeric overrides).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import { REDIS_KEYS } from "@/lib/metering/constants";
import {
  MeteringServiceUnavailableError,
  RESERVE_OR_EXTEND_LUA,
  SETTLE_OPERATION_LUA,
  type RedisEvalClient,
} from "@/lib/metering/lua-scripts";
import {
  createInitialAgentGraphState,
  type AgentGraphState,
} from "@/core/agent/state";
import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type { IWorkspaceProvider } from "@/core/workspace/provider";

const mockIsRedisConfigured = vi.hoisted(() => vi.fn());
const mockGetUserCreditBalance = vi.hoisted(() => vi.fn());
const mockFlushPendingSettlementsToPostgres = vi.hoisted(() => vi.fn());

vi.mock("@/server/services/ai-settlement-service", () => ({
  getUserCreditBalance: mockGetUserCreditBalance,
  flushPendingSettlementsToPostgres: mockFlushPendingSettlementsToPostgres,
}));

vi.mock("@/lib/redis", () => ({
  isRedisConfigured: mockIsRedisConfigured,
  redis: null,
}));

interface LeaseRecord {
  totalReservedMicro: number;
  userId: string;
  stepKey: string;
  ttl: number;
}

interface SettleCallRecord {
  operationId: string;
  actualCost: number;
  status: string;
  payload: Record<string, unknown>;
}

/**
 * Full in-memory Redis client simulating `RESERVE_OR_EXTEND_LUA` and `SETTLE_OPERATION_LUA`.
 */
class InMemoryGateRedis implements RedisEvalClient {
  public wallets = new Map<string, number>();
  public leases = new Map<string, LeaseRecord>();
  public stepDone = new Map<string, string>();
  public pendingSettlements = new Map<string, Map<string, string>>();
  public dirtyWallets = new Set<string>();
  public settleCalls: SettleCallRecord[] = [];

  public async get(key: string): Promise<string | number | null> {
    if (this.stepDone.has(key)) {
      return this.stepDone.get(key)!;
    }
    if (this.wallets.has(key)) {
      return this.wallets.get(key)!;
    }
    return null;
  }

  public async exists(key: string): Promise<number> {
    return this.wallets.has(key) ? 1 : 0;
  }

  public async eval<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<T> {
    if (script === RESERVE_OR_EXTEND_LUA) {
      const [walletKey, leaseKey, stepDoneKey] = keys;
      const [
        reqInputStr,
        desOutputStr,
        minOutputStr,
        zeroDustStr,
        leaseTtlStr,
        userId,
        stepKey,
      ] = args;

      if (this.stepDone.has(stepDoneKey)) {
        return JSON.stringify({
          status: "ALREADY_DONE",
          receipt: this.stepDone.get(stepDoneKey),
        }) as unknown as T;
      }

      if (!this.wallets.has(walletKey)) {
        return JSON.stringify({ status: "COLD_START_REQUIRED" }) as unknown as T;
      }

      const bal = this.wallets.get(walletKey) ?? 0;
      const reqInput = Number(reqInputStr);
      const desOutput = Number(desOutputStr);
      const minOutput = Number(minOutputStr);
      const zeroDust = Number(zeroDustStr);
      const leaseTtl = Number(leaseTtlStr);

      const needed = zeroDust === 1 ? reqInput : reqInput + minOutput;
      if (bal < needed) {
        return JSON.stringify({
          status: "INSUFFICIENT_CREDITS",
          available: bal,
          required: needed,
        }) as unknown as T;
      }

      let resOutput = 0;
      if (desOutput > 0) {
        if (bal >= reqInput + desOutput) {
          resOutput = desOutput;
        } else if (zeroDust === 1) {
          resOutput = Math.max(0, bal - reqInput);
        } else {
          resOutput = desOutput;
        }
      }

      const totalRes = reqInput + resOutput;
      const newBal = bal - totalRes;
      this.wallets.set(walletKey, newBal);

      const existingLease = this.leases.get(leaseKey);
      this.leases.set(leaseKey, {
        totalReservedMicro: (existingLease?.totalReservedMicro ?? 0) + totalRes,
        userId: String(userId),
        stepKey: String(stepKey),
        ttl: leaseTtl,
      });

      return JSON.stringify({
        status: "SUCCESS",
        reservedInputMicro: reqInput,
        reservedOutputMicro: resOutput,
        totalReservedMicro: totalRes,
        newBalanceMicro: newBal,
      }) as unknown as T;
    }

    if (script === SETTLE_OPERATION_LUA) {
      const [walletKey, leaseKey, pendingKey, , stepDoneKey] = keys;
      const [operationId, actualCostStr, payloadJson, userId] = args;

      const lease = this.leases.get(leaseKey);
      const totalReserved = Number(lease?.totalReservedMicro ?? 0);
      const actualCost = Number(actualCostStr);
      const refund = Math.max(0, totalReserved - actualCost);

      if (refund > 0) {
        const cur = this.wallets.get(walletKey) ?? 0;
        this.wallets.set(walletKey, cur + refund);
      }

      this.leases.delete(leaseKey);

      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(payloadJson)) as Record<string, unknown>;
      } catch {
        payload = { raw: payloadJson };
      }

      this.settleCalls.push({
        operationId: String(operationId),
        actualCost,
        status: String(payload.status ?? "SETTLED"),
        payload,
      });

      let pending = this.pendingSettlements.get(pendingKey);
      if (!pending) {
        pending = new Map();
        this.pendingSettlements.set(pendingKey, pending);
      }
      pending.set(String(operationId), String(payloadJson));

      this.dirtyWallets.add(String(userId));
      this.stepDone.set(stepDoneKey, String(payloadJson));

      return JSON.stringify({
        status: "SETTLED",
        refundMicro: refund,
        totalReservedMicro: totalReserved,
        actualCostMicro: actualCost,
        newBalanceMicro: this.wallets.get(walletKey) ?? 0,
      }) as unknown as T;
    }

    throw new Error(`Unhandled Lua script in InMemoryGateRedis: ${script}`);
  }
}

function createTestState(
  prompt = "",
  overrides: Partial<AgentGraphState> = {},
): AgentGraphState {
  return createInitialAgentGraphState({
    user_request: {
      prompt,
      workspaceId: "ws_gate_test",
      turnId: "turn_gate_1",
      targetFileIds: [],
      permissionMode: "safe",
      selectedSystem2ModelId: "google/gemini-3.8-flash",
    },
    ...overrides,
  });
}

function createRuntimeContext(
  overrides: Partial<AgentRuntimeContext> = {},
): AgentRuntimeContext {
  return {
    userId: "usr_gate_test_1",
    workspaceId: "ws_gate_test",
    threadId: "th_100",
    turnId: "turn_gate_1",
    permissionMode: "safe",
    selectedSystem2ModelId: "google/gemini-3.8-flash",
    workspaceProvider: {} as IWorkspaceProvider,
    ephemeralVaultPayloads: new Map(),
    liveDocumentSnapshots: new Map(),
    emitSseEvent: () => {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("Native Higher-Order Metered Node Gate (node-gate.ts)", () => {
  const userId = "usr_gate_test_1";
  const modelId = "google/gemini-3.8-flash";
  const nodeName = "generate_summary_node";

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRedisConfigured.mockReturnValue(false);
    mockGetUserCreditBalance.mockResolvedValue(BigInt(10_000_000));
  });

  describe("1. Step Done & Resumption Idempotency", () => {
    it("bypasses billing and executes nodeFn directly when step_done receipt exists for (threadId, checkpointId, nodeName, stepAttempt)", async () => {
      const redis = new InMemoryGateRedis();
      const threadId = "th_100";
      const checkpointId = "cp_200";
      const stepAttempt = 2;

      const stepKey = crypto
        .createHash("sha256")
        .update(`${threadId}:${checkpointId}:${nodeName}:${stepAttempt}`)
        .digest("hex");

      redis.stepDone.set(
        REDIS_KEYS.stepDone(stepKey),
        JSON.stringify({ status: "SETTLED", output: "cached_result" }),
      );

      const expectedResult: NodeExecutionResult = {
        status: "COMPLETED",
        stateDelta: { local_inspection_state: ["replayed_node_output"] },
      };
      const nodeFn = vi.fn<AgentGraphNodeFn>().mockResolvedValue(expectedResult);

      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        checkpointId,
        stepAttempt,
      });

      const result = await gatedNode(
        createTestState("summarize this file"),
        createRuntimeContext({ threadId, userId }),
      );

      expect(result).toEqual(expectedResult);
      expect(nodeFn).toHaveBeenCalledTimes(1);
      expect(redis.settleCalls).toHaveLength(0);
      expect(redis.leases.size).toBe(0);
    });

    it("bypasses settlement when Lua reserve script returns ALREADY_DONE due to concurrent completion", async () => {
      const redis = new InMemoryGateRedis();
      redis.wallets.set(REDIS_KEYS.wallet(userId), 10_000_000);
      vi.spyOn(redis, "get").mockResolvedValueOnce(null);
      vi.spyOn(redis, "eval").mockResolvedValueOnce(
        JSON.stringify({ status: "ALREADY_DONE", receipt: "{}" }),
      );

      const nodeFn = vi.fn<AgentGraphNodeFn>().mockResolvedValue({
        status: "COMPLETED",
        stateDelta: { search_loop_count: 1 },
      });

      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
      });

      const result = await gatedNode(createTestState("concurrent step"), createRuntimeContext());
      expect(result.status).toBe("COMPLETED");
      expect(nodeFn).toHaveBeenCalledTimes(1);
      expect(redis.settleCalls).toHaveLength(0);
    });
  });

  describe("2. User Identification & Fail-Closed Pre-flight Validation", () => {
    it("throws when ctx.userId is missing and never executes nodeFn", async () => {
      const redis = new InMemoryGateRedis();
      const nodeFn = vi.fn<AgentGraphNodeFn>();
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
      });

      await expect(
        gatedNode(createTestState("some text"), createRuntimeContext({ userId: "" })),
      ).rejects.toThrow(/userId could not be resolved/);

      expect(nodeFn).not.toHaveBeenCalled();
    });

    it("throws MeteringServiceUnavailableError when Redis is unconfigured and no customRedis is provided", async () => {
      mockIsRedisConfigured.mockReturnValue(false);
      const nodeFn = vi.fn<AgentGraphNodeFn>();
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn);

      await expect(
        gatedNode(createTestState("test prompt"), createRuntimeContext({ userId })),
      ).rejects.toThrow(MeteringServiceUnavailableError);

      expect(nodeFn).not.toHaveBeenCalled();
    });
  });

  describe("3. Sacred Regression: Native INSUFFICIENT_CREDITS Interruption (BUG-06)", () => {
    it("intercepts execution and returns native INTERRUPTED NodeExecutionResult without executing nodeFn or settling", async () => {
      const redis = new InMemoryGateRedis();
      redis.wallets.set(REDIS_KEYS.wallet(userId), 100);

      const nodeFn = vi.fn<AgentGraphNodeFn>();
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        pessimisticInputTokens: 1000,
      });

      const interrupt = await gatedNode(
        createTestState("Long text input requiring credits"),
        createRuntimeContext({ userId }),
      );

      expect(interrupt).toEqual({
        status: "INTERRUPTED",
        interruptReason: "INSUFFICIENT_CREDITS",
        stateDelta: {},
        interruptPayload: {
          availableMicro: 100,
          requiredMicro: expect.any(Number),
        },
      });
      expect(nodeFn).not.toHaveBeenCalled();
      expect(redis.settleCalls).toHaveLength(0);
    });
  });

  describe("4. Cold Start Race Recovery", () => {
    it("recovers automatically via flush-first reload when wallet is evicted before reservation", async () => {
      const redis = new InMemoryGateRedis();
      const originalEval = redis.eval.bind(redis);
      let raceSimulated = false;

      vi.spyOn(redis, "eval").mockImplementation(async (script, keys, args) => {
        if (script === RESERVE_OR_EXTEND_LUA && !raceSimulated) {
          raceSimulated = true;
          redis.wallets.delete(keys[0]);
          return JSON.stringify({ status: "COLD_START_REQUIRED" }) as never;
        }
        return originalEval(script, keys, args);
      });

      const nodeFn = vi.fn<AgentGraphNodeFn>().mockResolvedValue({
        status: "COMPLETED",
        stateDelta: { classified_intent: "CHAT_ONLY" },
      });
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
      });

      const result = await gatedNode(
        createTestState("Summarize this article"),
        createRuntimeContext({ userId }),
      );

      expect(result).toEqual({
        status: "COMPLETED",
        stateDelta: { classified_intent: "CHAT_ONLY" },
      });
      expect(nodeFn).toHaveBeenCalledTimes(1);
      expect(redis.settleCalls).toHaveLength(1);
      expect(raceSimulated).toBe(true);
      expect(mockGetUserCreditBalance).toHaveBeenCalledTimes(2);
    });
  });

  describe("5. Execution Success, Settlement, Refund & Cost Calculation", () => {
    it("reserves quota, settles actual usage cost, refunds unconsumed reservation, and records dirty wallet + step_done", async () => {
      const redis = new InMemoryGateRedis();
      const initialBalance = 10_000_000;
      redis.wallets.set(REDIS_KEYS.wallet(userId), initialBalance);

      const nodeResultWithUsage = {
        status: "COMPLETED" as const,
        stateDelta: { local_inspection_state: ["doc.md#intro"] },
        usage: {
          inputTokens: 50,
          outputTokens: 25,
        },
      } as NodeExecutionResult;

      const nodeFn = vi.fn<AgentGraphNodeFn>().mockResolvedValue(nodeResultWithUsage);
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        pessimisticInputTokens: 50,
        checkpointId: "cp_main_1",
        stepAttempt: 1,
      });

      const result = await gatedNode(
        createTestState("Brief prompt"),
        createRuntimeContext({ threadId: "th_main_1", userId }),
      );

      expect(result).toEqual(nodeResultWithUsage);
      expect(redis.settleCalls).toHaveLength(1);

      const settle = redis.settleCalls[0];
      expect(settle.status).toBe("SETTLED");
      expect(settle.payload.nodeName).toBe(nodeName);
      expect(settle.payload.inputTokens).toBe(50);
      expect(settle.payload.outputTokens).toBe(25);
      expect(settle.actualCost).toBeGreaterThan(0);

      // Unconsumed reservation is refunded back to wallet
      expect(redis.wallets.get(REDIS_KEYS.wallet(userId))).toBe(
        initialBalance - settle.actualCost,
      );
      expect(redis.dirtyWallets.has(userId)).toBe(true);
      expect(redis.stepDone.size).toBe(1);
    });

    it("honors custom calculateActualCostMicro override option", async () => {
      const redis = new InMemoryGateRedis();
      redis.wallets.set(REDIS_KEYS.wallet(userId), 10_000_000);

      const customFixedCostMicro = 45_000;
      const nodeFn = vi.fn<AgentGraphNodeFn>().mockResolvedValue({
        status: "COMPLETED",
        stateDelta: {},
      });

      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        calculateActualCostMicro: () => customFixedCostMicro,
      });

      await gatedNode(createTestState("Custom cost prompt"), createRuntimeContext({ userId }));

      expect(redis.settleCalls).toHaveLength(1);
      expect(redis.settleCalls[0].actualCost).toBe(customFixedCostMicro);
    });
  });

  describe("6. Sacred Regression: Execution Failure & Full Refund Rollback", () => {
    it("refunds reserved credits and records ABORTED settlement when nodeFn throws", async () => {
      const redis = new InMemoryGateRedis();
      const initialBalance = 10_000_000;
      redis.wallets.set(REDIS_KEYS.wallet(userId), initialBalance);

      const crashingNodeFn = vi
        .fn<AgentGraphNodeFn>()
        .mockRejectedValue(new Error("LLM upstream provider timeout"));

      const gatedNode = withMeteredNodeGate(nodeName, modelId, crashingNodeFn, {
        customRedis: redis,
      });

      await expect(
        gatedNode(createTestState("Crash prompt"), createRuntimeContext({ userId })),
      ).rejects.toThrow("LLM upstream provider timeout");

      expect(redis.settleCalls).toHaveLength(1);
      const abortSettle = redis.settleCalls[0];
      expect(abortSettle.status).toBe("ABORTED");
      expect(abortSettle.actualCost).toBe(0);
      expect(abortSettle.payload.error).toContain("LLM upstream provider timeout");
      expect(redis.wallets.get(REDIS_KEYS.wallet(userId))).toBe(initialBalance);
    });
  });

  describe("7. Input Token Extraction Variations", () => {
    it.each([
      {
        name: "state.user_request.prompt",
        state: createTestState("Sample architectural prompt payload for extraction"),
        useFnOverride: false,
      },
      {
        name: "state.messages array",
        state: createTestState("", {
          messages: [
            {
              id: "m1",
              role: "user",
              content: "User prompt message",
              createdAt: "2026-11-20T00:00:00.000Z",
            },
            {
              id: "m2",
              role: "assistant",
              content: "Assistant response message",
              createdAt: "2026-11-20T00:00:01.000Z",
            },
          ],
        }),
        useFnOverride: false,
      },
      {
        name: "function-based pessimisticInputTokens parameter",
        state: createTestState("input"),
        useFnOverride: true,
      },
    ])("extracts pessimistic input tokens from $name", async ({ state, useFnOverride }) => {
      const redis = new InMemoryGateRedis();
      redis.wallets.set(REDIS_KEYS.wallet(userId), 10_000_000);

      const nodeFn = vi.fn<AgentGraphNodeFn>().mockResolvedValue({
        status: "COMPLETED",
        stateDelta: {},
      });
      const tokenFn = vi.fn().mockReturnValue(350);

      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        ...(useFnOverride ? { pessimisticInputTokens: tokenFn } : {}),
      });

      await gatedNode(state, createRuntimeContext({ userId }));

      expect(nodeFn).toHaveBeenCalledTimes(1);
      expect(redis.settleCalls).toHaveLength(1);
      if (useFnOverride) {
        expect(tokenFn).toHaveBeenCalledWith(state, expect.objectContaining({ userId }));
        expect(redis.settleCalls[0].payload.inputTokens).toBe(350);
      } else {
        expect(Number(redis.settleCalls[0].payload.inputTokens)).toBeGreaterThan(0);
      }
    });
  });
});
