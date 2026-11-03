/**
 * Architectural Agent Stream Session State Machine
 *
 * Manages the client-side lifecycle of an autonomous LangGraph agent streaming
 * session, enforcing deterministic state transitions and monotonic session token
 * guards to discard stale asynchronous callbacks from superseded sessions.
 */

export type AIStreamStatus =
    | 'idle'
    | 'running_graph'
    | 'awaiting_hitl'
    | 'streaming_hunks'
    | 'preview_ready'
    | 'completed'
    | 'aborted'
    | 'failed';

export interface SelectionAnchor {
    from: number;
    to: number;
}

export interface AIStreamSession {
    sessionId: string;
    threadId: string;
    projectId: string;
    operationId: string;
    /** Monotonically increasing token guarding against stale async events from superseded sessions */
    sessionToken: number;
    fileId: string;
    targetFileIds: string[];
    prompt?: string;
    operation?: string;
    originalMarkdown: string;
    originalText: string;
    resultMarkdown?: string;
    selection: SelectionAnchor;
    expectedVersion: number;
    originalEtag: string | null;
    status: AIStreamStatus;
    reservationId?: string;
    correlationId?: string;
    periodKey?: string;
    editorGeneration: number;
    abortController: AbortController;
    startedAt: number;
    firstChunkAt?: number;
    completedAt?: number;
    failureReason?: string;
}

export type StreamSession = AIStreamSession;

/**
 * Finite state machine transition table for Phase 11 agent orchestration lifecycle.
 * Supports:
 * - idle -> running_graph -> awaiting_hitl -> running_graph
 * - running_graph -> streaming_hunks -> preview_ready -> completed
 * - direct transitions to aborted / failed / idle from any state
 */
const ALLOWED_TRANSITIONS: Record<AIStreamStatus, readonly AIStreamStatus[]> = {
    idle: [
        'idle',
        'running_graph',
        'awaiting_hitl',
        'streaming_hunks',
        'preview_ready',
        'completed',
        'aborted',
        'failed',
    ],
    running_graph: [
        'running_graph',
        'awaiting_hitl',
        'streaming_hunks',
        'preview_ready',
        'completed',
        'aborted',
        'failed',
        'idle',
    ],
    awaiting_hitl: [
        'awaiting_hitl',
        'running_graph',
        'streaming_hunks',
        'preview_ready',
        'completed',
        'aborted',
        'failed',
        'idle',
    ],
    streaming_hunks: [
        'streaming_hunks',
        'running_graph',
        'awaiting_hitl',
        'preview_ready',
        'completed',
        'aborted',
        'failed',
        'idle',
    ],
    preview_ready: [
        'preview_ready',
        'completed',
        'running_graph',
        'awaiting_hitl',
        'streaming_hunks',
        'aborted',
        'failed',
        'idle',
    ],
    completed: [
        'completed',
        'idle',
        'running_graph',
        'aborted',
        'failed',
    ],
    aborted: [
        'aborted',
        'idle',
        'running_graph',
    ],
    failed: [
        'failed',
        'idle',
        'running_graph',
    ],
};

let monotonicSessionTokenCounter = 0;

/**
 * Issues the next monotonically increasing session token.
 */
export function nextSessionToken(): number {
    monotonicSessionTokenCounter += 1;
    return monotonicSessionTokenCounter;
}

/**
 * Returns the latest issued monotonic session token.
 */
export function getCurrentSessionToken(): number {
    return monotonicSessionTokenCounter;
}

/**
 * Resets the monotonic session token counter (intended for deterministic test isolation).
 */
export function resetSessionTokenCounter(initialValue = 0): void {
    monotonicSessionTokenCounter = Math.max(0, Math.trunc(initialValue));
}

/**
 * Verifies whether a candidate session or token matches the active monotonic token.
 */
export function isSessionTokenValid(
    sessionOrToken: Pick<AIStreamSession, 'sessionToken'> | number | null | undefined,
    expectedToken: number = monotonicSessionTokenCounter
): boolean {
    if (sessionOrToken === null || sessionOrToken === undefined) {
        return false;
    }
    const token =
        typeof sessionOrToken === 'number'
            ? sessionOrToken
            : sessionOrToken.sessionToken;
    return typeof token === 'number' && token > 0 && token === expectedToken;
}

/**
 * Determines whether an incoming stream event belongs to a superseded or aborted session.
 */
export function isStaleSessionEvent(
    candidate: Pick<AIStreamSession, 'sessionId' | 'sessionToken' | 'abortController'> | null | undefined,
    active: Pick<AIStreamSession, 'sessionId' | 'sessionToken'> | null | undefined,
    eventSessionId?: string
): boolean {
    if (!candidate || !active) {
        return true;
    }
    if (candidate.abortController?.signal?.aborted) {
        return true;
    }
    if (candidate.sessionId !== active.sessionId) {
        return true;
    }
    if (candidate.sessionToken !== active.sessionToken) {
        return true;
    }
    if (eventSessionId !== undefined && eventSessionId !== active.sessionId) {
        return true;
    }
    return false;
}

/**
 * Validates if a state transition is permitted by the agent session FSM.
 */
export function isValidTransition(from: AIStreamStatus, to: AIStreamStatus): boolean {
    const allowed = ALLOWED_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
}

/**
 * Checks whether a session status is in a terminal final state.
 */
export function isTerminalStatus(status: AIStreamStatus): boolean {
    return status === 'completed' || status === 'aborted' || status === 'failed';
}

/**
 * Checks whether a session is actively executing or awaiting user action.
 */
export function isActiveStreamStatus(status: AIStreamStatus): boolean {
    return (
        status === 'running_graph' ||
        status === 'awaiting_hitl' ||
        status === 'streaming_hunks' ||
        status === 'preview_ready'
    );
}

export interface CreateStreamSessionParams {
    sessionId?: string;
    threadId?: string;
    projectId?: string;
    operationId?: string;
    sessionToken?: number;
    fileId: string;
    targetFileIds?: string[];
    prompt?: string;
    operation?: string;
    originalMarkdown?: string;
    originalText?: string;
    selection?: SelectionAnchor;
    expectedVersion?: number;
    originalEtag?: string | null;
    editorGeneration?: number;
    abortController?: AbortController;
    initialStatus?: AIStreamStatus;
}

/**
 * Creates a new agent streaming session state container with a monotonic token guard.
 */
export function createStreamSession(params: CreateStreamSessionParams): AIStreamSession {
    const token =
        typeof params.sessionToken === 'number' && params.sessionToken > 0
            ? params.sessionToken
            : nextSessionToken();
    const sessionId = params.sessionId || `session_${crypto.randomUUID()}`;
    const threadId = params.threadId || `thread_${crypto.randomUUID()}`;
    const operationId = params.operationId || `op_${crypto.randomUUID()}`;
    const projectId = params.projectId || params.fileId || 'default-project';
    const targetFileIds =
        Array.isArray(params.targetFileIds) && params.targetFileIds.length > 0
            ? [...params.targetFileIds]
            : params.fileId
              ? [params.fileId]
              : [];

    return {
        sessionId,
        threadId,
        projectId,
        operationId,
        sessionToken: token,
        fileId: params.fileId,
        targetFileIds,
        prompt: params.prompt,
        operation: params.operation,
        originalMarkdown: params.originalMarkdown ?? '',
        originalText: params.originalText ?? params.prompt ?? '',
        selection: params.selection ?? { from: 0, to: 0 },
        expectedVersion: params.expectedVersion ?? 1,
        originalEtag: params.originalEtag ?? null,
        status: params.initialStatus ?? 'idle',
        editorGeneration: params.editorGeneration ?? 1,
        abortController: params.abortController || new AbortController(),
        startedAt: Date.now(),
    };
}

/**
 * Transitions session to target status with strict FSM validation.
 */
export function transitionSession(
    session: AIStreamSession,
    nextStatus: AIStreamStatus,
    reason?: string
): AIStreamSession {
    if (!isValidTransition(session.status, nextStatus)) {
        throw new Error(
            `[AIStreamSession] Invalid transition from '${session.status}' to '${nextStatus}'`
        );
    }

    session.status = nextStatus;
    if (reason) {
        session.failureReason = reason;
    }

    if (
        (nextStatus === 'running_graph' || nextStatus === 'streaming_hunks') &&
        !session.firstChunkAt
    ) {
        session.firstChunkAt = Date.now();
    }

    if (nextStatus === 'preview_ready' || nextStatus === 'completed') {
        session.completedAt = Date.now();
    }

    return session;
}

/**
 * Asserts that the active editor generation and file version match the session anchor.
 */
export function assertSessionIntegrity(
    session: AIStreamSession,
    currentGeneration: number,
    currentVersion: number
): { valid: boolean; reason?: string } {
    if (session.editorGeneration !== currentGeneration) {
        return {
            valid: false,
            reason: `Editor generation mismatch (session: ${session.editorGeneration}, current: ${currentGeneration})`,
        };
    }

    if (session.expectedVersion !== currentVersion) {
        return {
            valid: false,
            reason: `File version mismatch (session: ${session.expectedVersion}, current: ${currentVersion})`,
        };
    }

    return { valid: true };
}
