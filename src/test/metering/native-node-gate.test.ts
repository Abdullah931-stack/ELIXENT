/**
 * Test Suite: Native Higher-Order Metered Node Gate (Wave 3.1 — node-gate.ts)
 *
 * Verifies the refactored `withMeteredNodeGate` contract using native
 * `(state: Readonly<AgentGraphState>, ctx: AgentRuntimeContext) => Promise<NodeExecutionResult>`:
 * - System 2 model ID dynamic routing (`options.isSystem2Node` or `modelId === "system2"` -> `ctx.selectedSystem2ModelId`)
 * - Native `INSUFFICIENT_CREDITS` `NodeExecutionResult` interruption (BUG-06 fix)
 * - Resumption idempotency via `credit:step_done:${stepKey}` (pre-read & Lua `ALREADY_DONE`)
 * - Cold-start flush-first race recovery (`COLD_START_REQUIRED`)
 * - Settlement cost calculation (`usage`, `actualTotalCostMicro`, `calculateActualCostMicro`) & unconsumed refund
 * - Failure rollback (`ABORTED`, `actualTotalCostMicro: 0`, full wallet refund)
 * - Input token extraction from `user_request.prompt`, `messages`, numeric & function overrides
 * - Pre-flight validation (`userId` missing, unconfigured Redis)
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
import { createInitialAgentGraphState } from "@/core/agent/state";
import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type { IWorkspaceProvider } from "@/core/workspace/provider";
import type { StreamGovernor } from "@/lib/metering/stream-governor";

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

interface SettlementRecord {
  operationId: string;
  actualCost: number;
  status: string;
  payload: Record<string, unknown>;
}

/**
 * In-memory Redis Lua simulator matching `RESERVE_OR_EXTEND_LUA` and `SETTLE_OPERATION_LUA`.
 */
class InMemoryGateRedis implements RedisEvalClient {
  public wallets = new Map<string, number>();
  public leases = new Map<string, { totalReservedMicro: number }>();
  public stepDone = new Map<string, string>();
  public pendingSettlements = new Map<string, Map<string, string>>();
  public settleCalls: SettlementRecord[] = [];

  public async exists(key: string): Promise<number> {
    return this.wallets.has(key) ? 1 : 0;
  }

  public async get(key: string): Promise<string | number | null> {
    if (this.stepDone.has(key)) return this.stepDone.get(key)!;
    if (this.wallets.has(key)) return this.wallets.get(key)!;
    return null;
  }

  public async eval<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<T> {
    if (script === RESERVE_OR_EXTEND_LUA) {
      const [walletKey, leaseKey, stepDoneKey] = keys;
      const [reqInputStr, desOutputStr, minOutputStr, zeroDustStr] = args;

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
      this.leases.set(leaseKey, {
        totalReservedMicro:
          (this.leases.get(leaseKey)?.totalReservedMicro ?? 0) + totalRes,
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
      const [walletKey, leaseKey, , , stepDoneKey] = keys;
      const [operationId, actualCostStr, payloadJson] = args;

      const totalReserved = this.leases.get(leaseKey)?.totalReservedMicro ?? 0;
      const actualCost = Number(actualCostStr);
      const refund = Math.max(0, totalReserved - actualCost);

      if (refund > 0) {
        this.wallets.set(walletKey, (this.wallets.get(walletKey) ?? 0) + refund);
      }
      this.leases.delete(leaseKey);

      const payload = JSON.parse(String(payloadJson)) as Record<string, unknown>;
      this.settleCalls.push({
        operationId: String(operationId),
        actualCost,
        status: String(payload.status ?? "SETTLED"),
        payload,
      });
      this.stepDone.set(stepDoneKey, String(payloadJson));

      return JSON.stringify({
        status: "SETTLED",
        refundMicro: refund,
        totalReservedMicro: totalReserved,
        actualCostMicro: actualCost,
        newBalanceMicro: this.wallets.get(walletKey) ?? 0,
      }) as unknown as T;
    }

    throw new Error(`Unhandled script in InMemoryGateRedis: ${script}`);
  }
}

function createRuntimeContext(
  overrides: Partial<AgentRuntimeContext> = {},
): AgentRuntimeContext {
  return {
    userId: "user-native-gate-1",
    workspaceId: "ws-gate-1",
    threadId: "th-gate-1",
    turnId: "turn-gate-1",
    permissionMode: "safe",
    selectedSystem2ModelId: "google/gemini-3.8-flash",
    workspaceProvider: {} as IWorkspaceProvider,
    streamGovernor: {} as StreamGovernor,
    ephemeralVaultPayloads: new Map(),
    liveDocumentSnapshots: new Map(),
    emitSseEvent: () => {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("Native Higher-Order Metered Node Gate (node-gate.ts — Wave 3.1)", () => {
  const userId = "user-native-gate-1";
  const flashModel = "google/gemini-3.8-flash";
  const argonModel = "google/gemini-4-argon";
  const nodeName = "assumption_extractor_node";

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRedisConfigured.mockReturnValue(false);
    mockGetUserCreditBalance.mockResolvedValue(BigInt(50_000_000));
  });

  describe("System 2 Model ID Dynamic Routing", () => {
    it.each([
      {
        label: "isSystem2Node: true overrides static modelId with ctx.selectedSystem2ModelId",
        declaredModelId: flashModel,
        isSystem2Node: true,
        selectedSystem2ModelId: argonModel,
        expectedEffectiveModelId: argonModel,
      },
      {
        label: "modelId === 'system2' routes to ctx.selectedSystem2ModelId",
        declaredModelId: "system2",
        isSystem2Node: false,
        selectedSystem2ModelId: argonModel,
        expectedEffectiveModelId: argonModel,
      },
      {
        label: "non-System-2 node retains its explicit modelId regardless of ctx.selectedSystem2ModelId",
        declaredModelId: "typesafe/jev-1.13",
        isSystem2Node: false,
        selectedSystem2ModelId: argonModel,
        expectedEffectiveModelId: "typesafe/jev-1.13",
      },
    ])(
      "$label",
      async ({
        declaredModelId,
        isSystem2Node,
        selectedSystem2ModelId,
        expectedEffectiveModelId,
      }) => {
        const redis = new InMemoryGateRedis();
        redis.wallets.set(REDIS_KEYS.wallet(userId), 50_000_000);

        const nodeFn: AgentGraphNodeFn = async () =>
          ({
            status: "COMPLETED",
            stateDelta: {},
            usage: { inputTokens: 1000, outputTokens: 500 },
          }) as NodeExecutionResult;

        const gated = withMeteredNodeGate(nodeName, declaredModelId, nodeFn, {
          customRedis: redis,
          isSystem2Node,
          pessimisticInputTokens: 1000,
        });

        await gated(
          createInitialAgentGraphState(),
          createRuntimeContext({ selectedSystem2ModelId }),
        );

        expect(redis.settleCalls).toHaveLength(1);
        expect(redis.settleCalls[0].payload.modelId).toBe(
          expectedEffectiveModelId,
        );
      },
    );

    it("charges higher micro-credits when System 2 routes to google/gemini-4-argon versus google/gemini-3.8-flash", async () => {
      const runWithModel = async (selectedSystem2ModelId: string) => {
        const redis = new InMemoryGateRedis();
        redis.wallets.set(REDIS_KEYS.wallet(userId), 50_000_000);

        const nodeFn: AgentGraphNodeFn = async () =>
          ({
            status: "COMPLETED",
            stateDelta: {},
            usage: { inputTokens: 1000, outputTokens: 1000 },
          }) as NodeExecutionResult;

        const gated = withMeteredNodeGate(nodeName, "system2", nodeFn, {
          customRedis: redis,
          pessimisticInputTokens: 1000,
        });

        await gated(
          createInitialAgentGraphState(),
          createRuntimeContext({ selectedSystem2ModelId }),
        );
        return redis.settleCalls[0].actualCost;
      };

      const flashCost = await runWithModel(flashModel);
      const argonCost = await runWithModel(argonModel);

      // gemini-3.8-flash: 0.15 + 0.60 = 0.75 credits = 750_000 micro
      // gemini-4-argon: 1.25 + 5.00 = 6.25 credits = 6_250_000 micro
      expect(flashCost).toBe(750_000);
      expect(argonCost).toBe(6_250_000);
      expect(argonCost).toBeGreaterThan(flashCost);
    });
  });

  describe("Native INSUFFICIENT_CREDITS Interruption (BUG-06)", () => {
    it("returns native INTERRUPTED NodeExecutionResult without running nodeFn or settling when balance is insufficient", async () => {
      const redis = new InMemoryGateRedis();
      redis.wallets.set(REDIS_KEYS.wallet(userId), 250);

      const nodeFn = vi.fn<AgentGraphNodeFn>();
      const gated = withMeteredNodeGate(nodeName, flashModel, nodeFn, {
        customRedis: redis,
        pessimisticInputTokens: 5000,
      });

      const result = await gated(
        createInitialAgentGraphState(),
        createRuntimeContext(),
      );

      expect(result).toEqual({
        status: "INTERRUPTED",
        interruptReason: "INSUFFICIENT_CREDITS",
        stateDelta: {},
        interruptPayload: {
          availableMicro: 250,
          requiredMicro: expect.any(Number),
        },
      });
      if (result.status === "INTERRUPTED") {
        expect(Number(result.interruptPayload.requiredMicro)).toBeGreaterThan(
          250,
        );
      }
      expect(nodeFn).not.toHaveBeenCalled();
      expect(redis.settleCalls).toHaveLength(0);
    });
  });

  describe("Idempotency, Cold-Start Recovery & Failure Rollback", () => {
    it("bypasses billing and invokes nodeFn directly when credit:step_done receipt exists for (threadId, turnId, nodeName, stepAttempt)", async () => {
      const redis = new InMemoryGateRedis();
      const ctx = createRuntimeContext({
        threadId: "th-idem",
        turnId: "turn-idem",
      });
      const stepKey = crypto
        .createHash("sha256")
        .update(`th-idem:turn-idem:${nodeName}:1`)
        .digest("hex");
      redis.stepDone.set(
        REDIS_KEYS.stepDone(stepKey),
        JSON.stringify({ status: "SETTLED" }),
      );

      const nodeFn = vi.fn<AgentGraphNodeFn>(async () => ({
        status: "COMPLETED",
        stateDelta: { search_loop_count: 1 },
      }));

      const gated = withMeteredNodeGate(nodeName, flashModel, nodeFn, {
        customRedis: redis,
      });

      const result = await gated(createInitialAgentGraphState(), ctx);

      expect(result).toEqual({
        status: "COMPLETED",
        stateDelta: { search_loop_count: 1 },
      });
      expect(nodeFn).toHaveBeenCalledTimes(1);
      expect(redis.settleCalls).toHaveLength(0);
    });

    it("recovers automatically from a COLD_START_REQUIRED reservation race via flush-first reload", async () => {
      const redis = new InMemoryGateRedis();
      const originalEval = redis.eval.bind(redis);
      let simulatedRace = false;

      vi.spyOn(redis, "eval").mockImplementation(async (script, keys, args) => {
        if (script === RESERVE_OR_EXTEND_LUA && !simulatedRace) {
          simulatedRace = true;
          redis.wallets.delete(keys[0]);
          return JSON.stringify({ status: "COLD_START_REQUIRED" }) as never;
        }
        return originalEval(script, keys, args);
      });

      const nodeFn: AgentGraphNodeFn = async () => ({
        status: "COMPLETED",
        stateDelta: { classified_intent: "CHAT_ONLY" },
      });

      const gated = withMeteredNodeGate(nodeName, flashModel, nodeFn, {
        customRedis: redis,
        calculateActualCostMicro: () => 12_000,
      });

      const result = await gated(
        createInitialAgentGraphState(),
        createRuntimeContext(),
      );

      expect(result.status).toBe("COMPLETED");
      expect(simulatedRace).toBe(true);
      expect(mockGetUserCreditBalance).toHaveBeenCalledTimes(2);
      expect(redis.settleCalls).toHaveLength(1);
      expect(redis.settleCalls[0].actualCost).toBe(12_000);
    });

    it("refunds full reservation with ABORTED settlement when nodeFn throws", async () => {
      const redis = new InMemoryGateRedis();
      const initialBalance = 20_000_000;
      redis.wallets.set(REDIS_KEYS.wallet(userId), initialBalance);

      const crashingNode: AgentGraphNodeFn = async () => {
        throw new Error("Upstream LLM timeout");
      };

      const gated = withMeteredNodeGate(nodeName, flashModel, crashingNode, {
        customRedis: redis,
        pessimisticInputTokens: 500,
      });

      await expect(
        gated(createInitialAgentGraphState(), createRuntimeContext()),
      ).rejects.toThrow("Upstream LLM timeout");

      expect(redis.settleCalls).toHaveLength(1);
      expect(redis.settleCalls[0].status).toBe("ABORTED");
      expect(redis.settleCalls[0].actualCost).toBe(0);
      expect(redis.wallets.get(REDIS_KEYS.wallet(userId))).toBe(initialBalance);
    });
  });

  describe("Token Extraction & Pre-Flight Validation", () => {
    it("extracts pessimistic input tokens from user_request.prompt and messages when no override is supplied", async () => {
      const redis = new InMemoryGateRedis();
      redis.wallets.set(REDIS_KEYS.wallet(userId), 20_000_000);

      const state = createInitialAgentGraphState({
        user_request: {
          prompt: "Design a distributed zero-knowledge markdown workspace",
          workspaceId: "ws-1",
          turnId: "turn-1",
          targetFileIds: [],
          permissionMode: "safe",
          selectedSystem2ModelId: flashModel,
        },
        messages: [
          {
            id: "m1",
            role: "user",
            content: "Additional architectural requirements for conflict merges",
            createdAt: "2026-11-20T00:00:00.000Z",
          },
        ],
      });

      const nodeFn: AgentGraphNodeFn = async () => ({
        status: "COMPLETED",
        stateDelta: {},
      });

      const gated = withMeteredNodeGate(nodeName, flashModel, nodeFn, {
        customRedis: redis,
      });

      await gated(state, createRuntimeContext());

      expect(redis.settleCalls).toHaveLength(1);
      expect(Number(redis.settleCalls[0].payload.inputTokens)).toBeGreaterThan(
        0,
      );
    });

    it("throws when ctx.userId is empty or Redis is unconfigured without customRedis", async () => {
      const redis = new InMemoryGateRedis();
      const noopNode: AgentGraphNodeFn = async () => ({
        status: "COMPLETED",
        stateDelta: {},
      });

      const gatedWithRedis = withMeteredNodeGate(nodeName, flashModel, noopNode, {
        customRedis: redis,
      });
      await expect(
        gatedWithRedis(
          createInitialAgentGraphState(),
          createRuntimeContext({ userId: "" }),
        ),
      ).rejects.toThrow(/userId could not be resolved/);

      const gatedNoRedis = withMeteredNodeGate(nodeName, flashModel, noopNode);
      await expect(
        gatedNoRedis(createInitialAgentGraphState(), createRuntimeContext()),
      ).rejects.toThrow(MeteringServiceUnavailableError);
    });
  });
});
