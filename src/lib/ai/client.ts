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
    ROTATION_ERROR_CODES,
    KeyInfo,
    CircuitBreakerOpenError,
} from "./key-rotation";

/**
 * Dynamically resolve maximum retry attempts based on the configured key pool size.
 * Allows larger key pools (e.g. 10-20 keys) to rotate through healthy keys without early abortion.
 */
function getMaxRetryAttempts(): number {
    const keyCount = getApiKeys().length;
    return Math.min(Math.max(6, keyCount), 10);
}

// =========================================================================
// Modern Vercel AI SDK v7 Gateway Implementations
// =========================================================================

/**
 * Helper to obtain an initialized Google model instance with a rotated key.
 *
 * - Uses `getApiKeyForRequest(modelId)`.
 * - Calls `createGoogleGenerativeAI({ apiKey })`.
 * - Returns `{ provider, modelInstance, keyIndex, keyInfo }`.
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
