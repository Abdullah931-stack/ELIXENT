import { describe, it, expect, beforeEach } from 'vitest';
import {
    createStreamSession,
    transitionSession,
    isValidTransition,
    assertSessionIntegrity,
    isTerminalStatus,
    isActiveStreamStatus,
    nextSessionToken,
    getCurrentSessionToken,
    resetSessionTokenCounter,
    isSessionTokenValid,
    isStaleSessionEvent,
} from '@/lib/ai/stream-session';

describe('AIStreamSession State Machine, Monotonic Token & Integrity Guards (Phase 11 / Wave 11.1)', () => {
    beforeEach(() => {
        resetSessionTokenCounter();
    });

    describe('FSM States, Terminal & Active Predicates', () => {
        it('correctly identifies terminal session states (completed, aborted, failed)', () => {
            expect(isTerminalStatus('completed')).toBe(true);
            expect(isTerminalStatus('aborted')).toBe(true);
            expect(isTerminalStatus('failed')).toBe(true);

            expect(isTerminalStatus('idle')).toBe(false);
            expect(isTerminalStatus('running_graph')).toBe(false);
            expect(isTerminalStatus('awaiting_hitl')).toBe(false);
            expect(isTerminalStatus('paused_insufficient_credits')).toBe(false);
            expect(isTerminalStatus('streaming_hunks')).toBe(false);
            expect(isTerminalStatus('preview_ready')).toBe(false);
        });

        it('correctly identifies active in-progress session states', () => {
            expect(isActiveStreamStatus('running_graph')).toBe(true);
            expect(isActiveStreamStatus('awaiting_hitl')).toBe(true);
            expect(isActiveStreamStatus('streaming_hunks')).toBe(true);
            expect(isActiveStreamStatus('preview_ready')).toBe(true);

            expect(isActiveStreamStatus('idle')).toBe(false);
            expect(isActiveStreamStatus('paused_insufficient_credits')).toBe(false);
            expect(isActiveStreamStatus('completed')).toBe(false);
            expect(isActiveStreamStatus('aborted')).toBe(false);
            expect(isActiveStreamStatus('failed')).toBe(false);
        });

        it('allows canonical legal state transitions across the 8-state Agent Graph lifecycle', () => {
            expect(isValidTransition('idle', 'running_graph')).toBe(true);
            expect(isValidTransition('running_graph', 'awaiting_hitl')).toBe(true);
            expect(isValidTransition('awaiting_hitl', 'running_graph')).toBe(true);
            expect(isValidTransition('running_graph', 'streaming_hunks')).toBe(true);
            expect(isValidTransition('streaming_hunks', 'preview_ready')).toBe(true);
            expect(isValidTransition('preview_ready', 'completed')).toBe(true);
            expect(isValidTransition('completed', 'idle')).toBe(true);

            expect(isValidTransition('running_graph', 'preview_ready')).toBe(true);
            expect(isValidTransition('running_graph', 'completed')).toBe(true);
            expect(isValidTransition('awaiting_hitl', 'streaming_hunks')).toBe(true);
            expect(isValidTransition('awaiting_hitl', 'preview_ready')).toBe(true);
            expect(isValidTransition('completed', 'running_graph')).toBe(true);
            expect(isValidTransition('aborted', 'running_graph')).toBe(true);
            expect(isValidTransition('failed', 'running_graph')).toBe(true);
        });

        it('strictly rejects illegal transitions out of terminal states', () => {
            expect(isValidTransition('completed', 'preview_ready')).toBe(false);
            expect(isValidTransition('completed', 'streaming_hunks')).toBe(false);
            expect(isValidTransition('completed', 'awaiting_hitl')).toBe(false);
            expect(isValidTransition('aborted', 'completed')).toBe(false);
            expect(isValidTransition('aborted', 'preview_ready')).toBe(false);
            expect(isValidTransition('aborted', 'streaming_hunks')).toBe(false);
            expect(isValidTransition('failed', 'completed')).toBe(false);
            expect(isValidTransition('failed', 'preview_ready')).toBe(false);
            expect(isValidTransition('failed', 'streaming_hunks')).toBe(false);
        });

        it('executes full lifecycle on a session object with timestamps and defaults', () => {
            const session = createStreamSession({
                sessionId: 's-1',
                fileId: 'file-1',
                prompt: 'Design a resilient zero-knowledge sync layer',
                originalMarkdown: '# Test Heading\ntest',
                originalText: 'test',
                selection: { from: 0, to: 4 },
                expectedVersion: 1,
                originalEtag: 'etag-1',
                editorGeneration: 1,
            });

            expect(session.status).toBe('idle');
            expect(session.sessionToken).toBe(1);
            expect(session.threadId).toMatch(/^thread_/);
            expect(session.projectId).toBe('file-1');
            expect(session.targetFileIds).toEqual(['file-1']);
            expect(session.firstChunkAt).toBeUndefined();
            expect(session.completedAt).toBeUndefined();

            // idle -> running_graph (records firstChunkAt)
            transitionSession(session, 'running_graph');
            expect(session.status).toBe('running_graph');
            expect(session.firstChunkAt).toBeTypeOf('number');
            const initialFirstChunkAt = session.firstChunkAt;

            // running_graph -> awaiting_hitl
            transitionSession(session, 'awaiting_hitl');
            expect(session.status).toBe('awaiting_hitl');

            // awaiting_hitl -> running_graph -> streaming_hunks (preserves original firstChunkAt)
            transitionSession(session, 'running_graph');
            transitionSession(session, 'streaming_hunks');
            expect(session.status).toBe('streaming_hunks');
            expect(session.firstChunkAt).toBe(initialFirstChunkAt);

            // streaming_hunks -> preview_ready (records completedAt)
            transitionSession(session, 'preview_ready');
            expect(session.status).toBe('preview_ready');
            expect(session.completedAt).toBeTypeOf('number');

            // preview_ready -> completed -> idle
            transitionSession(session, 'completed');
            expect(session.status).toBe('completed');
            transitionSession(session, 'idle');
            expect(session.status).toBe('idle');
        });

        it('throws an error when attempting an invalid transition on a session', () => {
            const session = createStreamSession({
                sessionId: 's-err',
                fileId: 'file-err',
                originalMarkdown: '# Test Heading\ntest',
                originalText: 'test',
                expectedVersion: 1,
                originalEtag: 'etag-1',
                editorGeneration: 1,
            });

            transitionSession(session, 'aborted');

            // Illegal: aborted -> completed directly without running_graph
            expect(() => transitionSession(session, 'completed')).toThrowError(
                /Invalid transition/
            );
        });

        it('allows cancellation and failure transitions with failureReason recording', () => {
            const session = createStreamSession({
                sessionId: 's-2',
                fileId: 'file-2',
                originalMarkdown: 'hello world',
                originalText: 'hello',
                selection: { from: 0, to: 5 },
                expectedVersion: 1,
                originalEtag: 'etag-2',
                editorGeneration: 1,
            });

            transitionSession(session, 'running_graph');
            transitionSession(session, 'streaming_hunks');
            transitionSession(session, 'aborted', 'User clicked stop');
            expect(session.status).toBe('aborted');
            expect(session.failureReason).toBe('User clicked stop');
            expect(isTerminalStatus(session.status)).toBe(true);

            // Can reset back to idle and re-run
            transitionSession(session, 'idle');
            expect(session.status).toBe('idle');

            transitionSession(session, 'running_graph');
            transitionSession(session, 'failed', 'INSUFFICIENT_CREDITS (402)');
            expect(session.status).toBe('failed');
            expect(session.failureReason).toBe('INSUFFICIENT_CREDITS (402)');
            expect(isTerminalStatus(session.status)).toBe(true);
        });

        it.each([
            ['idle', 'paused_insufficient_credits', true],
            ['running_graph', 'paused_insufficient_credits', true],
            ['awaiting_hitl', 'paused_insufficient_credits', true],
            ['streaming_hunks', 'paused_insufficient_credits', true],
            ['preview_ready', 'paused_insufficient_credits', true],
            ['paused_insufficient_credits', 'paused_insufficient_credits', true],
            ['paused_insufficient_credits', 'running_graph', true],
            ['paused_insufficient_credits', 'aborted', true],
            ['paused_insufficient_credits', 'failed', true],
            ['paused_insufficient_credits', 'idle', true],
            ['paused_insufficient_credits', 'completed', false],
            ['paused_insufficient_credits', 'preview_ready', false],
            ['paused_insufficient_credits', 'streaming_hunks', false],
            ['paused_insufficient_credits', 'awaiting_hitl', false],
        ] as const)(
            'enforces paused_insufficient_credits FSM transition (%s -> %s = %s)',
            (from, to, expected) => {
                expect(isValidTransition(from, to)).toBe(expected);
            }
        );

        it('supports pause on INSUFFICIENT_CREDITS and deterministic resume back to running_graph -> completed', () => {
            const session = createStreamSession({
                sessionId: 's-credit-pause',
                fileId: 'file-credit-1',
                originalMarkdown: '# Spec',
                originalText: '# Spec',
                expectedVersion: 1,
                originalEtag: 'etag-1',
                editorGeneration: 1,
            });

            transitionSession(session, 'running_graph');
            const initialFirstChunkAt = session.firstChunkAt;

            transitionSession(
                session,
                'paused_insufficient_credits',
                'INSUFFICIENT_CREDITS: Credit balance exhausted.'
            );
            expect(session.status).toBe('paused_insufficient_credits');
            expect(session.failureReason).toBe('INSUFFICIENT_CREDITS: Credit balance exhausted.');
            expect(isTerminalStatus(session.status)).toBe(false);
            expect(() => transitionSession(session, 'completed')).toThrowError(/Invalid transition/);

            transitionSession(session, 'running_graph');
            expect(session.status).toBe('running_graph');
            expect(session.firstChunkAt).toBe(initialFirstChunkAt);

            transitionSession(session, 'completed');
            expect(session.status).toBe('completed');
            expect(session.completedAt).toBeTypeOf('number');
        });
    });

    describe('Monotonic Session Token Guards', () => {
        it('mints strictly increasing tokens and detects stale session events', () => {
            expect(getCurrentSessionToken()).toBe(0);
            const t1 = nextSessionToken();
            const t2 = nextSessionToken();
            expect(t1).toBe(1);
            expect(t2).toBe(2);
            expect(getCurrentSessionToken()).toBe(2);

            expect(isSessionTokenValid(2, 2)).toBe(true);
            expect(isSessionTokenValid(1, 2)).toBe(false);
            expect(isSessionTokenValid(0, 0)).toBe(false);

            const staleSession = createStreamSession({
                sessionId: 'sess-stale',
                sessionToken: t1,
                fileId: 'file-1',
                originalMarkdown: 'doc',
                originalText: 'doc',
                expectedVersion: 1,
                originalEtag: 'etag-1',
                editorGeneration: 1,
            });
            const activeSession = createStreamSession({
                sessionId: 'sess-active',
                sessionToken: t2,
                fileId: 'file-1',
                originalMarkdown: 'doc',
                originalText: 'doc',
                expectedVersion: 1,
                originalEtag: 'etag-1',
                editorGeneration: 1,
            });

            expect(isStaleSessionEvent(staleSession, activeSession)).toBe(true);
            expect(isStaleSessionEvent(activeSession, activeSession)).toBe(false);
            expect(isStaleSessionEvent(null, activeSession)).toBe(true);

            // Once abortController is aborted, events on that session are treated as stale
            activeSession.abortController.abort();
            expect(isStaleSessionEvent(activeSession, activeSession)).toBe(true);
        });
    });

    describe('Generation & Version Integrity Guards', () => {
        it('passes integrity assertion when generation and version match', () => {
            const session = createStreamSession({
                sessionId: 's-3',
                fileId: 'file-3',
                originalMarkdown: 'content here',
                originalText: 'content',
                selection: { from: 0, to: 7 },
                expectedVersion: 3,
                originalEtag: 'etag-3',
                editorGeneration: 2,
            });

            const check = assertSessionIntegrity(session, 2, 3);
            expect(check.valid).toBe(true);
        });

        it('rejects commit if editor generation changed (stale session)', () => {
            const session = createStreamSession({
                sessionId: 's-4',
                fileId: 'file-4',
                originalMarkdown: 'content here',
                originalText: 'content',
                selection: { from: 0, to: 7 },
                expectedVersion: 1,
                originalEtag: 'etag-4',
                editorGeneration: 1,
            });

            const check = assertSessionIntegrity(session, 2, 1);
            expect(check.valid).toBe(false);
            expect(check.reason).toContain('generation mismatch');
        });

        it('rejects commit if file version changed concurrently', () => {
            const session = createStreamSession({
                sessionId: 's-5',
                fileId: 'file-5',
                originalMarkdown: 'content here',
                originalText: 'content',
                selection: { from: 0, to: 7 },
                expectedVersion: 1,
                originalEtag: 'etag-5',
                editorGeneration: 1,
            });

            const check = assertSessionIntegrity(session, 1, 2);
            expect(check.valid).toBe(false);
            expect(check.reason).toContain('version mismatch');
        });
    });
});
