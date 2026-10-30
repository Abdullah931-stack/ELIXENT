import { GoogleGenerativeAI } from "@google/generative-ai";
import {
    generateText,
    streamText,
    Output,
    stepCountIs,
    type ToolSet,
    type TypedToolCall,
    type TypedToolResult,
    type StepResult,
} from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { z } from "zod";
import {
    getApiKeyForRequest,
    getApiKeys,
    confirmApiKeyUsage,
    forceKeyRotationAndGetKey,
    shouldRotateOnError,
    is503OrOverloadError,
    getModelCircuitState,
    tryAcquireHalfOpenProbe,
    releaseProbeLock,
    recordModelSuccess,
    recordModelFailure,
    classifyGeminiError,
    maskApiKey,
    sanitizeErrorMessage,
    ROTATION_ERROR_CODES,
    KeyInfo,
    CircuitBreakerOpenError,
} from "./key-rotation";
import { AI_PROMPTS, AIOperation } from "./prompts";

import modelsConfig from "@/config/models.config.json";

// Model configurations per operation and tier loaded from central JSON
export const MODEL_CONFIG = modelsConfig;

export type Tier = "free" | "pro" | "ultra";

const ATTEMPT_TIMEOUT_MS = 15000;

/**
 * Creates an attempt AbortSignal that aborts if either:
 * 1. The downstream client signal aborts (user cancellation)
 * 2. The per-attempt watchdog timeout expires (provider stall / 503 hang)
 */
function createAttemptSignal(callerSignal?: AbortSignal, timeoutMs = ATTEMPT_TIMEOUT_MS): {
    attemptSignal: AbortSignal;
    cleanup: () => void;
    didTimeout: () => boolean;
} {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Attempt timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onCallerAbort = () => {
        controller.abort(callerSignal?.reason);
    };

    if (callerSignal) {
        if (callerSignal.aborted) {
            clearTimeout(timer);
            controller.abort(callerSignal.reason);
        } else {
            callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }
    }

    const cleanup = () => {
        clearTimeout(timer);
        if (callerSignal) {
            callerSignal.removeEventListener("abort", onCallerAbort);
        }
    };

    return {
        attemptSignal: controller.signal,
        cleanup,
        didTimeout: () => timedOut && (!callerSignal || !callerSignal.aborted),
    };
}

/**
 * Dynamically resolve maximum retry attempts based on the configured key pool size.
 * Allows larger key pools (e.g. 10-20 keys) to rotate through healthy keys without early abortion.
 */
function getMaxRetryAttempts(): number {
    const keyCount = getApiKeys().length;
    return Math.min(Math.max(6, keyCount), 10);
}

/**
 * Resolve full model hierarchy (primary and ordered fallbacks) for an operation and subscription tier.
 * Declarations are strictly sourced from models.config.json.
 */
export function getModelHierarchy(
    operation: AIOperation,
    tier: Tier
): { primary: string | null; fallbacks: string[] } {
    const config = MODEL_CONFIG[operation];
    if (!config) {
        return { primary: null, fallbacks: [] };
    }

    // Typed projection of the JSON entry: per-tier model ids plus optional
    // fallbacks as per-tier maps, bare identifiers, or fallback arrays.
    type ModelEntry = Partial<Record<Tier, string | null>> & {
        fallback?: Partial<Record<Tier, string | null>> | string;
        secondaryFallback?: Partial<Record<Tier, string | null>> | string;
        tertiaryFallback?: Partial<Record<Tier, string | null>> | string;
        fallbacks?: Partial<Record<Tier, string[]>> | string[];
    };
    const entry = config as unknown as ModelEntry;

    const primary = entry[tier] ?? null;
    const fallbacks: string[] = [];

    const resolveModel = (field: Partial<Record<Tier, string | null>> | string | undefined): string | null => {
        if (!field) return null;
        if (typeof field === "object") return field[tier] ?? null;
        if (typeof field === "string") return field;
        return null;
    };

    const fb1 = resolveModel(entry.fallback);
    if (fb1 && !fallbacks.includes(fb1)) fallbacks.push(fb1);

    const fb2 = resolveModel(entry.secondaryFallback);
    if (fb2 && !fallbacks.includes(fb2)) fallbacks.push(fb2);

    const fb3 = resolveModel(entry.tertiaryFallback);
    if (fb3 && !fallbacks.includes(fb3)) fallbacks.push(fb3);

    if (entry.fallbacks) {
        const list = Array.isArray(entry.fallbacks)
            ? entry.fallbacks
            : (entry.fallbacks[tier] || []);
        for (const m of list) {
            if (m && !fallbacks.includes(m)) fallbacks.push(m);
        }
    }

    return { primary, fallbacks };
}

/**
 * Resolve primary and fallback model names for an operation and subscription tier.
 * Declarations are strictly sourced from models.config.json.
 */
export function getModelPair(
    operation: AIOperation,
    tier: Tier
): { primary: string | null; fallback: string | null } {
    const { primary, fallbacks } = getModelHierarchy(operation, tier);
    return { primary, fallback: fallbacks[0] ?? null };
}

/**
 * Build generation config for a specific operation and tier.
 */
function buildGenerationConfig(
    operation: AIOperation,
    tier: Tier
): Record<string, unknown> {
    const config = MODEL_CONFIG[operation];

    const generationConfig: Record<string, unknown> = {
        temperature: config.temperature,
        topP: config.topP,
    };

    // Add thinking level for ToPrompt operation if applicable
    if (operation === "toPrompt" && "thinkingLevel" in config) {
        const thinkingConfig = config.thinkingLevel as Record<string, string>;
        if (thinkingConfig[tier]) {
            generationConfig.thinkingConfig = {
                thinkingBudget: thinkingConfig[tier] === "high" ? 8192 : 4096,
            };
        }
    }

    return generationConfig;
}

/**
 * Determine the active model to use, factoring in the distributed 3-state Circuit Breaker:
 * - CLOSED: Use primary model.
 * - OPEN: Bypass primary model and use fallback model (Fast-Path).
 * - HALF-OPEN: Only one single probe request is permitted to test primary; others use fallback.
 */
async function selectModelWithCircuitBreaker(
    primary: string | null,
    fallbackInput: string | null | string[]
): Promise<{ selectedModel: string; isProbe: boolean }> {
    const fallbacks: string[] = Array.isArray(fallbackInput)
        ? fallbackInput.filter(Boolean)
        : fallbackInput ? [fallbackInput] : [];

    if (!primary && fallbacks.length === 0) {
        throw new Error("No model configured for this operation and tier");
    }

    const selectHealthyFallback = async (): Promise<string> => {
        for (const fb of fallbacks) {
            const state = await getModelCircuitState(fb);
            if (state !== "open") {
                return fb;
            }
        }
        return fallbacks[0];
    };

    if (!primary) {
        const selected = await selectHealthyFallback();
        return { selectedModel: selected, isProbe: false };
    }

    if (fallbacks.length === 0) {
        // Only primary available - check circuit state
        const circuitState = await getModelCircuitState(primary);
        if (circuitState === "open") {
            throw new CircuitBreakerOpenError(primary);
        }
        return { selectedModel: primary, isProbe: circuitState === "half-open" };
    }

    const circuitState = await getModelCircuitState(primary);

    if (circuitState === "open") {
        const fallback = await selectHealthyFallback();
        console.log(`[Circuit Breaker] Fast-path active: Primary model '${primary}' is OPEN. Using fallback '${fallback}'`);
        return { selectedModel: fallback, isProbe: false };
    }

    if (circuitState === "half-open") {
        const wonProbe = await tryAcquireHalfOpenProbe(primary);
        if (wonProbe) {
            console.log(`[Circuit Breaker] Half-Open Single Probe acquired for primary model '${primary}'`);
            return { selectedModel: primary, isProbe: true };
        } else {
            const fallback = await selectHealthyFallback();
            console.log(`[Circuit Breaker] Half-Open probe in flight: Routing concurrent request to fallback '${fallback}'`);
            return { selectedModel: fallback, isProbe: false };
        }
    }

    // Default CLOSED state
    return { selectedModel: primary, isProbe: false };
}

/**
 * Process text with AI (synchronous complete generation).
 * 
 * Features:
 * - 3-State Distributed Circuit Breaker (Closed, Open, Half-Open Single Probe)
 * - Immediate 503 Failover to secondary fallback model
 * - Automatic Concurrency-Safe Key Rotation & Quota Cooldown in Redis
 * - Strict Data Sanitization (Masked credentials, zero sensitive text logging)
 * - Native AbortSignal Support
 * - Structured Error Classification & Fast-Fail on 400 Bad Request
 * 
 * @param operation - The AI operation to perform
 * @param text - The input text to process
 * @param tier - User's subscription tier
 * @param signal - Optional AbortSignal for request cancellation
 * @returns Processed text
 */
export async function processWithAI(
    operation: AIOperation,
    text: string,
    tier: Tier,
    signal?: AbortSignal
): Promise<string> {
    if (signal?.aborted) {
        const abortErr = new Error("The operation was aborted");
        abortErr.name = "AbortError";
        throw abortErr;
    }

    const { primary, fallbacks } = getModelHierarchy(operation, tier);
    const fallback = fallbacks[0] || null;

    if (!primary && fallbacks.length === 0) {
        throw new Error(`Operation '${operation}' is not available for ${tier} tier`);
    }

    const systemPrompt = AI_PROMPTS[operation];
    const generationConfig = buildGenerationConfig(operation, tier);

    // Initial model selection via Circuit Breaker state
    const { selectedModel: initialModel, isProbe: initialIsProbe } =
        await selectModelWithCircuitBreaker(primary, fallbacks);

    let targetModel = initialModel;
    let isProbe = initialIsProbe;
    const attemptedModels = new Set<string>([targetModel]);
    let retries = getMaxRetryAttempts();
    let lastError: Error | null = null;
    let keyInfo: KeyInfo | null = null;

    while (retries > 0) {
        if (signal?.aborted) {
            if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
            const abortErr = new Error("The operation was aborted");
            abortErr.name = "AbortError";
            throw abortErr;
        }

        const currentModel = targetModel || fallback;
        if (!currentModel) {
            throw new Error(`No available model configured for operation '${operation}' in ${tier} tier`);
        }

        let attemptScope: ReturnType<typeof createAttemptSignal> | null = null;
        try {
            // Get active healthy API key from Redis pool
            keyInfo = keyInfo || (await getApiKeyForRequest());

            // Initialize Gemini client
            const genAI = new GoogleGenerativeAI(keyInfo.key);

            const model = genAI.getGenerativeModel({
                model: currentModel,
                generationConfig,
            });

            // Generate content — propagate the downstream abort signal to the provider
            // HTTP request so cancellation terminates the upstream socket immediately.
            // If caller did not provide an AbortSignal, attach a 15s watchdog to avoid indefinite hangs on upstream 503 stalls.
            let requestSignal: AbortSignal | undefined = signal;
            if (!requestSignal) {
                attemptScope = createAttemptSignal(undefined, ATTEMPT_TIMEOUT_MS);
                requestSignal = attemptScope.attemptSignal;
            }

            let result;
            try {
                result = await model.generateContent(
                    [
                        { text: systemPrompt },
                        { text: text },
                    ],
                    requestSignal ? { signal: requestSignal } : undefined
                );
            } finally {
                attemptScope?.cleanup();
            }

            if (signal?.aborted) {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                const abortErr = new Error("The operation was aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            const response = result.response;
            const processedText = response.text();

            // SUCCESS: Increment the usage counter in Redis
            await confirmApiKeyUsage(keyInfo.index);

            // Record success for the model to reset / close circuit if probing
            if (currentModel === primary) {
                await recordModelSuccess(primary);
            }

            return processedText;

        } catch (error: unknown) {
            const isAttemptTimeout = Boolean(attemptScope?.didTimeout());
            attemptScope?.cleanup();
            lastError = error as Error;

            // Classify error
            const classification = classifyGeminiError(error);

            // 1. User Cancellation -> Fail fast without retrying (only if caller aborted, not attempt timeout)
            if (signal?.aborted || (classification.category === "cancelled" && !isAttemptTimeout)) {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                const abortErr = new Error("The operation was aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            // 2. Non-rotatable Client Error (400 Bad Request, Safety Filter) -> Fail fast
            if (classification.category === "invalid_request") {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                console.warn(`[AI Client] Non-rotatable request error on operation '${operation}':`, classification.reason);
                throw error;
            }

            // 3. Model Overload / 503 / Attempt Timeout -> Failover immediately to next fallback model in chain
            if (
                isAttemptTimeout ||
                classification.category === "overload" ||
                is503OrOverloadError(error)
            ) {
                // Record failure and trip circuit breaker in Redis
                if (targetModel) {
                    recordModelFailure(targetModel).catch(() => {});
                }

                const nextFallback = fallbacks.find((m) => !attemptedModels.has(m));
                if (nextFallback) {
                    console.warn(
                        `[AI Client] Model '${targetModel}' returned 503/Overload. Failing over to fallback '${nextFallback}' in same request...`
                    );
                    targetModel = nextFallback;
                    attemptedModels.add(nextFallback);
                    isProbe = false;
                    continue; // Retry immediately with fallback model
                }

                // If all fallback models in chain have been attempted, do 1 micro-retry with jitter if retries remain
                if (retries > 1 && !signal?.aborted) {
                    const jitterMs = 300 + Math.floor(Math.random() * 400);
                    console.warn(
                        `[AI Client] All models in fallback chain exhausted on 503/Overload. Pausing ${jitterMs}ms for micro-retry...`
                    );
                    await new Promise((resolve) => setTimeout(resolve, jitterMs));
                    retries--;
                    continue;
                }
            }

            // If probe failed on a non-overload error, release lock
            if (isProbe && primary) {
                releaseProbeLock(primary).catch(() => {});
                isProbe = false;
            }

            // 4. Rotatable technical errors (429 Quota, 401 Auth, 500/502/504 Transient)
            if (classification.retryableWithKey || shouldRotateOnError(error)) {
                console.warn(
                    `[AI Client] Request failed on key index ${keyInfo?.index ?? "unknown"} (${maskApiKey(keyInfo?.key)}): ${classification.reason}. Rotating key and retrying...`
                );

                // Force rotation and get next healthy key
                keyInfo = await forceKeyRotationAndGetKey(error);
                retries--;
                continue;
            }

            // Unclassified or non-rotatable errors throw immediately
            throw error;
        }
    }

    throw lastError || new Error("Failed to process text after maximum retries");
}

/**
 * Process text with AI and return an active ReadableStream of text chunks.
 * 
 * Features:
 * - 3-State Distributed Circuit Breaker (Closed, Open, Half-Open Single Probe)
 * - In-flight 503 Failover to secondary model on initiation
 * - Native AbortSignal support with stream cleanup and downstream cancel handling
 * - Unhandled Rejection Prevention
 * - Strict Credential & Content Sanitization
 * - Upstash Redis Concurrency-Safe Usage Updates
 * 
 * @param operation - The AI operation to perform
 * @param text - The input text to process
 * @param tier - User's subscription tier
 * @param signal - Optional Client abort signal for cancellation
 * @returns ReadableStream of encoded UTF-8 text chunks
 */
export async function streamWithAI(
    operation: AIOperation,
    text: string,
    tier: Tier,
    signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
    if (signal?.aborted) {
        const abortErr = new Error("Stream aborted before initialization");
        abortErr.name = "AbortError";
        throw abortErr;
    }

    const { primary, fallbacks } = getModelHierarchy(operation, tier);
    const fallback = fallbacks[0] || null;

    if (!primary && fallbacks.length === 0) {
        throw new Error(`Operation '${operation}' is not available for ${tier} tier`);
    }

    const systemPrompt = AI_PROMPTS[operation];
    const generationConfig = buildGenerationConfig(operation, tier);

    // Initial model selection via Circuit Breaker
    const { selectedModel: initialModel, isProbe: initialIsProbe } =
        await selectModelWithCircuitBreaker(primary, fallbacks);

    let targetModel = initialModel;
    let isProbe = initialIsProbe;
    const attemptedModels = new Set<string>([targetModel]);
    let retries = getMaxRetryAttempts();
    let lastError: Error | null = null;
    let keyInfo: KeyInfo | null = null;

    while (retries > 0) {
        if (signal?.aborted) {
            if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
            const abortErr = new Error("Stream aborted during key acquisition");
            abortErr.name = "AbortError";
            throw abortErr;
        }

        const currentModel = targetModel || fallback;
        if (!currentModel) {
            throw new Error(`No available model configured for operation '${operation}' in ${tier} tier`);
        }

        let attemptScope: ReturnType<typeof createAttemptSignal> | null = null;
        try {
            // Get active healthy API key from Redis pool
            keyInfo = keyInfo || (await getApiKeyForRequest());

            const genAI = new GoogleGenerativeAI(keyInfo.key);

            const model = genAI.getGenerativeModel({
                model: currentModel,
                generationConfig,
            });

            // Start stream generation — propagate the downstream abort signal to the
            // provider HTTP request. Without this, client disconnects and user aborts
            // never cancel the upstream Gemini socket and the server stays pinned
            // (reader.read() blocks) until the model finishes generating on its own.
            // If caller did not provide an AbortSignal, attach a 15s watchdog to avoid indefinite hangs on upstream 503 stalls.
            let requestSignal: AbortSignal | undefined = signal;
            if (!requestSignal) {
                attemptScope = createAttemptSignal(undefined, ATTEMPT_TIMEOUT_MS);
                requestSignal = attemptScope.attemptSignal;
            }

            let result;
            try {
                result = await model.generateContentStream(
                    [
                        { text: systemPrompt },
                        { text: text },
                    ],
                    requestSignal ? { signal: requestSignal } : undefined
                );
            } finally {
                attemptScope?.cleanup();
            }

            // Prevent unhandled promise rejection on SDK response promise
            if (result && result.response && typeof result.response.catch === "function") {
                result.response.catch(() => {});
            }

            // Stream started successfully, confirm usage in Redis
            await confirmApiKeyUsage(keyInfo.index);

            // Record success for model in circuit breaker
            if (currentModel === primary) {
                recordModelSuccess(primary).catch(() => {});
            }

            const currentKeyInfo = keyInfo;
            const activeModel = currentModel;
            let isStreamCancelled = false;

            return new ReadableStream<Uint8Array>({
                async start(controller) {
                    const encoder = new TextEncoder();

                    try {
                        for await (const chunk of result.stream) {
                            if (signal?.aborted || isStreamCancelled) {
                                controller.close();
                                return;
                            }

                            const chunkText = chunk.text();
                            if (chunkText) {
                                controller.enqueue(encoder.encode(chunkText));
                            }
                        }

                        controller.close();

                    } catch (streamErr) {
                        if (signal?.aborted || isStreamCancelled) {
                            return; // Suppress downstream error if cancelled
                        }

                        console.error(
                            `[AI Client] Mid-stream exception on model '${activeModel}' (key index ${currentKeyInfo.index}):`,
                            sanitizeErrorMessage((streamErr as Error)?.message || String(streamErr))
                        );

                        if (is503OrOverloadError(streamErr)) {
                            // Trip circuit breaker in Redis for overloaded model
                            recordModelFailure(activeModel).catch(() => {});
                        } else if (shouldRotateOnError(streamErr)) {
                            // Rotate key in Redis for subsequent requests
                            forceKeyRotationAndGetKey(streamErr).catch(() => {});
                        }

                        controller.error(streamErr);
                    }
                },
                cancel() {
                    // Downstream cancel handler: immediately break generator loop
                    isStreamCancelled = true;
                },
            });

        } catch (error: unknown) {
            const isAttemptTimeout = Boolean(attemptScope?.didTimeout());
            attemptScope?.cleanup();
            lastError = error as Error;

            const classification = classifyGeminiError(error);

            // 1. User Cancellation -> Fail fast (only if caller aborted, not attempt timeout)
            if (signal?.aborted || (classification.category === "cancelled" && !isAttemptTimeout)) {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                const abortErr = new Error("Stream aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            // 2. Non-rotatable Client Error (400 Bad Request, Safety Filter) -> Fail fast
            if (classification.category === "invalid_request") {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                console.warn(`[AI Client] Non-rotatable stream initialization error on '${operation}':`, classification.reason);
                throw error;
            }

            // 3. In-flight 503 / Overload / Attempt Timeout -> Immediately failover to fallback model in chain
            if (
                isAttemptTimeout ||
                classification.category === "overload" ||
                is503OrOverloadError(error)
            ) {
                // Record failure and trip circuit in Redis
                if (targetModel) {
                    recordModelFailure(targetModel).catch(() => {});
                }

                const nextFallback = fallbacks.find((m) => !attemptedModels.has(m));
                if (nextFallback) {
                    console.warn(
                        `[AI Client] Stream initiation on '${targetModel}' returned 503/Overload. Failing over to fallback model '${nextFallback}' in same request...`
                    );
                    targetModel = nextFallback;
                    attemptedModels.add(nextFallback);
                    isProbe = false;
                    continue; // Retry with fallback model
                }

                // If all fallback models in chain have been attempted, do 1 micro-retry with jitter if retries remain
                if (retries > 1 && !signal?.aborted) {
                    const jitterMs = 300 + Math.floor(Math.random() * 400);
                    console.warn(
                        `[AI Client] All models in fallback chain exhausted on 503/Overload. Pausing ${jitterMs}ms for micro-retry...`
                    );
                    await new Promise((resolve) => setTimeout(resolve, jitterMs));
                    retries--;
                    continue;
                }
            }

            if (isProbe && primary) {
                releaseProbeLock(primary).catch(() => {});
                isProbe = false;
            }

            // 4. Rotatable technical errors (429, 401, 500, etc.)
            if (classification.retryableWithKey || shouldRotateOnError(error)) {
                console.warn(
                    `[AI Client] Stream initialization failed on key index ${keyInfo?.index ?? "unknown"} (${classification.reason}), rotating key and retrying...`
                );

                // Force rotation and get new key for immediate retry
                keyInfo = await forceKeyRotationAndGetKey(error);
                retries--;
                continue;
            }

            // Non-rotatable errors throw immediately
            throw error;
        }
    }

    throw lastError || new Error("Failed to start stream after maximum retries");
}

// =========================================================================
// Modern Vercel AI SDK v7 Gateway Implementations
// =========================================================================

/**
 * Helper to obtain an initialized Google model instance with a rotated key.
 *
 * - Uses `getApiKeyForRequest(modelId)`.
 * - Calls `createGoogleGenerativeAI({ apiKey })`.
 * - Returns `{ provider, modelInstance, keyIndex }`.
 */
export async function getGoogleModel(
    modelId: string,
    existingKeyInfo?: KeyInfo
): Promise<{
    provider: ReturnType<typeof createGoogleGenerativeAI>;
    modelInstance: ReturnType<ReturnType<typeof createGoogleGenerativeAI>>;
    keyIndex: number;
    keyInfo: KeyInfo;
}> {
    const keyInfo = existingKeyInfo || (await getApiKeyForRequest(modelId));
    const provider = createGoogleGenerativeAI({ apiKey: keyInfo.key });
    const modelInstance = provider(modelId);
    return {
        provider,
        modelInstance,
        keyIndex: keyInfo.index,
        keyInfo,
    };
}

/**
 * Execute structured generation using Vercel AI SDK v7 `generateText` with `Output.object`.
 * Adheres to AI SDK v7 deprecation policy (using generateText + Output.object instead of deprecated generateObject).
 * Integrated with distributed Redis key rotation and circuit breaker protection.
 */
export async function executeStructuredGeneration<T>(options: {
    modelId: string;
    schema: z.ZodType<T>;
    prompt: string;
    system?: string;
    maxRetries?: number;
    abortSignal?: AbortSignal;
}): Promise<{
    object: T;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    finishReason: string;
    modelId: string;
}> {
    if (options.abortSignal?.aborted) {
        const abortErr = new Error("The operation was aborted");
        abortErr.name = "AbortError";
        throw abortErr;
    }

    const circuitState = await getModelCircuitState(options.modelId);
    if (circuitState === "open") {
        throw new CircuitBreakerOpenError(options.modelId);
    }

    let isProbe = false;
    if (circuitState === "half-open") {
        const wonProbe = await tryAcquireHalfOpenProbe(options.modelId);
        if (!wonProbe) {
            throw new CircuitBreakerOpenError(options.modelId);
        }
        isProbe = true;
    }

    let retries = options.maxRetries ?? getMaxRetryAttempts();
    let lastError: Error | null = null;
    let currentKeyInfo: KeyInfo | null = null;

    while (retries > 0) {
        if (options.abortSignal?.aborted) {
            if (isProbe) releaseProbeLock(options.modelId).catch(() => {});
            const abortErr = new Error("The operation was aborted");
            abortErr.name = "AbortError";
            throw abortErr;
        }

        try {
            const { modelInstance, keyIndex, keyInfo } = await getGoogleModel(
                options.modelId,
                currentKeyInfo ?? undefined
            );
            currentKeyInfo = keyInfo;

            const result = await generateText({
                model: modelInstance,
                system: options.system,
                prompt: options.prompt,
                output: Output.object({ schema: options.schema }),
                abortSignal: options.abortSignal,
            });

            await confirmApiKeyUsage(keyIndex);
            await recordModelSuccess(options.modelId);

            return {
                object: result.output as T,
                usage: {
                    inputTokens: result.usage?.inputTokens ?? 0,
                    outputTokens: result.usage?.outputTokens ?? 0,
                    totalTokens: result.usage?.totalTokens ?? 0,
                },
                finishReason: String(result.finishReason ?? "stop"),
                modelId: options.modelId,
            };
        } catch (error: unknown) {
            lastError = error as Error;
            const classification = classifyGeminiError(error);

            if (options.abortSignal?.aborted || classification.category === "cancelled") {
                if (isProbe) releaseProbeLock(options.modelId).catch(() => {});
                const abortErr = new Error("The operation was aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            if (classification.category === "invalid_request") {
                if (isProbe) releaseProbeLock(options.modelId).catch(() => {});
                throw error;
            }

            if (classification.category === "overload" || is503OrOverloadError(error)) {
                await recordModelFailure(options.modelId).catch(() => {});
                if (isProbe) {
                    releaseProbeLock(options.modelId).catch(() => {});
                    isProbe = false;
                }
                throw error;
            }

            if (isProbe) {
                releaseProbeLock(options.modelId).catch(() => {});
                isProbe = false;
            }

            if (classification.retryableWithKey || shouldRotateOnError(error)) {
                console.warn(
                    `[AI Gateway] Structured generation failed on key index ${currentKeyInfo?.index ?? "unknown"}: ${classification.reason}. Rotating key and retrying...`
                );
                currentKeyInfo = await forceKeyRotationAndGetKey(error);
                retries--;
                continue;
            }

            await recordModelFailure(options.modelId).catch(() => {});
            throw error;
        }
    }

    await recordModelFailure(options.modelId).catch(() => {});
    throw lastError || new Error("Failed to execute structured generation after maximum retries");
}

/**
 * Execute multi-step agent tool-calling generation using Vercel AI SDK v7 `generateText` with `stopWhen: stepCountIs(...)`.
 * Integrated with distributed Redis key rotation and circuit breaker protection.
 */
export async function executeToolAgentGeneration(options: {
    modelId: string;
    tools: ToolSet;
    prompt: string;
    system?: string;
    maxSteps?: number;
    abortSignal?: AbortSignal;
}): Promise<{
    text: string;
    toolCalls: TypedToolCall<ToolSet>[];
    toolResults: TypedToolResult<ToolSet>[];
    steps: StepResult<ToolSet>[];
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    finishReason: string;
    modelId: string;
}> {
    if (options.abortSignal?.aborted) {
        const abortErr = new Error("The operation was aborted");
        abortErr.name = "AbortError";
        throw abortErr;
    }

    const circuitState = await getModelCircuitState(options.modelId);
    if (circuitState === "open") {
        throw new CircuitBreakerOpenError(options.modelId);
    }

    let isProbe = false;
    if (circuitState === "half-open") {
        const wonProbe = await tryAcquireHalfOpenProbe(options.modelId);
        if (!wonProbe) {
            throw new CircuitBreakerOpenError(options.modelId);
        }
        isProbe = true;
    }

    let retries = getMaxRetryAttempts();
    let lastError: Error | null = null;
    let currentKeyInfo: KeyInfo | null = null;

    while (retries > 0) {
        if (options.abortSignal?.aborted) {
            if (isProbe) releaseProbeLock(options.modelId).catch(() => {});
            const abortErr = new Error("The operation was aborted");
            abortErr.name = "AbortError";
            throw abortErr;
        }

        try {
            const { modelInstance, keyIndex, keyInfo } = await getGoogleModel(
                options.modelId,
                currentKeyInfo ?? undefined
            );
            currentKeyInfo = keyInfo;

            const result = await generateText({
                model: modelInstance,
                system: options.system,
                prompt: options.prompt,
                tools: options.tools,
                stopWhen: stepCountIs(options.maxSteps ?? 6),
                abortSignal: options.abortSignal,
            });

            await confirmApiKeyUsage(keyIndex);
            await recordModelSuccess(options.modelId);

            return {
                text: result.text,
                toolCalls: result.toolCalls ?? [],
                toolResults: result.toolResults ?? [],
                steps: result.steps ?? [],
                usage: {
                    inputTokens: result.usage?.inputTokens ?? 0,
                    outputTokens: result.usage?.outputTokens ?? 0,
                    totalTokens: result.usage?.totalTokens ?? 0,
                },
                finishReason: String(result.finishReason ?? "stop"),
                modelId: options.modelId,
            };
        } catch (error: unknown) {
            lastError = error as Error;
            const classification = classifyGeminiError(error);

            if (options.abortSignal?.aborted || classification.category === "cancelled") {
                if (isProbe) releaseProbeLock(options.modelId).catch(() => {});
                const abortErr = new Error("The operation was aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            if (classification.category === "invalid_request") {
                if (isProbe) releaseProbeLock(options.modelId).catch(() => {});
                throw error;
            }

            if (classification.category === "overload" || is503OrOverloadError(error)) {
                await recordModelFailure(options.modelId).catch(() => {});
                if (isProbe) {
                    releaseProbeLock(options.modelId).catch(() => {});
                    isProbe = false;
                }
                throw error;
            }

            if (isProbe) {
                releaseProbeLock(options.modelId).catch(() => {});
                isProbe = false;
            }

            if (classification.retryableWithKey || shouldRotateOnError(error)) {
                console.warn(
                    `[AI Gateway] Tool agent generation failed on key index ${currentKeyInfo?.index ?? "unknown"}: ${classification.reason}. Rotating key and retrying...`
                );
                currentKeyInfo = await forceKeyRotationAndGetKey(error);
                retries--;
                continue;
            }

            await recordModelFailure(options.modelId).catch(() => {});
            throw error;
        }
    }

    await recordModelFailure(options.modelId).catch(() => {});
    throw lastError || new Error("Failed to execute tool agent generation after maximum retries");
}

/**
 * Execute streaming text generation using Vercel AI SDK v7 `streamText`.
 * Integrated with key rotation usage tracking and circuit breaker monitoring.
 */
export async function executeStreamingGeneration(options: {
    modelId: string;
    prompt: string;
    system?: string;
    abortSignal?: AbortSignal;
}): Promise<ReturnType<typeof streamText>> {
    if (options.abortSignal?.aborted) {
        const abortErr = new Error("Stream aborted before initialization");
        abortErr.name = "AbortError";
        throw abortErr;
    }

    const circuitState = await getModelCircuitState(options.modelId);
    if (circuitState === "open") {
        throw new CircuitBreakerOpenError(options.modelId);
    }

    let isProbe = false;
    if (circuitState === "half-open") {
        const wonProbe = await tryAcquireHalfOpenProbe(options.modelId);
        if (!wonProbe) {
            throw new CircuitBreakerOpenError(options.modelId);
        }
        isProbe = true;
    }

    const { modelInstance, keyIndex } = await getGoogleModel(options.modelId);

    try {
        const streamResult = streamText({
            model: modelInstance,
            system: options.system,
            prompt: options.prompt,
            abortSignal: options.abortSignal,
            onFinish: async () => {
                try {
                    await confirmApiKeyUsage(keyIndex);
                    await recordModelSuccess(options.modelId);
                } catch {
                    // Suppress confirmation errors
                }
            },
            onError: async ({ error }) => {
                if (isProbe) {
                    releaseProbeLock(options.modelId).catch(() => {});
                }
                if (is503OrOverloadError(error)) {
                    recordModelFailure(options.modelId).catch(() => {});
                } else if (shouldRotateOnError(error)) {
                    forceKeyRotationAndGetKey(error).catch(() => {});
                }
            },
        });

        return streamResult;
    } catch (err) {
        if (isProbe) {
            releaseProbeLock(options.modelId).catch(() => {});
        }
        if (is503OrOverloadError(err)) {
            await recordModelFailure(options.modelId).catch(() => {});
        } else if (shouldRotateOnError(err)) {
            await forceKeyRotationAndGetKey(err).catch(() => {});
        }
        throw err;
    }
}

// Re-export ROTATION_ERROR_CODES & CircuitBreakerOpenError for external use
export { ROTATION_ERROR_CODES, CircuitBreakerOpenError };
