import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    consumeAgentStream,
    consumeAIStream,
    parseHttpStreamError,
    AgentStreamError,
    type AgentStreamEvent,
    type AgentStreamGhostHunkProposedEvent,
    type AgentStreamFileMutatedEvent,
    type AgentStreamVaultFileCommitRequiredEvent,
    type AgentStreamInterruptEvent,
} from '@/lib/ai/stream-handler';
import { validateStreamMarkdownOutput } from '@/lib/parsers/stream-markdown';

const BASE_PAYLOAD = {
    threadId: 'thread-test-1',
    projectId: 'proj-test-1',
    targetFileIds: ['file-test-1'],
    prompt: 'Analyze architectural boundaries and propose sections',
};

describe('Agent SSE / NDJSON Stream Parser & Validator (Phase 11 / Wave 11.1)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('Stream Markdown Validator', () => {
        it('validates pure markdown stream outputs without HTML serialization', () => {
            const md = '# Title\n\n- Item 1\n- Item 2\n\n```js\nconsole.log(42);\n```';
            const validResult = validateStreamMarkdownOutput(md);
            expect(validResult.isValid).toBe(true);
            expect(validResult.isEmpty).toBe(false);
            expect(validResult.markdown).toBe(md);

            const emptyResult = validateStreamMarkdownOutput('   \n\t  ');
            expect(emptyResult.isValid).toBe(false);
            expect(emptyResult.isEmpty).toBe(true);
            expect(emptyResult.markdown).toBe('');
        });
    });

    describe('SSE & NDJSON Framing Transport (/api/agent/stream)', () => {
        it('correctly parses SSE and NDJSON events (start, update, done) split across chunk boundaries', async () => {
            const chunks = [
                'event: start\ndata: {"type":"start","sessionId":"s1","threadI',
                'd":"thread-test-1","operationId":"op1"}\n\n',
                'event: update\ndata: {"type":"update","chunk":{"node":"search_agent_node","text":"Hel',
                'lo, "}}\n\n{"type":"update","chunk":{"node":"document_writer_node","text":"world!"}}\n{"type":"done","threadId":"thread-test-1","operationId":"op1"}\n',
            ];

            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const chunk of chunks) {
                        controller.enqueue(encoder.encode(chunk));
                    }
                    controller.close();
                },
            });

            const fetchMock = vi.fn().mockResolvedValue(
                new Response(stream, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                })
            );
            vi.stubGlobal('fetch', fetchMock);

            let startEvent: unknown = null;
            const updateChunks: Array<Record<string, unknown>> = [];
            let doneEvent: unknown = null;

            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onStart: (ev) => {
                    startEvent = ev;
                },
                onUpdate: (ev) => {
                    updateChunks.push(ev.chunk);
                },
                onDone: (ev) => {
                    doneEvent = ev;
                },
                onError: (err) => {
                    throw err;
                },
            });

            expect(startEvent).toEqual({
                type: 'start',
                sessionId: 's1',
                threadId: 'thread-test-1',
                operationId: 'op1',
            });
            expect(updateChunks).toEqual([
                { node: 'search_agent_node', text: 'Hello, ' },
                { node: 'document_writer_node', text: 'world!' },
            ]);
            expect(doneEvent).toEqual({
                type: 'done',
                threadId: 'thread-test-1',
                operationId: 'op1',
            });
        });

        it('handles multi-byte UTF-8 characters split across chunk boundaries without corruption', async () => {
            const fullText = 'مرحبا بالعالم والذكاء الاصطناعي المعماري';
            const encoded = new TextEncoder().encode(
                `{"type":"start","sessionId":"s1","threadId":"thread-test-1","operationId":"op1"}\n` +
                    `{"type":"update","chunk":{"node":"document_writer_node","content":"${fullText}"}}\n` +
                    `{"type":"done","threadId":"thread-test-1","operationId":"op1"}\n`
            );

            // Intentionally slice byte array across multi-byte UTF-8 character boundary
            const slice1 = encoded.slice(0, 105);
            const slice2 = encoded.slice(105);

            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(slice1);
                    controller.enqueue(slice2);
                    controller.close();
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let receivedContent = '';
            await consumeAIStream({
                ...BASE_PAYLOAD,
                onUpdate: (ev) => {
                    if (typeof ev.chunk.content === 'string') {
                        receivedContent = ev.chunk.content;
                    }
                },
                onDone: () => {},
                onError: (err) => {
                    throw err;
                },
            });

            expect(receivedContent).toBe(fullText);
        });

        it('routes standalone interrupt events and inline __interrupt__ updates without triggering failed_incomplete_stream', async () => {
            const questionPayload = [
                {
                    questionId: 'q-db-1',
                    topicSlug: 'database-engine',
                    questionPrompt: 'Which primary database engine should back the ledger?',
                    contextExplanation: 'High write concurrency requires deterministic isolation.',
                    options: [
                        {
                            optionKey: 'opt_a',
                            neutralSummary: 'Neon PostgreSQL',
                            rationaleAndPremises: 'Serverless Postgres',
                        },
                        {
                            optionKey: 'opt_b',
                            neutralSummary: 'SQLite',
                            rationaleAndPremises: 'Embedded',
                        },
                    ],
                },
            ];

            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            `event: start\ndata: {"type":"start","sessionId":"s1","threadId":"thread-test-1","operationId":"op1"}\n\n` +
                                `event: interrupt\ndata: ${JSON.stringify({
                                    type: 'interrupt',
                                    threadId: 'thread-test-1',
                                    operationId: 'op1',
                                    interrupts: [{ value: questionPayload, resumable: true }],
                                })}\n\n`
                        )
                    );
                    controller.close(); // Stream closes after interrupt (graph suspended for HITL)
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let capturedInterrupt: unknown = null;
            let errorEmitted: unknown = null;

            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onInterrupt: (ev) => {
                    capturedInterrupt = ev;
                },
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(errorEmitted).toBeNull();
            expect(capturedInterrupt).toEqual({
                type: 'interrupt',
                threadId: 'thread-test-1',
                operationId: 'op1',
                interrupts: [{ value: questionPayload, resumable: true }],
            });
        });

        it('detects incomplete EOF stream without done or interrupt as failed_incomplete_stream', async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            '{"type":"start","sessionId":"s1","threadId":"thread-test-1","operationId":"op1"}\n' +
                                '{"type":"update","chunk":{"node":"search_agent_node","text":"Partial content..."}}\n'
                        )
                    );
                    controller.close(); // Abrupt EOF without done or interrupt frame
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onUpdate: () => {},
                onDone: () => {},
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(errorEmitted).not.toBeNull();
            expect(errorEmitted?.message).toContain('failed_incomplete_stream');
            expect(errorEmitted?.code).toBe('FAILED_INCOMPLETE_STREAM');
        });

        it('accepts first done and ignores duplicate done events', async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            '{"type":"start","sessionId":"s1","threadId":"thread-test-1","operationId":"op1"}\n' +
                                '{"type":"update","chunk":{"node":"document_writer_node","text":"Unique output"}}\n' +
                                '{"type":"done","threadId":"thread-test-1","operationId":"op1"}\n' +
                                '{"type":"done","threadId":"thread-test-1","operationId":"op1"}\n'
                        )
                    );
                    controller.close();
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let doneCalls = 0;

            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onDone: () => {
                    doneCalls++;
                },
                onError: (err) => {
                    throw err;
                },
            });

            expect(doneCalls).toBe(1);
        });

        it('safely ignores unknown message types and SSE comments without mutating state', async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            ': keep-alive comment\n' +
                                '{"type":"unknown_telemetry_event","timestamp":123456}\n' +
                                '{"type":"update","chunk":{"node":"document_writer_node","text":"Valid content"}}\n' +
                                '{"type":"custom_future_type","foo":"bar"}\n' +
                                '{"type":"done","threadId":"thread-test-1","operationId":"op1"}\n'
                        )
                    );
                    controller.close();
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            const updates: string[] = [];
            let doneCount = 0;

            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onUpdate: (ev) => {
                    if (typeof ev.chunk.text === 'string') {
                        updates.push(ev.chunk.text);
                    }
                },
                onDone: () => {
                    doneCount++;
                },
                onError: (err) => {
                    throw err;
                },
            });

            expect(updates).toEqual(['Valid content']);
            expect(doneCount).toBe(1);
        });

        it('aborts stream and emits AbortError when AbortSignal fires', async () => {
            const abortController = new AbortController();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            '{"type":"update","chunk":{"node":"search_agent_node","text":"Start..."}}\n'
                        )
                    );
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            await consumeAgentStream({
                ...BASE_PAYLOAD,
                signal: abortController.signal,
                onUpdate: () => {
                    abortController.abort();
                },
                onDone: () => {},
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(errorEmitted).not.toBeNull();
            expect(errorEmitted?.name).toBe('AbortError');
        });

        it('cleanly handles corrupted JSON frame and emits INVALID_STREAM_JSON without calling onDone', async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('data: {"type":"update", corrupted json\n\n'));
                    controller.close();
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            let doneCalled = false;

            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onDone: () => {
                    doneCalled = true;
                },
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(errorEmitted).not.toBeNull();
            expect(errorEmitted?.code).toBe('INVALID_STREAM_JSON');
            expect(doneCalled).toBe(false);
        });

        it('enforces MAX_LINE_BUFFER_CHARS and rejects buffer flooding with STREAM_BUFFER_OVERFLOW', async () => {
            const hugeChunk = 'a'.repeat(300 * 1024);
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(hugeChunk));
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onDone: () => {},
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(errorEmitted).not.toBeNull();
            expect(errorEmitted?.message).toContain('stream_buffer_overflow');
            expect(errorEmitted?.code).toBe('STREAM_BUFFER_OVERFLOW');
        });

        it('rejects invalid request payloads before network dispatch with INVALID_STREAM_PAYLOAD', async () => {
            const fetchSpy = vi.fn();
            vi.stubGlobal('fetch', fetchSpy);

            let errorEmitted: any = null;
            await consumeAgentStream({
                threadId: '',
                projectId: 'proj-1',
                targetFileIds: [],
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(fetchSpy).not.toHaveBeenCalled();
            expect(errorEmitted).toBeInstanceOf(AgentStreamError);
            expect(errorEmitted?.code).toBe('INVALID_STREAM_PAYLOAD');
        });

        it('parses HTTP status codes and structured JSON error payloads accurately', () => {
            const err402 = parseHttpStreamError(
                402,
                'Payment Required',
                JSON.stringify({ code: 'INSUFFICIENT_CREDITS', message: 'Quota exhausted' })
            );
            expect(err402.status).toBe(402);
            expect(err402.code).toBe('INSUFFICIENT_CREDITS');
            expect(err402.message).toContain('Quota exhausted');

            const err403Vault = parseHttpStreamError(
                403,
                'Forbidden',
                JSON.stringify({ code: 'VAULT_AI_ACCESS_DENIED', detail: 'Encrypted file' })
            );
            expect(err403Vault.code).toBe('VAULT_AI_ACCESS_DENIED');

            const err409 = parseHttpStreamError(409, 'Conflict', 'Thread locked');
            expect(err409.code).toBe('CONFLICT');

            const err429 = parseHttpStreamError(429, 'Too Many Requests', '');
            expect(err429.code).toBe('RATE_LIMIT_EXCEEDED');
            expect(err429.retryable).toBe(true);
        });
    });

    describe('Wave 4.1 Multi-File, ZK Commit & Native Interrupt Framing', () => {
        function sseStreamResponse(rawSse: string): Response {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(rawSse));
                    controller.close();
                },
            });
            return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
            });
        }

        it('dispatches ghost_hunk_proposed, file_mutated, and vault_file_commit_required frames without dropping events', async () => {
            const rawSse =
                `event: start\ndata: {"type":"start","sessionId":"s-w4","threadId":"thread-test-1","operationId":"op-w4"}\n\n` +
                // Header-only type fallback + non-object hunk filtering
                `event: ghost_hunk_proposed\ndata: ${JSON.stringify({
                    fileId: 'file-1',
                    headingSlug: 'auth-flow',
                    hunks: [
                        { from: 10, to: 24, replacementText: 'JWT Ed25519' },
                        null,
                        'stray-string',
                        ['nested-array'],
                    ],
                })}\n\n` +
                `event: file_mutated\ndata: ${JSON.stringify({
                    type: 'file_mutated',
                    fileId: 'file-2',
                    relativePath: 'docs/architecture.md',
                    action: 'created',
                })}\n\n` +
                `event: vault_file_commit_required\ndata: ${JSON.stringify({
                    type: 'vault_file_commit_required',
                    fileId: 'file-zk-1',
                    relativePath: 'vault/secrets.md',
                    mergedContent: '# Secrets\nRotated client-side',
                })}\n\n` +
                `event: done\ndata: {"type":"done","threadId":"thread-test-1","operationId":"op-w4"}\n\n`;

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseStreamResponse(rawSse)));

            const ghostHunks: AgentStreamGhostHunkProposedEvent[] = [];
            const mutations: AgentStreamFileMutatedEvent[] = [];
            const vaultCommits: AgentStreamVaultFileCommitRequiredEvent[] = [];
            const allEvents: AgentStreamEvent[] = [];

            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onEvent: (ev) => allEvents.push(ev),
                onGhostHunkProposed: (ev) => ghostHunks.push(ev),
                onFileMutated: (ev) => mutations.push(ev),
                onVaultFileCommitRequired: (ev) => vaultCommits.push(ev),
                onError: (err) => {
                    throw err;
                },
            });

            expect(ghostHunks).toEqual([
                {
                    type: 'ghost_hunk_proposed',
                    fileId: 'file-1',
                    headingSlug: 'auth-flow',
                    hunks: [{ from: 10, to: 24, replacementText: 'JWT Ed25519' }],
                },
            ]);
            expect(mutations).toEqual([
                {
                    type: 'file_mutated',
                    fileId: 'file-2',
                    relativePath: 'docs/architecture.md',
                    action: 'created',
                },
            ]);
            expect(vaultCommits).toEqual([
                {
                    type: 'vault_file_commit_required',
                    fileId: 'file-zk-1',
                    relativePath: 'vault/secrets.md',
                    mergedContent: '# Secrets\nRotated client-side',
                },
            ]);
            expect(allEvents.map((e) => e.type)).toEqual([
                'start',
                'ghost_hunk_proposed',
                'file_mutated',
                'vault_file_commit_required',
                'done',
            ]);
        });

        it.each(['created', 'updated', 'deleted'] as const)(
            'decodes file_mutated frames for action=%s',
            async (action) => {
                const rawSse =
                    `event: start\ndata: {"type":"start","sessionId":"s1","threadId":"thread-test-1","operationId":"op1"}\n\n` +
                    `event: file_mutated\ndata: ${JSON.stringify({
                        type: 'file_mutated',
                        fileId: `file-${action}`,
                        relativePath: `docs/${action}.md`,
                        action,
                    })}\n\n` +
                    `event: done\ndata: {"type":"done","threadId":"thread-test-1","operationId":"op1"}\n\n`;

                vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseStreamResponse(rawSse)));

                const received: AgentStreamFileMutatedEvent[] = [];
                await consumeAgentStream({
                    ...BASE_PAYLOAD,
                    onFileMutated: (ev) => received.push(ev),
                    onError: (err) => {
                        throw err;
                    },
                });

                expect(received).toEqual([
                    {
                        type: 'file_mutated',
                        fileId: `file-${action}`,
                        relativePath: `docs/${action}.md`,
                        action,
                    },
                ]);
            }
        );

        it.each([
            ['ghost_hunk_proposed missing hunks array', 'ghost_hunk_proposed', { type: 'ghost_hunk_proposed', fileId: 'f1', headingSlug: 'intro', hunks: 'not-array' }],
            ['ghost_hunk_proposed missing fileId', 'ghost_hunk_proposed', { type: 'ghost_hunk_proposed', headingSlug: 'intro', hunks: [] }],
            ['file_mutated invalid action', 'file_mutated', { type: 'file_mutated', fileId: 'f1', relativePath: 'a.md', action: 'renamed' }],
            ['file_mutated missing relativePath', 'file_mutated', { type: 'file_mutated', fileId: 'f1', action: 'updated' }],
            ['vault_file_commit_required missing mergedContent', 'vault_file_commit_required', { type: 'vault_file_commit_required', fileId: 'f1', relativePath: 'secret.md' }],
        ])('ignores malformed frame (%s) without crashing or firing mutation callbacks', async (_label, eventName, payload) => {
            const rawSse =
                `event: start\ndata: {"type":"start","sessionId":"s1","threadId":"thread-test-1","operationId":"op1"}\n\n` +
                `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n` +
                `event: done\ndata: {"type":"done","threadId":"thread-test-1","operationId":"op1"}\n\n`;

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseStreamResponse(rawSse)));

            const onGhostHunkProposed = vi.fn();
            const onFileMutated = vi.fn();
            const onVaultFileCommitRequired = vi.fn();
            const onDone = vi.fn();

            await consumeAgentStream({
                ...BASE_PAYLOAD,
                onGhostHunkProposed,
                onFileMutated,
                onVaultFileCommitRequired,
                onDone,
                onError: (err) => {
                    throw err;
                },
            });

            expect(onGhostHunkProposed).not.toHaveBeenCalled();
            expect(onFileMutated).not.toHaveBeenCalled();
            expect(onVaultFileCommitRequired).not.toHaveBeenCalled();
            expect(onDone).toHaveBeenCalledTimes(1);
        });

        it.each([
            {
                label: 'INSUFFICIENT_CREDITS with omitted interrupts array defaults resumable=false',
                frame: {
                    type: 'interrupt',
                    threadId: 'thread-test-1',
                    operationId: 'op-credit',
                    nodeId: 'assumption_extractor_node',
                    stepIndex: 3,
                    interruptReason: 'INSUFFICIENT_CREDITS',
                    interruptPayload: { availableMicro: 50, requiredMicro: 120_000 },
                },
                expectedResumable: false,
                expectedReason: 'INSUFFICIENT_CREDITS',
            },
            {
                label: 'INSUFFICIENT_CREDITS with interrupts item lacking explicit resumable defaults resumable=false',
                frame: {
                    type: 'interrupt',
                    threadId: 'thread-test-1',
                    operationId: 'op-credit-2',
                    nodeId: 'jev_conformal_scorer_node',
                    stepIndex: 4,
                    interruptReason: 'INSUFFICIENT_CREDITS',
                    interruptPayload: { availableMicro: 0, requiredMicro: 90_000 },
                    interrupts: [{ value: { code: 'INSUFFICIENT_CREDITS', availableMicro: 0 } }],
                },
                expectedResumable: false,
                expectedReason: 'INSUFFICIENT_CREDITS',
            },
            {
                label: 'HITL_CLARIFICATION_REQUIRED preserves node metadata, ns/when, and defaults resumable=true',
                frame: {
                    type: 'interrupt',
                    threadId: 'thread-test-1',
                    operationId: 'op-hitl',
                    nodeId: 'hitl_clarification_node',
                    stepIndex: 5,
                    interruptReason: 'HITL_CLARIFICATION_REQUIRED',
                    interruptPayload: { questionQueue: { questions: [{ questionId: 'q1' }] } },
                    interrupts: [
                        {
                            value: { questions: [{ questionId: 'q1' }], interruptReason: 'HITL_CLARIFICATION_REQUIRED' },
                            ns: ['graph', 'hitl'],
                            when: 'before_commit',
                        },
                    ],
                },
                expectedResumable: true,
                expectedReason: 'HITL_CLARIFICATION_REQUIRED',
            },
            {
                label: 'FILE_DELETION_APPROVAL_REQUIRED defaults resumable=true when synthesized from interruptPayload',
                frame: {
                    type: 'interrupt',
                    threadId: 'thread-test-1',
                    operationId: 'op-del',
                    nodeId: 'workspace_mutator_node',
                    stepIndex: 6,
                    interruptReason: 'FILE_DELETION_APPROVAL_REQUIRED',
                    interruptPayload: { targetFileId: 'file-obsolete' },
                },
                expectedResumable: true,
                expectedReason: 'FILE_DELETION_APPROVAL_REQUIRED',
            },
        ])(
            'preserves native interrupt metadata and resumable semantics: $label',
            async ({ frame, expectedResumable, expectedReason }) => {
                const rawSse =
                    `event: start\ndata: {"type":"start","sessionId":"s1","threadId":"thread-test-1","operationId":"${frame.operationId}"}\n\n` +
                    `event: interrupt\ndata: ${JSON.stringify(frame)}\n\n`;

                vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseStreamResponse(rawSse)));

                let receivedInterrupt: AgentStreamInterruptEvent | null = null;
                let receivedError: unknown = null;

                await consumeAgentStream({
                    ...BASE_PAYLOAD,
                    onInterrupt: (ev) => {
                        receivedInterrupt = ev;
                    },
                    onError: (err) => {
                        receivedError = err;
                    },
                });

                expect(receivedError).toBeNull();
                expect(receivedInterrupt).not.toBeNull();
                expect(receivedInterrupt).toMatchObject({
                    type: 'interrupt',
                    threadId: 'thread-test-1',
                    operationId: frame.operationId,
                    nodeId: frame.nodeId,
                    stepIndex: frame.stepIndex,
                    interruptReason: expectedReason,
                    interruptPayload: frame.interruptPayload,
                });
                expect(receivedInterrupt!.interrupts).toHaveLength(1);
                expect(receivedInterrupt!.interrupts[0].resumable).toBe(expectedResumable);
            }
        );

        it('omits synthesized workspaceId on the wire when caller only provides legacy projectId (both flat options and options.payload)', async () => {
            const fetchMock = vi.fn().mockImplementation(async () =>
                sseStreamResponse(
                    `event: start\ndata: {"type":"start","sessionId":"s1","threadId":"thread-test-1","operationId":"op1"}\n\n` +
                        `event: done\ndata: {"type":"done","threadId":"thread-test-1","operationId":"op1"}\n\n`
                )
            );
            vi.stubGlobal('fetch', fetchMock);

            // 1. Flat top-level options (projectId only)
            await consumeAgentStream({
                threadId: 'thread-legacy-flat',
                projectId: 'legacy-project-slug',
                targetFileIds: ['file-1'],
                prompt: 'Audit flat call',
                onError: (err) => {
                    throw err;
                },
            });

            const flatBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<
                string,
                unknown
            >;
            expect(flatBody.projectId).toBe('legacy-project-slug');
            expect('workspaceId' in flatBody).toBe(false);

            // 2. Structured payload (projectId only, with System 2 model & permissionMode)
            await consumeAgentStream({
                payload: {
                    threadId: 'thread-legacy-payload',
                    projectId: 'legacy-project-slug-2',
                    targetFileIds: ['file-2'],
                    selectedSystem2ModelId: 'google/gemini-3.1-pro',
                    permissionMode: 'full_auto',
                    resumePayload: { resumeReason: 'INSUFFICIENT_CREDITS' },
                },
                onError: (err) => {
                    throw err;
                },
            });

            const payloadBody = JSON.parse(fetchMock.mock.calls[1][1].body as string) as Record<
                string,
                unknown
            >;
            expect(payloadBody.projectId).toBe('legacy-project-slug-2');
            expect(payloadBody.selectedSystem2ModelId).toBe('google/gemini-3.1-pro');
            expect(payloadBody.permissionMode).toBe('full_auto');
            expect('workspaceId' in payloadBody).toBe(false);

            // 3. Explicit workspaceId MUST be preserved verbatim on the wire
            const explicitWorkspaceId = '550e8400-e29b-41d4-a716-446655440099';
            await consumeAgentStream({
                payload: {
                    threadId: 'thread-explicit-ws',
                    workspaceId: explicitWorkspaceId,
                    targetFileIds: ['file-3'],
                },
                onError: (err) => {
                    throw err;
                },
            });

            const explicitBody = JSON.parse(fetchMock.mock.calls[2][1].body as string) as Record<
                string,
                unknown
            >;
            expect(explicitBody.workspaceId).toBe(explicitWorkspaceId);
        });
    });
});
