import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import type { EditorAdapter, GhostHunk } from '@/components/editor/markdown/types';
import {
    type AIStreamSession,
    type AIStreamStatus,
    createStreamSession,
    transitionSession,
    isTerminalStatus,
    isStaleSessionEvent,
} from '@/lib/ai/stream-session';
import {
    consumeAgentStream,
    AgentStreamError,
    type AgentStreamRequestPayload,
    type AgentStreamInterruptEvent,
} from '@/lib/ai/stream-handler';
import {
    ClarificationResponseSchema,
    type ClarificationResponse,
    type SectionTarget,
} from '@/core/agent/schemas/decision-schemas';
import {
    reduceMasterLedger,
    reduceInvalidationMap,
    type ClarifyingQuestionBatch,
} from '@/core/agent/reducers';
import type { ATMSDecisionNode } from '@/core/agent/atms/dag';
import { extractSectionBySlug } from '@/core/ast/heading-slicer';
import { MAX_RECORD_KEYS } from '@/core/agent/stream-payload';
import { sessionKeyStore } from '@/lib/sync/session-key-store';
import { indexedDBManager } from '@/lib/sync/indexeddb';
import type { IDBFile, IDBOperation } from '@/lib/sync/idb-types';
import { SyncCryptoGateway } from '@/lib/sync/sync-crypto-gateway';
import { getFile, getUserFiles, toggleFileEncryption } from '@/client/rpc-client';
import { useOptionalWorkspaceTabs } from '@/components/editor/workspace-tab-bar';

export interface AgentMutatedFileRecord {
    fileId: string;
    relativePath?: string;
    action: 'created' | 'deleted' | 'updated';
    postTurnEtag?: string;
}

export interface AgentMutatedTurn {
    turnId: string;
    threadId: string;
    workspaceId: string;
    prompt?: string;
    timestamp: number;
    mutatedFiles: AgentMutatedFileRecord[];
    isReverted?: boolean;
}

const ZK_AI_NOTICE_STORAGE_KEY = 'elixent_zk_ai_notice_shown';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EditorInstance = EditorAdapter;

export interface UseAIStreamOptions {
    fileId?: string;
    workspaceId?: string;
    projectId?: string;
    userId?: string | null;
    threadId?: string;
    editor?: EditorInstance | null;
    getEditor?: () => EditorInstance | null;
    getLiveContent?: () => string;
    isEncrypted?: boolean | (() => boolean);
    allowAIOnEncryptedFiles?: boolean | (() => boolean);
    isVaultUnlocked?: () => boolean;
    onVaultLocked?: () => void;
    onVaultAiNotice?: (message: string) => void;
    onStreamStart?: () => void;
    onError?: (error: Error) => void;
    onHunkAccepted?: (updatedContent: string, hunkId: string, remainingCount: number) => void;
    onAllHunksAccepted?: (updatedContent: string) => void;
    onHunkRejected?: (hunkId: string, remainingCount: number) => void;
    onAllHunksRejected?: () => void;
    getLatestVersion?: () => number;
    getLatestETag?: () => string | null;
    /**
     * Wraps programmatic document mutations so the orchestrator can raise its
     * `isProgrammaticUpdate` guard and avoid misclassifying them as manual user edits.
     */
    onProgrammaticTransaction?: (fn: () => void) => void;
}

export interface StartAgentSessionParams {
    prompt: string;
    targetFileIds?: string[];
    fileId?: string;
    projectId?: string;
    threadId?: string;
    editor?: EditorInstance | null;
    expectedVersion?: number;
    originalEtag?: string | null;
    editorGeneration?: number;
    isEncrypted?: boolean;
    allowAIOnEncryptedFiles?: boolean;
    ephemeralVaultPayloads?: Record<string, string>;
    liveDocumentSnapshots?: Record<string, string>;
    selectedSystem2ModelId?: string;
    permissionMode?: 'safe' | 'semi_auto' | 'full_auto';
}

const KNOWN_STATE_CHANNELS = new Set([
    'messages',
    'user_request',
    'search_report',
    'local_inspection_state',
    'assumptions',
    'master_ledger',
    'masterLedger',
    'project_taxonomy',
    'unresolved_ledger',
    'invalidation_map',
    'invalidationMap',
    'question_queue',
    'questionQueue',
    'budget_tracking',
    'search_loop_count',
    'synthesized_sections',
    'synthesizedSections',
    'merged_sections',
    'mergedSections',
    'hunks',
    'ghostHunks',
    'ghost_hunks',
    'type',
]);

function inferStageFromUpdateChunk(chunk: Record<string, unknown>): string | null {
    if (typeof chunk.stage === 'string' && chunk.stage.trim()) {
        return chunk.stage.trim();
    }
    if (typeof chunk.node === 'string' && chunk.node.trim()) {
        return chunk.node.trim();
    }

    for (const key of Object.keys(chunk)) {
        if (key.endsWith('_node')) {
            return key;
        }
    }

    for (const [key, val] of Object.entries(chunk)) {
        if (
            !KNOWN_STATE_CHANNELS.has(key) &&
            val !== null &&
            typeof val === 'object' &&
            !Array.isArray(val)
        ) {
            return key;
        }
    }

    return null;
}

function collectCandidatePayloads(chunk: Record<string, unknown>): Record<string, unknown>[] {
    const payloads: Record<string, unknown>[] = [chunk];
    for (const [key, value] of Object.entries(chunk)) {
        if (
            !KNOWN_STATE_CHANNELS.has(key) &&
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value)
        ) {
            payloads.push(value as Record<string, unknown>);
        }
    }
    return payloads;
}

function normalizeQuestionsList(
    rawQuestions: unknown
): ClarifyingQuestionBatch['questions'] {
    if (!Array.isArray(rawQuestions)) {
        return [];
    }

    const normalized: Array<{
        readonly questionId: string;
        readonly topicSlug: string;
        readonly questionPrompt: string;
        readonly options: ReadonlyArray<{
            readonly optionKey: string;
            readonly neutralSummary: string;
            readonly rationaleAndPremises: string;
        }>;
        readonly contextExplanation?: string;
    }> = [];

    for (const item of rawQuestions) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const questionId =
            typeof rec.questionId === 'string'
                ? rec.questionId
                : typeof rec.id === 'string'
                  ? rec.id
                  : '';
        const questionPrompt =
            typeof rec.questionPrompt === 'string'
                ? rec.questionPrompt
                : typeof rec.prompt === 'string'
                  ? rec.prompt
                  : '';
        if (!questionId && !questionPrompt) continue;

        const rawOptions = Array.isArray(rec.options) ? rec.options : [];
        const options = rawOptions
            .filter((opt): opt is Record<string, unknown> => Boolean(opt && typeof opt === 'object'))
            .map((opt) => ({
                optionKey: String(opt.optionKey ?? opt.key ?? ''),
                neutralSummary: String(opt.neutralSummary ?? opt.summary ?? opt.label ?? ''),
                rationaleAndPremises: String(opt.rationaleAndPremises ?? opt.rationale ?? ''),
            }));

        normalized.push({
            questionId: questionId || `q_${normalized.length + 1}`,
            topicSlug: typeof rec.topicSlug === 'string' ? rec.topicSlug : questionId || 'general',
            questionPrompt,
            options,
            ...(typeof rec.contextExplanation === 'string'
                ? { contextExplanation: rec.contextExplanation }
                : {}),
        });
    }

    return normalized;
}

function extractQuestionsFromPayloads(
    payloads: readonly Record<string, unknown>[]
): ClarifyingQuestionBatch['questions'] | null {
    for (const payload of payloads) {
        const qQueue = payload.question_queue ?? payload.questionQueue;
        if (qQueue && typeof qQueue === 'object' && !Array.isArray(qQueue)) {
            const qRecord = qQueue as Record<string, unknown>;
            if (Array.isArray(qRecord.questions)) {
                return normalizeQuestionsList(qRecord.questions);
            }
        }
        if (Array.isArray(qQueue)) {
            return normalizeQuestionsList(qQueue);
        }
        if (Array.isArray(payload.questions)) {
            return normalizeQuestionsList(payload.questions);
        }
    }
    return null;
}

function extractRawSectionEntries(
    payloads: readonly Record<string, unknown>[]
): Array<Record<string, unknown>> {
    const entries: Array<Record<string, unknown>> = [];

    for (const payload of payloads) {
        const arrayCandidates = [
            payload.hunks,
            payload.ghostHunks,
            payload.ghost_hunks,
            payload.synthesized_sections,
            payload.synthesizedSections,
            payload.merged_sections,
            payload.mergedSections,
        ];

        for (const candidate of arrayCandidates) {
            if (Array.isArray(candidate)) {
                for (const item of candidate) {
                    if (item && typeof item === 'object' && !Array.isArray(item)) {
                        entries.push(item as Record<string, unknown>);
                    }
                }
            } else if (candidate && typeof candidate === 'object') {
                for (const [key, val] of Object.entries(candidate as Record<string, unknown>)) {
                    const slug = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key;
                    if (typeof val === 'string') {
                        entries.push({
                            headingSlug: slug,
                            replacementText: val,
                        });
                    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
                        entries.push({
                            headingSlug: slug,
                            ...(val as Record<string, unknown>),
                        });
                    }
                }
            }
        }
    }

    return entries;
}

/**
 * useAIStream: Client-side Architectural Agent Streaming & Multi-Hunk Ghost Hook (Phase 11).
 *
 * Connects directly to `POST /api/agent/stream` (`ELIXENT-ARCH-03` §4 & §5), managing:
 * 1. Ephemeral Zero-Knowledge Vault payload hydration (`ephemeralVaultPayloads`) when unlocked & opted-in.
 * 2. Live document snapshot transmission (`liveDocumentSnapshots`) for 3-way Diff3 section merging.
 * 3. Reactive 7-stage LangGraph progress (`agentGraphStage`), `masterDecisionLedger`, and `activeQuestionQueue`.
 * 4. Multi-Hunk Ghost session lifecycle (`activeGhostHunks`, `acceptGhostHunk`, `rejectGhostHunk`,
 *    `acceptAllGhostHunks`, `rejectAllGhostHunks`) with monotonic session token guards.
 */
export function useAIStream(options: UseAIStreamOptions = {}) {
    const [status, setStatus] = useState<AIStreamStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [isConflict, setIsConflict] = useState<boolean>(false);
    const [previewText, setPreviewText] = useState<string>('');
    const [agentGraphStage, setAgentGraphStage] = useState<string | null>(null);
    const [activeQuestionQueue, setActiveQuestionQueue] = useState<
        ClarifyingQuestionBatch['questions']
    >([]);
    const [masterDecisionLedger, setMasterDecisionLedger] = useState<
        Record<string, ATMSDecisionNode>
    >({});
    const [activeGhostHunks, setActiveGhostHunks] = useState<GhostHunk[]>([]);
    const [selectedSystem2ModelId, setSelectedSystem2ModelId] = useState<string>(
        'google/gemini-3.8-flash'
    );
    const [permissionMode, setPermissionMode] = useState<'safe' | 'semi_auto' | 'full_auto'>(
        'safe'
    );
    const [clientGeneratedThreadId] = useState<string>(() => `thread_${crypto.randomUUID()}`);
    const [sessionThreadId, setSessionThreadId] = useState<string | null>(null);
    const [ghostHunksByFileId, setGhostHunksByFileId] = useState<Record<string, GhostHunk[]>>({});
    const [mutatedTurns, setMutatedTurns] = useState<AgentMutatedTurn[]>([]);
    const [zkAiNotice, setZkAiNotice] = useState<string | null>(null);

    const workspaceTabs = useOptionalWorkspaceTabs();
    const workspaceTabsRef = useRef(workspaceTabs);
    const rawExplicitWorkspaceId = options.workspaceId || workspaceTabs?.activeWorkspaceId || '';
    const explicitWorkspaceId = UUID_REGEX.test(rawExplicitWorkspaceId)
        ? rawExplicitWorkspaceId
        : undefined;
    const effectiveWorkspaceId =
        rawExplicitWorkspaceId || options.projectId || options.fileId || '';

    const activeThreadId = options.threadId || sessionThreadId || clientGeneratedThreadId;

    const optsRef = useRef<UseAIStreamOptions>(options);
    const threadIdRef = useRef<string>(activeThreadId);
    const selectedSystem2ModelIdRef = useRef<string>(selectedSystem2ModelId);
    const permissionModeRef = useRef<'safe' | 'semi_auto' | 'full_auto'>(permissionMode);
    const effectiveWorkspaceIdRef = useRef<string>(effectiveWorkspaceId);
    const explicitWorkspaceIdRef = useRef<string | undefined>(explicitWorkspaceId);
    useLayoutEffect(() => {
        optsRef.current = options;
        threadIdRef.current = activeThreadId;
        selectedSystem2ModelIdRef.current = selectedSystem2ModelId;
        permissionModeRef.current = permissionMode;
        workspaceTabsRef.current = workspaceTabs;
        effectiveWorkspaceIdRef.current = effectiveWorkspaceId;
        explicitWorkspaceIdRef.current = explicitWorkspaceId;
    });

    const activeSessionRef = useRef<AIStreamSession | null>(null);
    const editorRef = useRef<EditorInstance | null>(options.editor ?? null);
    const projectIdRef = useRef<string>(options.projectId || options.fileId || 'default-project');
    const targetFileIdsRef = useRef<string[]>(options.fileId ? [options.fileId] : []);
    const masterDecisionLedgerRef = useRef<Record<string, ATMSDecisionNode>>({});
    const sessionInvalidationMapRef = useRef<Record<string, SectionTarget[]>>({});
    const activeGhostHunksRef = useRef<GhostHunk[]>([]);
    const ghostHunksByFileIdRef = useRef<Record<string, GhostHunk[]>>({});
    const turnIdByHunkIdRef = useRef<Record<string, string>>({});
    const currentTurnIdRef = useRef<string | null>(null);
    const currentTurnPromptRef = useRef<string | undefined>(undefined);
    const preTurnSnapshotsRef = useRef<Record<string, NonNullable<IDBOperation['snapshot']>>>({});
    const ghostSessionStartedRef = useRef<boolean>(false);
    const acceptedHunkCountRef = useRef<number>(0);
    const lastAllHunksAcceptedPromiseRef = useRef<Promise<unknown> | null>(null);

    const acceptGhostHunkRef = useRef<((hunkId: string) => string | null) | null>(null);
    const rejectGhostHunkRef = useRef<((hunkId: string) => void) | null>(null);
    const stopStreamRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (options.editor) {
            editorRef.current = options.editor;
        }
    }, [options.editor]);

    useEffect(() => {
        if (options.fileId) {
            if (!options.projectId && projectIdRef.current === 'default-project') {
                projectIdRef.current = options.fileId;
            }
            if (targetFileIdsRef.current.length === 0) {
                targetFileIdsRef.current = [options.fileId];
            }
        }
    }, [options.fileId, options.projectId]);

    const resolveEditor = useCallback(
        (overrideEditor?: EditorInstance | null): EditorInstance | null => {
            if (overrideEditor) {
                editorRef.current = overrideEditor;
                return overrideEditor;
            }
            const fromGetter = optsRef.current.getEditor?.();
            if (fromGetter) {
                editorRef.current = fromGetter;
                return fromGetter;
            }
            if (optsRef.current.editor) {
                editorRef.current = optsRef.current.editor;
                return optsRef.current.editor;
            }
            return editorRef.current;
        },
        []
    );

    const resolveLiveContent = useCallback(
        (editor: EditorInstance | null): string => {
            if (typeof optsRef.current.getLiveContent === 'function') {
                const live = optsRef.current.getLiveContent();
                if (typeof live === 'string') return live;
            }
            const anyEditor = editor as (EditorInstance & { getContent?: () => string }) | null;
            if (typeof anyEditor?.getContent === 'function') {
                return anyEditor.getContent();
            }
            if (typeof editor?.getValue === 'function') {
                return editor.getValue();
            }
            return '';
        },
        []
    );

    const runAsProgrammaticTransaction = useCallback((fn: () => void): void => {
        if (optsRef.current.onProgrammaticTransaction) {
            optsRef.current.onProgrammaticTransaction(fn);
        } else {
            fn();
        }
    }, []);

    const clearEditorGhostDecorations = useCallback(
        (editor: EditorInstance | null): void => {
            if (!editor) return;
            runAsProgrammaticTransaction(() => {
                if (typeof editor.clearGhostSession === 'function') {
                    editor.clearGhostSession();
                } else if (typeof editor.clearStreamingGhost === 'function') {
                    editor.clearStreamingGhost();
                }
            });
        },
        [runAsProgrammaticTransaction]
    );

    useEffect(() => {
        return () => {
            if (activeSessionRef.current) {
                activeSessionRef.current.abortController.abort();
                activeSessionRef.current = null;
            }
        };
    }, []);

    // Load persisted pending ghost hunks for the active workspace from IndexedDB
    useEffect(() => {
        const wsId = effectiveWorkspaceId;
        if (!wsId || wsId === 'default-project' || wsId === 'default-file') return;
        let cancelled = false;
        indexedDBManager
            .loadPendingGhostHunks(wsId)
            .then((persisted) => {
                if (cancelled || !persisted) return;
                const nextMap: Record<string, GhostHunk[]> = {};
                for (const [fId, hunks] of Object.entries(persisted.ghostHunksByFileId || {})) {
                    if (Array.isArray(hunks) && hunks.length > 0) {
                        nextMap[fId] = [...hunks];
                    }
                }
                ghostHunksByFileIdRef.current = nextMap;
                turnIdByHunkIdRef.current = { ...(persisted.turnIdByHunkId || {}) };
                setGhostHunksByFileId(nextMap);
            })
            .catch(() => {
                // Ignore IDB errors in constrained/test environments
            });
        return () => {
            cancelled = true;
        };
    }, [effectiveWorkspaceId]);

    const persistGhostHunksForFile = useCallback(
        (targetFileId: string, hunks: GhostHunk[], turnId?: string): void => {
            if (!targetFileId) return;
            const nextMap = { ...ghostHunksByFileIdRef.current };
            const nextTurnMap = { ...turnIdByHunkIdRef.current };

            if (hunks.length > 0) {
                nextMap[targetFileId] = hunks;
                if (turnId) {
                    for (const h of hunks) {
                        nextTurnMap[h.hunkId] = turnId;
                    }
                }
            } else {
                const prevHunks = nextMap[targetFileId] || [];
                for (const h of prevHunks) {
                    delete nextTurnMap[h.hunkId];
                }
                delete nextMap[targetFileId];
            }

            ghostHunksByFileIdRef.current = nextMap;
            turnIdByHunkIdRef.current = nextTurnMap;
            setGhostHunksByFileId(nextMap);

            try {
                workspaceTabsRef.current?.setGhostHunksForFile(targetFileId, hunks, turnId);
            } catch {
                // Ignore if provider not mounted
            }

            const wsId = effectiveWorkspaceIdRef.current;
            if (wsId && wsId !== 'default-project' && wsId !== 'default-file') {
                indexedDBManager
                    .savePendingGhostHunks(wsId, {
                        ghostHunksByFileId: nextMap,
                        turnIdByHunkId: nextTurnMap,
                    })
                    .catch(() => {
                        // Ignore IDB persistence errors in unit tests
                    });
            }
        },
        []
    );

    const recordTurnMutation = useCallback(
        (turnId: string, threadId: string, workspaceId: string, record: AgentMutatedFileRecord): void => {
            setMutatedTurns((prev) => {
                const existingIdx = prev.findIndex((t) => t.turnId === turnId);
                if (existingIdx >= 0) {
                    const existing = prev[existingIdx];
                    const fileIdx = existing.mutatedFiles.findIndex((f) => f.fileId === record.fileId);
                    const nextFiles = [...existing.mutatedFiles];
                    if (fileIdx >= 0) {
                        nextFiles[fileIdx] = { ...nextFiles[fileIdx], ...record };
                    } else {
                        nextFiles.push(record);
                    }
                    const next = [...prev];
                    next[existingIdx] = { ...existing, mutatedFiles: nextFiles, isReverted: false };
                    return next;
                }
                return [
                    ...prev,
                    {
                        turnId,
                        threadId,
                        workspaceId,
                        prompt: currentTurnPromptRef.current,
                        timestamp: Date.now(),
                        mutatedFiles: [record],
                        isReverted: false,
                    },
                ];
            });
        },
        []
    );

    const markTurnReverted = useCallback((turnId: string): void => {
        setMutatedTurns((prev) =>
            prev.map((t) => (t.turnId === turnId ? { ...t, isReverted: true } : t))
        );
    }, []);

    const markSessionReverted = useCallback((): void => {
        setMutatedTurns((prev) => prev.map((t) => ({ ...t, isReverted: true })));
    }, []);

    const upsertHunksIntoSession = useCallback(
        (
            session: AIStreamSession,
            editor: EditorInstance | null,
            incomingHunks: GhostHunk[]
        ): void => {
            if (incomingHunks.length === 0) return;

            if (session.status !== 'streaming_hunks' && session.status !== 'preview_ready') {
                transitionSession(session, 'streaming_hunks');
                setStatus('streaming_hunks');
            }

            const hydratedHunks = incomingHunks.map((hunk) => ({
                ...hunk,
                onApply: () => {
                    acceptGhostHunkRef.current?.(hunk.hunkId);
                },
                onReject: () => {
                    rejectGhostHunkRef.current?.(hunk.hunkId);
                },
                onStop: () => {
                    stopStreamRef.current?.();
                },
            }));

            if (editor && !ghostSessionStartedRef.current) {
                ghostSessionStartedRef.current = true;
                if (typeof editor.startGhostSession === 'function') {
                    editor.startGhostSession(session.sessionId, hydratedHunks);
                }
            }

            const nextList = [...activeGhostHunksRef.current];
            for (const hunk of hydratedHunks) {
                const existingIndex = nextList.findIndex((h) => h.hunkId === hunk.hunkId);
                if (existingIndex >= 0) {
                    nextList[existingIndex] = hunk;
                } else {
                    nextList.push(hunk);
                }
                if (editor && typeof editor.upsertGhostHunk === 'function') {
                    editor.upsertGhostHunk(hunk);
                }
            }

            activeGhostHunksRef.current = nextList;
            setActiveGhostHunks(nextList);
            if (session.fileId) {
                persistGhostHunksForFile(
                    session.fileId,
                    nextList,
                    currentTurnIdRef.current ?? undefined
                );
            }
            if (nextList.length > 0) {
                setPreviewText(nextList.map((h) => h.replacementText).join('\n\n'));
            }
        },
        [persistGhostHunksForFile]
    );

    const hydrateGhostHunksForFile = useCallback(
        (targetFileId: string, editorOverride?: EditorInstance | null): void => {
            if (!targetFileId) return;
            const pending = ghostHunksByFileIdRef.current[targetFileId];
            if (!pending || pending.length === 0) return;
            const editor = resolveEditor(editorOverride);
            const hydratedHunks: GhostHunk[] = pending.map((hunk) => ({
                ...hunk,
                status: 'preview_ready',
                onApply: () => acceptGhostHunkRef.current?.(hunk.hunkId),
                onReject: () => rejectGhostHunkRef.current?.(hunk.hunkId),
                onStop: () => stopStreamRef.current?.(),
            }));
            activeGhostHunksRef.current = hydratedHunks;
            setActiveGhostHunks(hydratedHunks);
            if (editor) {
                if (typeof editor.startGhostSession === 'function') {
                    ghostSessionStartedRef.current = true;
                    editor.startGhostSession(`hydrated_${targetFileId}`, hydratedHunks);
                } else if (typeof editor.upsertGhostHunk === 'function') {
                    for (const hunk of hydratedHunks) {
                        editor.upsertGhostHunk(hunk);
                    }
                }
            }
            setStatus('preview_ready');
        },
        [resolveEditor]
    );

    const buildGhostHunksFromRawEntries = useCallback(
        (
            rawEntries: ReadonlyArray<Record<string, unknown>>,
            liveContent: string,
            ledger: Record<string, ATMSDecisionNode>,
            preserveRawOffsets = false
        ): GhostHunk[] => {
            const constructed: GhostHunk[] = [];

            for (let i = 0; i < rawEntries.length; i++) {
                const entry = rawEntries[i];
                const headingSlug =
                    typeof entry.headingSlug === 'string' && entry.headingSlug.trim()
                        ? entry.headingSlug.trim()
                        : typeof entry.slug === 'string' && entry.slug.trim()
                          ? entry.slug.trim()
                          : typeof entry.sectionSlug === 'string' && entry.sectionSlug.trim()
                            ? entry.sectionSlug.trim()
                            : `section-${i + 1}`;

                const hunkId =
                    typeof entry.hunkId === 'string' && entry.hunkId.trim()
                        ? entry.hunkId.trim()
                        : typeof entry.id === 'string' && entry.id.trim()
                          ? entry.id.trim()
                          : `hunk_${headingSlug}`;

                const relatedDecisionIds = Array.isArray(entry.decisionIds)
                    ? entry.decisionIds.map(String)
                    : Object.values(ledger)
                          .filter((node) =>
                              node.affectedSections?.some((sec) => sec.headingSlug === headingSlug)
                          )
                          .map((node) => node.decisionId);

                const hunkRange =
                    entry.hunkRange &&
                    typeof entry.hunkRange === 'object' &&
                    !Array.isArray(entry.hunkRange)
                        ? (entry.hunkRange as Record<string, unknown>)
                        : null;

                let from: number;
                let to: number;
                let originalSlice: string;

                if (typeof entry.from === 'number' && typeof entry.to === 'number') {
                    if (liveContent.length === 0 && preserveRawOffsets) {
                        from = Math.max(0, entry.from);
                        to = Math.max(from, entry.to);
                    } else {
                        from = Math.max(0, Math.min(entry.from, liveContent.length));
                        to = Math.max(from, Math.min(entry.to, liveContent.length));
                    }
                    originalSlice =
                        typeof entry.originalSlice === 'string'
                            ? entry.originalSlice
                            : liveContent.slice(from, to);
                } else if (
                    hunkRange &&
                    typeof hunkRange.from === 'number' &&
                    typeof hunkRange.to === 'number'
                ) {
                    if (liveContent.length === 0 && preserveRawOffsets) {
                        from = Math.max(0, hunkRange.from);
                        to = Math.max(from, hunkRange.to);
                    } else {
                        from = Math.max(0, Math.min(hunkRange.from, liveContent.length));
                        to = Math.max(from, Math.min(hunkRange.to, liveContent.length));
                    }
                    originalSlice =
                        typeof entry.originalSlice === 'string'
                            ? entry.originalSlice
                            : liveContent.slice(from, to);
                } else {
                    const extracted = extractSectionBySlug(liveContent, headingSlug);
                    if (extracted) {
                        from = extracted.startOffset;
                        to = extracted.endOffset;
                        originalSlice = extracted.sectionContent;
                    } else {
                        from = 0;
                        to = liveContent.length;
                        originalSlice = liveContent;
                    }
                }

                const replacementText =
                    typeof entry.replacementText === 'string'
                        ? entry.replacementText
                        : hunkRange && typeof hunkRange.replacementText === 'string'
                          ? hunkRange.replacementText
                          : typeof entry.synthesizedContent === 'string'
                            ? entry.synthesizedContent
                            : typeof entry.mergedSectionContent === 'string'
                              ? entry.mergedSectionContent
                              : typeof entry.agentProposedSectionContent === 'string'
                                ? entry.agentProposedSectionContent
                                : typeof entry.content === 'string'
                                  ? entry.content
                                  : typeof entry.text === 'string'
                                    ? entry.text
                                    : '';

                const hunkStatus: 'streaming' | 'preview_ready' =
                    entry.status === 'preview_ready' ? 'preview_ready' : 'streaming';

                constructed.push({
                    hunkId,
                    decisionIds: relatedDecisionIds,
                    headingSlug,
                    from,
                    to,
                    originalSlice,
                    replacementText,
                    status: hunkStatus,
                    ...(typeof entry.operation === 'string' ? { operation: entry.operation } : {}),
                });
            }

            return constructed;
        },
        []
    );

    const finalizeHunkLifecycleIfEmpty = useCallback(
        (remainingHunks: GhostHunk[]): void => {
            if (remainingHunks.length > 0) return;

            const session = activeSessionRef.current;
            const nextStatus: AIStreamStatus =
                acceptedHunkCountRef.current > 0 ? 'completed' : 'idle';

            if (session && session.status !== nextStatus) {
                try {
                    transitionSession(session, nextStatus);
                } catch {
                    session.status = nextStatus;
                }
            }

            setStatus(nextStatus);
            setPreviewText('');
            ghostSessionStartedRef.current = false;
        },
        []
    );

    /**
     * Accepts a single GhostHunk by ID in the editor and updates reactive hunk state.
     * Returns the updated document content string so the orchestrator can persist to IDB
     * and schedule debounced server synchronization.
     */
    const acceptGhostHunk = useCallback(
        (hunkId: string): string | null => {
            if (!hunkId) return null;

            const editor = resolveEditor();
            const targetHunk = activeGhostHunksRef.current.find((h) => h.hunkId === hunkId);
            const beforeContent = resolveLiveContent(editor);

            runAsProgrammaticTransaction(() => {
                editor?.acceptGhostHunk?.(hunkId);
            });

            let updatedContent = resolveLiveContent(editor);
            if (targetHunk && updatedContent === beforeContent) {
                const safeFrom = Math.max(0, Math.min(targetHunk.from, beforeContent.length));
                const safeTo = Math.max(safeFrom, Math.min(targetHunk.to, beforeContent.length));
                const patched =
                    beforeContent.slice(0, safeFrom) +
                    targetHunk.replacementText +
                    beforeContent.slice(safeTo);
                if (patched !== beforeContent) {
                    updatedContent = patched;
                    runAsProgrammaticTransaction(() => {
                        editor?.setValue?.(patched);
                    });
                }
            }

            const delta = targetHunk
                ? targetHunk.replacementText.length - (targetHunk.to - targetHunk.from)
                : 0;

            const adapterHunks =
                typeof editor?.getGhostHunks === 'function' ? editor.getGhostHunks() : null;

            let nextHunks: GhostHunk[];
            if (
                adapterHunks &&
                adapterHunks.length === Math.max(0, activeGhostHunksRef.current.length - 1)
            ) {
                nextHunks = adapterHunks;
            } else {
                nextHunks = activeGhostHunksRef.current
                    .filter((h) => h.hunkId !== hunkId)
                    .map((h) => {
                        if (targetHunk && h.from >= targetHunk.to && delta !== 0) {
                            return {
                                ...h,
                                from: Math.max(0, h.from + delta),
                                to: Math.max(0, h.to + delta),
                            };
                        }
                        return h;
                    });
            }

            acceptedHunkCountRef.current += 1;
            activeGhostHunksRef.current = nextHunks;
            setActiveGhostHunks(nextHunks);
            const activeFileId = activeSessionRef.current?.fileId || optsRef.current.fileId;
            if (activeFileId) {
                persistGhostHunksForFile(
                    activeFileId,
                    nextHunks,
                    currentTurnIdRef.current ?? undefined
                );
            }

            optsRef.current.onHunkAccepted?.(updatedContent, hunkId, nextHunks.length);
            finalizeHunkLifecycleIfEmpty(nextHunks);

            return updatedContent;
        },
        [finalizeHunkLifecycleIfEmpty, persistGhostHunksForFile, resolveEditor, resolveLiveContent, runAsProgrammaticTransaction]
    );

    /**
     * Rejects a single GhostHunk by ID without mutating the document.
     */
    const rejectGhostHunk = useCallback(
        (hunkId: string): void => {
            if (!hunkId) return;

            const editor = resolveEditor();
            runAsProgrammaticTransaction(() => {
                editor?.rejectGhostHunk?.(hunkId);
            });

            const nextHunks = activeGhostHunksRef.current.filter((h) => h.hunkId !== hunkId);
            activeGhostHunksRef.current = nextHunks;
            setActiveGhostHunks(nextHunks);
            const activeFileId = activeSessionRef.current?.fileId || optsRef.current.fileId;
            if (activeFileId) {
                persistGhostHunksForFile(
                    activeFileId,
                    nextHunks,
                    currentTurnIdRef.current ?? undefined
                );
            }

            optsRef.current.onHunkRejected?.(hunkId, nextHunks.length);
            finalizeHunkLifecycleIfEmpty(nextHunks);
        },
        [finalizeHunkLifecycleIfEmpty, persistGhostHunksForFile, resolveEditor, runAsProgrammaticTransaction]
    );

    /**
     * Atomically accepts all remaining ghost hunks in a single combined transaction.
     */
    const acceptAllGhostHunks = useCallback((): string | null => {
        const editor = resolveEditor();
        const currentHunks = [...activeGhostHunksRef.current];
        const beforeContent = resolveLiveContent(editor);

        runAsProgrammaticTransaction(() => {
            editor?.acceptAllGhostHunks?.();
        });

        let updatedContent = resolveLiveContent(editor);
        if (currentHunks.length > 0 && updatedContent === beforeContent) {
            const sortedDesc = [...currentHunks].sort((a, b) => b.from - a.from);
            let patched = beforeContent;
            for (const hunk of sortedDesc) {
                const safeFrom = Math.max(0, Math.min(hunk.from, patched.length));
                const safeTo = Math.max(safeFrom, Math.min(hunk.to, patched.length));
                patched =
                    patched.slice(0, safeFrom) + hunk.replacementText + patched.slice(safeTo);
            }
            if (patched !== beforeContent) {
                updatedContent = patched;
                runAsProgrammaticTransaction(() => {
                    editor?.setValue?.(patched);
                });
            }
        }

        acceptedHunkCountRef.current += Math.max(1, currentHunks.length);
        activeGhostHunksRef.current = [];
        setActiveGhostHunks([]);
        const activeFileId = activeSessionRef.current?.fileId || optsRef.current.fileId;
        if (activeFileId) {
            persistGhostHunksForFile(activeFileId, []);
        }

        const maybePromise = optsRef.current.onAllHunksAccepted?.(updatedContent);
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
            lastAllHunksAcceptedPromiseRef.current = maybePromise as Promise<unknown>;
        } else {
            lastAllHunksAcceptedPromiseRef.current = null;
        }
        finalizeHunkLifecycleIfEmpty([]);

        return updatedContent;
    }, [finalizeHunkLifecycleIfEmpty, persistGhostHunksForFile, resolveEditor, resolveLiveContent, runAsProgrammaticTransaction]);

    /**
     * Rejects and clears all remaining ghost hunks without mutating the document.
     */
    const rejectAllGhostHunks = useCallback((): void => {
        const editor = resolveEditor();
        clearEditorGhostDecorations(editor);

        activeGhostHunksRef.current = [];
        setActiveGhostHunks([]);
        const activeFileId = activeSessionRef.current?.fileId || optsRef.current.fileId;
        if (activeFileId) {
            persistGhostHunksForFile(activeFileId, []);
        }

        optsRef.current.onAllHunksRejected?.();
        finalizeHunkLifecycleIfEmpty([]);
    }, [clearEditorGhostDecorations, finalizeHunkLifecycleIfEmpty, persistGhostHunksForFile, resolveEditor]);

    /**
     * Immediately aborts the active streaming session and dismantles ghost previews.
     */
    const stopStream = useCallback((): void => {
        const session = activeSessionRef.current;
        const editor = resolveEditor();

        if (!session) {
            if (activeGhostHunksRef.current.length > 0) {
                clearEditorGhostDecorations(editor);
                activeGhostHunksRef.current = [];
                setActiveGhostHunks([]);
            }
            return;
        }

        if (isTerminalStatus(session.status)) {
            activeSessionRef.current = null;
            return;
        }

        try {
            session.abortController.abort();
            transitionSession(session, 'aborted');
            setStatus('aborted');
        } catch {
            session.status = 'aborted';
            setStatus('aborted');
        } finally {
            clearEditorGhostDecorations(editor);
            activeGhostHunksRef.current = [];
            setActiveGhostHunks([]);
            setPreviewText('');
            ghostSessionStartedRef.current = false;
            activeSessionRef.current = null;
        }
    }, [clearEditorGhostDecorations, resolveEditor]);

    /**
     * Resets all agent session state, question queues, and ghost hunks back to `'idle'`.
     */
    const reset = useCallback((): void => {
        if (activeSessionRef.current && !isTerminalStatus(activeSessionRef.current.status)) {
            activeSessionRef.current.abortController.abort();
        }
        activeSessionRef.current = null;

        const editor = resolveEditor();
        clearEditorGhostDecorations(editor);

        activeGhostHunksRef.current = [];
        setActiveGhostHunks([]);
        setActiveQuestionQueue([]);
        setAgentGraphStage(null);
        setError(null);
        setIsConflict(false);
        setPreviewText('');
        ghostSessionStartedRef.current = false;
        acceptedHunkCountRef.current = 0;
        setStatus('idle');
    }, [clearEditorGhostDecorations, resolveEditor]);

    const resolveVaultAndSnapshots = useCallback(
        (params: {
            activeFileId: string;
            targetFileIds: string[];
            editor: EditorInstance | null;
            isEncryptedOverride?: boolean;
            allowAIOverride?: boolean;
            explicitVaultPayloads?: Record<string, string>;
            explicitLiveSnapshots?: Record<string, string>;
        }): {
            blocked: boolean;
            ephemeralVaultPayloads?: Record<string, string>;
            liveDocumentSnapshots: Record<string, string>;
        } => {
            const {
                activeFileId,
                editor,
                isEncryptedOverride,
                allowAIOverride,
                explicitVaultPayloads,
                explicitLiveSnapshots,
            } = params;

            const isEncryptedVal =
                isEncryptedOverride !== undefined
                    ? isEncryptedOverride
                    : typeof optsRef.current.isEncrypted === 'function'
                      ? optsRef.current.isEncrypted()
                      : Boolean(optsRef.current.isEncrypted);

            const allowAIVal =
                allowAIOverride !== undefined
                    ? allowAIOverride
                    : typeof optsRef.current.allowAIOnEncryptedFiles === 'function'
                      ? optsRef.current.allowAIOnEncryptedFiles()
                      : Boolean(optsRef.current.allowAIOnEncryptedFiles);

            const isUnlockedVal =
                typeof optsRef.current.isVaultUnlocked === 'function'
                    ? optsRef.current.isVaultUnlocked()
                    : sessionKeyStore.isVaultUnlocked();

            const livePlaintext = resolveLiveContent(editor);
            const liveDocumentSnapshots: Record<string, string> = {
                ...(activeFileId ? { [activeFileId]: livePlaintext } : {}),
                ...(explicitLiveSnapshots ?? {}),
            };

            if (!isEncryptedVal) {
                return {
                    blocked: false,
                    ...(explicitVaultPayloads ? { ephemeralVaultPayloads: explicitVaultPayloads } : {}),
                    liveDocumentSnapshots,
                };
            }

            if (!allowAIVal) {
                const accessDeniedErr = new AgentStreamError({
                    code: 'VAULT_AI_ACCESS_DENIED',
                    status: 403,
                    message:
                        'VAULT_AI_ACCESS_DENIED: AI operations are disabled on encrypted files by vault privacy policy.',
                    retryable: false,
                });
                setError(accessDeniedErr.message);
                setStatus('failed');
                optsRef.current.onError?.(accessDeniedErr);
                return { blocked: true, liveDocumentSnapshots };
            }

            if (!isUnlockedVal) {
                const lockedErr = new AgentStreamError({
                    code: 'VAULT_LOCKED',
                    status: 403,
                    message:
                        'VAULT_LOCKED: Vault is locked. Please unlock the vault before running AI operations on encrypted files.',
                    retryable: false,
                });
                setError(lockedErr.message);
                setStatus('failed');
                optsRef.current.onVaultLocked?.();
                optsRef.current.onError?.(lockedErr);
                return { blocked: true, liveDocumentSnapshots };
            }

            const ephemeralVaultPayloads: Record<string, string> = {
                ...(activeFileId ? { [activeFileId]: livePlaintext } : {}),
                ...(explicitVaultPayloads ?? {}),
            };

            return {
                blocked: false,
                ephemeralVaultPayloads,
                liveDocumentSnapshots,
            };
        },
        [resolveLiveContent]
    );

    const hydrateWorkspaceVaultPayloads = useCallback(
        async (
            basePayloads: Record<string, string> | undefined,
            activeFileId: string
        ): Promise<Record<string, string> | undefined> => {
            const allowAIVal =
                typeof optsRef.current.allowAIOnEncryptedFiles === 'function'
                    ? optsRef.current.allowAIOnEncryptedFiles()
                    : Boolean(optsRef.current.allowAIOnEncryptedFiles);
            const isUnlockedVal =
                typeof optsRef.current.isVaultUnlocked === 'function'
                    ? optsRef.current.isVaultUnlocked()
                    : sessionKeyStore.isVaultUnlocked();

            if (!allowAIVal || !isUnlockedVal) {
                return basePayloads;
            }

            const result: Record<string, string> = { ...(basePayloads ?? {}) };
            const effectiveUserId = optsRef.current.userId ?? undefined;
            const explicitWsId = explicitWorkspaceIdRef.current;

            const allowedWorkspaceFileIds = new Set<string>();
            const excludedRemoteFileIds = new Set<string>();
            let hasRemoteCatalog = false;
            type RemoteFileEntry = NonNullable<Awaited<ReturnType<typeof getUserFiles>>['data']>[number];
            let remoteFilesList: RemoteFileEntry[] = [];

            try {
                const remoteFilesRes = await getUserFiles();
                if (remoteFilesRes?.success && Array.isArray(remoteFilesRes.data)) {
                    hasRemoteCatalog = true;
                    remoteFilesList = remoteFilesRes.data;
                    for (const remoteFile of remoteFilesList) {
                        const rec = remoteFile as unknown as Record<string, unknown>;
                        const fileWorkspaceId =
                            typeof rec.workspaceId === 'string' ? rec.workspaceId : undefined;
                        const belongsToOtherWorkspace =
                            Boolean(explicitWsId) &&
                            Boolean(fileWorkspaceId) &&
                            fileWorkspaceId !== explicitWsId;
                        if (
                            remoteFile.isAiExcluded ||
                            remoteFile.deletedAt ||
                            remoteFile.isFolder ||
                            belongsToOtherWorkspace
                        ) {
                            excludedRemoteFileIds.add(remoteFile.id);
                        } else if (!explicitWsId || !fileWorkspaceId || fileWorkspaceId === explicitWsId) {
                            allowedWorkspaceFileIds.add(remoteFile.id);
                        }
                    }
                }
            } catch {
                // Ignore RPC errors in offline/unmocked unit tests
            }

            try {
                const allFiles = await indexedDBManager.getAllFiles();
                for (const file of allFiles) {
                    if (Object.keys(result).length >= MAX_RECORD_KEYS) break;
                    if (!file.isEncrypted || !file.content) continue;
                    const localExcluded = file.isAiExcluded === true;
                    if (localExcluded || excludedRemoteFileIds.has(file.id)) continue;
                    if (explicitWsId) {
                        const matchesWs = file.workspaceId
                            ? file.workspaceId === explicitWsId
                            : !hasRemoteCatalog || allowedWorkspaceFileIds.has(file.id);
                        if (!matchesWs) continue;
                    }
                    if (file.id === activeFileId && result[file.id] !== undefined) continue;
                    if (result[file.id] !== undefined) continue;

                    const inbound = await SyncCryptoGateway.decryptInbound({
                        fileId: file.id,
                        content: file.content,
                        isEncrypted: true,
                        encryptionMetadata: file.encryptionMetadata ?? null,
                        userId: effectiveUserId,
                    });
                    if (inbound.status === 'decrypted') {
                        result[file.id] = inbound.content;
                        preTurnSnapshotsRef.current[file.id] = {
                            content: file.content,
                            etag: file.etag,
                            version: file.version,
                            encryptionMetadata: file.encryptionMetadata ?? undefined,
                        };
                    }
                }
            } catch {
                // Ignore IDB errors in constrained/test environments
            }

            try {
                for (const remoteFile of remoteFilesList) {
                    if (Object.keys(result).length >= MAX_RECORD_KEYS) break;
                    if (excludedRemoteFileIds.has(remoteFile.id)) continue;
                    if (!remoteFile.isEncrypted) continue;
                    if (result[remoteFile.id] !== undefined) continue;

                    let ciphertext = remoteFile.content;
                    let encMeta = remoteFile.encryptionMetadata ?? null;
                    let detailEtag = remoteFile.etag || '';
                    let detailVersion = remoteFile.version ?? 1;
                    if (!ciphertext) {
                        const detailRes = await getFile(remoteFile.id).catch(() => null);
                        if (detailRes?.success && detailRes.data) {
                            ciphertext = detailRes.data.content;
                            encMeta = detailRes.data.encryptionMetadata ?? encMeta;
                            detailEtag = detailRes.data.etag || detailEtag;
                            detailVersion = detailRes.data.version ?? detailVersion;
                        }
                    }
                    if (!ciphertext) continue;

                    const inbound = await SyncCryptoGateway.decryptInbound({
                        fileId: remoteFile.id,
                        content: ciphertext,
                        isEncrypted: true,
                        encryptionMetadata: encMeta,
                        userId: effectiveUserId,
                    });
                    if (inbound.status === 'decrypted') {
                        result[remoteFile.id] = inbound.content;
                        preTurnSnapshotsRef.current[remoteFile.id] = {
                            content: ciphertext,
                            etag: detailEtag,
                            version: detailVersion,
                            encryptionMetadata: encMeta ?? undefined,
                        };
                    }
                }
            } catch {
                // Ignore RPC errors in offline/unmocked unit tests
            }

            if (Object.keys(result).length > 0) {
                try {
                    const alreadyShown =
                        typeof localStorage !== 'undefined' &&
                        localStorage.getItem(ZK_AI_NOTICE_STORAGE_KEY) === '1';
                    if (!alreadyShown) {
                        if (typeof localStorage !== 'undefined') {
                            localStorage.setItem(ZK_AI_NOTICE_STORAGE_KEY, '1');
                        }
                        const noticeMsg =
                            'Encrypted workspace files were decrypted transiently in memory for this AI request and are never stored in plaintext on the server.';
                        setZkAiNotice(noticeMsg);
                        optsRef.current.onVaultAiNotice?.(noticeMsg);
                    }
                } catch {
                    // Ignore localStorage errors
                }
            }

            return Object.keys(result).length > 0 ? result : undefined;
        },
        []
    );

    const executeStreamCycle = useCallback(
        async (
            session: AIStreamSession,
            requestPayload: AgentStreamRequestPayload,
            editor: EditorInstance | null
        ): Promise<void> => {
            transitionSession(session, 'running_graph');
            setStatus('running_graph');
            optsRef.current.onStreamStart?.();

            let hitlInterrupted = false;

            await consumeAgentStream({
                payload: requestPayload,
                signal: session.abortController.signal,
                onStart: (startEvt) => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }
                    session.operationId = startEvt.operationId || session.operationId;
                    session.correlationId = startEvt.correlationId;
                },
                onUpdate: (updateEvt) => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }

                    const { chunk } = updateEvt;
                    const stage = inferStageFromUpdateChunk(chunk);
                    if (stage) {
                        setAgentGraphStage(stage);
                    }

                    const candidatePayloads = collectCandidatePayloads(chunk);

                    // 1. Merge master_ledger updates
                    for (const payload of candidatePayloads) {
                        const ledgerUpdate = payload.master_ledger ?? payload.masterLedger;
                        if (
                            ledgerUpdate &&
                            typeof ledgerUpdate === 'object' &&
                            !Array.isArray(ledgerUpdate)
                        ) {
                            const mergedLedger = reduceMasterLedger(
                                masterDecisionLedgerRef.current,
                                ledgerUpdate as Record<string, ATMSDecisionNode>
                            );
                            masterDecisionLedgerRef.current = mergedLedger;
                            setMasterDecisionLedger(mergedLedger);
                        }

                        const invUpdate = payload.invalidation_map ?? payload.invalidationMap;
                        if (
                            invUpdate &&
                            typeof invUpdate === 'object' &&
                            !Array.isArray(invUpdate) &&
                            Object.keys(invUpdate).length > 0
                        ) {
                            sessionInvalidationMapRef.current = reduceInvalidationMap(
                                sessionInvalidationMapRef.current,
                                invUpdate as Record<string, SectionTarget[]>
                            );
                        }
                    }

                    // 2. Extract question_queue updates if present
                    const questions = extractQuestionsFromPayloads(candidatePayloads);
                    if (questions && questions.length > 0) {
                        setActiveQuestionQueue(questions);
                    }

                    // 3. Extract GhostHunk items when synthesized_sections / hunks arrive
                    const rawSectionEntries = extractRawSectionEntries(candidatePayloads);
                    const liveContent = resolveLiveContent(editor);

                    if (rawSectionEntries.length > 0) {
                        const hunks = buildGhostHunksFromRawEntries(
                            rawSectionEntries,
                            liveContent,
                            masterDecisionLedgerRef.current
                        );
                        upsertHunksIntoSession(session, editor, hunks);
                    }
                },
                onGhostHunkProposed: (ghostEvt) => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }
                    if (!Array.isArray(ghostEvt.hunks) || ghostEvt.hunks.length === 0) {
                        return;
                    }

                    const normalizedEntries = ghostEvt.hunks.map((entry) => ({
                        ...entry,
                        headingSlug: entry.headingSlug ?? ghostEvt.headingSlug,
                        fileId: entry.fileId ?? ghostEvt.fileId,
                    }));

                    const isFileMismatch =
                        Boolean(ghostEvt.fileId) &&
                        Boolean(session.fileId) &&
                        session.fileId !== 'default-file' &&
                        ghostEvt.fileId !== session.fileId;

                    if (isFileMismatch) {
                        const targetHunks = buildGhostHunksFromRawEntries(
                            normalizedEntries,
                            '',
                            masterDecisionLedgerRef.current,
                            true
                        );
                        persistGhostHunksForFile(
                            ghostEvt.fileId,
                            targetHunks,
                            currentTurnIdRef.current ?? undefined
                        );
                        return;
                    }

                    const liveContent = resolveLiveContent(editor);
                    const hunks = buildGhostHunksFromRawEntries(
                        normalizedEntries,
                        liveContent,
                        masterDecisionLedgerRef.current
                    );
                    upsertHunksIntoSession(session, editor, hunks);
                },
                onFileMutated: async (mutatedEvt) => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }
                    const wsId =
                        effectiveWorkspaceIdRef.current ||
                        projectIdRef.current ||
                        'default-workspace';
                    const turnId = currentTurnIdRef.current || `turn_${session.sessionId}`;
                    const opType =
                        mutatedEvt.action === 'created'
                            ? 'create'
                            : mutatedEvt.action === 'deleted'
                              ? 'delete'
                              : 'update';

                    let existingFile: IDBFile | undefined;
                    try {
                        existingFile = await indexedDBManager.getFile(mutatedEvt.fileId);
                    } catch {
                        existingFile = undefined;
                    }

                    let remoteFile: NonNullable<Awaited<ReturnType<typeof getFile>>['data']> | undefined;
                    let remoteEtag: string | undefined;
                    if (mutatedEvt.action === 'updated' || mutatedEvt.action === 'created') {
                        try {
                            const remoteRes = await getFile(mutatedEvt.fileId);
                            if (remoteRes?.success && remoteRes.data) {
                                remoteFile = remoteRes.data;
                                remoteEtag = remoteRes.data.etag ?? remoteRes.etag;
                            } else if (remoteRes?.etag) {
                                remoteEtag = remoteRes.etag;
                            }
                        } catch {
                            // Ignore RPC errors in offline/unmocked unit tests
                        }
                    }

                    const postTurnEtag = remoteEtag ?? existingFile?.etag;
                    const effectiveUid = optsRef.current.userId ?? undefined;
                    const preTurnSnapshot: IDBOperation['snapshot'] = existingFile
                        ? {
                              content: existingFile.content,
                              etag: existingFile.etag,
                              version: existingFile.version,
                              encryptionMetadata: existingFile.encryptionMetadata ?? undefined,
                          }
                        : preTurnSnapshotsRef.current[mutatedEvt.fileId];

                    const opId = `op_mut_${turnId}_${mutatedEvt.fileId}_${Date.now()}`;
                    const op: IDBOperation = {
                        id: opId,
                        operationId: opId,
                        userId: effectiveUid,
                        workspaceId: wsId,
                        threadId: session.threadId,
                        turnId,
                        postTurnEtag,
                        fileId: mutatedEvt.fileId,
                        baseVersion: existingFile?.version ?? preTurnSnapshot?.version ?? 1,
                        localRevision: (existingFile?.localRevision ?? 0) + 1,
                        sentRevision: existingFile?.localRevision ?? 0,
                        status: 'synced',
                        attempts: 0,
                        nextRetryAt: 0,
                        lastError: undefined,
                        operationType: opType,
                        position: 0,
                        content: remoteFile?.content ?? existingFile?.content ?? '',
                        timestamp: Date.now(),
                        synced: true,
                        isEncrypted: remoteFile?.isEncrypted ?? existingFile?.isEncrypted,
                        ...(preTurnSnapshot ? { snapshot: preTurnSnapshot } : {}),
                    };

                    try {
                        await indexedDBManager.saveOperation(op);
                        if (remoteFile) {
                            const remoteRec = remoteFile as unknown as Record<string, unknown>;
                            const remoteWsId =
                                typeof remoteRec.workspaceId === 'string'
                                    ? remoteRec.workspaceId
                                    : existingFile?.workspaceId ?? explicitWorkspaceIdRef.current;
                            await indexedDBManager.saveFile(
                                {
                                    id: mutatedEvt.fileId,
                                    content: remoteFile.content ?? '',
                                    etag: postTurnEtag || '',
                                    lastModified: Date.now(),
                                    lastSyncedAt: Date.now(),
                                    isDirty: false,
                                    version: remoteFile.version ?? (existingFile?.version ?? 1),
                                    title: remoteFile.title || existingFile?.title || mutatedEvt.relativePath,
                                    parentFolderId:
                                        remoteFile.parentFolderId ?? existingFile?.parentFolderId ?? null,
                                    isFolder: Boolean(remoteFile.isFolder),
                                    isEncrypted: Boolean(remoteFile.isEncrypted),
                                    encryptionMetadata:
                                        remoteFile.encryptionMetadata ?? existingFile?.encryptionMetadata ?? null,
                                    workspaceId: remoteWsId,
                                    isAiExcluded:
                                        remoteFile.isAiExcluded ?? existingFile?.isAiExcluded,
                                    localRevision: (existingFile?.localRevision ?? 0) + 1,
                                    syncStatus: 'synced',
                                },
                                effectiveUid
                            );
                        }
                    } catch {
                        // Ignore IDB errors in constrained/test environments
                    }

                    recordTurnMutation(turnId, session.threadId, wsId, {
                        fileId: mutatedEvt.fileId,
                        relativePath: mutatedEvt.relativePath,
                        action: mutatedEvt.action,
                        postTurnEtag,
                    });

                    if (
                        mutatedEvt.fileId === session.fileId &&
                        editor &&
                        remoteFile &&
                        !remoteFile.isEncrypted &&
                        resolveLiveContent(editor) !== (remoteFile.content ?? '')
                    ) {
                        runAsProgrammaticTransaction(() => {
                            editor.setValue?.(remoteFile.content ?? '', 'agent.mutation');
                        });
                    }
                },
                onVaultFileCommitRequired: async (commitEvt) => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }
                    const wsId =
                        effectiveWorkspaceIdRef.current ||
                        projectIdRef.current ||
                        'default-workspace';
                    const turnId = currentTurnIdRef.current || `turn_${session.sessionId}`;
                    const effectiveUid = optsRef.current.userId ?? undefined;

                    let existingFile: IDBFile | undefined;
                    try {
                        existingFile = await indexedDBManager.getFile(commitEvt.fileId);
                    } catch {
                        existingFile = undefined;
                    }

                    const opId = `op_vault_${turnId}_${commitEvt.fileId}_${Date.now()}`;
                    const baseOp: IDBOperation = {
                        id: opId,
                        operationId: opId,
                        userId: effectiveUid,
                        workspaceId: wsId,
                        threadId: session.threadId,
                        turnId,
                        fileId: commitEvt.fileId,
                        baseVersion: existingFile?.version ?? 1,
                        localRevision: (existingFile?.localRevision ?? 0) + 1,
                        sentRevision: existingFile?.localRevision ?? 0,
                        status: 'queued',
                        attempts: 0,
                        nextRetryAt: 0,
                        lastError: undefined,
                        operationType: 'update',
                        position: 0,
                        content: commitEvt.mergedContent,
                        timestamp: Date.now(),
                        synced: false,
                        isEncrypted: true,
                        ...(existingFile
                            ? {
                                  snapshot: {
                                      content: existingFile.content,
                                      etag: existingFile.etag,
                                      version: existingFile.version,
                                      encryptionMetadata:
                                          existingFile.encryptionMetadata ?? undefined,
                                  },
                              }
                            : {}),
                    };

                    try {
                        await indexedDBManager.saveOperation(baseOp);
                    } catch {
                        // Ignore IDB errors in constrained/test environments
                    }

                    try {
                        const enc = await SyncCryptoGateway.encryptOutbound(
                            commitEvt.fileId,
                            commitEvt.mergedContent,
                            effectiveUid
                        );
                        const rpcRes = await toggleFileEncryption(
                            commitEvt.fileId,
                            true,
                            enc.ciphertextBase64,
                            enc.encryptionMetadata,
                            { expectedVersion: existingFile?.version }
                        );
                        const postTurnEtag =
                            rpcRes?.etag ?? rpcRes?.data?.etag ?? existingFile?.etag;
                        const nextVersion =
                            rpcRes?.version ??
                            rpcRes?.data?.version ??
                            (existingFile?.version ?? 1) + 1;

                        const updatedIdbFile: IDBFile = {
                            id: commitEvt.fileId,
                            content: enc.ciphertextBase64,
                            etag: postTurnEtag || '',
                            lastModified: Date.now(),
                            lastSyncedAt: Date.now(),
                            isDirty: false,
                            version: nextVersion,
                            title: existingFile?.title || commitEvt.relativePath,
                            parentFolderId: existingFile?.parentFolderId ?? null,
                            isFolder: false,
                            isEncrypted: true,
                            encryptionMetadata: enc.encryptionMetadata,
                            workspaceId:
                                existingFile?.workspaceId ?? explicitWorkspaceIdRef.current,
                            isAiExcluded: existingFile?.isAiExcluded,
                            localRevision: (existingFile?.localRevision ?? 0) + 1,
                            syncStatus: 'synced',
                        };
                        await indexedDBManager.saveFile(updatedIdbFile, effectiveUid).catch(() => {});
                        await indexedDBManager
                            .saveOperation({
                                ...baseOp,
                                postTurnEtag,
                                status: 'synced',
                                synced: true,
                            })
                            .catch(() => {});

                        recordTurnMutation(turnId, session.threadId, wsId, {
                            fileId: commitEvt.fileId,
                            relativePath: commitEvt.relativePath,
                            action: 'updated',
                            postTurnEtag,
                        });

                        if (
                            commitEvt.fileId === session.fileId &&
                            editor &&
                            resolveLiveContent(editor) !== commitEvt.mergedContent
                        ) {
                            runAsProgrammaticTransaction(() => {
                                editor.setValue?.(commitEvt.mergedContent, 'agent.mutation');
                            });
                        }
                    } catch (commitErr) {
                        const message =
                            commitErr instanceof Error
                                ? commitErr.message
                                : 'Failed to commit encrypted vault file';
                        setError(message);
                    }
                },
                onInterrupt: (interruptEvt: AgentStreamInterruptEvent) => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }

                    const extractedQuestions: Array<
                        ClarifyingQuestionBatch['questions'][number]
                    > = [];

                    let insufficientCreditsMsg: string | null = null;
                    if (interruptEvt.interruptReason === 'INSUFFICIENT_CREDITS') {
                        insufficientCreditsMsg = 'INSUFFICIENT_CREDITS: Credit balance exhausted.';
                    }

                    for (const intr of interruptEvt.interrupts) {
                        const val = intr.value;
                        if (val && typeof val === 'object' && !Array.isArray(val)) {
                            const rec = val as Record<string, unknown>;
                            if (rec.code === 'INSUFFICIENT_CREDITS' || insufficientCreditsMsg !== null) {
                                if (typeof rec.message === 'string' && rec.message.trim()) {
                                    insufficientCreditsMsg = `INSUFFICIENT_CREDITS: ${rec.message.trim()}`;
                                } else if (insufficientCreditsMsg === null) {
                                    insufficientCreditsMsg =
                                        'INSUFFICIENT_CREDITS: Credit balance exhausted.';
                                }
                                continue;
                            }
                            if (Array.isArray(rec.questions)) {
                                extractedQuestions.push(
                                    ...normalizeQuestionsList(rec.questions)
                                );
                            }
                        } else if (Array.isArray(val)) {
                            extractedQuestions.push(...normalizeQuestionsList(val));
                        }
                    }

                    if (insufficientCreditsMsg !== null) {
                        setError(insufficientCreditsMsg);
                        transitionSession(
                            session,
                            'paused_insufficient_credits',
                            insufficientCreditsMsg
                        );
                        setStatus('paused_insufficient_credits');
                        optsRef.current.onError?.(
                            new AgentStreamError({
                                code: 'INSUFFICIENT_CREDITS',
                                status: 402,
                                message: insufficientCreditsMsg,
                            })
                        );
                        return;
                    }

                    if (extractedQuestions.length > 0) {
                        setActiveQuestionQueue(extractedQuestions);
                    }

                    hitlInterrupted = true;
                    setAgentGraphStage('pure_interrupt_node');
                    transitionSession(session, 'awaiting_hitl');
                    setStatus('awaiting_hitl');
                },
                onDone: () => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }

                    if (
                        hitlInterrupted ||
                        session.status === 'awaiting_hitl' ||
                        session.status === 'paused_insufficient_credits'
                    ) {
                        return;
                    }

                    if (activeGhostHunksRef.current.length > 0) {
                        const readyHunks = activeGhostHunksRef.current.map((h) => ({
                            ...h,
                            status: 'preview_ready' as const,
                        }));
                        activeGhostHunksRef.current = readyHunks;
                        setActiveGhostHunks(readyHunks);

                        if (editor && typeof editor.upsertGhostHunk === 'function') {
                            for (const hunk of readyHunks) {
                                editor.upsertGhostHunk(hunk);
                            }
                        }

                        transitionSession(session, 'preview_ready');
                        setStatus('preview_ready');
                    } else {
                        transitionSession(session, 'completed');
                        setStatus('completed');
                    }
                },
                onError: (err) => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }

                    clearEditorGhostDecorations(editor);
                    activeGhostHunksRef.current = [];
                    setActiveGhostHunks([]);
                    ghostSessionStartedRef.current = false;

                    if (err.name === 'AbortError') {
                        transitionSession(session, 'aborted');
                        setStatus('aborted');
                        activeSessionRef.current = null;
                        return;
                    }

                    const message = err.message || 'Agent stream execution failed';
                    setError(message);
                    transitionSession(session, 'failed', message);
                    setStatus('failed');
                    activeSessionRef.current = null;
                    optsRef.current.onError?.(err);
                },
            });
        },
        [
            buildGhostHunksFromRawEntries,
            clearEditorGhostDecorations,
            persistGhostHunksForFile,
            recordTurnMutation,
            resolveLiveContent,
            runAsProgrammaticTransaction,
            upsertHunksIntoSession,
        ]
    );

    /**
     * Initiates a new autonomous LangGraph agent session against `POST /api/agent/stream`.
     */
    const startAgentSession = useCallback(
        async (
            promptOrParams: string | StartAgentSessionParams,
            targetFileIdsArg?: string[],
            overrides?: Partial<StartAgentSessionParams>
        ): Promise<void> => {
            if (
                activeSessionRef.current &&
                (activeSessionRef.current.status === 'running_graph' ||
                    activeSessionRef.current.status === 'streaming_hunks')
            ) {
                return;
            }

            const params: StartAgentSessionParams =
                typeof promptOrParams === 'string'
                    ? {
                          prompt: promptOrParams,
                          targetFileIds: targetFileIdsArg,
                          ...overrides,
                      }
                    : promptOrParams;

            const prompt = params.prompt?.trim() ?? '';
            if (!prompt) {
                setError('Please enter a prompt to start the agent session');
                return;
            }

            const editor = resolveEditor(params.editor);
            const activeFileId =
                params.fileId ||
                optsRef.current.fileId ||
                params.targetFileIds?.[0] ||
                'default-file';
            const projectId =
                params.projectId ||
                optsRef.current.projectId ||
                activeFileId ||
                'default-project';
            const targetFileIds =
                Array.isArray(params.targetFileIds) && params.targetFileIds.length > 0
                    ? [...params.targetFileIds]
                    : activeFileId
                      ? [activeFileId]
                      : [];
            const threadId =
                params.threadId ||
                optsRef.current.threadId ||
                threadIdRef.current ||
                `thread_${crypto.randomUUID()}`;

            threadIdRef.current = threadId;
            setSessionThreadId(threadId);
            projectIdRef.current = projectId;
            targetFileIdsRef.current = targetFileIds;

            setError(null);
            setIsConflict(false);
            setPreviewText('');
            setActiveQuestionQueue([]);
            setAgentGraphStage(null);
            acceptedHunkCountRef.current = 0;
            sessionInvalidationMapRef.current = {};

            if (activeGhostHunksRef.current.length > 0) {
                clearEditorGhostDecorations(editor);
                activeGhostHunksRef.current = [];
                setActiveGhostHunks([]);
                ghostSessionStartedRef.current = false;
            }

            const vaultAndSnapshots = resolveVaultAndSnapshots({
                activeFileId,
                targetFileIds,
                editor,
                isEncryptedOverride: params.isEncrypted,
                allowAIOverride: params.allowAIOnEncryptedFiles,
                explicitVaultPayloads: params.ephemeralVaultPayloads,
                explicitLiveSnapshots: params.liveDocumentSnapshots,
            });

            if (vaultAndSnapshots.blocked) {
                return;
            }

            const turnId = `turn_${crypto.randomUUID()}`;
            currentTurnIdRef.current = turnId;
            currentTurnPromptRef.current = prompt;
            const wireWorkspaceId = explicitWorkspaceIdRef.current;

            const hydratedVaultPayloads = await hydrateWorkspaceVaultPayloads(
                vaultAndSnapshots.ephemeralVaultPayloads,
                activeFileId
            );

            const session = createStreamSession({
                threadId,
                projectId,
                fileId: activeFileId,
                targetFileIds,
                prompt,
                originalMarkdown: vaultAndSnapshots.liveDocumentSnapshots[activeFileId] ?? '',
                originalText: prompt,
                expectedVersion:
                    params.expectedVersion ?? optsRef.current.getLatestVersion?.() ?? 1,
                originalEtag:
                    params.originalEtag ?? optsRef.current.getLatestETag?.() ?? null,
                editorGeneration: params.editorGeneration ?? 1,
            });

            activeSessionRef.current = session;

            const effectiveModelId =
                params.selectedSystem2ModelId ?? selectedSystem2ModelIdRef.current;
            const effectivePermissionMode =
                params.permissionMode ?? permissionModeRef.current;

            const requestPayload: AgentStreamRequestPayload = {
                threadId,
                projectId,
                ...(wireWorkspaceId ? { workspaceId: wireWorkspaceId } : {}),
                turnId,
                prompt,
                targetFileIds,
                selectedSystem2ModelId: effectiveModelId,
                permissionMode: effectivePermissionMode,
                ...(hydratedVaultPayloads
                    ? { ephemeralVaultPayloads: hydratedVaultPayloads }
                    : {}),
                liveDocumentSnapshots: vaultAndSnapshots.liveDocumentSnapshots,
            };

            await executeStreamCycle(session, requestPayload, editor);
        },
        [clearEditorGhostDecorations, executeStreamCycle, hydrateWorkspaceVaultPayloads, resolveEditor, resolveVaultAndSnapshots]
    );

    /**
     * Resumes a suspended HITL agent session (`awaiting_hitl`) with user clarification answers.
     */
    const resumeAgentInterrupt = useCallback(
        async (response: ClarificationResponse): Promise<void> => {
            const validation = ClarificationResponseSchema.safeParse(response);
            if (!validation.success) {
                const issueMsg = validation.error.issues
                    .map((i) => i.message)
                    .join('; ');
                const err = new AgentStreamError({
                    code: 'INVALID_CLARIFICATION_RESPONSE',
                    status: 400,
                    message: `INVALID_CLARIFICATION_RESPONSE: ${issueMsg}`,
                    retryable: false,
                });
                setError(err.message);
                setStatus('failed');
                optsRef.current.onError?.(err);
                return;
            }

            const editor = resolveEditor();
            const prevSession = activeSessionRef.current;
            const activeFileId =
                prevSession?.fileId ||
                optsRef.current.fileId ||
                targetFileIdsRef.current[0] ||
                'default-file';
            const threadId =
                prevSession?.threadId ||
                optsRef.current.threadId ||
                threadIdRef.current;
            const projectId =
                prevSession?.projectId ||
                optsRef.current.projectId ||
                projectIdRef.current ||
                activeFileId;
            const targetFileIds =
                prevSession?.targetFileIds && prevSession.targetFileIds.length > 0
                    ? prevSession.targetFileIds
                    : targetFileIdsRef.current.length > 0
                      ? targetFileIdsRef.current
                      : [activeFileId];

            const vaultAndSnapshots = resolveVaultAndSnapshots({
                activeFileId,
                targetFileIds,
                editor,
            });

            if (vaultAndSnapshots.blocked) {
                return;
            }

            const hydratedVaultPayloads = await hydrateWorkspaceVaultPayloads(
                vaultAndSnapshots.ephemeralVaultPayloads,
                activeFileId
            );
            const wireWorkspaceId = explicitWorkspaceIdRef.current;
            const turnId = currentTurnIdRef.current || `turn_${crypto.randomUUID()}`;
            currentTurnIdRef.current = turnId;

            setError(null);
            setActiveQuestionQueue([]);

            const resumedSession = createStreamSession({
                threadId,
                projectId,
                fileId: activeFileId,
                targetFileIds,
                originalMarkdown: vaultAndSnapshots.liveDocumentSnapshots[activeFileId] ?? '',
                expectedVersion:
                    prevSession?.expectedVersion ?? optsRef.current.getLatestVersion?.() ?? 1,
                originalEtag:
                    prevSession?.originalEtag ?? optsRef.current.getLatestETag?.() ?? null,
                editorGeneration: prevSession?.editorGeneration ?? 1,
            });

            activeSessionRef.current = resumedSession;

            const requestPayload: AgentStreamRequestPayload = {
                threadId,
                projectId,
                ...(wireWorkspaceId ? { workspaceId: wireWorkspaceId } : {}),
                turnId,
                targetFileIds,
                selectedSystem2ModelId: selectedSystem2ModelIdRef.current,
                permissionMode: permissionModeRef.current,
                resumePayload: { answers: validation.data.answers },
                ...(hydratedVaultPayloads
                    ? { ephemeralVaultPayloads: hydratedVaultPayloads }
                    : {}),
                liveDocumentSnapshots: vaultAndSnapshots.liveDocumentSnapshots,
            };

            await executeStreamCycle(resumedSession, requestPayload, editor);
        },
        [executeStreamCycle, hydrateWorkspaceVaultPayloads, resolveEditor, resolveVaultAndSnapshots]
    );

    /**
     * Resumes a paused agent session (`paused_insufficient_credits`) from its saved checkpoint.
     */
    const resumeInsufficientCreditsTask = useCallback(async (): Promise<void> => {
        const editor = resolveEditor();
        const prevSession = activeSessionRef.current;
        const activeFileId =
            prevSession?.fileId ||
            optsRef.current.fileId ||
            targetFileIdsRef.current[0] ||
            'default-file';
        const threadId =
            prevSession?.threadId || optsRef.current.threadId || threadIdRef.current;
        const projectId =
            prevSession?.projectId ||
            optsRef.current.projectId ||
            projectIdRef.current ||
            activeFileId;
        const targetFileIds =
            prevSession?.targetFileIds && prevSession.targetFileIds.length > 0
                ? prevSession.targetFileIds
                : targetFileIdsRef.current.length > 0
                  ? targetFileIdsRef.current
                  : [activeFileId];

        const vaultAndSnapshots = resolveVaultAndSnapshots({
            activeFileId,
            targetFileIds,
            editor,
        });

        if (vaultAndSnapshots.blocked) {
            return;
        }

        const hydratedVaultPayloads = await hydrateWorkspaceVaultPayloads(
            vaultAndSnapshots.ephemeralVaultPayloads,
            activeFileId
        );
        const wireWorkspaceId = explicitWorkspaceIdRef.current;
        const turnId = currentTurnIdRef.current || `turn_${crypto.randomUUID()}`;
        currentTurnIdRef.current = turnId;

        setError(null);

        const resumedSession = createStreamSession({
            threadId,
            projectId,
            fileId: activeFileId,
            targetFileIds,
            originalMarkdown: vaultAndSnapshots.liveDocumentSnapshots[activeFileId] ?? '',
            expectedVersion:
                prevSession?.expectedVersion ?? optsRef.current.getLatestVersion?.() ?? 1,
            originalEtag:
                prevSession?.originalEtag ?? optsRef.current.getLatestETag?.() ?? null,
            editorGeneration: prevSession?.editorGeneration ?? 1,
        });

        activeSessionRef.current = resumedSession;

        const requestPayload: AgentStreamRequestPayload = {
            threadId,
            projectId,
            ...(wireWorkspaceId ? { workspaceId: wireWorkspaceId } : {}),
            turnId,
            targetFileIds,
            selectedSystem2ModelId: selectedSystem2ModelIdRef.current,
            permissionMode: permissionModeRef.current,
            resumePayload: { resumeReason: 'INSUFFICIENT_CREDITS' },
            ...(hydratedVaultPayloads
                ? { ephemeralVaultPayloads: hydratedVaultPayloads }
                : {}),
            liveDocumentSnapshots: vaultAndSnapshots.liveDocumentSnapshots,
        };

        await executeStreamCycle(resumedSession, requestPayload, editor);
    }, [executeStreamCycle, hydrateWorkspaceVaultPayloads, resolveEditor, resolveVaultAndSnapshots]);

    useLayoutEffect(() => {
        acceptGhostHunkRef.current = acceptGhostHunk;
        rejectGhostHunkRef.current = rejectGhostHunk;
        stopStreamRef.current = stopStream;
    }, [acceptGhostHunk, rejectGhostHunk, stopStream]);

    const activeGhostHunksCount = activeGhostHunks.length;

    return {
        status,
        aiStatus: status,
        aiStreamStatus: status,
        previewText,
        error,
        aiError: error,
        isConflict,
        agentGraphStage,
        activeQuestionQueue,
        masterDecisionLedger,
        activeGhostHunks,
        activeGhostHunksCount,
        ghostHunksByFileId,
        mutatedTurns,
        zkAiNotice,
        hydrateGhostHunksForFile,
        persistGhostHunksForFile,
        markTurnReverted,
        markSessionReverted,
        selectedSystem2ModelId,
        setSelectedSystem2ModelId,
        permissionMode,
        setPermissionMode,
        threadId: activeThreadId,
        isLoading: status === 'running_graph' || status === 'streaming_hunks',
        isStreaming: status === 'running_graph' || status === 'streaming_hunks',
        isCommitting: false,
        isPreviewReady: status === 'preview_ready',
        isAwaitingHitl: status === 'awaiting_hitl',
        startAgentSession,
        resumeAgentInterrupt,
        resumeInsufficientCreditsTask,
        acceptGhostHunk,
        rejectGhostHunk,
        acceptAllGhostHunks,
        rejectAllGhostHunks,
        stopStream,
        stopAIOperation: stopStream,
        reset,
        resetAI: reset,
        // Backward-compatible aliases
        startStream: startAgentSession,
        commitPreview: async () => {
            acceptAllGhostHunks();
            if (lastAllHunksAcceptedPromiseRef.current) {
                await lastAllHunksAcceptedPromiseRef.current;
            }
        },
        rejectPreview: rejectAllGhostHunks,
        retryPreview: async () => {
            const lastPrompt = activeSessionRef.current?.prompt;
            if (lastPrompt) {
                rejectAllGhostHunks();
                await startAgentSession(lastPrompt);
            }
        },
    };
}
