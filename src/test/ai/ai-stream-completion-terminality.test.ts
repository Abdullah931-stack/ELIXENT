/**
 * Runtime Remediation Tests: Agent Stream Terminality Guarantees (Phase 11 / Wave 11.1)
 *
 * Verifies the two classes of "stuck session / infinite loop" defects prevented in
 * `stream-handler.ts`:
 *
 * 1. Completion error routing: if `onDone` throws, the exception MUST be routed
 *    into `onError` (single terminal failure path) instead of escaping unhandled.
 *
 * 2. Provider stall watchdogs: a connection that never delivers a first byte must
 *    fail closed within `FIRST_CHUNK_TIMEOUT_MS` (`AI_STREAM_FIRST_CHUNK_TIMEOUT`),
 *    and streams exceeding `MAX_STREAM_DURATION_MS` fail with `AI_STREAM_DURATION_EXCEEDED`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    consumeAgentStream,
    FIRST_CHUNK_TIMEOUT_MS,
    MAX_STREAM_DURATION_MS,
} from '@/lib/ai/stream-handler';

const BASE_PAYLOAD = {
    threadId: 'thread-term-1',
    projectId: 'proj-term-1',
    targetFileIds: ['file-term-1'],
    prompt: 'Draft architecture specification',
};

function ndjsonResponse(frames: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const frame of frames) {
                controller.enqueue(encoder.encode(frame + '\n'));
            }
            controller.close();
        },
    });
    return new Response(stream, { status: 200 });
}

function stalledResponse(): Response {
    return new Response(
        new ReadableStream<Uint8Array>({
            start() {
                /* intentionally idle */
            },
        }),
        { status: 200 }
    );
}

describe('Agent Stream Completion Terminality (Wave 11.1)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('routes onDone handler exceptions into onError with a single terminal callback', async () => {
        const onDone = vi.fn(() => {
            throw new Error('post-done handler failure');
        });
        const onError = vi.fn();
        const onUpdate = vi.fn();

        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                ndjsonResponse([
                    JSON.stringify({ type: 'start', sessionId: 's1', threadId: 'thread-term-1', operationId: 'op1' }),
                    JSON.stringify({ type: 'update', chunk: { node: 'document_writer_node', text: 'hello world' } }),
                    JSON.stringify({ type: 'done', threadId: 'thread-term-1', operationId: 'op1' }),
                ])
            )
        );

        await consumeAgentStream({
            ...BASE_PAYLOAD,
            onUpdate,
            onDone,
            onError,
        });

        expect(onDone).toHaveBeenCalledTimes(1);
        expect(onUpdate).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'post-done handler failure' })
        );
    });

    it('emits no error when the onDone handler completes cleanly', async () => {
        const onDone = vi.fn(() => {
            /* clean completion */
        });
        const onError = vi.fn();

        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                ndjsonResponse([
                    JSON.stringify({ type: 'update', chunk: { node: 'document_writer_node', text: 'ok' } }),
                    JSON.stringify({ type: 'done', threadId: 'thread-term-1', operationId: 'op1' }),
                ])
            )
        );

        await consumeAgentStream({
            ...BASE_PAYLOAD,
            onDone,
            onError,
        });

        expect(onDone).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it('fails closed via the first-chunk watchdog when the provider stalls', async () => {
        vi.useFakeTimers();

        const onError = vi.fn();
        const onDone = vi.fn();

        vi.stubGlobal('fetch', vi.fn(async () => stalledResponse()));

        const pending = consumeAgentStream({
            ...BASE_PAYLOAD,
            onDone,
            onError,
        });

        await vi.advanceTimersByTimeAsync(FIRST_CHUNK_TIMEOUT_MS + 5);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('AI_STREAM_FIRST_CHUNK_TIMEOUT'),
            })
        );
        expect(onDone).not.toHaveBeenCalled();

        await expect(pending).resolves.toBeUndefined();
    });

    it('fails closed via the max-duration watchdog when a stream stays open past MAX_STREAM_DURATION_MS', async () => {
        vi.useFakeTimers();

        const onError = vi.fn();
        const onDone = vi.fn();

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        JSON.stringify({ type: 'start', sessionId: 's1', threadId: 'thread-term-1', operationId: 'op1' }) + '\n'
                    )
                );
            },
        });

        vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));

        const pending = consumeAgentStream({
            ...BASE_PAYLOAD,
            onDone,
            onError,
        });

        await vi.advanceTimersByTimeAsync(MAX_STREAM_DURATION_MS + 10);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('AI_STREAM_DURATION_EXCEEDED'),
            })
        );
        expect(onDone).not.toHaveBeenCalled();

        await expect(pending).resolves.toBeUndefined();
    });
});
