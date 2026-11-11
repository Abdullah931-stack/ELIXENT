import {
    parseAgentStreamPayload,
    type AgentStreamRequestPayload,
} from '@/core/agent/stream-payload';
import { getRpcClientFetch } from '@/client/rpc-client';

export type { AgentStreamRequestPayload };

export const AGENT_STREAM_ENDPOINT = '/api/agent/stream';

/**
 * 256 KB Line buffer safety ceiling preventing unbounded heap allocation (ADV-01).
 */
export const MAX_LINE_BUFFER_CHARS = 262_144;

/**
 * Watchdog: maximum wait (ms) for the first streamed byte before failing the session.
 * A stalled provider connection must fail closed instead of hanging the editor forever.
 */
export const FIRST_CHUNK_TIMEOUT_MS = 20_000;

/**
 * Watchdog: absolute ceiling (ms) for a single streaming session regardless of activity.
 */
export const MAX_STREAM_DURATION_MS = 300_000;

export interface AgentStreamStartEvent {
    type: 'start';
    sessionId: string;
    threadId: string;
    operationId: string;
    correlationId?: string;
}

export interface AgentStreamUpdateEvent {
    type: 'update';
    chunk: Record<string, unknown>;
}

export interface AgentInterruptItem {
    value: unknown;
    resumable?: boolean;
    ns?: string[];
    when?: string;
}

export interface AgentStreamInterruptEvent {
    type: 'interrupt';
    threadId: string;
    operationId: string;
    interrupts: AgentInterruptItem[];
}

export interface AgentStreamErrorEvent {
    type: 'error';
    code: string;
    message: string;
    retryable?: boolean;
}

export interface AgentStreamDoneEvent {
    type: 'done';
    threadId: string;
    operationId: string;
}

export type AgentStreamEvent =
    | AgentStreamStartEvent
    | AgentStreamUpdateEvent
    | AgentStreamInterruptEvent
    | AgentStreamErrorEvent
    | AgentStreamDoneEvent;

export type StreamStartEvent = AgentStreamStartEvent;
export type StreamUpdateEvent = AgentStreamUpdateEvent;
export type StreamInterruptEvent = AgentStreamInterruptEvent;
export type StreamErrorEvent = AgentStreamErrorEvent;
export type StreamDoneEvent = AgentStreamDoneEvent;
export type StreamEvent = AgentStreamEvent;

/**
 * Structured error surfaced for HTTP non-2xx responses and SSE error frames.
 */
export class AgentStreamError extends Error {
    readonly code: string;
    readonly status?: number;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;

    constructor(params: {
        message: string;
        code: string;
        status?: number;
        retryable?: boolean;
        details?: Record<string, unknown>;
    }) {
        super(params.message);
        this.name = 'AgentStreamError';
        this.code = params.code;
        this.status = params.status;
        this.retryable = params.retryable ?? false;
        this.details = params.details;
        Object.setPrototypeOf(this, AgentStreamError.prototype);
    }
}

export interface StreamHandlerOptions {
    /** Validated or candidate request payload for POST /api/agent/stream */
    payload?: AgentStreamRequestPayload;
    threadId?: string;
    projectId?: string;
    prompt?: string;
    targetFileIds?: string[];
    resumePayload?: unknown;
    ephemeralVaultPayloads?: Record<string, string>;
    liveDocumentSnapshots?: Record<string, string>;
    onStart?: (event: AgentStreamStartEvent) => void;
    onUpdate?: (event: AgentStreamUpdateEvent) => void;
    onInterrupt?: (event: AgentStreamInterruptEvent) => void;
    onDone?: (event: AgentStreamDoneEvent) => void;
    onError: (error: AgentStreamError | Error) => void;
    onEvent?: (event: AgentStreamEvent) => void;
    signal?: AbortSignal;
    /** Ops/test hook: override the first-chunk watchdog threshold (ms). */
    firstChunkTimeoutMs?: number;
    /** Ops/test hook: override the absolute stream-duration watchdog threshold (ms). */
    maxDurationMs?: number;
}

const DEFAULT_STATUS_ERROR_CODES: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    402: 'INSUFFICIENT_CREDITS',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'RATE_LIMIT_EXCEEDED',
    500: 'INTERNAL_SERVER_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
    504: 'GATEWAY_TIMEOUT',
};

/**
 * Resolves a deterministic error code and message from an HTTP non-2xx response.
 */
export function parseHttpStreamError(
    status: number,
    statusText: string,
    rawBody: string
): AgentStreamError {
    let parsed: Record<string, unknown> | null = null;
    const trimmed = rawBody.trim();
    if (trimmed.startsWith('{')) {
        try {
            const candidate = JSON.parse(trimmed);
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                parsed = candidate as Record<string, unknown>;
            }
        } catch {
            parsed = null;
        }
    }

    let code = '';
    if (parsed) {
        if (typeof parsed.code === 'string' && parsed.code.trim()) {
            code = parsed.code.trim();
        } else if (typeof parsed.errorCode === 'string' && parsed.errorCode.trim()) {
            code = parsed.errorCode.trim();
        } else if (
            typeof parsed.error === 'string' &&
            /^[A-Z0-9_]+$/.test(parsed.error.trim())
        ) {
            code = parsed.error.trim();
        }
    }

    const combinedText = `${rawBody} ${
        parsed ? `${String(parsed.type ?? '')} ${String(parsed.title ?? '')} ${String(parsed.detail ?? '')}` : ''
    }`;

    if (!code) {
        if (combinedText.includes('VAULT_AI_ACCESS_DENIED') || (status === 403 && /vault|encrypted/i.test(combinedText))) {
            code = 'VAULT_AI_ACCESS_DENIED';
        } else if (combinedText.includes('INSUFFICIENT_CREDITS') || combinedText.includes('QUOTA_EXCEEDED')) {
            code = status === 402 ? 'INSUFFICIENT_CREDITS' : 'QUOTA_EXCEEDED';
        } else if (combinedText.includes('RATE_LIMIT_EXCEEDED') || status === 429) {
            code = 'RATE_LIMIT_EXCEEDED';
        } else {
            code = DEFAULT_STATUS_ERROR_CODES[status] || `HTTP_${status}`;
        }
    }

    const extractedDetail =
        (parsed && typeof parsed.detail === 'string' && parsed.detail.trim()) ||
        (parsed && typeof parsed.message === 'string' && parsed.message.trim()) ||
        (parsed && typeof parsed.error === 'string' && parsed.error.trim()) ||
        (parsed && typeof parsed.title === 'string' && parsed.title.trim()) ||
        trimmed ||
        statusText ||
        `HTTP Error ${status}`;

    const message = extractedDetail.includes(code)
        ? extractedDetail
        : `${code}: ${extractedDetail}`;

    const retryable =
        parsed && typeof parsed.retryable === 'boolean'
            ? parsed.retryable
            : status === 429 || status === 503 || status === 504;

    return new AgentStreamError({
        code,
        status,
        message,
        retryable,
        details: parsed ?? undefined,
    });
}

function buildRequestPayload(options: StreamHandlerOptions): AgentStreamRequestPayload {
    const rawCandidate: AgentStreamRequestPayload = options.payload ?? {
        threadId: options.threadId ?? '',
        projectId: options.projectId ?? '',
        ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
        targetFileIds: options.targetFileIds ?? [],
        ...(options.resumePayload !== undefined ? { resumePayload: options.resumePayload } : {}),
        ...(options.ephemeralVaultPayloads !== undefined
            ? { ephemeralVaultPayloads: options.ephemeralVaultPayloads }
            : {}),
        ...(options.liveDocumentSnapshots !== undefined
            ? { liveDocumentSnapshots: options.liveDocumentSnapshots }
            : {}),
    };

    const parsed = parseAgentStreamPayload(rawCandidate);
    if (!parsed.success) {
        const reason = parsed.error.issues
            .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
            .join('; ');
        throw new AgentStreamError({
            code: 'INVALID_STREAM_PAYLOAD',
            status: 400,
            message: `INVALID_STREAM_PAYLOAD: ${reason}`,
            retryable: false,
        });
    }

    return parsed.data;
}

/**
 * Normalizes a parsed JSON frame and optional SSE `event:` header into a typed AgentStreamEvent.
 */
function normalizeParsedFrame(
    eventHeader: string | null,
    parsed: Record<string, unknown>,
    fallbackThreadId: string
): AgentStreamEvent | null {
    const resolvedType = (
        typeof parsed.type === 'string' && parsed.type.trim()
            ? parsed.type.trim()
            : eventHeader?.trim() || ''
    ).toLowerCase();

    if (resolvedType === 'start' || resolvedType === 'meta' || resolvedType === 'metadata') {
        return {
            type: 'start',
            sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : `session_${crypto.randomUUID()}`,
            threadId: typeof parsed.threadId === 'string' ? parsed.threadId : fallbackThreadId,
            operationId: typeof parsed.operationId === 'string' ? parsed.operationId : `op_${crypto.randomUUID()}`,
            ...(typeof parsed.correlationId === 'string' ? { correlationId: parsed.correlationId } : {}),
        };
    }

    if (resolvedType === 'update') {
        const chunkCandidate =
            'chunk' in parsed &&
            parsed.chunk !== null &&
            typeof parsed.chunk === 'object' &&
            !Array.isArray(parsed.chunk)
                ? (parsed.chunk as Record<string, unknown>)
                : parsed;
        return {
            type: 'update',
            chunk: chunkCandidate,
        };
    }

    if (resolvedType === 'interrupt') {
        const rawInterrupts = Array.isArray(parsed.interrupts)
            ? parsed.interrupts
            : '__interrupt__' in parsed && Array.isArray(parsed.__interrupt__)
              ? (parsed.__interrupt__ as unknown[])
              : 'value' in parsed
                ? [{ value: parsed.value, resumable: true }]
                : [];

        const normalizedInterrupts: AgentInterruptItem[] = rawInterrupts.map((item) => {
            if (item && typeof item === 'object' && 'value' in item) {
                const record = item as Record<string, unknown>;
                return {
                    value: record.value,
                    resumable: typeof record.resumable === 'boolean' ? record.resumable : true,
                    ...(Array.isArray(record.ns) ? { ns: record.ns.map(String) } : {}),
                    ...(typeof record.when === 'string' ? { when: record.when } : {}),
                };
            }
            return {
                value: item,
                resumable: true,
            };
        });

        return {
            type: 'interrupt',
            threadId: typeof parsed.threadId === 'string' ? parsed.threadId : fallbackThreadId,
            operationId: typeof parsed.operationId === 'string' ? parsed.operationId : '',
            interrupts: normalizedInterrupts,
        };
    }

    if (resolvedType === 'error') {
        const code =
            typeof parsed.code === 'string' && parsed.code.trim()
                ? parsed.code.trim()
                : 'STREAM_EXECUTION_ERROR';
        const rawMessage =
            typeof parsed.message === 'string' && parsed.message.trim()
                ? parsed.message.trim()
                : code;
        return {
            type: 'error',
            code,
            message: rawMessage,
            ...(typeof parsed.retryable === 'boolean' ? { retryable: parsed.retryable } : {}),
        };
    }

    if (resolvedType === 'done') {
        return {
            type: 'done',
            threadId: typeof parsed.threadId === 'string' ? parsed.threadId : fallbackThreadId,
            operationId: typeof parsed.operationId === 'string' ? parsed.operationId : '',
        };
    }

    return null;
}

/**
 * Consumes the `/api/agent/stream` SSE response stream with resilient frame decoding,
 * strict line-buffer ceiling (`MAX_LINE_BUFFER_CHARS = 262_144`), and first-chunk
 * watchdog timer (`FIRST_CHUNK_TIMEOUT_MS = 20_000`).
 */
export async function consumeAgentStream(options: StreamHandlerOptions): Promise<void> {
    const {
        onStart,
        onUpdate,
        onInterrupt,
        onDone,
        onError,
        onEvent,
        signal,
        firstChunkTimeoutMs: firstChunkTimeoutMsOverride,
        maxDurationMs: maxDurationMsOverride,
    } = options;

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let isTerminalCallbackEmitted = false;

    const firstChunkTimeoutMs = firstChunkTimeoutMsOverride ?? FIRST_CHUNK_TIMEOUT_MS;
    const maxDurationMs = maxDurationMsOverride ?? MAX_STREAM_DURATION_MS;
    let receivedFirstChunk = false;
    let firstChunkTimer: ReturnType<typeof setTimeout> | null = null;
    let durationTimer: ReturnType<typeof setTimeout> | null = null;

    const clearWatchdogTimers = (): void => {
        if (firstChunkTimer) {
            clearTimeout(firstChunkTimer);
            firstChunkTimer = null;
        }
        if (durationTimer) {
            clearTimeout(durationTimer);
            durationTimer = null;
        }
    };

    const emitError = (err: AgentStreamError | Error): void => {
        clearWatchdogTimers();
        if (isTerminalCallbackEmitted) return;
        isTerminalCallbackEmitted = true;
        onError(err);
    };

    const emitDone = (doneEvent: AgentStreamDoneEvent): void => {
        if (isTerminalCallbackEmitted) return;
        clearWatchdogTimers();
        isTerminalCallbackEmitted = true;
        try {
            onDone?.(doneEvent);
        } catch (doneErr) {
            isTerminalCallbackEmitted = false;
            emitError(
                doneErr instanceof Error
                    ? doneErr
                    : new Error(String(doneErr) || 'Stream completion handler failed')
            );
        }
    };

    const fireWatchdogTimeout = (code: string, detail: string): void => {
        try {
            reader?.cancel(code);
        } catch {
            // Reader already released or locked elsewhere.
        }
        emitError(
            new AgentStreamError({
                code,
                message: `${code}: ${detail}`,
                retryable: true,
            })
        );
    };

    try {
        const requestPayload = buildRequestPayload(options);

        const activeFetch = getRpcClientFetch() ?? globalThis.fetch;
        const response = await activeFetch(AGENT_STREAM_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
            },
            body: JSON.stringify(requestPayload),
            signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw parseHttpStreamError(response.status, response.statusText, errText);
        }

        reader = response.body?.getReader() || null;
        if (!reader) {
            throw new AgentStreamError({
                code: 'NO_READABLE_STREAM',
                message: 'No readable stream available in response',
                retryable: false,
            });
        }

        firstChunkTimer = setTimeout(() => {
            if (!receivedFirstChunk) {
                fireWatchdogTimeout(
                    'AI_STREAM_FIRST_CHUNK_TIMEOUT',
                    `no data received from agent stream within ${firstChunkTimeoutMs}ms`
                );
            }
        }, firstChunkTimeoutMs);

        durationTimer = setTimeout(() => {
            fireWatchdogTimeout(
                'AI_STREAM_DURATION_EXCEEDED',
                `stream exceeded maximum allowed duration of ${maxDurationMs}ms`
            );
        }, maxDurationMs);

        const decoder = new TextDecoder('utf-8');
        let lineBuffer = '';
        let currentEventHeader: string | null = null;
        let currentDataLines: string[] = [];
        let isDoneReceived = false;
        let isInterruptReceived = false;
        let lastOperationId = '';

        const dispatchJsonPayload = (eventHeader: string | null, rawJson: string): void => {
            const trimmedJson = rawJson.trim();
            if (!trimmedJson) return;
            if (trimmedJson === '[DONE]') {
                isDoneReceived = true;
                return;
            }

            let parsed: Record<string, unknown>;
            try {
                const candidate = JSON.parse(trimmedJson);
                if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
                    throw new Error('SSE data payload must be a JSON object');
                }
                parsed = candidate as Record<string, unknown>;
            } catch {
                throw new AgentStreamError({
                    code: 'INVALID_STREAM_JSON',
                    message: 'Invalid JSON stream chunk received',
                    retryable: false,
                });
            }

            const event = normalizeParsedFrame(
                eventHeader,
                parsed,
                requestPayload.threadId
            );
            if (!event) {
                return;
            }

            onEvent?.(event);

            switch (event.type) {
                case 'start': {
                    if (event.operationId) {
                        lastOperationId = event.operationId;
                    }
                    onStart?.(event);
                    break;
                }
                case 'update': {
                    // Check if inline __interrupt__ exists inside the update chunk
                    if ('__interrupt__' in event.chunk && Array.isArray(event.chunk.__interrupt__)) {
                        isInterruptReceived = true;
                        const interruptEvent = normalizeParsedFrame(
                            'interrupt',
                            {
                                type: 'interrupt',
                                threadId: requestPayload.threadId,
                                operationId: lastOperationId,
                                interrupts: event.chunk.__interrupt__,
                            },
                            requestPayload.threadId
                        ) as AgentStreamInterruptEvent;
                        onInterrupt?.(interruptEvent);
                    } else {
                        onUpdate?.(event);
                    }
                    break;
                }
                case 'interrupt': {
                    isInterruptReceived = true;
                    if (event.operationId) {
                        lastOperationId = event.operationId;
                    }
                    onInterrupt?.(event);
                    break;
                }
                case 'error': {
                    const formattedMsg = event.message.includes(event.code)
                        ? event.message
                        : `${event.code}: ${event.message}`;
                    throw new AgentStreamError({
                        code: event.code,
                        message: formattedMsg,
                        retryable: event.retryable ?? false,
                    });
                }
                case 'done': {
                    if (event.operationId) {
                        lastOperationId = event.operationId;
                    }
                    if (!isDoneReceived) {
                        isDoneReceived = true;
                        emitDone(event);
                    }
                    break;
                }
            }
        };

        const flushPendingSSEBlock = (): void => {
            if (currentDataLines.length > 0) {
                const joinedData = currentDataLines.join('\n');
                const header = currentEventHeader;
                currentEventHeader = null;
                currentDataLines = [];
                dispatchJsonPayload(header, joinedData);
            } else {
                currentEventHeader = null;
            }
        };

        const processLine = (rawLine: string): void => {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            const trimmed = line.trim();

            // Blank line marks the end of an SSE event frame (\n\n)
            if (!trimmed) {
                flushPendingSSEBlock();
                return;
            }

            // SSE comment / keep-alive line
            if (trimmed.startsWith(':')) {
                return;
            }

            if (trimmed.startsWith('event:')) {
                if (currentDataLines.length > 0) {
                    flushPendingSSEBlock();
                }
                currentEventHeader = trimmed.slice(6).trim();
                return;
            }

            if (trimmed.startsWith('data:')) {
                const payloadFragment = trimmed.slice(5).trim();
                if (payloadFragment === '[DONE]') {
                    flushPendingSSEBlock();
                    isDoneReceived = true;
                    return;
                }

                // If no prior multi-line fragments are buffered and this line is a complete
                // single-line JSON object, dispatch immediately while also supporting \n\n.
                if (currentDataLines.length === 0 && payloadFragment.startsWith('{') && payloadFragment.endsWith('}')) {
                    const header = currentEventHeader;
                    currentEventHeader = null;
                    dispatchJsonPayload(header, payloadFragment);
                    return;
                }

                currentDataLines.push(payloadFragment);
                return;
            }

            // Direct NDJSON line fallback
            if (trimmed.startsWith('{')) {
                flushPendingSSEBlock();
                dispatchJsonPayload(null, trimmed);
            }
        };

        try {
            while (true) {
                if (signal?.aborted) {
                    try {
                        await reader.cancel('Aborted by client');
                    } catch {
                        // Suppress lock error on cancel
                    }
                    const abortErr = new Error('Operation cancelled by user');
                    abortErr.name = 'AbortError';
                    emitError(abortErr);
                    return;
                }

                const { done, value } = await reader.read();
                if (done) break;

                const decoded = decoder.decode(value, { stream: true });
                if (!decoded) continue;

                if (!receivedFirstChunk) {
                    receivedFirstChunk = true;
                    if (firstChunkTimer) {
                        clearTimeout(firstChunkTimer);
                        firstChunkTimer = null;
                    }
                }

                lineBuffer += decoded;

                if (lineBuffer.length > MAX_LINE_BUFFER_CHARS) {
                    throw new AgentStreamError({
                        code: 'STREAM_BUFFER_OVERFLOW',
                        message: 'stream_buffer_overflow',
                        retryable: false,
                    });
                }

                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop() ?? '';

                for (const line of lines) {
                    processLine(line);
                }
            }

            const flushed = decoder.decode();
            if (flushed) {
                lineBuffer += flushed;
            }

            if (lineBuffer.trim()) {
                processLine(lineBuffer);
            }

            flushPendingSSEBlock();
        } finally {
            try {
                reader.releaseLock();
            } catch {
                // Ignore lock release error on completed reader
            }
        }

        if (signal?.aborted) {
            const abortErr = new Error('Operation cancelled by user');
            abortErr.name = 'AbortError';
            emitError(abortErr);
            return;
        }

        if (!isDoneReceived && !isInterruptReceived) {
            throw new AgentStreamError({
                code: 'FAILED_INCOMPLETE_STREAM',
                message: 'failed_incomplete_stream',
                retryable: true,
            });
        }

        if (!isTerminalCallbackEmitted) {
            emitDone({
                type: 'done',
                threadId: requestPayload.threadId,
                operationId: lastOperationId,
            });
        }
    } catch (err) {
        clearWatchdogTimers();

        const errName = err instanceof Error ? err.name : '';
        const errMessage =
            err instanceof Error
                ? err.message
                : typeof err === 'string'
                  ? err
                  : '';

        if (signal?.aborted || errName === 'AbortError') {
            const abortErr = new Error('Operation cancelled by user');
            abortErr.name = 'AbortError';
            emitError(abortErr);
            return;
        }

        if (err instanceof AgentStreamError) {
            emitError(err);
            return;
        }

        const isNetworkError =
            errName === 'TypeError' ||
            errMessage.includes('Failed to fetch') ||
            errMessage.includes('network error');

        const errorToEmit = isNetworkError
            ? new AgentStreamError({
                  code: 'NETWORK_ERROR',
                  message: 'Connection interrupted. Original content preserved.',
                  retryable: true,
              })
            : err instanceof Error
              ? err
              : new Error(errMessage || 'Unexpected streaming error');

        emitError(errorToEmit);
    }
}

export const consumeAIStream = consumeAgentStream;
