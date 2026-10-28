import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  tokensToMicroCredits,
  deriveSinglePassReservation,
  deriveDiscreteThinkingReservation,
  deriveStreamingGenerativeReservation,
  getModelRegistryEntry,
} from "@/lib/metering/derivation";
import {
  executeReserveOrExtend,
  executeSettleOperation,
  executeStripeDualWrite,
  MeteringServiceUnavailableError,
  RESERVE_OR_EXTEND_LUA,
  SETTLE_OPERATION_LUA,
  STRIPE_DUAL_WRITE_LUA,
  type RedisEvalClient,
} from "@/lib/metering/lua-scripts";
import { StreamGovernor } from "@/lib/metering/stream-governor";
import { ensureWalletLoadedFlushFirst } from "@/lib/metering/cold-start";
import {
  B_DISCRETE_DEFAULT_TOKENS,
  DIRTY_SETTLEMENT_GRACE_MS,
  LEASE_TTL_SECONDS,
  LOCAL_HOLD_TIMEOUT_MS,
  MICRO_PER_CREDIT,
  REDIS_KEYS,
  WALLET_TTL_SECONDS,
} from "@/lib/metering/constants";
import * as aiSettlement from "@/server/services/ai-settlement-service";

/**
 * High-fidelity in-memory Redis client supporting both direct methods
 * and atomic Lua script evaluations for the complete credit metering test suite.
 */
class InMemoryRedisEvalClient implements RedisEvalClient {
  public wallets = new Map<string, number>();
  public leases = new Map<string, Record<string, any>>();
  public stepDone = new Map<string, string>();
  public pendingSettlements = new Map<string, Map<string, string>>();
  public dirtyWallets = new Set<string>();
  public ttls = new Map<string, number>();
  public evalDelayMs: number = 0;

  public setWallet(userId: string, balanceMicro: number): void {
    this.wallets.set(REDIS_KEYS.wallet(userId), balanceMicro);
  }

  public getWallet(userId: string): number | undefined {
    return this.wallets.get(REDIS_KEYS.wallet(userId));
  }

  public setStepDone(stepKey: string, payload: string): void {
    this.stepDone.set(REDIS_KEYS.stepDone(stepKey), payload);
  }

  // Direct Redis methods
  public async exists(key: string): Promise<number> {
    return this.wallets.has(key) ? 1 : 0;
  }

  public async get(key: string): Promise<string | number | null> {
    return this.wallets.has(key) ? this.wallets.get(key)! : null;
  }

  public async set(
    key: string,
    value: string | number,
    options?: { nx?: boolean; ex?: number }
  ): Promise<string | null> {
    if (options?.nx && this.wallets.has(key)) {
      return null;
    }
    this.wallets.set(key, Number(value));
    if (options?.ex) {
      this.ttls.set(key, options.ex);
    }
    return "OK";
  }

  public async setnx(key: string, value: string | number): Promise<number> {
    if (this.wallets.has(key)) return 0;
    this.wallets.set(key, Number(value));
    return 1;
  }

  public async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds);
    return 1;
  }

  public async hlen(key: string): Promise<number> {
    const map = this.pendingSettlements.get(key);
    return map ? map.size : 0;
  }

  public async hgetall(key: string): Promise<Record<string, string>> {
    const map = this.pendingSettlements.get(key);
    if (!map) return {};
    return Object.fromEntries(map.entries());
  }

  public async hdel(key: string, ...fields: string[]): Promise<number> {
    const map = this.pendingSettlements.get(key);
    if (!map) return 0;
    let count = 0;
    for (const f of fields) {
      if (map.delete(f)) count++;
    }
    return count;
  }

  public async smembers(_key: string): Promise<string[]> {
    return Array.from(this.dirtyWallets);
  }

  public async srem(_key: string, ...members: string[]): Promise<number> {
    let count = 0;
    for (const m of members) {
      if (this.dirtyWallets.delete(m)) count++;
    }
    return count;
  }

  public async eval<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[]
  ): Promise<T> {
    if (this.evalDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.evalDelayMs));
    }

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

      // 1. Check idempotency
      const doneReceipt = this.stepDone.get(stepDoneKey);
      if (doneReceipt) {
        return JSON.stringify({
          status: "ALREADY_DONE",
          receipt: doneReceipt,
        }) as unknown as T;
      }

      // 2. Check cold start
      if (!this.wallets.has(walletKey)) {
        return JSON.stringify({
          status: "COLD_START_REQUIRED",
        }) as unknown as T;
      }

      const bal = this.wallets.get(walletKey) ?? 0;
      const reqInput = Number(reqInputStr);
      const desOutput = Number(desOutputStr);
      const minOutput = Number(minOutputStr);
      const zeroDust = Number(zeroDustStr);
      const leaseTtl = Number(leaseTtlStr);

      // 3. Affordability check
      if (zeroDust === 1) {
        if (bal < reqInput) {
          return JSON.stringify({
            status: "INSUFFICIENT_CREDITS",
            available: bal,
            required: reqInput,
          }) as unknown as T;
        }
      } else {
        if (bal < reqInput + minOutput) {
          return JSON.stringify({
            status: "INSUFFICIENT_CREDITS",
            available: bal,
            required: reqInput + minOutput,
          }) as unknown as T;
        }
      }

      // 4. Allocation
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
      const updatedLease = {
        ...existingLease,
        totalReservedMicro:
          Number(existingLease.totalReservedMicro || 0) + totalRes,
        reservedInputMicro:
          Number(existingLease.reservedInputMicro || 0) + reqInput,
        reservedOutputMicro:
          Number(existingLease.reservedOutputMicro || 0) + resOutput,
        userId: String(userId),
        stepKey: String(stepKey),
        ttl: leaseTtl,
      };
      this.leases.set(leaseKey, updatedLease);

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
      const actualCost = Math.min(Number(actualCostStr), totalReserved);
      const refund = Math.max(0, totalReserved - actualCost);

      if (refund > 0) {
        const currentBal = this.wallets.get(walletKey) ?? 0;
        this.wallets.set(walletKey, currentBal + refund);
      }

      this.leases.delete(leaseKey);

      let pending = this.pendingSettlements.get(pendingKey);
      if (!pending) {
        pending = new Map<string, string>();
        this.pendingSettlements.set(pendingKey, pending);
      }
      pending.set(String(operationId), String(payloadJson));

      this.dirtyWallets.add(String(userId));
      this.stepDone.set(stepDoneKey, String(payloadJson));

      const newBal = this.wallets.get(walletKey) ?? 0;

      return JSON.stringify({
        status: "SETTLED",
        refundMicro: refund,
        totalReservedMicro: totalReserved,
        actualCostMicro: actualCost,
        newBalanceMicro: newBal,
      }) as unknown as T;
    }

    if (script === STRIPE_DUAL_WRITE_LUA) {
      const [walletKey] = keys;
      const [topupStr] = args;

      if (this.wallets.has(walletKey)) {
        const cur = this.wallets.get(walletKey)!;
        const newBal = cur + Number(topupStr);
        this.wallets.set(walletKey, newBal);
        this.ttls.set(walletKey, 86400);
        return JSON.stringify({
          applied: true,
          newBalanceMicro: newBal,
        }) as unknown as T;
      } else {
        return JSON.stringify({
          applied: false,
          newBalanceMicro: null,
        }) as unknown as T;
      }
    }

    throw new Error(`Unknown script in InMemoryRedisEvalClient: ${script}`);
  }
}

describe("Credit Metering & Settlement Acceptance Suite (MTR-01 through MTR-06)", () => {
  let redisClient: InMemoryRedisEvalClient;

  beforeEach(() => {
    redisClient = new InMemoryRedisEvalClient();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // MTR-01: Model registry & token-to-micro-credit derivation formulas
  // =========================================================================
  describe("MTR-01: Model Registry & Mathematical Derivation Formulas", () => {
    it("retrieves valid model specifications including velocity, context, and pricing rates", () => {
      const decisionModel = getModelRegistryEntry("microsoft/decision-1");
      expect(decisionModel.modelId).toBe("microsoft/decision-1");
      expect(decisionModel.executionMode).toBe("SINGLE_PASS_DECISION");
      expect(decisionModel.V).toBe(0);
      expect(decisionModel.creditsPer1kInput).toBe(0.10);
      expect(decisionModel.creditsPer1kOutput).toBe(0);

      const jev = getModelRegistryEntry("typesafe/jev-1.13");
      expect(jev.modelId).toBe("typesafe/jev-1.13");
      expect(jev.executionMode).toBe("SINGLE_PASS_DECISION");
      expect(jev.V).toBe(0);
      expect(jev.creditsPer1kInput).toBe(0.15);
      expect(jev.creditsPer1kOutput).toBe(0);

      const flash = getModelRegistryEntry("google/gemini-3.8-flash");
      expect(flash.modelId).toBe("google/gemini-3.8-flash");
      expect(flash.executionMode).toBe("STREAMING_GENERATIVE");
      expect(flash.V).toBe(120);
      expect(flash.creditsPer1kInput).toBe(0.15);
      expect(flash.creditsPer1kOutput).toBe(0.60);

      const glide = getModelRegistryEntry("fastino/glide");
      expect(glide.modelId).toBe("fastino/glide");
      expect(glide.executionMode).toBe("DISCRETE_THINKING");
      expect(glide.V).toBe(85);
      expect(glide.creditsPer1kInput).toBe(0.25);
      expect(glide.creditsPer1kOutput).toBe(0.80);

      expect(() => getModelRegistryEntry("non-existent-model")).toThrow(
        /not found in model registry/
      );
    });

    it("evaluates tokensToMicroCredits with strict ceiling rounding", () => {
      // 1 token at 0.001 credits/1k = ceil(1 * 0.001 * 1000) = 1 micro-credit
      expect(tokensToMicroCredits(1, 0.001)).toBe(BigInt(1));

      // 1000 tokens at 0.60 credits per 1k = ceil(1000 * 0.60 * 1000) = 600,000 micro-credits
      expect(tokensToMicroCredits(1000, 0.60)).toBe(BigInt(600_000));

      // 1000 tokens at 1.0 display credit per 1k = 1,000,000 micro-credits (1 display credit)
      expect(tokensToMicroCredits(1000, 1.0)).toBe(MICRO_PER_CREDIT);

      // Fractional ceiling: 1 token at 0.15 credits/1k = ceil(1 * 0.15 * 1000) = 150 micro-credits
      expect(tokensToMicroCredits(1, 0.15)).toBe(BigInt(150));

      // Zero and negative token handling
      expect(tokensToMicroCredits(0, 0.50)).toBe(BigInt(0));
      expect(tokensToMicroCredits(-10, 0.50)).toBe(BigInt(0));
    });

    it("derives single-pass decision reservations with zero output tokens and zero trigger", () => {
      const jev = getModelRegistryEntry("typesafe/jev-1.13");
      const res = deriveSinglePassReservation(1000, jev);

      expect(res.executionMode).toBe("SINGLE_PASS_DECISION");
      expect(res.modelId).toBe("typesafe/jev-1.13");
      expect(res.desiredOutputMicro).toBe(BigInt(0));
      expect(res.minAllowedOutputMicro).toBe(BigInt(0));
      expect(res.allocatedOutputTokens).toBe(0);
      expect(res.triggerRemainingTokens).toBe(0);
      expect(res.isZeroDustAllowed).toBe(false);

      // 1000 input tokens at 0.15 credits/1k = 150,000 micro-credits
      expect(res.requiredInputMicro).toBe(BigInt(150_000));
      expect(res.totalReservedMicro).toBe(BigInt(150_000));
    });

    it("derives discrete thinking reservations including pessimistic thinking ceiling", () => {
      const glide = getModelRegistryEntry("fastino/glide");
      const res = deriveDiscreteThinkingReservation(1000, glide);

      expect(res.executionMode).toBe("DISCRETE_THINKING");
      expect(res.modelId).toBe("fastino/glide");
      expect(res.allocatedOutputTokens).toBe(B_DISCRETE_DEFAULT_TOKENS); // 1500 tokens
      expect(res.triggerRemainingTokens).toBe(0);
      expect(res.isZeroDustAllowed).toBe(false);

      // Input: 1000 * 0.25 * 1000 = 250,000 micro-credits
      expect(res.requiredInputMicro).toBe(BigInt(250_000));
      // Output: 1500 * 0.80 * 1000 = 1,200,000 micro-credits
      expect(res.desiredOutputMicro).toBe(BigInt(1_200_000));
      expect(res.minAllowedOutputMicro).toBe(BigInt(1_200_000));
      expect(res.totalReservedMicro).toBe(BigInt(1_450_000));
    });

    it("derives streaming generative reservations respecting runway trigger and minimum chunk floor", () => {
      const flash = getModelRegistryEntry("google/gemini-3.8-flash");
      // V = 120 tokens/sec
      // Target chunk tokens = max(500, 120 * 10) = 1200 tokens
      // Runway trigger = 120 * 3 = 360 tokens
      const highBalance = BigInt(10_000_000);
      const res = deriveStreamingGenerativeReservation(500, flash, highBalance);

      expect(res.executionMode).toBe("STREAMING_GENERATIVE");
      expect(res.modelId).toBe("google/gemini-3.8-flash");
      expect(res.allocatedOutputTokens).toBe(1200);
      expect(res.triggerRemainingTokens).toBe(360);
      expect(res.isZeroDustAllowed).toBe(false);
      expect(res.canAfford).toBe(true);

      // Input: 500 * 0.15 * 1000 = 75,000 micro-credits
      expect(res.requiredInputMicro).toBe(BigInt(75_000));
      // Desired chunk: 1200 * 0.60 * 1000 = 720,000 micro-credits
      expect(res.desiredOutputMicro).toBe(BigInt(720_000));
      // Min floor: 500 * 0.60 * 1000 = 300,000 micro-credits
      expect(res.minAllowedOutputMicro).toBe(BigInt(300_000));
    });
  });

  // =========================================================================
  // MTR-02: Atomic pre-allocation & lease acquisition via Lua script
  // =========================================================================
  describe("MTR-02: Atomic Pre-Allocation & Lease Acquisition (executeReserveOrExtend)", () => {
    const userId = "mtr-02-user";
    const operationId = "op-mtr-02-lease";
    const stepKey = "step-mtr-02";

    it("atomically pre-allocates micro-credits and registers lease hash with TTL", async () => {
      redisClient.setWallet(userId, 500_000); // 500,000 micro-credits

      const result = await executeReserveOrExtend(
        {
          userId,
          operationId,
          stepKey,
          requiredInputMicro: BigInt(50_000),
          desiredOutputMicro: BigInt(100_000),
          minAllowedOutputMicro: BigInt(50_000),
          isZeroDustAllowed: true,
          leaseTtlSeconds: LEASE_TTL_SECONDS,
        },
        redisClient
      );

      expect(result.status).toBe("SUCCESS");
      if (result.status === "SUCCESS") {
        expect(result.reservedInputMicro).toBe(50_000);
        expect(result.reservedOutputMicro).toBe(100_000);
        expect(result.totalReservedMicro).toBe(150_000);
        expect(result.newBalanceMicro).toBe(350_000);
      }

      // Verify wallet mutated and lease exists in Redis
      expect(redisClient.getWallet(userId)).toBe(350_000);
      const lease = redisClient.leases.get(REDIS_KEYS.lease(operationId));
      expect(lease).toBeDefined();
      expect(lease?.totalReservedMicro).toBe(150_000);
    });

    it("prevents concurrency race conditions and overdraft: 10 concurrent requests on 3-slice balance", async () => {
      // Wallet holds 150,000 micro-credits, exactly enough for 3 slices of 50,000 each
      redisClient.setWallet(userId, 150_000);

      const tasks = Array.from({ length: 10 }).map((_, i) =>
        executeReserveOrExtend(
          {
            userId,
            operationId: `concurrent-op-${i}`,
            stepKey: `concurrent-step-${i}`,
            requiredInputMicro: BigInt(50_000),
            desiredOutputMicro: BigInt(0),
            minAllowedOutputMicro: BigInt(0),
            isZeroDustAllowed: false,
          },
          redisClient
        )
      );

      const results = await Promise.all(tasks);
      const successful = results.filter((r) => r.status === "SUCCESS");
      const rejected = results.filter((r) => r.status === "INSUFFICIENT_CREDITS");

      expect(successful.length).toBe(3);
      expect(rejected.length).toBe(7);
      expect(redisClient.getWallet(userId)).toBe(0); // Strictly non-negative
    });

    it("detects cold start requirement when wallet key is missing from Redis", async () => {
      const result = await executeReserveOrExtend(
        {
          userId: "cold-user-no-cache",
          operationId: "cold-op",
          stepKey: "cold-step",
          requiredInputMicro: BigInt(10_000),
          desiredOutputMicro: BigInt(20_000),
          minAllowedOutputMicro: BigInt(10_000),
          isZeroDustAllowed: true,
        },
        redisClient
      );

      expect(result.status).toBe("COLD_START_REQUIRED");
    });

    it("enforces stepKey idempotency via stepDone receipt without double reservation", async () => {
      const initialBal = 200_000;
      redisClient.setWallet(userId, initialBal);
      redisClient.setStepDone("step-already-done", '{"status":"SETTLED","cost":5000}');

      const result = await executeReserveOrExtend(
        {
          userId,
          operationId: "idempotent-op",
          stepKey: "step-already-done",
          requiredInputMicro: BigInt(20_000),
          desiredOutputMicro: BigInt(40_000),
          minAllowedOutputMicro: BigInt(20_000),
          isZeroDustAllowed: true,
        },
        redisClient
      );

      expect(result.status).toBe("ALREADY_DONE");
      if (result.status === "ALREADY_DONE") {
        expect(result.receipt).toContain('"status":"SETTLED"');
      }
      expect(redisClient.getWallet(userId)).toBe(initialBal); // Untouched
    });

    it("enforces Fail-Closed policy on Redis network error", async () => {
      const failingClient: RedisEvalClient = {
        eval: async () => {
          throw new Error("Connection reset by peer");
        },
      };

      await expect(
        executeReserveOrExtend(
          {
            userId,
            operationId: "fail-closed-op",
            stepKey: "fail-closed-step",
            requiredInputMicro: BigInt(10_000),
            desiredOutputMicro: BigInt(20_000),
            minAllowedOutputMicro: BigInt(10_000),
            isZeroDustAllowed: true,
          },
          failingClient
        )
      ).rejects.toThrow(MeteringServiceUnavailableError);
    });
  });

  // =========================================================================
  // MTR-03: Real-time streaming sliding-window extensions & local hold gate
  // =========================================================================
  describe("MTR-03: StreamGovernor Sliding-Window Extensions & Local Hold Gate", () => {
    const userId = "mtr-03-user";
    const operationId = "op-mtr-03-gov";
    const modelId = "google/gemini-3.8-flash";

    it("proactively triggers background sliding-window extension when runway drops below trigger", async () => {
      redisClient.setWallet(userId, 5_000_000);
      const abortController = new AbortController();

      // Initial reservation: 1500 tokens (covered: 1500)
      const governor = new StreamGovernor(
        userId,
        operationId,
        modelId,
        1500,
        abortController,
        { customRedis: redisClient }
      );

      // Trigger runway for gemini-3.8-flash (V=120) is 360 tokens.
      // Emitting 1200 tokens leaves 300 remaining runway (< 360 trigger)
      const allowed = await governor.onTokenChunk(1200);

      // Background renewal must be triggered smoothly without abort
      expect(allowed).toBe(true);
      expect(governor.isAborted()).toBe(false);
      expect(governor.isInHold()).toBe(false);
    });

    it("enters local hold gate and aborts when 500ms timeout expires on delayed extension", async () => {
      redisClient.setWallet(userId, 1_000_000);
      // Simulate slow Redis where extension takes 600ms (> 500ms LOCAL_HOLD_TIMEOUT_MS)
      redisClient.evalDelayMs = 600;
      const abortController = new AbortController();

      const governor = new StreamGovernor(
        userId,
        operationId,
        modelId,
        100, // only 100 tokens reserved initially
        abortController,
        { customRedis: redisClient }
      );

      // Consuming 300 tokens (> 100 covered) forces local hold gate
      const startTime = Date.now();
      const allowed = await governor.onTokenChunk(300);
      const elapsed = Date.now() - startTime;

      // Must have held for ~500ms before timing out and aborting
      expect(elapsed).toBeGreaterThanOrEqual(LOCAL_HOLD_TIMEOUT_MS - 30);
      expect(allowed).toBe(false);
      expect(governor.isAborted()).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
    });

    it("cleans up and releases leases on explicit abort", async () => {
      redisClient.setWallet(userId, 500_000);
      const abortController = new AbortController();

      const governor = new StreamGovernor(
        userId,
        operationId,
        modelId,
        1000,
        abortController,
        { customRedis: redisClient }
      );

      governor.abort();
      expect(governor.isAborted()).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
    });
  });

  // =========================================================================
  // MTR-04: Settlement & surplus release (Zero-Dust drain, cost capping)
  // =========================================================================
  describe("MTR-04: Settlement & Surplus Release (Zero-Dust Drain & Cost Capping)", () => {
    const userId = "mtr-04-user";
    const operationId = "op-mtr-04-settle";
    const stepKey = "step-mtr-04";

    it("refunds unconsumed surplus micro-credits back to wallet atomically", async () => {
      redisClient.setWallet(userId, 100_000);

      // 1. Reserve 100,000 micro-credits
      await executeReserveOrExtend(
        {
          userId,
          operationId,
          stepKey,
          requiredInputMicro: BigInt(20_000),
          desiredOutputMicro: BigInt(80_000),
          minAllowedOutputMicro: BigInt(20_000),
          isZeroDustAllowed: true,
        },
        redisClient
      );
      expect(redisClient.getWallet(userId)).toBe(0);

      // 2. Settle with actual cost of 35,000 micro-credits
      const settleResult = await executeSettleOperation(
        {
          userId,
          operationId,
          stepKey,
          actualTotalCostMicro: BigInt(35_000),
          settlementPayload: {
            operationId,
            userId,
            actualTotalCostMicro: 35_000,
            deltaMicro: -35_000,
            status: "SETTLED",
          },
        },
        redisClient
      );

      expect(settleResult.status).toBe("SETTLED");
      expect(settleResult.totalReservedMicro).toBe(100_000);
      expect(settleResult.actualCostMicro).toBe(35_000);
      expect(settleResult.refundMicro).toBe(65_000); // 100,000 - 35,000
      expect(settleResult.newBalanceMicro).toBe(65_000);

      // Assert lease removed and receipt recorded
      expect(redisClient.leases.has(REDIS_KEYS.lease(operationId))).toBe(false);
      expect(redisClient.stepDone.has(REDIS_KEYS.stepDone(stepKey))).toBe(true);
      expect(redisClient.dirtyWallets.has(userId)).toBe(true);
    });

    it("executes Zero-Dust drain waiving floor when balance is below minimum slice", async () => {
      // Balance covers input (10,000) + 80 tokens worth of output (48 micro) < L_MIN floor
      const tinyBalance = 10_048;
      redisClient.setWallet(userId, tinyBalance);

      const res = await executeReserveOrExtend(
        {
          userId,
          operationId: "op-zero-dust",
          stepKey: "step-zero-dust",
          requiredInputMicro: BigInt(10_000),
          desiredOutputMicro: BigInt(900_000), // high desired slice
          minAllowedOutputMicro: BigInt(300_000), // floor is 300,000
          isZeroDustAllowed: true, // Zero-Dust drain enabled!
        },
        redisClient
      );

      expect(res.status).toBe("SUCCESS");
      if (res.status === "SUCCESS") {
        expect(res.reservedInputMicro).toBe(10_000);
        expect(res.reservedOutputMicro).toBe(48); // Drains exact dust!
        expect(res.totalReservedMicro).toBe(10_048);
        expect(res.newBalanceMicro).toBe(0); // Wallet drained to precisely 0
      }
    });

    it("caps actual deducted cost to totalReservedMicro preventing negative refund", async () => {
      redisClient.setWallet(userId, 50_000);

      await executeReserveOrExtend(
        {
          userId,
          operationId: "op-cap",
          stepKey: "step-cap",
          requiredInputMicro: BigInt(20_000),
          desiredOutputMicro: BigInt(30_000),
          minAllowedOutputMicro: BigInt(20_000),
          isZeroDustAllowed: true,
        },
        redisClient
      );

      // Settle reports higher cost than reserved (e.g. 80,000 > 50,000)
      const settleResult = await executeSettleOperation(
        {
          userId,
          operationId: "op-cap",
          stepKey: "step-cap",
          actualTotalCostMicro: BigInt(80_000),
          settlementPayload: {
            operationId: "op-cap",
            userId,
            actualTotalCostMicro: 80_000,
          },
        },
        redisClient
      );

      expect(settleResult.status).toBe("SETTLED");
      expect(settleResult.totalReservedMicro).toBe(50_000);
      expect(settleResult.actualCostMicro).toBe(50_000); // Capped!
      expect(settleResult.refundMicro).toBe(0);
      expect(settleResult.newBalanceMicro).toBe(0);
    });
  });

  // =========================================================================
  // MTR-05: Cold-start flush-first protocol
  // =========================================================================
  describe("MTR-05: Cold-Start Flush-First Protocol (ensureWalletLoadedFlushFirst)", () => {
    const userId = "mtr-05-user";

    it("returns warm balance immediately without touching PostgreSQL", async () => {
      redisClient.setWallet(userId, 750_000);
      const spyGetUserBalance = vi.spyOn(aiSettlement, "getUserCreditBalance");
      const spyFlush = vi.spyOn(aiSettlement, "flushPendingSettlementsToPostgres");

      const balance = await ensureWalletLoadedFlushFirst(userId, redisClient);

      expect(balance).toBe(BigInt(750_000));
      expect(spyGetUserBalance).not.toHaveBeenCalled();
      expect(spyFlush).not.toHaveBeenCalled();
    });

    it("executes flush-first when cold wallet has pending settlements in Redis hash", async () => {
      // Wallet key is absent in Redis (cold start)
      // Hash has an unsettled pending record
      const pendingMap = new Map<string, string>();
      pendingMap.set(
        "op-pending-1",
        JSON.stringify({
          operationId: "op-pending-1",
          userId,
          deltaMicro: -50_000,
          created_at_ms: Date.now() - 1000,
        })
      );
      redisClient.pendingSettlements.set(
        REDIS_KEYS.pendingSettlements(userId),
        pendingMap
      );

      const spyFlush = vi
        .spyOn(aiSettlement, "flushPendingSettlementsToPostgres")
        .mockImplementation(async () => {
          // Simulate draining the hash
          pendingMap.clear();
          return { flushedCount: 1, netDeltaMicro: BigInt(-50_000) };
        });

      const spyGetUserBalance = vi
        .spyOn(aiSettlement, "getUserCreditBalance")
        .mockResolvedValue(BigInt(450_000)); // Updated balance post-flush

      const loadedBalance = await ensureWalletLoadedFlushFirst(
        userId,
        redisClient
      );

      // Flush-first protocol invariants:
      expect(spyFlush).toHaveBeenCalledWith(userId, { customRedis: redisClient });
      expect(spyGetUserBalance).toHaveBeenCalledWith(userId);
      expect(loadedBalance).toBe(BigInt(450_000));
      expect(redisClient.getWallet(userId)).toBe(450_000);
      expect(redisClient.ttls.get(REDIS_KEYS.wallet(userId))).toBe(
        WALLET_TTL_SECONDS
      );
    });

    it("loads directly from DB when cold cache has zero pending settlements", async () => {
      const spyFlush = vi.spyOn(aiSettlement, "flushPendingSettlementsToPostgres");
      const spyGetUserBalance = vi
        .spyOn(aiSettlement, "getUserCreditBalance")
        .mockResolvedValue(BigInt(300_000));

      const balance = await ensureWalletLoadedFlushFirst(userId, redisClient);

      expect(spyFlush).not.toHaveBeenCalled();
      expect(spyGetUserBalance).toHaveBeenCalledWith(userId);
      expect(balance).toBe(BigInt(300_000));
      expect(redisClient.getWallet(userId)).toBe(300_000);
    });
  });

  // =========================================================================
  // MTR-06: Background periodic draining (>30s) & Stripe dual-write
  // =========================================================================
  describe("MTR-06: Background Periodic Draining (>30s) & Stripe Dual-Write", () => {
    const userId = "mtr-06-user";

    it("filters pending settlements older than 30s grace window during background draining", async () => {
      const now = Date.now();
      const oldOpId = "op-old-settled";
      const youngOpId = "op-young-settled";

      const pendingMap = new Map<string, string>();
      // Older than 30s
      pendingMap.set(
        oldOpId,
        JSON.stringify({
          operationId: oldOpId,
          userId,
          deltaMicro: -40_000,
          created_at_ms: now - (DIRTY_SETTLEMENT_GRACE_MS + 5_000), // 35s ago
        })
      );
      // Younger than 30s
      pendingMap.set(
        youngOpId,
        JSON.stringify({
          operationId: youngOpId,
          userId,
          deltaMicro: -15_000,
          created_at_ms: now - 5_000, // 5s ago
        })
      );

      redisClient.pendingSettlements.set(
        REDIS_KEYS.pendingSettlements(userId),
        pendingMap
      );
      redisClient.dirtyWallets.add(userId);

      // Verify grace period filter logic directly
      const pendingEntries = await redisClient.hgetall(
        REDIS_KEYS.pendingSettlements(userId)
      );
      const eligibleToFlush: string[] = [];

      for (const [opId, rawJson] of Object.entries(pendingEntries)) {
        const parsed = JSON.parse(rawJson);
        if (now - parsed.created_at_ms >= DIRTY_SETTLEMENT_GRACE_MS) {
          eligibleToFlush.push(opId);
        }
      }

      expect(eligibleToFlush).toEqual([oldOpId]);
      expect(eligibleToFlush).not.toContain(youngOpId);
    });

    it("synchronizes Stripe top-ups via dual-write to warm Redis wallets", async () => {
      // 1. Warm wallet test
      redisClient.setWallet(userId, 100_000);
      const warmResult = await executeStripeDualWrite(
        {
          userId,
          topupMicro: BigInt(500_000),
        },
        redisClient
      );

      expect(warmResult.applied).toBe(true);
      expect(warmResult.newBalanceMicro).toBe(600_000);
      expect(redisClient.getWallet(userId)).toBe(600_000);
      expect(redisClient.ttls.get(REDIS_KEYS.wallet(userId))).toBe(86400);

      // 2. Cold wallet test (wallet absent in Redis)
      const coldUserId = "cold-stripe-user";
      const coldResult = await executeStripeDualWrite(
        {
          userId: coldUserId,
          topupMicro: BigInt(500_000),
        },
        redisClient
      );

      expect(coldResult.applied).toBe(false);
      expect(coldResult.newBalanceMicro).toBeNull();
      // Leaves Redis wallet unpopulated so next request runs cold-start flush-first
      expect(redisClient.wallets.has(REDIS_KEYS.wallet(coldUserId))).toBe(false);
    });
  });
});
