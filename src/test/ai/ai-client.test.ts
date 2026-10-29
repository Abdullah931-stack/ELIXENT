import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =========================================================================
// Mock Setup using vi.hoisted for Redis and Gemini SDK boundaries
// =========================================================================
const { mockStore, mockRedis, resetRedisMocks, sdkMocks } = vi.hoisted(() => {
    const mockStore: Map<string, unknown> = new Map();
    const mockExpires: Map<string, number> = new Map();

    const defaultTtlImpl = async (key: string) => mockExpires.get(key) ?? -1;
    const defaultGetImpl = async (key: string) => mockStore.get(key) ?? null;
    const defaultSetImpl = async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
        if (options?.nx && mockStore.has(key)) {
            return null; // Atomic NX semantics: cannot set if key exists
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

    const generateContent = vi.fn();
    const generateContentStream = vi.fn();
    const getGenerativeModel = vi.fn(() => ({
        generateContent,
        generateContentStream,
    }));

    class MockGoogleGenerativeAI {
        constructor(_apiKey: string) { }
        getGenerativeModel = getGenerativeModel;
    }

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
            generateContent,
            generateContentStream,
            getGenerativeModel,
            MockGoogleGenerativeAI,
        },
    };
});

// Mock the Redis boundary
vi.mock('@/lib/redis', () => ({
    redis: mockRedis,
    REDIS_KEYS: {
        CURRENT_KEY_INDEX: 'gemini:current_key_index',
        USAGE_COUNT_PREFIX: 'gemini:usage_count:',
    },
}));

// Mock the Gemini SDK boundary
vi.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: sdkMocks.MockGoogleGenerativeAI,
}));

// Real client import (runs against real key-rotation logic)
import { processWithAI, streamWithAI, getModelPair, getModelHierarchy, MODEL_CONFIG } from '@/lib/ai/client';

describe('AI Client (Robust & Fault-Tolerant Execution)', () => {
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
    // getModelPair Tests
    // =========================================================================
    describe('getModelPair & getModelHierarchy', () => {
        it('should return primary and fallback for correct operation', () => {
            const pair = getModelPair('correct', 'free');
            expect(pair.primary).toBe(MODEL_CONFIG.correct.free);
            expect(pair.fallback).toBe(MODEL_CONFIG.correct.fallback.free);
        });

        it('should return full cascading fallback chain in getModelHierarchy', () => {
            const hierarchy = getModelHierarchy('correct', 'free');
            expect(hierarchy.primary).toBe('gemini-3.8-flash');
            expect(hierarchy.fallbacks).toEqual([
                'gemini-3.6-flash',
                'gemini-3.5-flash-lite',
                'gemini-3.1-flash-lite',
            ]);
        });

        it('should return null primary and fallback for toPrompt free tier', () => {
            const pair = getModelPair('toPrompt', 'free');
            expect(pair.primary).toBeNull();
            expect(pair.fallback).toBeNull();
        });
    });

    // =========================================================================
    // processWithAI Tests
    // =========================================================================
    describe('processWithAI', () => {
        it('should process text successfully and confirm usage', async () => {
            const mockResponse = { text: () => 'Processed text' };
            sdkMocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Processed text');
            expect(mockStore.get('gemini:usage_count:0')).toBe(1);
        });

        it('should fast-path to fallback model when circuit is OPEN', async () => {
            mockStore.set(`gemini:circuit_breaker:${MODEL_CONFIG.correct.free}`, 'open');
            const mockResponse = { text: () => 'Fallback text' };
            sdkMocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Fallback text');
            expect(sdkMocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should allow single probe on primary model during HALF-OPEN state', async () => {
            mockStore.set(`gemini:model_failures:${MODEL_CONFIG.correct.free}`, 2);
            const mockResponse = { text: () => 'Primary probe success' };
            sdkMocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Primary probe success');
            expect(sdkMocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.free })
            );
            expect(mockStore.has(`gemini:model_failures:${MODEL_CONFIG.correct.free}`)).toBe(false);
        });

        it('should route to fallback model during HALF-OPEN state when probe is already in flight', async () => {
            mockStore.set(`gemini:model_failures:${MODEL_CONFIG.correct.free}`, 2);
            mockStore.set(`gemini:circuit_probe:${MODEL_CONFIG.correct.free}`, 'probing');
            const mockResponse = { text: () => 'Fallback concurrent result' };
            sdkMocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Fallback concurrent result');
            expect(sdkMocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should immediately failover to fallback model on 503 overload in same call', async () => {
            const error503 = new Error('503 Service Unavailable: The model is overloaded');
            sdkMocks.generateContent
                .mockRejectedValueOnce(error503)
                .mockResolvedValueOnce({ response: { text: () => 'Recovered via fallback' } });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Recovered via fallback');
            expect(mockStore.get(`gemini:model_failures:${MODEL_CONFIG.correct.free}`)).toBe(1);
            expect(sdkMocks.getGenerativeModel).toHaveBeenLastCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should cascade through secondary fallback when primary and first fallback return 503', async () => {
            const error503 = new Error('503 Service Unavailable: Model is overloaded');
            sdkMocks.generateContent
                .mockRejectedValueOnce(error503)
                .mockRejectedValueOnce(error503)
                .mockResolvedValueOnce({ response: { text: () => 'Recovered via secondary fallback' } });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Recovered via secondary fallback');
            expect(sdkMocks.getGenerativeModel).toHaveBeenLastCalledWith(
                expect.objectContaining({ model: 'gemini-3.5-flash-lite' })
            );
        });

        it('should fail fast on 400 Bad Request without rotating keys or retrying', async () => {
            const error400 = new Error('400 Bad Request: Invalid argument');
            sdkMocks.generateContent.mockRejectedValue(error400);

            await expect(processWithAI('correct', 'Test input', 'free')).rejects.toThrow('400 Bad Request');

            expect(mockStore.get('gemini:current_key_index')).toBeUndefined();
            expect(mockStore.get('gemini:usage_count:test-api-key-1')).toBeUndefined();
        });

        it('should propagate AbortSignal cancellation cleanly', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(processWithAI('correct', 'Test input', 'free', controller.signal)).rejects.toThrow('The operation was aborted');
            expect(sdkMocks.getGenerativeModel).not.toHaveBeenCalled();
        });

        it('should retry with new key on rotatable quota/auth errors', async () => {
            const error429 = new Error('429 Too Many Requests: Resource has been exhausted');
            sdkMocks.generateContent
                .mockRejectedValueOnce(error429)
                .mockResolvedValueOnce({ response: { text: () => 'Rotated Success' } });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Rotated Success');
            expect(mockStore.get('gemini:current_key_index')).toBe(1);
            expect(mockStore.get('gemini:usage_count:1')).toBe(1);
        });
    });

    // =========================================
    // streamWithAI Tests
    // =========================================
    describe('streamWithAI', () => {
        function createMockStream(chunks: string[]) {
            return {
                stream: (async function* () {
                    for (const chunk of chunks) {
                        yield { text: () => chunk };
                    }
                })(),
                response: Promise.resolve({ candidates: [] }),
            };
        }

        it('should return a ReadableStream on success', async () => {
            sdkMocks.generateContentStream.mockResolvedValue(createMockStream(['Hello', ' World']));

            const stream = await streamWithAI('correct', 'Test input', 'free');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mockStore.get('gemini:usage_count:0')).toBe(1);
        });

        it('should stream text chunks correctly', async () => {
            const chunks = ['Hello', ' ', 'World', '!'];
            sdkMocks.generateContentStream.mockResolvedValue(createMockStream(chunks));

            const stream = await streamWithAI('correct', 'Test input', 'free');
            const reader = stream.getReader();
            const decoder = new TextDecoder();

            let result = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                result += decoder.decode(value);
            }

            expect(result).toBe('Hello World!');
        });

        it('should fail fast on 400 Bad Request during stream startup', async () => {
            const error400 = new Error('400 Bad Request: Invalid request');
            sdkMocks.generateContentStream.mockRejectedValue(error400);

            await expect(streamWithAI('correct', 'Test input', 'free')).rejects.toThrow('400 Bad Request');
            expect(mockStore.get('gemini:current_key_index')).toBeUndefined();
        });

        it('should failover stream immediately on 503 error in same request', async () => {
            const error503 = new Error('503 Service Unavailable: Model overloaded');
            sdkMocks.generateContentStream
                .mockRejectedValueOnce(error503)
                .mockResolvedValueOnce(createMockStream(['Stream recovered']));

            const stream = await streamWithAI('correct', 'Test input', 'free');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mockStore.get(`gemini:model_failures:${MODEL_CONFIG.correct.free}`)).toBe(1);
            expect(sdkMocks.getGenerativeModel).toHaveBeenLastCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should cascade stream through secondary fallback when primary and first fallback return 503', async () => {
            const error503 = new Error('503 Service Unavailable: Model overloaded');
            sdkMocks.generateContentStream
                .mockRejectedValueOnce(error503)
                .mockRejectedValueOnce(error503)
                .mockResolvedValueOnce(createMockStream(['Stream recovered via secondary fallback']));

            const stream = await streamWithAI('correct', 'Test input', 'free');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(sdkMocks.getGenerativeModel).toHaveBeenLastCalledWith(
                expect.objectContaining({ model: 'gemini-3.5-flash-lite' })
            );
        });

        it('should abort stream cleanly if AbortSignal triggers before start', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(streamWithAI('correct', 'Test input', 'free', controller.signal)).rejects.toThrow('Stream aborted before initialization');
        });

        it('forwards the downstream AbortSignal into generateContentStream request options', async () => {
            const controller = new AbortController();
            sdkMocks.generateContentStream.mockResolvedValueOnce({
                stream: (async function* () {
                    yield { text: () => 'chunk-1' };
                })(),
                response: Promise.resolve({ candidates: [] }),
            });

            const stream = await streamWithAI('correct', 'input text', 'free', controller.signal);

            const reader = stream.getReader();
            while (!(await reader.read()).done) {
                /* drain */
            }

            expect(sdkMocks.generateContentStream).toHaveBeenCalledWith(
                expect.anything(),
                { signal: controller.signal }
            );
        });
    });

    // =========================================
    // Generation Config Tests
    // =========================================
    describe('Generation Config', () => {
        function createMockStream() {
            return {
                stream: (async function* () {
                    yield { text: () => 'Result' };
                })(),
                response: Promise.resolve({ candidates: [] }),
            };
        }

        it('should include thinking config for toPrompt Ultra tier', async () => {
            sdkMocks.generateContentStream.mockResolvedValue(createMockStream());

            await streamWithAI('toPrompt', 'Test', 'ultra');

            expect(sdkMocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({
                    generationConfig: expect.objectContaining({
                        thinkingConfig: expect.objectContaining({
                            thinkingBudget: 8192,
                        }),
                    }),
                })
            );
        });
    });
});
