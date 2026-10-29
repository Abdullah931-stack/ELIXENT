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

/**
 * Full in-memory Redis client with Lua simulation and step_done receipt storage.
 */
class InMemoryGateRedis implements RedisEvalClient {
  public wallets = new Map<string, number>();
  public leases = new Map<string, Record<string, any>>();
  public stepDone = new Map<string, string>();
  public pendingSettlements = new Map<string, Map<string, string>>();
  public dirtyWallets = new Set<string>();

  public settleCalls: Array<{
    operationId: string;
    actualCost: number;
    status: string;
    payload: any;
  }> = [];

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
    args: (string | number)[]
  ): Promise<T> {
    if (script === RESERVE_OR_EXTEND_LUA) {
      const [walletKey, leaseKey, stepDoneKey] = keys;
      const [reqInputStr, desOutputStr, minOutputStr, zeroDustStr, leaseTtlStr, userId, stepKey] = args;

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

      const existingLease = this.leases.get(leaseKey) || {};
      this.leases.set(leaseKey, {
        ...existingLease,
        totalReservedMicro: (existingLease.totalReservedMicro || 0) + totalRes,
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
      const [walletKey, leaseKey, pendingKey, _dirtyKey, stepDoneKey] = keys;
      const [operationId, actualCostStr, payloadJson, userId] = args;

      const lease = this.leases.get(leaseKey);
      const totalReserved = Number(lease?.totalReservedMicro || 0);
      const actualCost = Number(actualCostStr);
      const refund = Math.max(0, totalReserved - actualCost);

      if (refund > 0) {
        const cur = this.wallets.get(walletKey) ?? 0;
        this.wallets.set(walletKey, cur + refund);
      }

      this.leases.delete(leaseKey);

      let payload: any = {};
      try {
        payload = JSON.parse(String(payloadJson));
      } catch {
        payload = payloadJson;
      }

      this.settleCalls.push({
        operationId: String(operationId),
        actualCost,
        status: payload.status || "SETTLED",
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

describe("LangGraph Higher-Order Metered Node Gate (node-gate.ts)", () => {
  const userId = "usr_gate_test_1";
  const modelId = "google/gemini-3.8-flash";
  const nodeName = "generate_summary_node";

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRedisConfigured.mockReturnValue(false);
    mockGetUserCreditBalance.mockResolvedValue(BigInt(10_000_000));
  });

  describe("Step Done & Resumption Idempotency", () => {
    it("should bypass billing and execute nodeFn directly when step was already completed", async () => {
      const redis = new InMemoryGateRedis();
      const threadId = "th_100";
      const checkpointId = "cp_200";
      const stepAttempt = 1;

      const stepKey = crypto
        .createHash("sha256")
        .update(`${threadId}:${checkpointId}:${nodeName}:${stepAttempt}`)
        .digest("hex");

      redis.stepDone.set(
        REDIS_KEYS.stepDone(stepKey),
        JSON.stringify({ status: "SETTLED", output: "cached_result" })
      );

      const nodeFn = vi.fn().mockResolvedValue({ output: "replayed_node_output" });

      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
      });

      const result = await gatedNode(
        { prompt: "summarize this file" },
        {
          configurable: {
            thread_id: threadId,
            checkpoint_id: checkpointId,
            step_attempt: stepAttempt,
            userId,
          },
        }
      );

      expect(result).toEqual({ output: "replayed_node_output" });
      expect(nodeFn).toHaveBeenCalledTimes(1);
      // No reservation or settlement should have occurred
      expect(redis.settleCalls.length).toBe(0);
      expect(redis.leases.size).toBe(0);
    });
  });

  describe("User Identification & Pre-flight Validation", () => {
    it("should throw an error when userId cannot be resolved from config or state", async () => {
      const redis = new InMemoryGateRedis();
      const nodeFn = vi.fn();
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
      });

      await expect(
        gatedNode({ prompt: "some text" }, { configurable: {} })
      ).rejects.toThrow(/userId could not be resolved/);

      expect(nodeFn).not.toHaveBeenCalled();
    });

    it("should throw MeteringServiceUnavailableError when Redis is unconfigured and no customRedis is provided", async () => {
      mockIsRedisConfigured.mockReturnValue(false);
      const nodeFn = vi.fn();
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn);

      await expect(
        gatedNode({ prompt: "test prompt" }, { configurable: { userId } })
      ).rejects.toThrow(MeteringServiceUnavailableError);

      expect(nodeFn).not.toHaveBeenCalled();
    });
  });

  describe("Insufficient Credits Interruption", () => {
    it("should intercept execution and return MeteredGateInterrupt when balance is insufficient", async () => {
      const redis = new InMemoryGateRedis();
      // Set wallet balance to very low amount (100 micro-credits)
      redis.wallets.set(REDIS_KEYS.wallet(userId), 100);

      const nodeFn = vi.fn();
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        pessimisticInputTokens: 1000, // requires far more than 100 micro-credits
      });

      const interrupt = await gatedNode(
        { prompt: "Long text input requiring credits" },
        { configurable: { userId } }
      );

      expect(interrupt).toEqual({
        interrupt: true,
        code: "INSUFFICIENT_CREDITS",
        availableMicro: 100,
        requiredMicro: expect.any(Number),
        targetNode: "pure_interrupt_node",
      });

      // Crucial: The underlying node function must NEVER execute when interrupted
      expect(nodeFn).not.toHaveBeenCalled();
      expect(redis.settleCalls.length).toBe(0);
    });
  });

  describe("Cold Start Race Recovery", () => {
    it("should recover automatically if wallet cold start race occurs during reservation", async () => {
      const redis = new InMemoryGateRedis();
      // True cold start: do not pre-warm redis.wallets.
      // Simulate race condition: wallet is evicted right before initial reservation executes.
      const originalEval = redis.eval.bind(redis);
      let raceSimulated = false;
      vi.spyOn(redis, "eval").mockImplementation(async (script, keys, args) => {
        if (script === RESERVE_OR_EXTEND_LUA && !raceSimulated) {
          raceSimulated = true;
          redis.wallets.delete(keys[0]);
          return JSON.stringify({ status: "COLD_START_REQUIRED" }) as any;
        }
        return originalEval(script, keys, args);
      });

      const nodeFn = vi.fn().mockResolvedValue({ summary: "Generated summary successfully" });
      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
      });

      const result = await gatedNode(
        { prompt: "Summarize this article" },
        { configurable: { userId } }
      );

      expect(result).toEqual({ summary: "Generated summary successfully" });
      expect(nodeFn).toHaveBeenCalledTimes(1);
      expect(redis.settleCalls.length).toBe(1);
      expect(raceSimulated).toBe(true);
      // Both initial cold-start and post-race reload should invoke getUserCreditBalance
      expect(mockGetUserCreditBalance).toHaveBeenCalledTimes(2);
    });
  });

  describe("Execution Success, Settlement & Cost Calculation", () => {
    it("should successfully reserve quota, execute nodeFn, settle actual cost, and record step_done", async () => {
      const redis = new InMemoryGateRedis();
      const initialBalance = 10_000_000;
      redis.wallets.set(REDIS_KEYS.wallet(userId), initialBalance);

      const nodeFn = vi.fn().mockResolvedValue({
        resultText: "Processed successfully",
        usage: {
          inputTokens: 50,
          outputTokens: 25,
        },
      });

      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        pessimisticInputTokens: 50,
      });

      const result = await gatedNode(
        { prompt: "Brief prompt" },
        {
          configurable: {
            threadId: "th_main_1",
            checkpointId: "cp_main_1",
            stepAttempt: 1,
            userId,
          },
        }
      );

      expect(result).toEqual({
        resultText: "Processed successfully",
        usage: { inputTokens: 50, outputTokens: 25 },
      });

      // Verify settlement recorded
      expect(redis.settleCalls.length).toBe(1);
      const settle = redis.settleCalls[0];
      expect(settle.status).toBe("SETTLED");
      expect(settle.payload.nodeName).toBe(nodeName);
      expect(settle.payload.inputTokens).toBe(50);
      expect(settle.payload.outputTokens).toBe(25);
      expect(settle.actualCost).toBeGreaterThan(0);

      // Verify unconsumed reservation was refunded back to user wallet
      const finalBal = redis.wallets.get(REDIS_KEYS.wallet(userId))!;
      expect(finalBal).toBe(initialBalance - settle.actualCost);
    });

    it("should support custom calculateActualCostMicro override option", async () => {
      const redis = new InMemoryGateRedis();
      redis.wallets.set(REDIS_KEYS.wallet(userId), 10_000_000);

      const customFixedCostMicro = 45000;
      const nodeFn = vi.fn().mockResolvedValue({ customField: "done" });

      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        calculateActualCostMicro: () => customFixedCostMicro,
      });

      await gatedNode({ prompt: "Custom cost prompt" }, { configurable: { userId } });

      expect(redis.settleCalls.length).toBe(1);
      expect(redis.settleCalls[0].actualCost).toBe(customFixedCostMicro);
    });
  });

  describe("Execution Failure & Rollback Protection", () => {
    it("should refund reserved credits and record ABORTED settlement when nodeFn throws an error", async () => {
      const redis = new InMemoryGateRedis();
      const initialBalance = 10_000_000;
      redis.wallets.set(REDIS_KEYS.wallet(userId), initialBalance);

      const crashingNodeFn = vi.fn().mockRejectedValue(new Error("LLM upstream provider timeout"));

      const gatedNode = withMeteredNodeGate(nodeName, modelId, crashingNodeFn, {
        customRedis: redis,
      });

      await expect(
        gatedNode({ prompt: "Crash prompt" }, { configurable: { userId } })
      ).rejects.toThrow("LLM upstream provider timeout");

      // Verify settlement executed with status ABORTED and actualCost 0 (full refund)
      expect(redis.settleCalls.length).toBe(1);
      const abortSettle = redis.settleCalls[0];
      expect(abortSettle.status).toBe("ABORTED");
      expect(abortSettle.actualCost).toBe(0);
      expect(abortSettle.payload.error).toContain("LLM upstream provider timeout");

      // Verify full wallet refund: user balance must be fully restored
      const restoredBal = redis.wallets.get(REDIS_KEYS.wallet(userId));
      expect(restoredBal).toBe(initialBalance);
    });
  });

  describe("Input Token Extraction Variations", () => {
    it.each([
      {
        name: "state.text",
        state: { text: "Sample text payload for extraction" },
        options: {},
      },
      {
        name: "state.messages array",
        state: {
          messages: [
            { content: "User prompt message" },
            { content: "Assistant response message" },
          ],
        },
        options: {},
      },
      {
        name: "function-based pessimisticInputTokens parameter",
        state: { prompt: "input" },
        options: { pessimisticInputTokens: vi.fn().mockReturnValue(350) },
      },
    ])("should extract pessimistic tokens from $name", async ({ state, options }) => {
      const redis = new InMemoryGateRedis();
      redis.wallets.set(REDIS_KEYS.wallet(userId), 10_000_000);
      const nodeFn = vi.fn().mockResolvedValue({ ok: true });

      const gatedNode = withMeteredNodeGate(nodeName, modelId, nodeFn, {
        customRedis: redis,
        ...options,
      });

      await gatedNode(state, { configurable: { userId } });
      expect(nodeFn).toHaveBeenCalledTimes(1);
      if (typeof options.pessimisticInputTokens === "function") {
        expect(options.pessimisticInputTokens).toHaveBeenCalled();
      }
    });
  });
});
