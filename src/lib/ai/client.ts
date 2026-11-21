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

export interface ParsedQualifiedModelId {
    provider: string;
    providerModelName: string;
    qualifiedModelId: string;
}

/**
 * Parses a provider-qualified model identifier (e.g. `"google/gemini-3.8-flash"`)
 * into its provider namespace, provider-native model name, and canonical qualified ID.
 * Unprefixed model IDs default to the `"google"` provider.
 */
export function parseQualifiedModelId(qualifiedModelId: string): ParsedQualifiedModelId {
    const trimmed = qualifiedModelId.trim();
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
        return {
            provider: trimmed.slice(0, slashIndex),
            providerModelName: trimmed.slice(slashIndex + 1),
            qualifiedModelId: trimmed,
        };
    }

    return {
        provider: "google",
        providerModelName: trimmed,
        qualifiedModelId: trimmed,
    };
}

/**
 * Helper to obtain an initialized Google model instance with a rotated key.
 *
 * - Parses `qualifiedModelId` via `parseQualifiedModelId(modelId)`.
 * - Uses `getApiKeyForRequest(parsed.qualifiedModelId)`.
 * - Calls `createGoogleGenerativeAI({ apiKey })`.
 * - Invokes `provider(parsed.providerModelName)`.
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
    const parsed = parseQualifiedModelId(modelId);
    const keyInfo = existingKeyInfo || (await getApiKeyForRequest(parsed.qualifiedModelId));
    const provider = createGoogleGenerativeAI({ apiKey: keyInfo.key });
    const modelInstance = provider(parsed.providerModelName);
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

    const qualifiedModelId = parseQualifiedModelId(options.modelId).qualifiedModelId;

    const circuitState = await getModelCircuitState(qualifiedModelId);
    if (circuitState === "open") {
        throw new CircuitBreakerOpenError(qualifiedModelId);
    }

    let isProbe = false;
    if (circuitState === "half-open") {
        const wonProbe = await tryAcquireHalfOpenProbe(qualifiedModelId);
        if (!wonProbe) {
            throw new CircuitBreakerOpenError(qualifiedModelId);
        }
        isProbe = true;
    }

    let retries = options.maxRetries ?? getMaxRetryAttempts();
    let lastError: Error | null = null;
    let currentKeyInfo: KeyInfo | null = null;

    while (retries > 0) {
        if (options.abortSignal?.aborted) {
            if (isProbe) releaseProbeLock(qualifiedModelId).catch(() => {});
            const abortErr = new Error("The operation was aborted");
            abortErr.name = "AbortError";
            throw abortErr;
        }

        try {
            const { modelInstance, keyIndex, keyInfo } = await getGoogleModel(
                qualifiedModelId,
                currentKeyInfo ?? undefined
            );
            currentKeyInfo = keyInfo;

            const result = await generateText({
                model: modelInstance,
                system: options.system,
                prompt: options.prompt,
                output: Output.object({ schema: options.schema }),
                maxRetries: 0,
                abortSignal: options.abortSignal,
            });

            await confirmApiKeyUsage(keyIndex);
            await recordModelSuccess(qualifiedModelId);

            return {
                object: result.output as T,
                usage: {
                    inputTokens: result.usage?.inputTokens ?? 0,
                    outputTokens: result.usage?.outputTokens ?? 0,
                    totalTokens: result.usage?.totalTokens ?? 0,
                },
                finishReason: String(result.finishReason ?? "stop"),
                modelId: qualifiedModelId,
            };
        } catch (error: unknown) {
            lastError = error as Error;
            const classification = classifyGeminiError(error);

            if (options.abortSignal?.aborted || classification.category === "cancelled") {
                if (isProbe) releaseProbeLock(qualifiedModelId).catch(() => {});
                const abortErr = new Error("The operation was aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            if (classification.category === "invalid_request") {
                if (isProbe) releaseProbeLock(qualifiedModelId).catch(() => {});
                throw error;
            }

            if (classification.category === "overload" || is503OrOverloadError(error)) {
                await recordModelFailure(qualifiedModelId).catch(() => {});
                if (isProbe) {
                    releaseProbeLock(qualifiedModelId).catch(() => {});
                    isProbe = false;
                }
                throw error;
            }

            if (isProbe) {
                releaseProbeLock(qualifiedModelId).catch(() => {});
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

            await recordModelFailure(qualifiedModelId).catch(() => {});
            throw error;
        }
    }

    await recordModelFailure(qualifiedModelId).catch(() => {});
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

    const qualifiedModelId = parseQualifiedModelId(options.modelId).qualifiedModelId;

    const circuitState = await getModelCircuitState(qualifiedModelId);
    if (circuitState === "open") {
        throw new CircuitBreakerOpenError(qualifiedModelId);
    }

    let isProbe = false;
    if (circuitState === "half-open") {
        const wonProbe = await tryAcquireHalfOpenProbe(qualifiedModelId);
        if (!wonProbe) {
            throw new CircuitBreakerOpenError(qualifiedModelId);
        }
        isProbe = true;
    }

    let retries = getMaxRetryAttempts();
    let lastError: Error | null = null;
    let currentKeyInfo: KeyInfo | null = null;

    while (retries > 0) {
        if (options.abortSignal?.aborted) {
            if (isProbe) releaseProbeLock(qualifiedModelId).catch(() => {});
            const abortErr = new Error("The operation was aborted");
            abortErr.name = "AbortError";
            throw abortErr;
        }

        try {
            const { modelInstance, keyIndex, keyInfo } = await getGoogleModel(
                qualifiedModelId,
                currentKeyInfo ?? undefined
            );
            currentKeyInfo = keyInfo;

            const result = await generateText({
                model: modelInstance,
                system: options.system,
                prompt: options.prompt,
                tools: options.tools,
                stopWhen: stepCountIs(options.maxSteps ?? 6),
                maxRetries: 0,
                abortSignal: options.abortSignal,
            });

            await confirmApiKeyUsage(keyIndex);
            await recordModelSuccess(qualifiedModelId);

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
                modelId: qualifiedModelId,
            };
        } catch (error: unknown) {
            lastError = error as Error;
            const classification = classifyGeminiError(error);

            if (options.abortSignal?.aborted || classification.category === "cancelled") {
                if (isProbe) releaseProbeLock(qualifiedModelId).catch(() => {});
                const abortErr = new Error("The operation was aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            if (classification.category === "invalid_request") {
                if (isProbe) releaseProbeLock(qualifiedModelId).catch(() => {});
                throw error;
            }

            if (classification.category === "overload" || is503OrOverloadError(error)) {
                await recordModelFailure(qualifiedModelId).catch(() => {});
                if (isProbe) {
                    releaseProbeLock(qualifiedModelId).catch(() => {});
                    isProbe = false;
                }
                throw error;
            }

            if (isProbe) {
                releaseProbeLock(qualifiedModelId).catch(() => {});
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

            await recordModelFailure(qualifiedModelId).catch(() => {});
            throw error;
        }
    }

    await recordModelFailure(qualifiedModelId).catch(() => {});
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

    const qualifiedModelId = parseQualifiedModelId(options.modelId).qualifiedModelId;

    const circuitState = await getModelCircuitState(qualifiedModelId);
    if (circuitState === "open") {
        throw new CircuitBreakerOpenError(qualifiedModelId);
    }

    let isProbe = false;
    if (circuitState === "half-open") {
        const wonProbe = await tryAcquireHalfOpenProbe(qualifiedModelId);
        if (!wonProbe) {
            throw new CircuitBreakerOpenError(qualifiedModelId);
        }
        isProbe = true;
    }

    const { modelInstance, keyIndex } = await getGoogleModel(qualifiedModelId);

    try {
        const streamResult = streamText({
            model: modelInstance,
            system: options.system,
            prompt: options.prompt,
            maxRetries: 0,
            abortSignal: options.abortSignal,
            onFinish: async () => {
                try {
                    await confirmApiKeyUsage(keyIndex);
                    await recordModelSuccess(qualifiedModelId);
                } catch {
                    // Suppress confirmation errors
                }
            },
            onError: async ({ error }) => {
                if (isProbe) {
                    releaseProbeLock(qualifiedModelId).catch(() => {});
                }
                if (is503OrOverloadError(error)) {
                    recordModelFailure(qualifiedModelId).catch(() => {});
                } else if (shouldRotateOnError(error)) {
                    forceKeyRotationAndGetKey(error).catch(() => {});
                }
            },
        });

        return streamResult;
    } catch (err) {
        if (isProbe) {
            releaseProbeLock(qualifiedModelId).catch(() => {});
        }
        if (is503OrOverloadError(err)) {
            await recordModelFailure(qualifiedModelId).catch(() => {});
        } else if (shouldRotateOnError(err)) {
            await forceKeyRotationAndGetKey(err).catch(() => {});
        }
        throw err;
    }
}

// Re-export ROTATION_ERROR_CODES & CircuitBreakerOpenError for external use
export { ROTATION_ERROR_CODES, CircuitBreakerOpenError };
