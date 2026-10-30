/**
 * Test Suite: Modern AI SDK v7 Gateway & GEMINI_API_KEY Fallback
 *
 * Verifies:
 * 1. GEMINI_API_KEY Fallback & Key Rotation Precedence (process.env.GEMINI_API_KEY vs GEMINI_KEY_*)
 * 2. getGoogleModel initialization with rotated key
 * 3. executeStructuredGeneration with Vercel AI SDK v7 generateText + Output.object
 * 4. executeToolAgentGeneration with generateText + stopWhen: stepCountIs(...)
 * 5. executeStreamingGeneration with streamText and onFinish/onError lifecycle hooks
 * 6. Edge cases: AbortSignal handling, CircuitBreaker protection, 429 rotation retry,
 *    503 overload non-retryable isolation, and max retries exhaustion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

// =========================================================================
// System Boundary Mocks (Redis, AI SDK, Google Provider)
// =========================================================================
const {
  mockStore,
  mockRedis,
  MOCK_REDIS_KEYS,
  resetRedisMocks,
  mockGenerateText,
  mockStreamText,
  mockCreateGoogleGenerativeAI,
  mockOutput,
  mockStepCountIs,
} = vi.hoisted(() => {
  const mockStore: Map<string, unknown> = new Map();
  const mockExpires: Map<string, number> = new Map();

  const defaultTtlImpl = async (key: string) => mockExpires.get(key) ?? -1;
  const defaultGetImpl = async (key: string) => mockStore.get(key) ?? null;
  const defaultSetImpl = async (
    key: string,
    value: unknown,
    options?: { nx?: boolean; ex?: number }
  ) => {
    if (options?.nx && mockStore.has(key)) {
      return null;
    }
    mockStore.set(key, value);
    if (options?.ex) {
      mockExpires.set(key, options.ex);
    }
    return "OK";
  };
  const defaultDelImpl = async (key: string) => {
    mockStore.delete(key);
    mockExpires.delete(key);
    return 1;
  };
  const defaultIncrImpl = async (key: string) => {
    const current = (mockStore.get(key) as number) ?? 0;
    const newValue = current + 1;
    mockStore.set(key, newValue);
    return newValue;
  };
  const defaultExpireImpl = async (key: string, seconds: number) => {
    mockExpires.set(key, seconds);
    return 1;
  };

  const mockRedis = {
    get: vi.fn(defaultGetImpl),
    set: vi.fn(defaultSetImpl),
    del: vi.fn(defaultDelImpl),
    incr: vi.fn(defaultIncrImpl),
    expire: vi.fn(defaultExpireImpl),
    ttl: vi.fn(defaultTtlImpl),
  };

  const MOCK_REDIS_KEYS = {
    CURRENT_KEY_INDEX: "gemini:current_key_index",
    USAGE_COUNT_PREFIX: "gemini:usage_count:",
  };

  const mockGenerateText = vi.fn();
  const mockStreamText = vi.fn();
  const mockCreateGoogleGenerativeAI = vi.fn((config: { apiKey: string }) => {
    return (modelId: string) => ({
      modelId,
      apiKey: config.apiKey,
    });
  });
  const mockOutput = {
    object: vi.fn(({ schema }: { schema: any }) => ({ type: "object", schema })),
  };
  const mockStepCountIs = vi.fn((count: number) => ({ type: "stepCountIs", count }));

  const resetRedisMocks = () => {
    mockStore.clear();
    mockExpires.clear();
    vi.clearAllMocks();
    mockRedis.get.mockImplementation(defaultGetImpl);
    mockRedis.set.mockImplementation(defaultSetImpl);
    mockRedis.del.mockImplementation(defaultDelImpl);
    mockRedis.incr.mockImplementation(defaultIncrImpl);
    mockRedis.expire.mockImplementation(defaultExpireImpl);
    mockRedis.ttl.mockImplementation(defaultTtlImpl);
  };

  return {
    mockStore,
    mockExpires,
    mockRedis,
    MOCK_REDIS_KEYS,
    resetRedisMocks,
    mockGenerateText,
    mockStreamText,
    mockCreateGoogleGenerativeAI,
    mockOutput,
    mockStepCountIs,
  };
});

vi.mock("@/lib/redis", () => ({
  redis: mockRedis,
  REDIS_KEYS: MOCK_REDIS_KEYS,
  isRedisConfigured: () => true,
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: mockGenerateText,
    streamText: mockStreamText,
    Output: mockOutput,
    stepCountIs: mockStepCountIs,
  };
});

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: mockCreateGoogleGenerativeAI,
}));

// Import modules under test after mocks
import {
  getApiKeys,
  getApiKeyForRequest,
  tripModelCircuit,
} from "@/lib/ai/key-rotation";
import {
  getGoogleModel,
  executeStructuredGeneration,
  executeToolAgentGeneration,
  executeStreamingGeneration,
  CircuitBreakerOpenError,
} from "@/lib/ai/client";

describe("Modern AI SDK v7 Gateway & GEMINI_API_KEY Fallback", () => {
  beforeEach(() => {
    resetRedisMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // 1. GEMINI_API_KEY Fallback & Key Precedence
  // =========================================================================
  describe("1. GEMINI_API_KEY Fallback & Key Resolution", () => {
    it("should fallback to GEMINI_API_KEY when no indexed GEMINI_KEY_* exist", () => {
      // Clear indexed keys
      for (let i = 1; i <= 20; i++) {
        vi.stubEnv(`GEMINI_KEY_${i}`, "");
      }
      vi.stubEnv("GEMINI_API_KEY", "fallback-key-secret-123");

      const keys = getApiKeys();
      expect(keys).toEqual(["fallback-key-secret-123"]);
    });

    it("should strip double and single quotes from GEMINI_API_KEY fallback", () => {
      for (let i = 1; i <= 20; i++) {
        vi.stubEnv(`GEMINI_KEY_${i}`, "");
      }
      vi.stubEnv("GEMINI_API_KEY", '"quoted-api-key-456"');

      const keys = getApiKeys();
      expect(keys).toEqual(["quoted-api-key-456"]);

      vi.stubEnv("GEMINI_API_KEY", "'single-quoted-key-789'");
      expect(getApiKeys()).toEqual(["single-quoted-key-789"]);
    });

    it("should ignore placeholder values in GEMINI_API_KEY", () => {
      for (let i = 1; i <= 20; i++) {
        vi.stubEnv(`GEMINI_KEY_${i}`, "");
      }

      vi.stubEnv("GEMINI_API_KEY", "AIzaSy...example");
      expect(getApiKeys()).toEqual([]);

      vi.stubEnv("GEMINI_API_KEY", "CHANGE_ME_NOW");
      expect(getApiKeys()).toEqual([]);

      vi.stubEnv("GEMINI_API_KEY", "   ");
      expect(getApiKeys()).toEqual([]);
    });

    it("should prioritize indexed GEMINI_KEY_* over GEMINI_API_KEY when indexed keys exist", () => {
      vi.stubEnv("GEMINI_KEY_1", "indexed-key-primary");
      vi.stubEnv("GEMINI_API_KEY", "fallback-key-should-be-ignored");

      const keys = getApiKeys();
      expect(keys).toEqual(["indexed-key-primary"]);
      expect(keys).not.toContain("fallback-key-should-be-ignored");
    });

    it("should allow passing modelName parameter to getApiKeyForRequest", async () => {
      vi.stubEnv("GEMINI_KEY_1", "test-key-for-request");
      const keyInfo = await getApiKeyForRequest("gemini-2.5-pro");
      expect(keyInfo.key).toBe("test-key-for-request");
      expect(keyInfo.index).toBe(0);
    });
  });

  // =========================================================================
  // 2. getGoogleModel Helper
  // =========================================================================
  describe("2. getGoogleModel Model Instantiation", () => {
    it("should initialize Google provider with rotated key and return model instance", async () => {
      vi.stubEnv("GEMINI_KEY_1", "model-test-key-1");
      const result = await getGoogleModel("gemini-2.5-pro");

      expect(result.provider).toBeDefined();
      expect(result.modelInstance).toBeDefined();
      expect(result.keyIndex).toBe(0);
      expect(result.keyInfo.key).toBe("model-test-key-1");
      expect(mockCreateGoogleGenerativeAI).toHaveBeenCalledWith({
        apiKey: "model-test-key-1",
      });
    });

    it("should reuse existingKeyInfo when provided without calling getApiKeyForRequest", async () => {
      vi.stubEnv("GEMINI_KEY_1", "key-1");
      vi.stubEnv("GEMINI_KEY_2", "key-2");

      const existingKey = { key: "reused-key-explicit", index: 1, usageCount: 5 };
      const result = await getGoogleModel("gemini-2.5-flash", existingKey);

      expect(result.keyIndex).toBe(1);
      expect(result.keyInfo.key).toBe("reused-key-explicit");
      expect(mockCreateGoogleGenerativeAI).toHaveBeenCalledWith({
        apiKey: "reused-key-explicit",
      });
    });
  });

  // =========================================================================
  // 3. executeStructuredGeneration (AI SDK v7 generateText + Output.object)
  // =========================================================================
  describe("3. executeStructuredGeneration", () => {
    const TestSchema = z.object({
      summary: z.string(),
      confidence: z.number(),
    });

    beforeEach(() => {
      vi.stubEnv("GEMINI_KEY_1", "key-struct-1");
      vi.stubEnv("GEMINI_KEY_2", "key-struct-2");
    });

    it("should throw AbortError immediately when signal is pre-aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        executeStructuredGeneration({
          modelId: "gemini-2.5-pro",
          schema: TestSchema,
          prompt: "Analyze architecture",
          abortSignal: controller.signal,
        })
      ).rejects.toThrow("The operation was aborted");

      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("should throw CircuitBreakerOpenError when circuit state is open", async () => {
      // Simulate open circuit breaker using authoritative helper
      await tripModelCircuit("gemini-2.5-pro");

      await expect(
        executeStructuredGeneration({
          modelId: "gemini-2.5-pro",
          schema: TestSchema,
          prompt: "Analyze architecture",
        })
      ).rejects.toThrow(CircuitBreakerOpenError);

      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("should execute structured generation successfully using Output.object and record usage", async () => {
      const mockOutputData = {
        summary: "Architecture is modular and robust",
        confidence: 0.98,
      };

      mockGenerateText.mockResolvedValueOnce({
        output: mockOutputData,
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          totalTokens: 165,
        },
        finishReason: "stop",
      });

      const response = await executeStructuredGeneration({
        modelId: "gemini-2.5-pro",
        schema: TestSchema,
        prompt: "Analyze modularity",
        system: "You are a senior system architect",
      });

      expect(response.object).toEqual(mockOutputData);
      expect(response.usage).toEqual({
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
      });
      expect(response.finishReason).toBe("stop");
      expect(response.modelId).toBe("gemini-2.5-pro");

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockOutput.object).toHaveBeenCalledWith({ schema: TestSchema });

      // Verifying usage was confirmed in Redis
      expect(mockStore.get("gemini:usage_count:0")).toBe(1);
    });

    it("should rotate key and retry when encountering 429 quota exhaustion error", async () => {
      const quotaError = new Error("Resource has been exhausted (e.g. check quota).");
      (quotaError as any).status = 429;

      const successfulOutput = {
        summary: "Recovered successfully on rotated key",
        confidence: 0.99,
      };

      // First call fails with 429, second call succeeds
      mockGenerateText
        .mockRejectedValueOnce(quotaError)
        .mockResolvedValueOnce({
          output: successfulOutput,
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
          finishReason: "stop",
        });

      const response = await executeStructuredGeneration({
        modelId: "gemini-2.5-pro",
        schema: TestSchema,
        prompt: "Check resilience",
        maxRetries: 3,
      });

      expect(response.object).toEqual(successfulOutput);
      expect(mockGenerateText).toHaveBeenCalledTimes(2);

      // Usage must be confirmed on rotated key index 1
      expect(mockStore.get("gemini:usage_count:1")).toBe(1);
    });

    it("should rotate key and retry when encountering 400 invalid API key error", async () => {
      const invalidKeyError = new Error("API_KEY_INVALID: Key not valid");
      (invalidKeyError as any).status = 400;

      const successfulOutput = {
        summary: "Succeeded on valid key",
        confidence: 0.95,
      };

      mockGenerateText
        .mockRejectedValueOnce(invalidKeyError)
        .mockResolvedValueOnce({
          output: successfulOutput,
          usage: { inputTokens: 40, outputTokens: 15, totalTokens: 55 },
          finishReason: "stop",
        });

      const response = await executeStructuredGeneration({
        modelId: "gemini-2.5-pro",
        schema: TestSchema,
        prompt: "Check API key rotation",
      });

      expect(response.object).toEqual(successfulOutput);
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
    });

    it("should throw immediately and record failure without rotating on non-retryable 503 overload", async () => {
      const overloadError = new Error("503 Model is overloaded");
      (overloadError as any).status = 503;

      mockGenerateText.mockRejectedValueOnce(overloadError);

      await expect(
        executeStructuredGeneration({
          modelId: "gemini-2.5-pro",
          schema: TestSchema,
          prompt: "Test overload handling",
        })
      ).rejects.toThrow(/503/);

      // Only 1 attempt because 503 is an infrastructure overload, not a key quota issue
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      // Model failure count recorded
      expect(mockStore.get("gemini:model_failures:gemini-2.5-pro")).toBe(1);
    });

    it("should fail and record circuit failure when max retries are exhausted", async () => {
      vi.stubEnv("GEMINI_KEY_3", "key-struct-3");
      const quotaError = new Error("Quota exceeded 429");
      (quotaError as any).status = 429;

      mockGenerateText.mockRejectedValue(quotaError);

      await expect(
        executeStructuredGeneration({
          modelId: "gemini-2.5-pro",
          schema: TestSchema,
          prompt: "Exhaust retries",
          maxRetries: 2,
        })
      ).rejects.toThrow("Quota exceeded 429");

      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      expect(mockStore.get("gemini:model_failures:gemini-2.5-pro")).toBe(1);
    });
  });

  // =========================================================================
  // 4. executeToolAgentGeneration (AI SDK v7 generateText + stopWhen: stepCountIs)
  // =========================================================================
  describe("4. executeToolAgentGeneration", () => {
    beforeEach(() => {
      vi.stubEnv("GEMINI_KEY_1", "key-tool-1");
      vi.stubEnv("GEMINI_KEY_2", "key-tool-2");
    });

    it("should abort immediately when AbortSignal is pre-triggered", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        executeToolAgentGeneration({
          modelId: "gemini-2.5-pro",
          tools: {},
          prompt: "Run agent task",
          abortSignal: controller.signal,
        })
      ).rejects.toThrow("The operation was aborted");

      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("should execute multi-step tool-calling agent with stepCountIs and return aggregated results", async () => {
      const mockResult = {
        text: "The final answer after tool invocations",
        toolCalls: [
          {
            toolName: "searchDoc",
            args: { query: "taxonomy" },
          },
        ],
        toolResults: [
          {
            toolName: "searchDoc",
            result: { found: true },
          },
        ],
        steps: [
          { stepType: "tool-call", text: "" },
          { stepType: "tool-result", text: "The final answer after tool invocations" },
        ],
        usage: { inputTokens: 300, outputTokens: 150, totalTokens: 450 },
        finishReason: "stop",
      };

      mockGenerateText.mockResolvedValueOnce(mockResult);

      const response = await executeToolAgentGeneration({
        modelId: "gemini-2.5-pro",
        tools: {
          searchDoc: {
            description: "Search documents",
            parameters: z.object({ query: z.string() }),
            execute: async () => ({ found: true }),
          } as any,
        },
        prompt: "Find taxonomy docs",
        maxSteps: 4,
      });

      expect(response.text).toBe("The final answer after tool invocations");
      expect(response.toolCalls.length).toBe(1);
      expect(response.toolResults.length).toBe(1);
      expect(response.steps.length).toBe(2);
      expect(response.usage.totalTokens).toBe(450);
      expect(response.modelId).toBe("gemini-2.5-pro");

      expect(mockStepCountIs).toHaveBeenCalledWith(4);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockStore.get("gemini:usage_count:0")).toBe(1);
    });

    it("should rotate key and retry tool generation when encountering retryable quota error", async () => {
      const quotaError = new Error("RESOURCE_EXHAUSTED 429");
      (quotaError as any).status = 429;

      mockGenerateText
        .mockRejectedValueOnce(quotaError)
        .mockResolvedValueOnce({
          text: "Tool agent succeeded on rotated key",
          toolCalls: [],
          toolResults: [],
          steps: [],
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          finishReason: "stop",
        });

      const response = await executeToolAgentGeneration({
        modelId: "gemini-2.5-pro",
        tools: {},
        prompt: "Resilient tool call",
      });

      expect(response.text).toBe("Tool agent succeeded on rotated key");
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      expect(mockStore.get("gemini:usage_count:1")).toBe(1);
    });
  });

  // =========================================================================
  // 5. executeStreamingGeneration (AI SDK v7 streamText + onFinish/onError)
  // =========================================================================
  describe("5. executeStreamingGeneration", () => {
    beforeEach(() => {
      vi.stubEnv("GEMINI_KEY_1", "key-stream-1");
    });

    it("should abort before initialization when AbortSignal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        executeStreamingGeneration({
          modelId: "gemini-2.5-pro",
          prompt: "Stream response",
          abortSignal: controller.signal,
        })
      ).rejects.toThrow("Stream aborted before initialization");

      expect(mockStreamText).not.toHaveBeenCalled();
    });

    it("should initialize streamText and trigger onFinish to confirm usage", async () => {
      let capturedOnFinish: (() => Promise<void>) | undefined;

      mockStreamText.mockImplementationOnce((config: any) => {
        capturedOnFinish = config.onFinish;
        return {
          textStream: (async function* () {
            yield "Hello ";
            yield "world!";
          })(),
        };
      });

      const streamResult = await executeStreamingGeneration({
        modelId: "gemini-2.5-pro",
        prompt: "Say hello",
        system: "Greeting bot",
      });

      expect(streamResult).toBeDefined();
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Say hello",
          system: "Greeting bot",
        })
      );

      // Trigger the captured onFinish hook
      expect(capturedOnFinish).toBeDefined();
      await capturedOnFinish!();

      // Usage confirmed on key index 0
      expect(mockStore.get("gemini:usage_count:0")).toBe(1);
      // Circuit success recorded
      expect(mockStore.get("gemini:circuit:gemini-2.5-pro:failures")).toBeUndefined();
    });

    it("should trigger onError hook and record model failure on 503 overload error during streaming", async () => {
      let capturedOnError: (({ error }: { error: any }) => Promise<void>) | undefined;

      mockStreamText.mockImplementationOnce((config: any) => {
        capturedOnError = config.onError;
        return {};
      });

      await executeStreamingGeneration({
        modelId: "gemini-2.5-pro",
        prompt: "Overload test",
      });

      expect(capturedOnError).toBeDefined();

      const overloadErr = new Error("503 Service Unavailable");
      (overloadErr as any).status = 503;

      await capturedOnError!({ error: overloadErr });
      // Allow microtask tick for fire-and-forget recordModelFailure
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Model failure count recorded
      expect(mockStore.get("gemini:model_failures:gemini-2.5-pro")).toBe(1);
    });

    it("should reject with CircuitBreakerOpenError when circuit is open", async () => {
      await tripModelCircuit("gemini-2.5-pro");

      await expect(
        executeStreamingGeneration({
          modelId: "gemini-2.5-pro",
          prompt: "Should fail fast",
        })
      ).rejects.toThrow(CircuitBreakerOpenError);

      expect(mockStreamText).not.toHaveBeenCalled();
    });
  });
});
