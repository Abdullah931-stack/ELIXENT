import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import modelsConfig from '@/config/models.config.json';

// =========================================================================
// Mock Setup using vi.hoisted for Redis and Vercel AI SDK v7 boundaries
// =========================================================================
const { mockStore, mockRedis, resetRedisMocks, sdkMocks } = vi.hoisted(() => {
    const mockStore: Map<string, unknown> = new Map();
    const mockExpires: Map<string, number> = new Map();

    const defaultTtlImpl = async (key: string) => mockExpires.get(key) ?? -1;
    const defaultGetImpl = async (key: string) => mockStore.get(key) ?? null;
    const defaultSetImpl = async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
        if (options?.nx && mockStore.has(key)) {
            return null;
        }
        mockStore.set(key, value);
        if (options?.ex) {
            mockExpires.set(key, options.ex);
        }
        return 'OK';
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

    const generateTextMock = vi.fn();
    const streamTextMock = vi.fn();
    const outputObjectMock = vi.fn((opts: unknown) => ({ type: 'object', ...(opts as object) }));
    const stepCountIsMock = vi.fn((count: number) => ({ type: 'stepCount', count }));
    const createGoogleGenerativeAIMock = vi.fn(({ apiKey }: { apiKey: string }) => {
        const providerFn = vi.fn((modelId: string) => ({
            provider: 'google',
            modelId,
            apiKey,
        }));
        return providerFn;
    });

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
        resetRedisMocks,
        sdkMocks: {
            generateTextMock,
            streamTextMock,
            outputObjectMock,
            stepCountIsMock,
            createGoogleGenerativeAIMock,
        },
    };
});

vi.mock('@/lib/redis', () => ({
    redis: mockRedis,
    REDIS_KEYS: {
        CURRENT_KEY_INDEX: 'gemini:current_key_index',
        USAGE_COUNT_PREFIX: 'gemini:usage_count:',
    },
}));

vi.mock('ai', () => ({
    generateText: sdkMocks.generateTextMock,
    streamText: sdkMocks.streamTextMock,
    Output: {
        object: sdkMocks.outputObjectMock,
    },
    stepCountIs: sdkMocks.stepCountIsMock,
}));

vi.mock('@ai-sdk/google', () => ({
    createGoogleGenerativeAI: sdkMocks.createGoogleGenerativeAIMock,
}));

import {
    getGoogleModel,
    executeStructuredGeneration,
    executeToolAgentGeneration,
    executeStreamingGeneration,
    CircuitBreakerOpenError,
    ROTATION_ERROR_CODES,
} from '@/lib/ai/client';

describe('AI Client (Vercel AI SDK v7 Gateway & Model Registry)', () => {
    beforeEach(() => {
        resetRedisMocks();
        for (let i = 1; i <= 20; i++) {
            vi.stubEnv(`GEMINI_KEY_${i}`, i <= 3 ? `test-api-key-${i}` : '');
        }
        vi.stubEnv('GEMINI_REQUESTS_PER_KEY', '20');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // =========================================================================
    // Model Registry (`models.config.json`) Contract Tests
    // =========================================================================
    describe('Model Registry (models.config.json)', () => {
        it('defines all canonical Elixent execution models with valid executionMode and credit rates', () => {
            const models = modelsConfig.models;
            expect(models['openai/gpt-6-luna-decisions'].executionMode).toBe('SINGLE_PASS_DECISION');
            expect(models['microsoft/decision-1'].executionMode).toBe('SINGLE_PASS_DECISION');
            expect(models['typesafe/jev-1.13'].executionMode).toBe('SINGLE_PASS_DECISION');
            expect(models['fastino/glide'].executionMode).toBe('DISCRETE_THINKING');
            expect(models['google/gemini-4-argon'].executionMode).toBe('STREAMING_GENERATIVE');
            expect(models['google/gemini-3.8-flash'].executionMode).toBe('STREAMING_GENERATIVE');
            expect(models['google/gemini-3.1-pro'].executionMode).toBe('STREAMING_GENERATIVE');

            for (const entry of Object.values(models)) {
                expect(entry.modelId).toBeTruthy();
                expect(entry.creditsPer1kInput).toBeGreaterThanOrEqual(0);
                expect(entry.creditsPer1kCacheRead).toBeGreaterThanOrEqual(0);
                expect(entry.creditsPer1kOutput).toBeGreaterThanOrEqual(0);
            }
        });

        it('exports ROTATION_ERROR_CODES for quota and auth failover', () => {
            expect(ROTATION_ERROR_CODES).toContain(429);
            expect(ROTATION_ERROR_CODES).toContain(401);
            expect(ROTATION_ERROR_CODES).toContain(403);
        });
    });

    // =========================================================================
    // getGoogleModel Tests
    // =========================================================================
    describe('getGoogleModel', () => {
        it('initializes Google Generative AI provider with rotated API key from pool', async () => {
            const { modelInstance, keyIndex, keyInfo } = await getGoogleModel('gemini-3.8-flash');

            expect(keyIndex).toBe(0);
            expect(keyInfo.key).toBe('test-api-key-1');
            expect(sdkMocks.createGoogleGenerativeAIMock).toHaveBeenCalledWith({
                apiKey: 'test-api-key-1',
            });
            expect(modelInstance).toEqual(
                expect.objectContaining({
                    modelId: 'gemini-3.8-flash',
                    apiKey: 'test-api-key-1',
                })
            );
        });
    });

    // =========================================================================
    // executeStructuredGeneration Tests
    // =========================================================================
    describe('executeStructuredGeneration', () => {
        const testSchema = z.object({
            intent: z.enum(['edit', 'chat']),
            confidence: z.number(),
        });

        it('executes structured generation via Output.object and confirms key usage', async () => {
            sdkMocks.generateTextMock.mockResolvedValueOnce({
                output: { intent: 'edit', confidence: 0.98 },
                usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
                finishReason: 'stop',
            });

            const res = await executeStructuredGeneration({
                modelId: 'gemini-3.8-flash',
                schema: testSchema,
                prompt: 'Classify user request',
                system: 'Classifier',
            });

            expect(res.object).toEqual({ intent: 'edit', confidence: 0.98 });
            expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
            expect(res.modelId).toBe('gemini-3.8-flash');
            expect(mockStore.get('gemini:usage_count:0')).toBe(1);
        });

        it('throws CircuitBreakerOpenError immediately when model circuit is open', async () => {
            mockStore.set('gemini:circuit_breaker:gemini-3.8-flash', 'open');

            await expect(
                executeStructuredGeneration({
                    modelId: 'gemini-3.8-flash',
                    schema: testSchema,
                    prompt: 'Classify',
                })
            ).rejects.toThrow(CircuitBreakerOpenError);

            expect(sdkMocks.generateTextMock).not.toHaveBeenCalled();
        });

        it('rotates API key on 429 quota exhaustion and succeeds on retry', async () => {
            const error429 = new Error('429 Too Many Requests: Resource has been exhausted');
            sdkMocks.generateTextMock
                .mockRejectedValueOnce(error429)
                .mockResolvedValueOnce({
                    output: { intent: 'chat', confidence: 0.91 },
                    usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
                    finishReason: 'stop',
                });

            const res = await executeStructuredGeneration({
                modelId: 'gemini-3.8-flash',
                schema: testSchema,
                prompt: 'Hello',
            });

            expect(res.object.intent).toBe('chat');
            expect(mockStore.get('gemini:current_key_index')).toBe(1);
            expect(mockStore.get('gemini:usage_count:1')).toBe(1);
        });

        it('fails fast on 400 Bad Request without rotating keys', async () => {
            const error400 = new Error('400 Bad Request: Invalid argument');
            sdkMocks.generateTextMock.mockRejectedValueOnce(error400);

            await expect(
                executeStructuredGeneration({
                    modelId: 'gemini-3.8-flash',
                    schema: testSchema,
                    prompt: 'Invalid',
                })
            ).rejects.toThrow('400 Bad Request');

            expect(mockStore.get('gemini:current_key_index')).toBeUndefined();
        });

        it('records model failure and rethrows on 503 overload', async () => {
            const error503 = new Error('503 Service Unavailable: The model is overloaded');
            sdkMocks.generateTextMock.mockRejectedValueOnce(error503);

            await expect(
                executeStructuredGeneration({
                    modelId: 'gemini-3.8-flash',
                    schema: testSchema,
                    prompt: 'Overload',
                })
            ).rejects.toThrow('503 Service Unavailable');

            expect(mockStore.get('gemini:model_failures:gemini-3.8-flash')).toBe(1);
        });

        it('propagates AbortSignal cancellation before execution', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                executeStructuredGeneration({
                    modelId: 'gemini-3.8-flash',
                    schema: testSchema,
                    prompt: 'Abort test',
                    abortSignal: controller.signal,
                })
            ).rejects.toThrow('The operation was aborted');
            expect(sdkMocks.generateTextMock).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // executeToolAgentGeneration Tests
    // =========================================================================
    describe('executeToolAgentGeneration', () => {
        const mockTools = {} as ToolSet;

        it('executes multi-step tool agent generation with stepCountIs and confirms usage', async () => {
            sdkMocks.generateTextMock.mockResolvedValueOnce({
                text: 'Completed workspace inspection.',
                toolCalls: [],
                toolResults: [],
                steps: [],
                usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
                finishReason: 'stop',
            });

            const res = await executeToolAgentGeneration({
                modelId: 'gemini-3.1-pro',
                tools: mockTools,
                prompt: 'Inspect files',
                maxSteps: 4,
            });

            expect(res.text).toBe('Completed workspace inspection.');
            expect(res.usage.totalTokens).toBe(280);
            expect(sdkMocks.stepCountIsMock).toHaveBeenCalledWith(4);
            expect(mockStore.get('gemini:usage_count:0')).toBe(1);
        });

        it('allows single probe during half-open circuit state and resets failures on success', async () => {
            mockStore.set('gemini:model_failures:gemini-3.1-pro', 2);
            sdkMocks.generateTextMock.mockResolvedValueOnce({
                text: 'Probe succeeded',
                toolCalls: [],
                toolResults: [],
                steps: [],
                usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
                finishReason: 'stop',
            });

            const res = await executeToolAgentGeneration({
                modelId: 'gemini-3.1-pro',
                tools: mockTools,
                prompt: 'Probe',
            });

            expect(res.text).toBe('Probe succeeded');
            expect(mockStore.has('gemini:model_failures:gemini-3.1-pro')).toBe(false);
        });
    });

    // =========================================================================
    // executeStreamingGeneration Tests
    // =========================================================================
    describe('executeStreamingGeneration', () => {
        it('delegates to streamText and confirms key usage via onFinish callback', async () => {
            let capturedOnFinish: (() => Promise<void>) | undefined;
            sdkMocks.streamTextMock.mockImplementationOnce((opts: { onFinish?: () => Promise<void> }) => {
                capturedOnFinish = opts.onFinish;
                return {
                    textStream: (async function* () {
                        yield 'Hello ';
                        yield 'World';
                    })(),
                };
            });

            const streamResult = await executeStreamingGeneration({
                modelId: 'gemini-3.8-flash',
                prompt: 'Stream test',
                system: 'System prompt',
            });

            expect(streamResult).toBeDefined();
            expect(sdkMocks.streamTextMock).toHaveBeenCalledTimes(1);

            await capturedOnFinish?.();
            expect(mockStore.get('gemini:usage_count:0')).toBe(1);
        });

        it('rejects immediately if AbortSignal is already aborted before stream initialization', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                executeStreamingGeneration({
                    modelId: 'gemini-3.8-flash',
                    prompt: 'Aborted stream',
                    abortSignal: controller.signal,
                })
            ).rejects.toThrow('Stream aborted before initialization');
        });
    });
});
