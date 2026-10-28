import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamGovernor } from "@/lib/metering/stream-governor";
import {
  LOCAL_HOLD_TIMEOUT_MS,
  REDIS_KEYS,
} from "@/lib/metering/constants";
import {
  RESERVE_OR_EXTEND_LUA,
  SETTLE_OPERATION_LUA,
  type RedisEvalClient,
} from "@/lib/metering/lua-scripts";

/**
 * In-memory Mock Redis Client for Stream Governor Testing.
 */
class MockGovernorRedis implements RedisEvalClient {
  public wallets = new Map<string, number>();
  public leases = new Map<string, Record<string, any>>();
  public stepDone = new Map<string, string>();
  public pendingSettlements = new Map<string, Map<string, string>>();
  public dirtyWallets = new Set<string>();

  public extendCallCount = 0;
  public settleCallCount = 0;
  public shouldFailExtension = false;
  public extensionDelayMs = 0;

  public async eval<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[]
  ): Promise<T> {
    if (script === RESERVE_OR_EXTEND_LUA) {
      this.extendCallCount++;

      if (this.extensionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.extensionDelayMs));
      }

      if (this.shouldFailExtension) {
        return JSON.stringify({
          status: "INSUFFICIENT_CREDITS",
          available: 0,
          required: 100000,
        }) as unknown as T;
      }

      const [walletKey, leaseKey] = keys;
      const [_reqInputStr, desOutputStr, _minOutputStr, _zeroDustStr, leaseTtlStr, userId, stepKey] = args;

      const desOutput = Number(desOutputStr);
      const curBal = this.wallets.get(walletKey) ?? 50_000_000;
      this.wallets.set(walletKey, curBal - desOutput);

      const existingLease = this.leases.get(leaseKey) || {
        totalReservedMicro: 0,
        reservedOutputMicro: 0,
      };

      this.leases.set(leaseKey, {
        ...existingLease,
        totalReservedMicro: (existingLease.totalReservedMicro || 0) + desOutput,
        reservedOutputMicro: (existingLease.reservedOutputMicro || 0) + desOutput,
        userId: String(userId),
        stepKey: String(stepKey),
        ttl: Number(leaseTtlStr),
      });

      return JSON.stringify({
        status: "SUCCESS",
        reservedInputMicro: 0,
        reservedOutputMicro: desOutput,
        totalReservedMicro: desOutput,
        newBalanceMicro: curBal - desOutput,
      }) as unknown as T;
    }

    if (script === SETTLE_OPERATION_LUA) {
      this.settleCallCount++;
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

    throw new Error(`Unhandled script in MockGovernorRedis: ${script}`);
  }
}

describe("Stream Governor & Real-Time Local Hold Gate (stream-governor.ts)", () => {
  const userId = "usr_stream_test_1";
  const operationId = "op_stream_run_1";
  const streamingModelId = "google/gemini-3.8-flash";
  const decisionModelId = "openai/gpt-6-luna-decisions";

  let redis: MockGovernorRedis;
  let abortController: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = new MockGovernorRedis();
    redis.wallets.set(REDIS_KEYS.wallet(userId), 50_000_000);
    abortController = new AbortController();
  });

  describe("Initialization & Model Derivations", () => {
    it("should initialize with correct token allocations and trigger thresholds", () => {
      // gemini-3.8-flash: V = 120, T_RUNWAY_SECONDS = 3 -> trigger = 360 tokens
      const initialReservationTokens = 500;
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        initialReservationTokens,
        abortController,
        { customRedis: redis }
      );

      expect(governor.getTotalReservedTokens()).toBe(500);
      expect(governor.getCoveredTokens()).toBe(500);
      expect(governor.getTotalProducedTokens()).toBe(0);
      expect(governor.isAborted()).toBe(false);
      expect(governor.isInHold()).toBe(false);
      expect(governor.isSettled()).toBe(false);
    });

    it("should sanitize negative, NaN, or non-finite initialReservationTokens to 0", () => {
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        NaN,
        abortController,
        { customRedis: redis }
      );

      expect(governor.getTotalReservedTokens()).toBe(0);
      expect(governor.getCoveredTokens()).toBe(0);
    });

    it("should start in aborted state if AbortController signal was already aborted before construction", () => {
      const preAborted = new AbortController();
      preAborted.abort("Pre-aborted test");

      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        500,
        preAborted,
        { customRedis: redis }
      );

      expect(governor.isAborted()).toBe(true);
    });
  });

  describe("Token Chunk Processing & Runway Renewal", () => {
    it("should allow chunks within the confirmed runway without triggering extension", async () => {
      // 1000 initial tokens. Trigger is at 360 remaining tokens (consumed = 640).
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        1000,
        abortController,
        { customRedis: redis }
      );

      // Consume 100 tokens -> remaining = 900 (above 360 trigger)
      const allowed = await governor.onTokenChunk(100);

      expect(allowed).toBe(true);
      expect(governor.getTotalProducedTokens()).toBe(100);
      expect(redis.extendCallCount).toBe(0);
    });

    it("should trigger asynchronous non-blocking extension when remaining tokens reach runway threshold", async () => {
      // 500 initial tokens. Trigger is at 360 remaining.
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        500,
        abortController,
        { customRedis: redis }
      );

      // Consume 200 tokens -> remaining = 300 <= 360 trigger
      const allowed = await governor.onTokenChunk(200);

      expect(allowed).toBe(true);
      expect(governor.getTotalProducedTokens()).toBe(200);

      // Give event loop tick for async non-blocking extension to resolve
      await new Promise((r) => setTimeout(r, 10));

      expect(redis.extendCallCount).toBe(1);
      // Reservation should expand
      expect(governor.getTotalReservedTokens()).toBeGreaterThan(500);
    });

    it("should dedupe concurrent in-flight extensions without firing duplicate requests", async () => {
      redis.extensionDelayMs = 50; // In-flight extension takes 50ms

      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        500,
        abortController,
        { customRedis: redis }
      );

      // First chunk triggers extension
      await governor.onTokenChunk(200);

      // Subsequent chunks while first extension is still in-flight
      await governor.onTokenChunk(50);
      await governor.onTokenChunk(50);

      // Wait for extension to finish
      await new Promise((r) => setTimeout(r, 70));

      // Must only have triggered 1 extension call
      expect(redis.extendCallCount).toBe(1);
    });

    it("should handle raw string chunks by counting tokens with tiktoken", async () => {
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        1000,
        abortController,
        { customRedis: redis }
      );

      const text = "This is a streaming response token chunk generated by AI model.";
      const allowed = await governor.onTokenChunk(text);

      expect(allowed).toBe(true);
      expect(governor.getTotalProducedTokens()).toBeGreaterThan(5);
    });
  });

  describe("500ms Local Hold Gate & Slice Exhaustion", () => {
    it("should hold and succeed when in-flight extension resolves within 500ms", async () => {
      redis.extensionDelayMs = 30; // Resolves well within 500ms hold gate

      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        100, // Small initial slice
        abortController,
        { customRedis: redis }
      );

      // Consuming 150 tokens immediately exhausts 100 token slice
      const allowedPromise = governor.onTokenChunk(150);

      // Verify governor entered hold gate
      expect(governor.isInHold()).toBe(true);

      const allowed = await allowedPromise;

      expect(allowed).toBe(true);
      expect(governor.isInHold()).toBe(false);
      expect(governor.isAborted()).toBe(false);
      expect(governor.getTotalReservedTokens()).toBeGreaterThanOrEqual(150);
    });

    it("should abort with SLICE_EXHAUSTED and fail closed when extension fails (insufficient credits)", async () => {
      redis.shouldFailExtension = true; // Extension returns INSUFFICIENT_CREDITS

      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        50,
        abortController,
        { customRedis: redis }
      );

      // Consuming 80 tokens exceeds 50 token slice
      const allowed = await governor.onTokenChunk(80);

      expect(allowed).toBe(false);
      expect(governor.isAborted()).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      expect(abortController.signal.reason).toBe("SLICE_EXHAUSTED");
      expect(governor.isSettled()).toBe(true);
    });

    it("should abort when 500ms local hold gate expires", async () => {
      // Simulate slow extension taking longer than LOCAL_HOLD_TIMEOUT_MS (500ms)
      redis.extensionDelayMs = LOCAL_HOLD_TIMEOUT_MS + 200;

      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        50,
        abortController,
        { customRedis: redis }
      );

      const start = Date.now();
      const allowed = await governor.onTokenChunk(100);
      const elapsed = Date.now() - start;

      expect(allowed).toBe(false);
      expect(governor.isAborted()).toBe(true);
      expect(abortController.signal.reason).toBe("SLICE_EXHAUSTED");
      // Must have waited approximately 500ms before failing closed
      expect(elapsed).toBeGreaterThanOrEqual(LOCAL_HOLD_TIMEOUT_MS - 50);
    });
  });

  describe("AbortController Integration", () => {
    it("should abort immediately and stop further token processing when external abort signal fires", async () => {
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        1000,
        abortController,
        { customRedis: redis }
      );

      await governor.onTokenChunk(50);
      expect(governor.isAborted()).toBe(false);

      // External user clicks "Stop Generating"
      abortController.abort("User cancelled generation");

      expect(governor.isAborted()).toBe(true);

      // Subsequent chunks must be immediately rejected
      const nextAllowed = await governor.onTokenChunk(50);
      expect(nextAllowed).toBe(false);
    });

    it("should abort external AbortController when governor.abort() is called directly", () => {
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        1000,
        abortController,
        { customRedis: redis }
      );

      governor.abort("Internal error");

      expect(governor.isAborted()).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      expect(abortController.signal.reason).toBe("Internal error");
    });
  });

  describe("Settlement Operation & Zero-Dust Conservation", () => {
    it("should settle successfully, calculate accurate cost, and refund unused surplus credits", async () => {
      const initialTokens = 500;
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        initialTokens,
        abortController,
        {
          customRedis: redis,
          inputTokens: 100,
          threadId: "th_stream_1",
          nodeName: "stream_node",
        }
      );

      // Consume only 150 output tokens
      await governor.onTokenChunk(150);

      // Settle the stream
      const result = await governor.settle("SETTLED");

      expect(result.status).toBe("SETTLED");
      expect(governor.isSettled()).toBe(true);
      expect(redis.settleCallCount).toBe(1);

      // Unused reservation released back to Redis
      expect(result.refundMicro).toBeGreaterThan(0);
      expect(result.actualCostMicro).toBeGreaterThan(0);
      expect(result.totalReservedMicro).toBe(result.actualCostMicro + result.refundMicro);
    });

    it("should cap consumed output tokens at coveredTokens on settlement when produced tokens exceed covered tokens", async () => {
      redis.shouldFailExtension = true; // Prevent lease expansion

      const initialTokens = 80;
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        initialTokens,
        abortController,
        { customRedis: redis }
      );

      // Attempt to produce 120 tokens (exceeds 80 covered)
      await governor.onTokenChunk(120);

      expect(governor.getCoveredTokens()).toBe(80);
      expect(governor.getTotalProducedTokens()).toBe(120);

      // Settle should cap billed output tokens at coveredTokens (80), not 120
      const result = await governor.settle();
      expect(result.status).toBe("SETTLED");

      const pendingHash = redis.pendingSettlements.get(REDIS_KEYS.pendingSettlements(userId));
      const rawPayload = pendingHash?.get(operationId);
      expect(rawPayload).toBeDefined();
      const payload = JSON.parse(rawPayload as string);
      expect(payload.outputTokens).toBe(80);
    });

    it("should be idempotent when settle() is called multiple times", async () => {
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        500,
        abortController,
        { customRedis: redis }
      );

      await governor.onTokenChunk(100);

      const firstSettle = await governor.settle("SETTLED");
      const secondSettle = await governor.settle("SETTLED");

      expect(firstSettle).toBe(secondSettle);
      expect(redis.settleCallCount).toBe(1); // Exactly 1 Redis settle call
    });

    it("should force status to ABORTED if stream was aborted prior to settlement", async () => {
      const governor = new StreamGovernor(
        userId,
        operationId,
        streamingModelId,
        500,
        abortController,
        { customRedis: redis }
      );

      await governor.onTokenChunk(50);
      governor.abort("Stream timed out");

      // Even if caller asks for "SETTLED", governor must force "ABORTED"
      const result = await governor.settle("SETTLED");
      expect(result.status).toBe("SETTLED"); // Redis script status returns SETTLED
      // Verify pending settlement payload has status ABORTED
      const pendingHash = redis.pendingSettlements.get(REDIS_KEYS.pendingSettlements(userId));
      const rawPayload = pendingHash?.get(operationId);
      expect(rawPayload).toBeDefined();
      const payload = JSON.parse(rawPayload as string);
      expect(payload.status).toBe("ABORTED");
    });
  });

  describe("Zero-Output-Rate / Decision Models", () => {
    it("should automatically advance reservation without making Redis extension calls for zero-cost output models", async () => {
      const governor = new StreamGovernor(
        userId,
        operationId,
        decisionModelId,
        0, // 0 initial output tokens
        abortController,
        { customRedis: redis }
      );

      const allowed = await governor.onTokenChunk(250);

      expect(allowed).toBe(true);
      expect(governor.getTotalProducedTokens()).toBe(250);
      expect(governor.getTotalReservedTokens()).toBe(250);
      expect(governor.getCoveredTokens()).toBe(250);

      // Must not call Redis extension for free output models
      expect(redis.extendCallCount).toBe(0);
    });
  });
});
