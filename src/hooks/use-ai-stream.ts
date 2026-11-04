'use client';

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
import { diff3MergeSection } from '@/lib/sync/diff3';
import { sessionKeyStore } from '@/lib/sync/session-key-store';

/**
 * Pure helper to synthesize section content for multi-hunk preview in the browser.
 */
function synthesizeAgentSectionContent(
    baseContent: string,
    headingSlug: string,
    relevantDecisions: readonly ATMSDecisionNode[]
): string {
    const trimmedBase = baseContent.trim();
    const humanReadableHeading = headingSlug
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    const decisionLines: string[] = [];
    for (const decision of relevantDecisions) {
        decisionLines.push(
            `- **${decision.topicSlug}** [${decision.selectedOptionKey}]: ${decision.selectionRationale}`
        );
    }

    const decisionBlock =
        decisionLines.length > 0
            ? `\n\n<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->\n${decisionLines.join('\n')}\n<!-- END:AGENT_DECISION_ALIGNMENT -->`
            : '';

    if (trimmedBase.length === 0) {
        return `## ${humanReadableHeading}\n${decisionBlock.trimStart()}`;
    }

    const startMarker = '<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->';
    const endMarker = '<!-- END:AGENT_DECISION_ALIGNMENT -->';
    const startIndex = trimmedBase.indexOf(startMarker);
    const endIndex = trimmedBase.indexOf(endMarker);

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        const beforeBlock = trimmedBase.slice(0, startIndex).trimEnd();
        const afterBlock = trimmedBase.slice(endIndex + endMarker.length).trimStart();
        return `${beforeBlock}${decisionBlock}\n\n${afterBlock}`.trim();
    }

    return `${trimmedBase}${decisionBlock}`;
}

export type EditorInstance = EditorAdapter;

export interface UseAIStreamOptions {
    fileId?: string;
    projectId?: string;
    threadId?: string;
    editor?: EditorInstance | null;
    getEditor?: () => EditorInstance | null;
    getLiveContent?: () => string;
    isEncrypted?: boolean | (() => boolean);
    allowAIOnEncryptedFiles?: boolean | (() => boolean);
    isVaultUnlocked?: () => boolean;
    onVaultLocked?: () => void;
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
    const [clientGeneratedThreadId] = useState<string>(() => `thread_${crypto.randomUUID()}`);
    const [sessionThreadId, setSessionThreadId] = useState<string | null>(null);

    const activeThreadId = options.threadId || sessionThreadId || clientGeneratedThreadId;

    const optsRef = useRef<UseAIStreamOptions>(options);
    const threadIdRef = useRef<string>(activeThreadId);
    useLayoutEffect(() => {
        optsRef.current = options;
        threadIdRef.current = activeThreadId;
    });

    const activeSessionRef = useRef<AIStreamSession | null>(null);
    const editorRef = useRef<EditorInstance | null>(options.editor ?? null);
    const projectIdRef = useRef<string>(options.projectId || options.fileId || 'default-project');
    const targetFileIdsRef = useRef<string[]>(options.fileId ? [options.fileId] : []);
    const masterDecisionLedgerRef = useRef<Record<string, ATMSDecisionNode>>({});
    const sessionInvalidationMapRef = useRef<Record<string, SectionTarget[]>>({});
    const activeGhostHunksRef = useRef<GhostHunk[]>([]);
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
            if (nextList.length > 0) {
                setPreviewText(nextList.map((h) => h.replacementText).join('\n\n'));
            }
        },
        []
    );

    const buildGhostHunksFromRawEntries = useCallback(
        (
            rawEntries: ReadonlyArray<Record<string, unknown>>,
            liveContent: string,
            ledger: Record<string, ATMSDecisionNode>
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
                    from = Math.max(0, Math.min(entry.from, liveContent.length));
                    to = Math.max(from, Math.min(entry.to, liveContent.length));
                    originalSlice =
                        typeof entry.originalSlice === 'string'
                            ? entry.originalSlice
                            : liveContent.slice(from, to);
                } else if (
                    hunkRange &&
                    typeof hunkRange.from === 'number' &&
                    typeof hunkRange.to === 'number'
                ) {
                    from = Math.max(0, Math.min(hunkRange.from, liveContent.length));
                    to = Math.max(from, Math.min(hunkRange.to, liveContent.length));
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

    const synthesizeHunksFromLedgerAndInvalidation = useCallback(
        (
            activeFileId: string,
            liveContent: string,
            ledger: Record<string, ATMSDecisionNode>,
            invalidationMap: Record<string, SectionTarget[]>
        ): GhostHunk[] => {
            const targetSlugs = new Set<string>();

            for (const sections of Object.values(invalidationMap)) {
                for (const sec of sections) {
                    if (!activeFileId || sec.fileId === activeFileId) {
                        targetSlugs.add(sec.headingSlug);
                    }
                }
            }

            if (targetSlugs.size === 0) {
                for (const node of Object.values(ledger)) {
                    for (const sec of node.affectedSections ?? []) {
                        if (!activeFileId || sec.fileId === activeFileId) {
                            targetSlugs.add(sec.headingSlug);
                        }
                    }
                }
            }

            const synthesized: GhostHunk[] = [];
            for (const headingSlug of targetSlugs) {
                const relevantDecisions = Object.values(ledger).filter((node) =>
                    node.affectedSections?.some(
                        (sec) =>
                            (!activeFileId || sec.fileId === activeFileId) &&
                            sec.headingSlug === headingSlug
                    )
                );

                const extracted = extractSectionBySlug(liveContent, headingSlug);
                const baseSectionContent = extracted ? extracted.sectionContent : '';
                const proposedContent = synthesizeAgentSectionContent(
                    baseSectionContent,
                    headingSlug,
                    relevantDecisions
                );

                if (extracted) {
                    const mergeOutcome = diff3MergeSection({
                        headingSlug,
                        liveDocumentContent: liveContent,
                        baseSectionContent,
                        agentProposedSectionContent: proposedContent,
                    });
                    synthesized.push({
                        hunkId: `hunk_${headingSlug}`,
                        decisionIds: relevantDecisions.map((d) => d.decisionId),
                        headingSlug,
                        from: mergeOutcome.hunkRange.from,
                        to: mergeOutcome.hunkRange.to,
                        originalSlice: baseSectionContent,
                        replacementText: mergeOutcome.hunkRange.replacementText,
                        status: 'streaming',
                    });
                } else {
                    synthesized.push({
                        hunkId: `hunk_${headingSlug}`,
                        decisionIds: relevantDecisions.map((d) => d.decisionId),
                        headingSlug,
                        from: liveContent.length,
                        to: liveContent.length,
                        originalSlice: '',
                        replacementText: proposedContent,
                        status: 'streaming',
                    });
                }
            }

            return synthesized;
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

            optsRef.current.onHunkAccepted?.(updatedContent, hunkId, nextHunks.length);
            finalizeHunkLifecycleIfEmpty(nextHunks);

            return updatedContent;
        },
        [finalizeHunkLifecycleIfEmpty, resolveEditor, resolveLiveContent, runAsProgrammaticTransaction]
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

            optsRef.current.onHunkRejected?.(hunkId, nextHunks.length);
            finalizeHunkLifecycleIfEmpty(nextHunks);
        },
        [finalizeHunkLifecycleIfEmpty, resolveEditor, runAsProgrammaticTransaction]
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

        const maybePromise = optsRef.current.onAllHunksAccepted?.(updatedContent);
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
            lastAllHunksAcceptedPromiseRef.current = maybePromise as Promise<unknown>;
        } else {
            lastAllHunksAcceptedPromiseRef.current = null;
        }
        finalizeHunkLifecycleIfEmpty([]);

        return updatedContent;
    }, [finalizeHunkLifecycleIfEmpty, resolveEditor, resolveLiveContent, runAsProgrammaticTransaction]);

    /**
     * Rejects and clears all remaining ghost hunks without mutating the document.
     */
    const rejectAllGhostHunks = useCallback((): void => {
        const editor = resolveEditor();
        clearEditorGhostDecorations(editor);

        activeGhostHunksRef.current = [];
        setActiveGhostHunks([]);

        optsRef.current.onAllHunksRejected?.();
        finalizeHunkLifecycleIfEmpty([]);
    }, [clearEditorGhostDecorations, finalizeHunkLifecycleIfEmpty, resolveEditor]);

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

                    // 3. Extract GhostHunk items when document_writer_node or synthesized_sections arrive
                    const rawSectionEntries = extractRawSectionEntries(candidatePayloads);
                    const liveContent = resolveLiveContent(editor);

                    if (rawSectionEntries.length > 0) {
                        const hunks = buildGhostHunksFromRawEntries(
                            rawSectionEntries,
                            liveContent,
                            masterDecisionLedgerRef.current
                        );
                        upsertHunksIntoSession(session, editor, hunks);
                    } else if (stage === 'document_writer_node') {
                        const synthesizedHunks = synthesizeHunksFromLedgerAndInvalidation(
                            session.fileId,
                            liveContent,
                            masterDecisionLedgerRef.current,
                            sessionInvalidationMapRef.current
                        );
                        if (synthesizedHunks.length > 0) {
                            upsertHunksIntoSession(session, editor, synthesizedHunks);
                        }
                    }
                },
                onInterrupt: (interruptEvt: AgentStreamInterruptEvent) => {
                    if (isStaleSessionEvent(session, activeSessionRef.current)) {
                        return;
                    }

                    const extractedQuestions: Array<
                        ClarifyingQuestionBatch['questions'][number]
                    > = [];

                    for (const intr of interruptEvt.interrupts) {
                        const val = intr.value;
                        if (val && typeof val === 'object' && !Array.isArray(val)) {
                            const rec = val as Record<string, unknown>;
                            if (rec.code === 'INSUFFICIENT_CREDITS') {
                                const msg =
                                    typeof rec.message === 'string' && rec.message.trim()
                                        ? `INSUFFICIENT_CREDITS: ${rec.message.trim()}`
                                        : 'INSUFFICIENT_CREDITS: Credit balance exhausted.';
                                setError(msg);
                                transitionSession(session, 'failed', msg);
                                setStatus('failed');
                                optsRef.current.onError?.(
                                    new AgentStreamError({
                                        code: 'INSUFFICIENT_CREDITS',
                                        status: 402,
                                        message: msg,
                                    })
                                );
                                return;
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

                    if (hitlInterrupted || session.status === 'awaiting_hitl') {
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
            resolveLiveContent,
            synthesizeHunksFromLedgerAndInvalidation,
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

            const requestPayload: AgentStreamRequestPayload = {
                threadId,
                projectId,
                prompt,
                targetFileIds,
                ...(vaultAndSnapshots.ephemeralVaultPayloads
                    ? { ephemeralVaultPayloads: vaultAndSnapshots.ephemeralVaultPayloads }
                    : {}),
                liveDocumentSnapshots: vaultAndSnapshots.liveDocumentSnapshots,
            };

            await executeStreamCycle(session, requestPayload, editor);
        },
        [clearEditorGhostDecorations, executeStreamCycle, resolveEditor, resolveVaultAndSnapshots]
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
                targetFileIds,
                resumePayload: { answers: validation.data.answers },
                ...(vaultAndSnapshots.ephemeralVaultPayloads
                    ? { ephemeralVaultPayloads: vaultAndSnapshots.ephemeralVaultPayloads }
                    : {}),
                liveDocumentSnapshots: vaultAndSnapshots.liveDocumentSnapshots,
            };

            await executeStreamCycle(resumedSession, requestPayload, editor);
        },
        [executeStreamCycle, resolveEditor, resolveVaultAndSnapshots]
    );

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
        threadId: activeThreadId,
        isLoading: status === 'running_graph' || status === 'streaming_hunks',
        isStreaming: status === 'running_graph' || status === 'streaming_hunks',
        isCommitting: false,
        isPreviewReady: status === 'preview_ready',
        isAwaitingHitl: status === 'awaiting_hitl',
        startAgentSession,
        resumeAgentInterrupt,
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
