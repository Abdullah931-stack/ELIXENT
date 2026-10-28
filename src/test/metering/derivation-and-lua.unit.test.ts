import { describe, it, expect } from "vitest";
import {
  tokensToMicroCredits,
  deriveSinglePassReservation,
  deriveDiscreteThinkingReservation,
  deriveStreamingGenerativeReservation,
  deriveModelReservationParameters,
  getModelRegistryEntry,
} from "@/lib/metering/derivation";
import {
  countRawTokens,
  estimatePessimisticInputTokens,
} from "@/lib/metering/tokenizer";
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
import {
  B_DISCRETE_DEFAULT_TOKENS,
  L_MIN_TOKENS,
  LEASE_TTL_SECONDS,
  REDIS_KEYS,
} from "@/lib/metering/constants";

/**
 * In-memory simulation of Redis client and atomic Lua script evaluations.
 * Provides high-fidelity state mutation and key isolation for unit testing.
 */
class InMemoryRedisEvalClient implements RedisEvalClient {
  public wallets = new Map<string, number>();
  public leases = new Map<string, Record<string, string | number>>();
  public stepDone = new Map<string, string>();
  public pendingSettlements = new Map<string, Map<string, string>>();
  public dirtyWallets = new Set<string>();

  public setWallet(userId: string, balanceMicro: number): void {
    this.wallets.set(REDIS_KEYS.wallet(userId), balanceMicro);
  }

  public getWallet(userId: string): number | undefined {
    return this.wallets.get(REDIS_KEYS.wallet(userId));
  }

  public setStepDone(stepKey: string, payload: string): void {
    this.stepDone.set(REDIS_KEYS.stepDone(stepKey), payload);
  }

  public async eval<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[]
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

      // 5. Affordability check
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

      // 6. Allocation
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
      const actualCost = Number(actualCostStr);
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

describe("Mathematical Derivations & Tokenizer Unit Tests", () => {
  describe("tokensToMicroCredits", () => {
    it("converts tokens and rates accurately to micro-credits", () => {
      // 1000 tokens at 1.0 credits per 1k = 1,000,000 micro-credits (1 credit)
      expect(tokensToMicroCredits(1000, 1.0)).toBe(BigInt(1_000_000));

      // Ceiling verification on fractional micro-credits
      // 3 tokens * 0.0001 * 1000 = 0.3 -> ceil = 1
      expect(tokensToMicroCredits(3, 0.0001)).toBe(BigInt(1));

      // 0 tokens or non-positive rates
      expect(tokensToMicroCredits(0, 1.0)).toBe(BigInt(0));
      expect(tokensToMicroCredits(-5, 1.0)).toBe(BigInt(0));
      expect(tokensToMicroCredits(100, 0)).toBe(BigInt(0));
      expect(tokensToMicroCredits(100, -0.5)).toBe(BigInt(0));
    });
  });

  describe("MTR-01: Single-Pass Decision Model Reservations", () => {
    const decisionModels = [
      "typesafe/jev-1.13",
      "microsoft/decision-1",
      "openai/gpt-6-luna-decisions",
    ];

    it.each(decisionModels)(
      "reserves input cost only with zero output tokens and trigger for %s",
      (modelId) => {
        const model = getModelRegistryEntry(modelId);
        expect(model.executionMode).toBe("SINGLE_PASS_DECISION");
        expect(model.creditsPer1kOutput).toBe(0);

        const inputTokens = 1200;
        const res = deriveSinglePassReservation(
          inputTokens,
          model,
          BigInt(500_000)
        );

        expect(res.executionMode).toBe("SINGLE_PASS_DECISION");
        expect(res.allocatedOutputTokens).toBe(0);
        expect(res.triggerRemainingTokens).toBe(0);
        expect(res.desiredOutputMicro).toBe(BigInt(0));
        expect(res.minAllowedOutputMicro).toBe(BigInt(0));
        expect(res.isZeroDustAllowed).toBe(false);
        expect(res.canAfford).toBe(true);

        const expectedMicro = tokensToMicroCredits(
          inputTokens,
          model.creditsPer1kInput
        );
        expect(res.requiredInputMicro).toBe(expectedMicro);
        expect(res.totalReservedMicro).toBe(expectedMicro);
      }
    );

    it("evaluates affordability correctly for single-pass models", () => {
      const model = getModelRegistryEntry("typesafe/jev-1.13");
      const inputTokens = 1000; // 1000 * 0.15 * 1000 = 150,000 micro-credits

      const affordable = deriveSinglePassReservation(
        inputTokens,
        model,
        BigInt(150_000)
      );
      expect(affordable.canAfford).toBe(true);

      const unaffordable = deriveSinglePassReservation(
        inputTokens,
        model,
        BigInt(149_999)
      );
      expect(unaffordable.canAfford).toBe(false);
    });
  });

  describe("Discrete Thinking Model Reservations", () => {
    it("allocates discrete ceiling and reserves input plus discrete output", () => {
      const model = getModelRegistryEntry("fastino/glide");
      expect(model.executionMode).toBe("DISCRETE_THINKING");

      const inputTokens = 500;

      // Default ceiling (1500 tokens)
      const resDefault = deriveDiscreteThinkingReservation(inputTokens, model);
      expect(resDefault.allocatedOutputTokens).toBe(B_DISCRETE_DEFAULT_TOKENS);
      expect(resDefault.triggerRemainingTokens).toBe(0);
      expect(resDefault.requiredInputMicro).toBe(
        tokensToMicroCredits(inputTokens, model.creditsPer1kInput)
      );
      expect(resDefault.desiredOutputMicro).toBe(
        tokensToMicroCredits(
          B_DISCRETE_DEFAULT_TOKENS,
          model.creditsPer1kOutput
        )
      );
      expect(resDefault.totalReservedMicro).toBe(
        resDefault.requiredInputMicro + resDefault.desiredOutputMicro
      );

      // Custom discrete ceiling (2000 tokens)
      const resCustom = deriveDiscreteThinkingReservation(
        inputTokens,
        model,
        2000
      );
      expect(resCustom.allocatedOutputTokens).toBe(2000);
      expect(resCustom.triggerRemainingTokens).toBe(0);
    });
  });

  describe("MTR-04: Streaming Generative Model Reservations & Zero-Dust Drain", () => {
    it("calculates standard operational chunk (L_calc) when balance is ample", () => {
      const model = getModelRegistryEntry("google/gemini-4-argon");
      // V = 100, T_chunk = 10s -> L_calc = max(500, 100 * 10) = 1000
      // T_runway = 3s -> trigger = 100 * 3 = 300
      const inputTokens = 1000;
      const balance = BigInt(100_000_000); // 100 credits

      const res = deriveStreamingGenerativeReservation(
        inputTokens,
        model,
        balance
      );
      expect(res.executionMode).toBe("STREAMING_GENERATIVE");
      expect(res.allocatedOutputTokens).toBe(1000);
      expect(res.triggerRemainingTokens).toBe(300);
      expect(res.isZeroDustAllowed).toBe(false);
      expect(res.canAfford).toBe(true);
      expect(res.minAllowedOutputMicro).toBe(
        tokensToMicroCredits(L_MIN_TOKENS, model.creditsPer1kOutput)
      );
    });

    it("MTR-04: waives L_min floor and drains wallet to exactly 0 micro-credits when 0 < capacity < L_min", () => {
      const model = getModelRegistryEntry("google/gemini-4-argon");
      const inputTokens = 1000;
      const inputMicro = tokensToMicroCredits(
        inputTokens,
        model.creditsPer1kInput
      );
      // 1000 * 1.25 * 1000 = 1,250,000 micro-credits

      // Capacity for exactly 80 output tokens (< L_min = 500)
      const outputTokens = 80;
      const outputMicro = tokensToMicroCredits(
        outputTokens,
        model.creditsPer1kOutput
      );
      // 80 * 5.00 * 1000 = 400,000 micro-credits

      const totalBalance = inputMicro + outputMicro; // 1,650,000 micro-credits

      const res = deriveStreamingGenerativeReservation(
        inputTokens,
        model,
        totalBalance
      );

      expect(res.canAfford).toBe(true);
      expect(res.isZeroDustAllowed).toBe(true);
      expect(res.allocatedOutputTokens).toBe(80);
      expect(res.requiredInputMicro).toBe(inputMicro);
      expect(res.desiredOutputMicro).toBe(outputMicro);
      expect(res.minAllowedOutputMicro).toBe(outputMicro);
      expect(res.totalReservedMicro).toBe(totalBalance);
      expect(totalBalance - res.totalReservedMicro).toBe(BigInt(0));
    });

    it("rejects reservation when user balance cannot cover input tokens", () => {
      const model = getModelRegistryEntry("google/gemini-3.8-flash");
      const inputTokens = 1000; // 1000 * 0.15 * 1000 = 150,000 micro-credits
      const balance = BigInt(100_000); // 100,000 < 150,000

      const res = deriveStreamingGenerativeReservation(
        inputTokens,
        model,
        balance
      );
      expect(res.canAfford).toBe(false);
      expect(res.allocatedOutputTokens).toBe(0);
      expect(res.desiredOutputMicro).toBe(BigInt(0));
    });

    it("dispatches correctly via deriveModelReservationParameters", () => {
      const decisionRes = deriveModelReservationParameters(
        "openai/gpt-6-luna-decisions",
        500,
        BigInt(1_000_000)
      );
      expect(decisionRes.executionMode).toBe("SINGLE_PASS_DECISION");

      const discreteRes = deriveModelReservationParameters(
        "fastino/glide",
        500,
        BigInt(2_000_000)
      );
      expect(discreteRes.executionMode).toBe("DISCRETE_THINKING");

      const streamingRes = deriveModelReservationParameters(
        "google/gemini-3.8-flash",
        500,
        BigInt(5_000_000)
      );
      expect(streamingRes.executionMode).toBe("STREAMING_GENERATIVE");
    });
  });

  describe("Tiktoken Pessimistic Tokenizer", () => {
    it("counts raw tokens accurately and handles empty/whitespace input", () => {
      expect(countRawTokens("")).toBe(0);
      expect(countRawTokens("    \n\t  ")).toBe(0);
      expect(countRawTokens(null as unknown as string)).toBe(0);

      const text =
        "The quick brown fox jumps over the lazy dog. Architectural Clean Code.";
      const count = countRawTokens(text);
      expect(count).toBeGreaterThan(0);
    });

    it("applies +15% pessimistic margin rounded up", () => {
      expect(estimatePessimisticInputTokens("")).toBe(0);

      const text = "Elixent multi-pass architectural transformation.";
      const raw = countRawTokens(text);
      const pessimistic = estimatePessimisticInputTokens(text);

      expect(pessimistic).toBe(Math.ceil(raw * 1.15));
      expect(pessimistic).toBeGreaterThanOrEqual(raw);
    });
  });
});

describe("Atomic Redis Lua Scripts & Execution Wrappers", () => {
  describe("MTR-02: Concurrency & Overdraft Prevention", () => {
    it("accepts exactly 3 concurrent requests and rejects 7 without overdraft", async () => {
      const redis = new InMemoryRedisEvalClient();
      const userId = "user-mtr-02-test";

      // Balance covers exactly 3 reservations of 100,000 micro-credits each
      redis.setWallet(userId, 300_000);

      // Dispatch 10 concurrent reservation requests
      const requests = Array.from({ length: 10 }, (_, i) =>
        executeReserveOrExtend(
          {
            userId,
            operationId: `op-concurrent-${i}`,
            stepKey: `step-concurrent-${i}`,
            requiredInputMicro: 100_000,
            desiredOutputMicro: 0,
            minAllowedOutputMicro: 0,
            isZeroDustAllowed: false,
            leaseTtlSeconds: LEASE_TTL_SECONDS,
          },
          redis
        )
      );

      const results = await Promise.all(requests);

      const successful = results.filter((r) => r.status === "SUCCESS");
      const rejected = results.filter(
        (r) => r.status === "INSUFFICIENT_CREDITS"
      );

      expect(successful).toHaveLength(3);
      expect(rejected).toHaveLength(7);

      // Final balance is precisely 0 (non-negative, no overdraft)
      const finalBal = redis.getWallet(userId);
      expect(finalBal).toBe(0);
      expect(finalBal!).toBeGreaterThanOrEqual(0);
    });
  });

  describe("MTR-03: Fail-Closed Policy Enforcement", () => {
    it("immediately throws MeteringServiceUnavailableError (503) on Redis network/script failure", async () => {
      const failingRedis: RedisEvalClient = {
        eval: async () => {
          throw new Error("Upstash Redis connection timeout (ECONNREFUSED)");
        },
      };

      // 1. executeReserveOrExtend
      await expect(
        executeReserveOrExtend(
          {
            userId: "u-fail",
            operationId: "op-fail",
            stepKey: "step-fail",
            requiredInputMicro: 10_000,
            desiredOutputMicro: 0,
            minAllowedOutputMicro: 0,
            isZeroDustAllowed: false,
          },
          failingRedis
        )
      ).rejects.toThrow(MeteringServiceUnavailableError);

      try {
        await executeReserveOrExtend(
          {
            userId: "u-fail",
            operationId: "op-fail",
            stepKey: "step-fail",
            requiredInputMicro: 10_000,
            desiredOutputMicro: 0,
            minAllowedOutputMicro: 0,
            isZeroDustAllowed: false,
          },
          failingRedis
        );
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MeteringServiceUnavailableError);
        const meteringErr = err as MeteringServiceUnavailableError;
        expect(meteringErr.status).toBe(503);
        expect(meteringErr.code).toBe("METERING_SERVICE_UNAVAILABLE");
      }

      // 2. executeSettleOperation
      await expect(
        executeSettleOperation(
          {
            userId: "u-fail",
            operationId: "op-fail",
            stepKey: "step-fail",
            actualTotalCostMicro: 5_000,
            settlementPayload: { op: "fail" },
          },
          failingRedis
        )
      ).rejects.toThrow(MeteringServiceUnavailableError);

      // 3. executeStripeDualWrite
      await expect(
        executeStripeDualWrite(
          {
            userId: "u-fail",
            topupMicro: 100_000,
          },
          failingRedis
        )
      ).rejects.toThrow(MeteringServiceUnavailableError);
    });

    it("throws MeteringServiceUnavailableError (503) when Redis is unconfigured in runtime", async () => {
      // Calling wrappers without a custom client in an unconfigured test environment
      await expect(
        executeReserveOrExtend({
          userId: "u-unconfigured",
          operationId: "op-unconfigured",
          stepKey: "step-unconfigured",
          requiredInputMicro: 10_000,
          desiredOutputMicro: 0,
          minAllowedOutputMicro: 0,
          isZeroDustAllowed: false,
        })
      ).rejects.toThrow(MeteringServiceUnavailableError);

      await expect(
        executeSettleOperation({
          userId: "u-unconfigured",
          operationId: "op-unconfigured",
          stepKey: "step-unconfigured",
          actualTotalCostMicro: 5_000,
          settlementPayload: {},
        })
      ).rejects.toThrow(MeteringServiceUnavailableError);

      await expect(
        executeStripeDualWrite({
          userId: "u-unconfigured",
          topupMicro: 50_000,
        })
      ).rejects.toThrow(MeteringServiceUnavailableError);
    });
  });

  describe("Idempotency via lugx:step_done", () => {
    it("returns ALREADY_DONE without double billing when stepKey was previously settled", async () => {
      const redis = new InMemoryRedisEvalClient();
      const userId = "user-idempotent";
      const stepKey = "step-unique-idempotency-key";
      const receipt = JSON.stringify({
        operationId: "op-prior-settled",
        cost: 45_000,
      });

      redis.setWallet(userId, 500_000);
      redis.setStepDone(stepKey, receipt);

      const res = await executeReserveOrExtend(
        {
          userId,
          operationId: "op-replay-attempt",
          stepKey,
          requiredInputMicro: 50_000,
          desiredOutputMicro: 0,
          minAllowedOutputMicro: 0,
          isZeroDustAllowed: false,
        },
        redis
      );

      expect(res.status).toBe("ALREADY_DONE");
      if (res.status === "ALREADY_DONE") {
        expect(res.receipt).toBe(receipt);
      }

      // Wallet balance must not be deducted
      expect(redis.getWallet(userId)).toBe(500_000);
    });
  });

  describe("Cold Start Detection", () => {
    it("returns COLD_START_REQUIRED when wallet key is absent from Redis", async () => {
      const redis = new InMemoryRedisEvalClient();
      const res = await executeReserveOrExtend(
        {
          userId: "user-cold-start",
          operationId: "op-cold-01",
          stepKey: "step-cold-01",
          requiredInputMicro: 20_000,
          desiredOutputMicro: 10_000,
          minAllowedOutputMicro: 10_000,
          isZeroDustAllowed: false,
        },
        redis
      );

      expect(res.status).toBe("COLD_START_REQUIRED");
    });
  });

  describe("Operation Settlement & Durability Staging", () => {
    it("refunds surplus, deletes lease, writes pending settlement, registers dirty wallet, and stamps step_done", async () => {
      const redis = new InMemoryRedisEvalClient();
      const userId = "user-settlement-flow";
      const operationId = "op-stream-999";
      const stepKey = "step-settle-999";

      // Initial wallet balance
      redis.setWallet(userId, 1_000_000);

      // Pre-flight reservation: input = 100k, output = 300k (total 400k reserved)
      const reserveRes = await executeReserveOrExtend(
        {
          userId,
          operationId,
          stepKey,
          requiredInputMicro: 100_000,
          desiredOutputMicro: 300_000,
          minAllowedOutputMicro: 50_000,
          isZeroDustAllowed: false,
        },
        redis
      );
      expect(reserveRes.status).toBe("SUCCESS");
      expect(redis.getWallet(userId)).toBe(600_000);

      // Verify lease was staged
      const leaseKey = REDIS_KEYS.lease(operationId);
      expect(redis.leases.has(leaseKey)).toBe(true);

      // Settle with actual total cost of 250,000 (Refund = 400,000 - 250,000 = 150,000)
      const settlementPayload = {
        operationId,
        userId,
        actualTotalCostMicro: 250_000,
        inputTokens: 100,
        outputTokens: 250,
        created_at_ms: Date.now(),
      };

      const settleRes = await executeSettleOperation(
        {
          userId,
          operationId,
          stepKey,
          actualTotalCostMicro: 250_000,
          settlementPayload,
        },
        redis
      );

      expect(settleRes.status).toBe("SETTLED");
      expect(settleRes.refundMicro).toBe(150_000);
      expect(settleRes.totalReservedMicro).toBe(400_000);
      expect(settleRes.actualCostMicro).toBe(250_000);
      expect(settleRes.newBalanceMicro).toBe(750_000); // 600k + 150k refund

      // 1. Lease deleted
      expect(redis.leases.has(leaseKey)).toBe(false);

      // 2. Pending settlements recorded
      const pendingMap = redis.pendingSettlements.get(
        REDIS_KEYS.pendingSettlements(userId)
      );
      expect(pendingMap?.get(operationId)).toBe(
        JSON.stringify(settlementPayload)
      );

      // 3. User added to dirty wallets
      expect(redis.dirtyWallets.has(userId)).toBe(true);

      // 4. Step done stamped
      expect(redis.stepDone.get(REDIS_KEYS.stepDone(stepKey))).toBe(
        JSON.stringify(settlementPayload)
      );
    });

    it("handles zero refund when actual cost matches or exceeds total reserved", async () => {
      const redis = new InMemoryRedisEvalClient();
      const userId = "user-exact-settle";
      const operationId = "op-exact";
      const stepKey = "step-exact";

      redis.setWallet(userId, 500_000);

      await executeReserveOrExtend(
        {
          userId,
          operationId,
          stepKey,
          requiredInputMicro: 100_000,
          desiredOutputMicro: 100_000,
          minAllowedOutputMicro: 0,
          isZeroDustAllowed: false,
        },
        redis
      );
      expect(redis.getWallet(userId)).toBe(300_000);

      // Actual cost exactly 200,000 -> refund 0
      const settleRes = await executeSettleOperation(
        {
          userId,
          operationId,
          stepKey,
          actualTotalCostMicro: 200_000,
          settlementPayload: { op: "exact" },
        },
        redis
      );

      expect(settleRes.refundMicro).toBe(0);
      expect(settleRes.newBalanceMicro).toBe(300_000);
      expect(redis.getWallet(userId)).toBe(300_000);
    });
  });

  describe("Stripe Webhook Dual-Write Protocol", () => {
    it("increments balance when wallet is warm in Redis (EXISTS == 1)", async () => {
      const redis = new InMemoryRedisEvalClient();
      const userId = "user-warm-stripe";

      redis.setWallet(userId, 250_000);

      const res = await executeStripeDualWrite(
        {
          userId,
          topupMicro: 750_000,
        },
        redis
      );

      expect(res.applied).toBe(true);
      expect(res.newBalanceMicro).toBe(1_000_000);
      expect(redis.getWallet(userId)).toBe(1_000_000);
    });

    it("returns applied: false and nil balance when wallet is cold in Redis (EXISTS == 0)", async () => {
      const redis = new InMemoryRedisEvalClient();
      const userId = "user-cold-stripe";

      const res = await executeStripeDualWrite(
        {
          userId,
          topupMicro: 1_000_000,
        },
        redis
      );

      expect(res.applied).toBe(false);
      expect(res.newBalanceMicro).toBeNull();
      expect(redis.getWallet(userId)).toBeUndefined();
    });
  });

  describe("Mid-Stream Lease Extension & Zero-Dust Drain via Lua", () => {
    it("extends active stream chunk and accumulates reserved totals in lease hash", async () => {
      const redis = new InMemoryRedisEvalClient();
      const userId = "user-stream-ext";
      const operationId = "op-stream-ext-1";
      const stepKey = "step-stream-ext-1";

      redis.setWallet(userId, 500_000);

      // Initial chunk: reserve input (50k) + output (100k) = 150k
      const initRes = await executeReserveOrExtend(
        {
          userId,
          operationId,
          stepKey,
          requiredInputMicro: 50_000,
          desiredOutputMicro: 100_000,
          minAllowedOutputMicro: 50_000,
          isZeroDustAllowed: false,
        },
        redis
      );

      expect(initRes.status).toBe("SUCCESS");
      expect(redis.getWallet(userId)).toBe(350_000);

      // Mid-stream extension 1: input = 0, desired output = 100k
      const extRes1 = await executeReserveOrExtend(
        {
          userId,
          operationId,
          stepKey,
          requiredInputMicro: 0,
          desiredOutputMicro: 100_000,
          minAllowedOutputMicro: 50_000,
          isZeroDustAllowed: false,
        },
        redis
      );

      expect(extRes1.status).toBe("SUCCESS");
      expect(redis.getWallet(userId)).toBe(250_000);

      const lease = redis.leases.get(REDIS_KEYS.lease(operationId));
      expect(lease?.totalReservedMicro).toBe(250_000); // 150k + 100k
      expect(lease?.reservedInputMicro).toBe(50_000);
      expect(lease?.reservedOutputMicro).toBe(200_000);

      // Mid-stream extension 2: Zero-Dust drain of remaining 250,000
      const extRes2 = await executeReserveOrExtend(
        {
          userId,
          operationId,
          stepKey,
          requiredInputMicro: 0,
          desiredOutputMicro: 300_000, // wants 300k, but only 250k left
          minAllowedOutputMicro: 50_000,
          isZeroDustAllowed: true,
        },
        redis
      );

      expect(extRes2.status).toBe("SUCCESS");
      if (extRes2.status === "SUCCESS") {
        expect(extRes2.reservedOutputMicro).toBe(250_000);
        expect(extRes2.newBalanceMicro).toBe(0);
      }
      expect(redis.getWallet(userId)).toBe(0);

      const finalLease = redis.leases.get(REDIS_KEYS.lease(operationId));
      expect(finalLease?.totalReservedMicro).toBe(500_000);
    });
  });
});
