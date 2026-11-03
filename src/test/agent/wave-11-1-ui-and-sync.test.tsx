/**
 * @vitest-environment jsdom
 *
 * Phase 11 — Wave 11.1 Comprehensive Unit & Integration Test Suite:
 * 1. HITLQuestionCard (`src/components/agent/hitl-question-card.tsx`)
 * 2. AgentChatPanel (`src/components/agent/chat-panel.tsx`)
 * 3. AIToolbar (`src/components/editor/ai-toolbar.tsx`)
 * 4. useAIStream Vault Gates, HITL Interrupts & Section Synthesis (`src/hooks/use-ai-stream.ts`)
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, renderHook, act } from "@testing-library/react";
import { HITLQuestionCard, type HITLQuestionItem } from "@/components/agent/hitl-question-card";
import { AgentChatPanel } from "@/components/agent/chat-panel";
import { AIToolbar } from "@/components/editor/ai-toolbar";
import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import { PROJECT_TAXONOMY_SENTINEL_ID } from "@/core/agent/taxonomy/predefined-tags";
import type { GhostHunk, EditorAdapter } from "@/components/editor/markdown/types";
import type { StreamHandlerOptions } from "@/lib/ai/stream-handler";

const mockConsumeAgentStream = vi.fn();
vi.mock("@/lib/ai/stream-handler", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/ai/stream-handler")>();
    return {
        ...actual,
        consumeAgentStream: (...args: unknown[]) => mockConsumeAgentStream(...args),
        consumeAIStream: (...args: unknown[]) => mockConsumeAgentStream(...args),
    };
});

import { useAIStream } from "@/hooks/use-ai-stream";

const SAMPLE_QUESTIONS: HITLQuestionItem[] = [
    {
        questionId: "q_storage_engine",
        topicSlug: "storage-architecture",
        questionPrompt: "Which primary persistence engine should store the ATMS ledger?",
        contextExplanation: "High concurrency requires deterministic ACID isolation.",
        options: [
            {
                optionKey: "opt_postgres",
                neutralSummary: "Neon Serverless PostgreSQL",
                rationaleAndPremises: "Strict serializable transactions and native JSONB indexing.",
            },
            {
                optionKey: "opt_sqlite",
                neutralSummary: "Embedded SQLite Replica",
                rationaleAndPremises: "Zero network hop latency for single-node deployments.",
            },
        ],
    },
    {
        questionId: "q_sync_protocol",
        topicSlug: "offline-sync-protocol",
        questionPrompt: "How should concurrent section edits be reconciled?",
        options: [
            {
                optionKey: "opt_diff3",
                neutralSummary: "Section-Level 3-Way Diff3 Merge",
                rationaleAndPremises: "Preserves non-overlapping user edits with deterministic conflict markers.",
            },
            {
                optionKey: "opt_lww",
                neutralSummary: "Last-Writer-Wins Overwrite",
                rationaleAndPremises: "Simpler implementation at the risk of overwriting concurrent paragraphs.",
            },
        ],
    },
];

const SAMPLE_DECISION_NODE: ATMSDecisionNode = {
    decisionId: "dec_storage_01",
    topicSlug: "storage-architecture",
    questionPrompt: "Which primary persistence engine should store the ATMS ledger?",
    selectedOptionKey: "opt_postgres",
    runnerUpOptionKey: "opt_sqlite",
    selectionRationale: "Selected Neon PostgreSQL for multi-device ACID guarantees.",
    evaluatedAlternatives: [
        {
            optionKey: "opt_postgres",
            neutralSummary: "Neon Serverless PostgreSQL",
            rationaleAndPremises: "ACID compliance across serverless functions.",
            normalizedProbability: 0.82,
        },
        {
            optionKey: "opt_sqlite",
            neutralSummary: "Embedded SQLite Replica",
            rationaleAndPremises: "Local-only write lock constraints.",
            normalizedProbability: 0.18,
        },
    ],
    dependsOn: ["dec_auth_00"],
    dependedBy: ["dec_sync_02"],
    affectedSections: [
        { fileId: "file-arch-1", headingSlug: "storage-layer" },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
    conceptTags: ["database", "consistency"],
};

describe("Phase 11 — Wave 11.1 UI Components & Orchestration Suite", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("1. HITLQuestionCard Component", () => {
        it("returns null when questions array is empty and no single question prop is provided", () => {
            const { container } = render(
                <HITLQuestionCard questions={[]} onSubmit={vi.fn()} />
            );
            expect(container.firstChild).toBeNull();
        });

        it("normalizes a single question prop into a 1-item batch and renders all metadata", () => {
            render(
                <HITLQuestionCard
                    question={SAMPLE_QUESTIONS[0]}
                    onSubmit={vi.fn()}
                />
            );

            expect(screen.getByTestId("hitl-question-card")).toBeDefined();
            expect(screen.getByTestId("hitl-progress-badge").textContent).toBe("0/1 answered");
            expect(screen.getByTestId("hitl-topic-slug-q_storage_engine").textContent).toBe(
                "storage-architecture"
            );
            expect(screen.getByTestId("hitl-context-q_storage_engine").textContent).toContain(
                "High concurrency requires deterministic ACID isolation."
            );
        });

        it("blocks submission with validation errors when any question is unanswered, then clears error upon selection", async () => {
            const onSubmit = vi.fn();
            render(
                <HITLQuestionCard
                    questions={SAMPLE_QUESTIONS}
                    onSubmit={onSubmit}
                />
            );

            // Answer only the first question
            fireEvent.click(screen.getByTestId("hitl-option-q_storage_engine-opt_postgres"));
            expect(screen.getByTestId("hitl-progress-badge").textContent).toBe("1/2 answered");

            // Attempt submit with second question unanswered
            fireEvent.submit(screen.getByTestId("hitl-question-card"));

            expect(onSubmit).not.toHaveBeenCalled();
            expect(screen.getByTestId("hitl-question-error-q_sync_protocol").textContent).toContain(
                "Please select an architectural option"
            );
            expect(screen.getByTestId("hitl-validation-error")).toBeDefined();

            // Selecting an option on the second question immediately clears the error
            fireEvent.click(screen.getByTestId("hitl-option-q_sync_protocol-opt_diff3"));
            expect(screen.queryByTestId("hitl-question-error-q_sync_protocol")).toBeNull();
            expect(screen.queryByTestId("hitl-validation-error")).toBeNull();
            expect(screen.getByTestId("hitl-progress-badge").textContent).toBe("2/2 answered");

            // Now submit succeeds and passes ClarificationResponseSchema-validated payload
            fireEvent.submit(screen.getByTestId("hitl-question-card"));
            await waitFor(() => {
                expect(onSubmit).toHaveBeenCalledTimes(1);
                expect(onSubmit).toHaveBeenCalledWith({
                    answers: [
                        { questionId: "q_storage_engine", selectedOptionKey: "opt_postgres" },
                        { questionId: "q_sync_protocol", selectedOptionKey: "opt_diff3" },
                    ],
                });
            });
        });

        it("enforces MAX_CUSTOM_NOTES_LENGTH (500 chars) and trims valid custom notes", async () => {
            const onSubmit = vi.fn();
            render(
                <HITLQuestionCard
                    question={SAMPLE_QUESTIONS[0]}
                    onSubmit={onSubmit}
                />
            );

            fireEvent.click(screen.getByTestId("hitl-option-q_storage_engine-opt_postgres"));
            const notesInput = screen.getByTestId("hitl-custom-notes-q_storage_engine");

            // Exceed 500 characters
            const overLimitNotes = "x".repeat(505);
            fireEvent.change(notesInput, { target: { value: overLimitNotes } });
            expect(screen.getByTestId("hitl-char-count-q_storage_engine").textContent).toBe("505/500");

            fireEvent.submit(screen.getByTestId("hitl-question-card"));
            expect(onSubmit).not.toHaveBeenCalled();
            expect(screen.getByTestId("hitl-question-error-q_storage_engine").textContent).toContain(
                "Custom notes cannot exceed 500 characters"
            );

            // Update to valid notes with surrounding whitespace
            fireEvent.change(notesInput, {
                target: { value: "  Must support connection pooling via PgBouncer.  " },
            });
            fireEvent.submit(screen.getByTestId("hitl-question-card"));

            await waitFor(() => {
                expect(onSubmit).toHaveBeenCalledWith({
                    answers: [
                        {
                            questionId: "q_storage_engine",
                            selectedOptionKey: "opt_postgres",
                            customNotes: "Must support connection pooling via PgBouncer.",
                        },
                    ],
                });
            });
        });

        it("disables controls and displays Resuming Agent state when isSubmitting is true", () => {
            const onSubmit = vi.fn();
            render(
                <HITLQuestionCard
                    question={SAMPLE_QUESTIONS[0]}
                    onSubmit={onSubmit}
                    isSubmitting={true}
                />
            );

            const submitBtn = screen.getByTestId("hitl-submit-button") as HTMLButtonElement;
            expect(submitBtn.disabled).toBe(true);
            expect(submitBtn.textContent).toContain("Resuming Agent...");
        });

        it("allows switching options back and forth and clears previous question error upon new selection", async () => {
            const onSubmit = vi.fn();
            render(
                <HITLQuestionCard
                    question={SAMPLE_QUESTIONS[0]}
                    onSubmit={onSubmit}
                />
            );

            fireEvent.click(screen.getByTestId("hitl-option-q_storage_engine-opt_postgres"));
            expect(screen.getByTestId("hitl-progress-badge").textContent).toBe("1/1 answered");

            fireEvent.click(screen.getByTestId("hitl-option-q_storage_engine-opt_sqlite"));
            expect(screen.getByTestId("hitl-progress-badge").textContent).toBe("1/1 answered");

            fireEvent.submit(screen.getByTestId("hitl-question-card"));
            await waitFor(() => {
                expect(onSubmit).toHaveBeenCalledWith({
                    answers: [
                        { questionId: "q_storage_engine", selectedOptionKey: "opt_sqlite" },
                    ],
                });
            });
        });

        it("omits customNotes key from submission payload when input consists only of whitespace", async () => {
            const onSubmit = vi.fn();
            render(
                <HITLQuestionCard
                    question={SAMPLE_QUESTIONS[0]}
                    onSubmit={onSubmit}
                />
            );

            fireEvent.click(screen.getByTestId("hitl-option-q_storage_engine-opt_postgres"));
            const notesInput = screen.getByTestId("hitl-custom-notes-q_storage_engine");
            fireEvent.change(notesInput, { target: { value: "     \n   \t  " } });

            fireEvent.submit(screen.getByTestId("hitl-question-card"));
            await waitFor(() => {
                expect(onSubmit).toHaveBeenCalledTimes(1);
                const submittedAnswer = onSubmit.mock.calls[0][0].answers[0];
                expect(submittedAnswer.customNotes).toBeUndefined();
            });
        });

        it("accepts customNotes at the exact boundary of 500 characters", async () => {
            const onSubmit = vi.fn();
            render(
                <HITLQuestionCard
                    question={SAMPLE_QUESTIONS[0]}
                    onSubmit={onSubmit}
                />
            );

            fireEvent.click(screen.getByTestId("hitl-option-q_storage_engine-opt_postgres"));
            const notesInput = screen.getByTestId("hitl-custom-notes-q_storage_engine");
            const exactly500 = "x".repeat(500);
            fireEvent.change(notesInput, { target: { value: exactly500 } });

            expect(screen.getByTestId("hitl-char-count-q_storage_engine").textContent).toBe("500/500");
            fireEvent.submit(screen.getByTestId("hitl-question-card"));

            await waitFor(() => {
                expect(onSubmit).toHaveBeenCalledTimes(1);
                expect(onSubmit.mock.calls[0][0].answers[0].customNotes).toBe(exactly500);
            });
        });

        it("disables all interactions when disabled={true}", () => {
            const onSubmit = vi.fn();
            render(
                <HITLQuestionCard
                    question={SAMPLE_QUESTIONS[0]}
                    onSubmit={onSubmit}
                    disabled={true}
                />
            );

            const optLabel = screen.getByTestId("hitl-option-q_storage_engine-opt_postgres");
            const radioInput = optLabel.querySelector("input[type='radio']") as HTMLInputElement;
            expect(radioInput.disabled).toBe(true);

            fireEvent.click(optLabel);
            expect(screen.getByTestId("hitl-progress-badge").textContent).toBe("0/1 answered");

            const submitBtn = screen.getByTestId("hitl-submit-button");
            expect(submitBtn.hasAttribute("disabled")).toBe(true);
        });
    });

    describe("2. AgentChatPanel Component", () => {
        it("returns null when isOpen is false", () => {
            const { container } = render(
                <AgentChatPanel
                    isOpen={false}
                    status="idle"
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                />
            );
            expect(container.firstChild).toBeNull();
        });

        it("computes 7-stage pipeline states accurately across status and node aliases", () => {
            const { rerender } = render(
                <AgentChatPanel
                    status="running_graph"
                    currentStage="confidence_classifier_node"
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                />
            );

            // Stage 4 (classifier) is index 3: stages 1-3 completed, stage 4 active, stages 5-7 upcoming
            expect(screen.getByTestId("agent-stage-orchestrator").getAttribute("data-stage-state")).toBe("completed");
            expect(screen.getByTestId("agent-stage-search").getAttribute("data-stage-state")).toBe("completed");
            expect(screen.getByTestId("agent-stage-assumptions_jev").getAttribute("data-stage-state")).toBe("completed");
            expect(screen.getByTestId("agent-stage-classifier").getAttribute("data-stage-state")).toBe("active");
            expect(screen.getByTestId("agent-stage-ledger").getAttribute("data-stage-state")).toBe("upcoming");

            // awaiting_hitl -> Stage 6 (hitl_interrupt) is active
            rerender(
                <AgentChatPanel
                    status="awaiting_hitl"
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                />
            );
            expect(screen.getByTestId("agent-stage-hitl_interrupt").getAttribute("data-stage-state")).toBe("active");
            expect(screen.getByTestId("agent-stage-writer").getAttribute("data-stage-state")).toBe("upcoming");

            // streaming_hunks -> Stage 7 (writer) is active
            rerender(
                <AgentChatPanel
                    status="streaming_hunks"
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                />
            );
            expect(screen.getByTestId("agent-stage-writer").getAttribute("data-stage-state")).toBe("active");

            // preview_ready -> All 7 stages completed
            rerender(
                <AgentChatPanel
                    status="preview_ready"
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                />
            );
            expect(screen.getByTestId("agent-stage-writer").getAttribute("data-stage-state")).toBe("completed");
        });

        it("renders ATMS Decision Ledger nodes while filtering out reserved __PROJECT_TAXONOMY__ entries", () => {
            const ledgerWithReservedRecord = {
                [PROJECT_TAXONOMY_SENTINEL_ID]: {
                    decisionId: PROJECT_TAXONOMY_SENTINEL_ID,
                    topicSlug: "system-taxonomy",
                } as unknown as ATMSDecisionNode,
                dec_storage_01: SAMPLE_DECISION_NODE,
            };

            render(
                <AgentChatPanel
                    status="preview_ready"
                    masterDecisionLedger={ledgerWithReservedRecord}
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                />
            );

            expect(screen.queryByTestId(`decision-node-${PROJECT_TAXONOMY_SENTINEL_ID}`)).toBeNull();
            expect(screen.getByTestId("decision-node-dec_storage_01")).toBeDefined();
            expect(screen.getByTestId("decision-topic-dec_storage_01").textContent).toBe("storage-architecture");
            expect(screen.getByTestId("decision-status-dec_storage_01").textContent).toBe("APPROVED_DIRECT");
            expect(screen.getByTestId("decision-impact-dec_storage_01").textContent).toBe("CORE_ARCHITECTURAL");
            expect(screen.getByTestId("decision-load-bearing-dec_storage_01").textContent).toBe("Load-Bearing");
            expect(screen.getByTestId("decision-selected-option-dec_storage_01").textContent).toContain("opt_postgres");
            expect(screen.getByTestId("decision-runner-up-dec_storage_01").textContent).toContain("opt_sqlite");
            expect(screen.getByTestId("decision-rationale-dec_storage_01").textContent).toContain(
                "Selected Neon PostgreSQL"
            );
            expect(screen.getByTestId("decision-tags-dec_storage_01").textContent).toContain("#database");
            expect(screen.getByTestId("decision-alternative-dec_storage_01-opt_postgres").textContent).toContain("82%");
            expect(screen.getByTestId("decision-depends-on-dec_storage_01").textContent).toContain("dec_auth_00");
            expect(screen.getByTestId("decision-depended-by-dec_storage_01").textContent).toContain("dec_sync_02");
            expect(screen.getByTestId("decision-sections-dec_storage_01").textContent).toContain(
                "file-arch-1#storage-layer"
            );
        });

        it("renders Multi-Hunk Ghost Review Bar and triggers batch and individual hunk callbacks", () => {
            const onAcceptGhostHunk = vi.fn();
            const onRejectGhostHunk = vi.fn();
            const onAcceptAllGhostHunks = vi.fn();
            const onRejectAllGhostHunks = vi.fn();

            const hunks: GhostHunk[] = [
                {
                    hunkId: "hunk_arch_1",
                    decisionIds: ["dec_storage_01"],
                    headingSlug: "storage-layer",
                    from: 0,
                    to: 25,
                    originalSlice: "Old storage section",
                    replacementText: "New storage section",
                    status: "preview_ready",
                },
                {
                    hunkId: "hunk_arch_2",
                    decisionIds: ["dec_sync_02"],
                    headingSlug: "sync-engine",
                    from: 30,
                    to: 55,
                    originalSlice: "Old sync section",
                    replacementText: "New sync section",
                    status: "preview_ready",
                },
            ];

            render(
                <AgentChatPanel
                    status="preview_ready"
                    activeGhostHunks={hunks}
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                    onAcceptGhostHunk={onAcceptGhostHunk}
                    onRejectGhostHunk={onRejectGhostHunk}
                    onAcceptAllGhostHunks={onAcceptAllGhostHunks}
                    onRejectAllGhostHunks={onRejectAllGhostHunks}
                />
            );

            expect(screen.getByTestId("agent-ghost-review-bar")).toBeDefined();
            expect(screen.getByTestId("agent-ghost-hunks-count").textContent).toBe("2 hunks");

            fireEvent.click(screen.getByTestId("agent-accept-hunk-hunk_arch_1"));
            expect(onAcceptGhostHunk).toHaveBeenCalledWith("hunk_arch_1");

            fireEvent.click(screen.getByTestId("agent-reject-hunk-hunk_arch_2"));
            expect(onRejectGhostHunk).toHaveBeenCalledWith("hunk_arch_2");

            fireEvent.click(screen.getByTestId("agent-accept-all-hunks"));
            expect(onAcceptAllGhostHunks).toHaveBeenCalledTimes(1);

            fireEvent.click(screen.getByTestId("agent-reject-all-hunks"));
            expect(onRejectAllGhostHunks).toHaveBeenCalledTimes(1);
        });

        it("submits prompt via onStartSession, clears input, and enforces offline/vault guards", async () => {
            const onStartSession = vi.fn();
            const onStopSession = vi.fn();
            const onResetSession = vi.fn();

            const { rerender } = render(
                <AgentChatPanel
                    status="idle"
                    targetFileIds={["file-1"]}
                    onStartSession={onStartSession}
                    onResumeInterrupt={vi.fn()}
                    onStopSession={onStopSession}
                    onResetSession={onResetSession}
                />
            );

            const promptInput = screen.getByTestId("agent-prompt-input") as HTMLTextAreaElement;
            fireEvent.change(promptInput, {
                target: { value: "  Synthesize zero-knowledge sync architecture  " },
            });
            fireEvent.submit(screen.getByTestId("agent-prompt-form"));

            await waitFor(() => {
                expect(onStartSession).toHaveBeenCalledWith(
                    "Synthesize zero-knowledge sync architecture",
                    ["file-1"]
                );
                expect(promptInput.value).toBe("");
            });

            // Verify Vault Shield Notice & execution block when encrypted without opt-in
            rerender(
                <AgentChatPanel
                    status="completed"
                    isEncrypted={true}
                    allowAIOnEncryptedFiles={false}
                    error="VAULT_AI_ACCESS_DENIED"
                    onStartSession={onStartSession}
                    onResumeInterrupt={vi.fn()}
                    onResetSession={onResetSession}
                />
            );
            expect(screen.getByTestId("agent-vault-shield-notice")).toBeDefined();
            expect(screen.getByTestId("agent-error-alert").textContent).toContain("VAULT_AI_ACCESS_DENIED");

            fireEvent.click(screen.getByTestId("agent-reset-button"));
            expect(onResetSession).toHaveBeenCalledTimes(1);
        });

        it("renders ATMS Decision Ledger nodes when masterDecisionLedger is provided as an array", () => {
            render(
                <AgentChatPanel
                    status="preview_ready"
                    masterDecisionLedger={[SAMPLE_DECISION_NODE]}
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                />
            );

            expect(screen.getByTestId("decision-node-dec_storage_01")).toBeDefined();
            expect(screen.getByTestId("decision-topic-dec_storage_01").textContent).toBe("storage-architecture");
        });

        it("renders HITLQuestionCard inside ChatPanel when status is awaiting_hitl and activeQuestionQueue has items", async () => {
            const onResumeInterrupt = vi.fn();
            render(
                <AgentChatPanel
                    status="awaiting_hitl"
                    activeQuestionQueue={[SAMPLE_QUESTIONS[0]]}
                    onStartSession={vi.fn()}
                    onResumeInterrupt={onResumeInterrupt}
                />
            );

            expect(screen.getByTestId("hitl-question-card")).toBeDefined();
            fireEvent.click(screen.getByTestId("hitl-option-q_storage_engine-opt_postgres"));
            fireEvent.submit(screen.getByTestId("hitl-question-card"));

            await waitFor(() => {
                expect(onResumeInterrupt).toHaveBeenCalledTimes(1);
            });
        });

        it("disables prompt textarea, submit button, and displays offline badge when isOffline={true}", () => {
            const onStartSession = vi.fn();
            render(
                <AgentChatPanel
                    status="idle"
                    isOffline={true}
                    onStartSession={onStartSession}
                    onResumeInterrupt={vi.fn()}
                />
            );

            expect(screen.getByTestId("agent-offline-notice")).toBeDefined();
            const textarea = screen.getByTestId("agent-prompt-input");
            expect(textarea.hasAttribute("disabled")).toBe(true);
            const startBtn = screen.getByTestId("agent-start-button");
            expect(startBtn.hasAttribute("disabled")).toBe(true);
        });

        it("displays stop button in running_graph or streaming_hunks status and invokes onStopSession", () => {
            const onStopSession = vi.fn();
            const { rerender } = render(
                <AgentChatPanel
                    status="running_graph"
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                    onStopSession={onStopSession}
                />
            );

            const stopBtn = screen.getByTestId("agent-stop-button");
            fireEvent.click(stopBtn);
            expect(onStopSession).toHaveBeenCalledTimes(1);

            rerender(
                <AgentChatPanel
                    status="streaming_hunks"
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                    onStopSession={onStopSession}
                />
            );
            fireEvent.click(screen.getByTestId("agent-stop-button"));
            expect(onStopSession).toHaveBeenCalledTimes(2);
        });

        it("renders empty state message when masterDecisionLedger is empty", () => {
            render(
                <AgentChatPanel
                    status="idle"
                    masterDecisionLedger={{}}
                    onStartSession={vi.fn()}
                    onResumeInterrupt={vi.fn()}
                />
            );

            expect(screen.getByTestId("agent-decision-ledger-empty")).toBeDefined();
            expect(screen.getByTestId("agent-decision-ledger-empty").textContent).toContain(
                "No architectural decisions recorded"
            );
        });
    });

    describe("3. AIToolbar Component", () => {
        it("renders Architectural Agent toggle, Multi-Hunk Ghost batch bar, and Vault/Write-Lock/Offline badges", () => {
            const onToggleAgentPanel = vi.fn();
            const onAcceptAllGhostHunks = vi.fn();
            const onRejectAllGhostHunks = vi.fn();
            const onToggleAllowAI = vi.fn();

            const { rerender } = render(
                <AIToolbar
                    isAgentPanelOpen={true}
                    onToggleAgentPanel={onToggleAgentPanel}
                    activeGhostHunksCount={1}
                    onAcceptAllGhostHunks={onAcceptAllGhostHunks}
                    onRejectAllGhostHunks={onRejectAllGhostHunks}
                    isEncrypted={true}
                    allowAIOnEncryptedFiles={false}
                    onToggleAllowAI={onToggleAllowAI}
                    isWriteLocked={true}
                    isOffline={true}
                />
            );

            const toggleBtn = screen.getByTestId("ai-toolbar-agent-toggle");
            expect(toggleBtn.getAttribute("aria-pressed")).toBe("true");
            fireEvent.click(toggleBtn);
            expect(onToggleAgentPanel).toHaveBeenCalledTimes(1);

            expect(screen.getByTestId("ai-toolbar-ghost-count").textContent).toBe("1 hunk");
            fireEvent.click(screen.getByTestId("ai-toolbar-accept-all"));
            expect(onAcceptAllGhostHunks).toHaveBeenCalledTimes(1);
            fireEvent.click(screen.getByTestId("ai-toolbar-reject-all"));
            expect(onRejectAllGhostHunks).toHaveBeenCalledTimes(1);

            expect(screen.getByTestId("ai-encrypted-badge")).toBeDefined();
            expect(screen.getByTestId("ai-toolbar-write-lock-badge")).toBeDefined();
            expect(screen.getByTestId("ai-toolbar-offline-badge")).toBeDefined();

            fireEvent.click(screen.getByTestId("ai-vault-shield-toggle"));
            expect(onToggleAllowAI).toHaveBeenCalledWith(true);

            // Rerender with opted-in unlocked vault and 3 hunks
            rerender(
                <AIToolbar
                    isAgentPanelOpen={false}
                    activeGhostHunksCount={3}
                    isEncrypted={true}
                    allowAIOnEncryptedFiles={true}
                    isVaultUnlocked={true}
                    onToggleAllowAI={onToggleAllowAI}
                />
            );
            expect(screen.getByTestId("ai-toolbar-ghost-count").textContent).toBe("3 hunks");
            expect(screen.getByTestId("ai-vault-opted-in-badge")).toBeDefined();

            // Rerender with locked vault
            rerender(
                <AIToolbar
                    isEncrypted={true}
                    allowAIOnEncryptedFiles={true}
                    isVaultUnlocked={false}
                />
            );
            expect(screen.getByTestId("ai-vault-locked-badge")).toBeDefined();
        });

        it("omits ghost batch review buttons when activeGhostHunksCount is 0 or undefined", () => {
            render(
                <AIToolbar
                    activeGhostHunksCount={0}
                    onAcceptAllGhostHunks={vi.fn()}
                    onRejectAllGhostHunks={vi.fn()}
                />
            );

            expect(screen.queryByTestId("ai-toolbar-ghost-actions")).toBeNull();
            expect(screen.queryByTestId("ai-toolbar-accept-all")).toBeNull();
            expect(screen.queryByTestId("ai-toolbar-reject-all")).toBeNull();
        });

        it("toggles allowAI from true to false when shield button is clicked in opted-in state", () => {
            const onToggleAllowAI = vi.fn();
            render(
                <AIToolbar
                    isEncrypted={true}
                    allowAIOnEncryptedFiles={true}
                    isVaultUnlocked={true}
                    onToggleAllowAI={onToggleAllowAI}
                />
            );

            expect(screen.getByTestId("ai-vault-opted-in-badge")).toBeDefined();
            const shieldBtn = screen.getByTestId("ai-vault-shield-toggle");
            fireEvent.click(shieldBtn);
            expect(onToggleAllowAI).toHaveBeenCalledWith(false);
        });

        it("renders write-lock badge with aria attributes when isWriteLocked is true", () => {
            render(<AIToolbar isWriteLocked={true} />);
            const badge = screen.getByTestId("ai-toolbar-write-lock-badge");
            expect(badge).toBeDefined();
            expect(badge.textContent).toContain("Locked");
        });
    });

    describe("4. useAIStream Vault Gates, HITL Interrupts & Section Synthesis", () => {
        function createSimpleEditor(initialDoc: string): EditorAdapter {
            let doc = initialDoc;
            return {
                getValue: () => doc,
                setValue: (val: string) => {
                    doc = val;
                },
                getSelection: () => ({ from: 0, to: 0 }),
                setSelection: vi.fn(),
                replaceRange: (from: number, to: number, insert: string) => {
                    doc = doc.slice(0, from) + insert + doc.slice(to);
                },
                replaceRanges: vi.fn(),
                getSelectedText: () => "",
                insertMarkdown: vi.fn(),
                setEditable: vi.fn(),
                focus: vi.fn(),
                blur: vi.fn(),
                hasFocus: () => true,
                undo: () => true,
                redo: () => true,
                canUndo: () => true,
                canRedo: () => false,
                getWordCount: () => 5,
                getCharCount: () => doc.length,
                getLineCount: () => 2,
                getHeadingCount: () => 1,
                getMode: () => "live",
                setMode: vi.fn(),
                getDirectionSettings: () => ({ mode: "auto", lockCodeBlocksLTR: true }),
                setDirectionSettings: vi.fn(),
                destroy: vi.fn(),
            };
        }

        it("enforces VAULT_AI_ACCESS_DENIED and VAULT_LOCKED gates before dispatching network stream", async () => {
            const onVaultLocked = vi.fn();
            const editor = createSimpleEditor("# Secret Architecture\n\nConfidential details.");

            // Case A: Encrypted file with allowAIOnEncryptedFiles = false
            const { result: deniedResult } = renderHook(() =>
                useAIStream({
                    fileId: "file-enc-1",
                    editor,
                    isEncrypted: true,
                    allowAIOnEncryptedFiles: false,
                })
            );

            await act(async () => {
                await deniedResult.current.startAgentSession("Analyze secret architecture");
            });

            expect(mockConsumeAgentStream).not.toHaveBeenCalled();
            expect(deniedResult.current.status).toBe("failed");
            expect(deniedResult.current.error).toContain("VAULT_AI_ACCESS_DENIED");

            // Case B: Encrypted file with allowAIOnEncryptedFiles = true, but vault is locked
            const { result: lockedResult } = renderHook(() =>
                useAIStream({
                    fileId: "file-enc-1",
                    editor,
                    isEncrypted: true,
                    allowAIOnEncryptedFiles: true,
                    isVaultUnlocked: () => false,
                    onVaultLocked,
                })
            );

            await act(async () => {
                await lockedResult.current.startAgentSession("Analyze secret architecture");
            });

            expect(mockConsumeAgentStream).not.toHaveBeenCalled();
            expect(lockedResult.current.status).toBe("failed");
            expect(lockedResult.current.error).toContain("VAULT_LOCKED");
            expect(onVaultLocked).toHaveBeenCalledTimes(1);

            // Case C: Encrypted file with allowAIOnEncryptedFiles = true and unlocked vault -> populates ephemeralVaultPayloads
            let capturedPayload: unknown = null;
            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                capturedPayload = opts.payload;
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-enc",
                    threadId: "t-enc",
                    operationId: "op-enc",
                });
                opts.onDone?.({
                    type: "done",
                    threadId: "t-enc",
                    operationId: "op-enc",
                });
            });

            const { result: unlockedResult } = renderHook(() =>
                useAIStream({
                    fileId: "file-enc-1",
                    editor,
                    isEncrypted: true,
                    allowAIOnEncryptedFiles: true,
                    isVaultUnlocked: () => true,
                })
            );

            await act(async () => {
                await unlockedResult.current.startAgentSession("Analyze secret architecture");
            });

            expect(mockConsumeAgentStream).toHaveBeenCalledTimes(1);
            expect(capturedPayload).toMatchObject({
                ephemeralVaultPayloads: {
                    "file-enc-1": "# Secret Architecture\n\nConfidential details.",
                },
                liveDocumentSnapshots: {
                    "file-enc-1": "# Secret Architecture\n\nConfidential details.",
                },
            });
        });

        it("handles HITL interrupt suspension, validates ClarificationResponse, and resumes execution", async () => {
            const editor = createSimpleEditor("# System Spec\n\nInitial draft.");

            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-hitl",
                    threadId: "thread-hitl-1",
                    operationId: "op-hitl-1",
                });
                opts.onInterrupt?.({
                    type: "interrupt",
                    threadId: "thread-hitl-1",
                    operationId: "op-hitl-1",
                    interrupts: [
                        {
                            value: {
                                questions: [SAMPLE_QUESTIONS[0]],
                            },
                            resumable: true,
                        },
                    ],
                });
            });

            const { result } = renderHook(() =>
                useAIStream({
                    fileId: "file-hitl-1",
                    threadId: "thread-hitl-1",
                    editor,
                })
            );

            await act(async () => {
                await result.current.startAgentSession("Refine storage specification");
            });

            expect(result.current.status).toBe("awaiting_hitl");
            expect(result.current.activeQuestionQueue).toHaveLength(1);
            expect(result.current.activeQuestionQueue[0].questionId).toBe("q_storage_engine");

            // Invalid clarification response (customNotes > 500 chars) fails ClarificationResponseSchema validation
            await act(async () => {
                await result.current.resumeAgentInterrupt({
                    answers: [
                        {
                            questionId: "q_storage_engine",
                            selectedOptionKey: "opt_postgres",
                            customNotes: "x".repeat(505),
                        },
                    ],
                });
            });
            expect(result.current.status).toBe("failed");
            expect(result.current.error).toContain("INVALID_CLARIFICATION_RESPONSE");

            // Valid clarification response dispatches resumePayload to consumeAgentStream
            let resumedPayload: unknown = null;
            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                resumedPayload = opts.payload;
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-hitl-2",
                    threadId: "thread-hitl-1",
                    operationId: "op-hitl-2",
                });
                opts.onDone?.({
                    type: "done",
                    threadId: "thread-hitl-1",
                    operationId: "op-hitl-2",
                });
            });

            await act(async () => {
                await result.current.resumeAgentInterrupt({
                    answers: [
                        {
                            questionId: "q_storage_engine",
                            selectedOptionKey: "opt_postgres",
                        },
                    ],
                });
            });

            expect(resumedPayload).toMatchObject({
                threadId: "thread-hitl-1",
                resumePayload: {
                    answers: [
                        {
                            questionId: "q_storage_engine",
                            selectedOptionKey: "opt_postgres",
                        },
                    ],
                },
            });
            expect(result.current.status).toBe("completed");
        });

        it("transitions to failed on INSUFFICIENT_CREDITS interrupt and synthesizes section hunks from ledger + invalidation_map", async () => {
            const editor = createSimpleEditor(
                "# Storage Layer\n\nLegacy storage description.\n\n# Network Layer\n\nTCP transport."
            );

            // 1. INSUFFICIENT_CREDITS interrupt
            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-402",
                    threadId: "t-402",
                    operationId: "op-402",
                });
                opts.onInterrupt?.({
                    type: "interrupt",
                    threadId: "t-402",
                    operationId: "op-402",
                    interrupts: [
                        {
                            value: {
                                code: "INSUFFICIENT_CREDITS",
                                message: "Token quota exceeded during Stage 4",
                            },
                        },
                    ],
                });
            });

            const { result } = renderHook(() =>
                useAIStream({
                    fileId: "file-arch-1",
                    editor,
                })
            );

            await act(async () => {
                await result.current.startAgentSession("Run deep synthesis");
            });

            expect(result.current.status).toBe("failed");
            expect(result.current.error).toContain("INSUFFICIENT_CREDITS: Token quota exceeded");

            // 2. Client-side synthesis fallback when document_writer_node emits ledger + invalidation_map
            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-synth",
                    threadId: "t-synth",
                    operationId: "op-synth",
                });
                opts.onUpdate?.({
                    type: "update",
                    chunk: {
                        stage: "document_writer_node",
                        master_ledger: {
                            dec_storage_01: SAMPLE_DECISION_NODE,
                        },
                        invalidation_map: {
                            dec_storage_01: [
                                { fileId: "file-arch-1", headingSlug: "storage-layer" },
                            ],
                        },
                    },
                });
                opts.onDone?.({
                    type: "done",
                    threadId: "t-synth",
                    operationId: "op-synth",
                });
            });

            await act(async () => {
                await result.current.startAgentSession("Synthesize storage layer");
            });

            expect(result.current.status).toBe("preview_ready");
            expect(result.current.activeGhostHunks).toHaveLength(1);
            expect(result.current.activeGhostHunks[0].headingSlug).toBe("storage-layer");
            expect(result.current.activeGhostHunks[0].decisionIds).toContain("dec_storage_01");
        });

        it("rejects empty prompt and sets error without dispatching stream", async () => {
            const editor = createSimpleEditor("# Title\n\nContent.");
            const { result } = renderHook(() =>
                useAIStream({
                    fileId: "file-empty-1",
                    editor,
                })
            );

            await act(async () => {
                await result.current.startAgentSession("   ");
            });

            expect(mockConsumeAgentStream).not.toHaveBeenCalled();
            expect(result.current.error).toBe("Please enter a prompt to start the agent session");
        });

        it("rejects concurrent startAgentSession calls when session is already running", async () => {
            const editor = createSimpleEditor("# Title\n\nContent.");

            let triggerDone: (() => void) | null = null;
            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-concurrent",
                    threadId: "t-concurrent",
                    operationId: "op-concurrent",
                });
                triggerDone = () => {
                    opts.onDone?.({
                        type: "done",
                        threadId: "t-concurrent",
                        operationId: "op-concurrent",
                    });
                };
            });

            const { result } = renderHook(() =>
                useAIStream({
                    fileId: "file-concurrent-1",
                    editor,
                })
            );

            await act(async () => {
                await result.current.startAgentSession("First prompt");
            });

            expect(result.current.status).toBe("running_graph");
            expect(mockConsumeAgentStream).toHaveBeenCalledTimes(1);

            await act(async () => {
                await result.current.startAgentSession("Second prompt");
            });

            expect(mockConsumeAgentStream).toHaveBeenCalledTimes(1);

            await act(async () => {
                triggerDone?.();
            });
            expect(result.current.status).toBe("completed");
        });

        it("manages granular hunk acceptance and rejection, notifying lifecycle callbacks", async () => {
            const editor = createSimpleEditor("Hello World");
            const onHunkAccepted = vi.fn();
            const onHunkRejected = vi.fn();
            const onAllHunksAccepted = vi.fn();
            const onAllHunksRejected = vi.fn();

            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-hunks",
                    threadId: "t-hunks",
                    operationId: "op-hunks",
                });
                opts.onUpdate?.({
                    type: "update",
                    chunk: {
                        stage: "document_writer_node",
                        hunks: [
                            {
                                hunkId: "hunk-1",
                                headingSlug: "intro",
                                from: 0,
                                to: 5,
                                replacementText: "Hi",
                            },
                            {
                                hunkId: "hunk-2",
                                headingSlug: "world",
                                from: 6,
                                to: 11,
                                replacementText: "Universe",
                            },
                        ],
                    },
                });
                opts.onDone?.({
                    type: "done",
                    threadId: "t-hunks",
                    operationId: "op-hunks",
                });
            });

            const { result } = renderHook(() =>
                useAIStream({
                    fileId: "file-hunks-1",
                    editor,
                    onHunkAccepted,
                    onHunkRejected,
                    onAllHunksAccepted,
                    onAllHunksRejected,
                })
            );

            await act(async () => {
                await result.current.startAgentSession("Translate greetings");
            });

            expect(result.current.status).toBe("preview_ready");
            expect(result.current.activeGhostHunks).toHaveLength(2);

            let updatedText: string | null = null;
            act(() => {
                updatedText = result.current.acceptGhostHunk("hunk-1");
            });

            expect(updatedText).toBe("Hi World");
            expect(result.current.activeGhostHunks).toHaveLength(1);
            expect(onHunkAccepted).toHaveBeenCalledWith("Hi World", "hunk-1", 1);
            expect(result.current.status).toBe("preview_ready");

            act(() => {
                result.current.rejectGhostHunk("hunk-2");
            });

            expect(result.current.activeGhostHunks).toHaveLength(0);
            expect(onHunkRejected).toHaveBeenCalledWith("hunk-2", 0);
            expect(result.current.status).toBe("completed");
        });

        it("acceptAllGhostHunks applies all replacements atomically and invokes onAllHunksAccepted", async () => {
            const editor = createSimpleEditor("foo and bar");
            const onAllHunksAccepted = vi.fn();

            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-all",
                    threadId: "t-all",
                    operationId: "op-all",
                });
                opts.onUpdate?.({
                    type: "update",
                    chunk: {
                        stage: "document_writer_node",
                        hunks: [
                            {
                                hunkId: "h-foo",
                                headingSlug: "foo-part",
                                from: 0,
                                to: 3,
                                replacementText: "baz",
                            },
                            {
                                hunkId: "h-bar",
                                headingSlug: "bar-part",
                                from: 8,
                                to: 11,
                                replacementText: "qux",
                            },
                        ],
                    },
                });
                opts.onDone?.({
                    type: "done",
                    threadId: "t-all",
                    operationId: "op-all",
                });
            });

            const { result } = renderHook(() =>
                useAIStream({
                    fileId: "file-all-1",
                    editor,
                    onAllHunksAccepted,
                })
            );

            await act(async () => {
                await result.current.startAgentSession("Replace foo and bar");
            });

            expect(result.current.status).toBe("preview_ready");
            expect(result.current.activeGhostHunks).toHaveLength(2);

            let allUpdated: string | null = null;
            act(() => {
                allUpdated = result.current.acceptAllGhostHunks();
            });

            expect(allUpdated).toBe("baz and qux");
            expect(editor.getValue()).toBe("baz and qux");
            expect(result.current.activeGhostHunks).toHaveLength(0);
            expect(onAllHunksAccepted).toHaveBeenCalledWith("baz and qux");
            expect(result.current.status).toBe("completed");
        });

        it("rejectAllGhostHunks clears all hunks without modifying document and invokes onAllHunksRejected", async () => {
            const editor = createSimpleEditor("pristine doc");
            const onAllHunksRejected = vi.fn();

            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-reject-all",
                    threadId: "t-reject-all",
                    operationId: "op-reject-all",
                });
                opts.onUpdate?.({
                    type: "update",
                    chunk: {
                        stage: "document_writer_node",
                        hunks: [
                            {
                                hunkId: "h-1",
                                headingSlug: "doc",
                                from: 0,
                                to: 8,
                                replacementText: "modified",
                            },
                        ],
                    },
                });
                opts.onDone?.({
                    type: "done",
                    threadId: "t-reject-all",
                    operationId: "op-reject-all",
                });
            });

            const { result } = renderHook(() =>
                useAIStream({
                    fileId: "file-reject-all",
                    editor,
                    onAllHunksRejected,
                })
            );

            await act(async () => {
                await result.current.startAgentSession("Propose edit");
            });

            expect(result.current.status).toBe("preview_ready");
            expect(result.current.activeGhostHunks).toHaveLength(1);

            act(() => {
                result.current.rejectAllGhostHunks();
            });

            expect(editor.getValue()).toBe("pristine doc");
            expect(result.current.activeGhostHunks).toHaveLength(0);
            expect(onAllHunksRejected).toHaveBeenCalledTimes(1);
            expect(result.current.status).toBe("idle");
        });

        it("aborts active stream via stopStream, transitioning session to aborted", async () => {
            const editor = createSimpleEditor("content");
            const abortSpy = vi.fn();

            mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
                opts.signal?.addEventListener("abort", abortSpy);
                opts.onStart?.({
                    type: "start",
                    sessionId: "s-stop",
                    threadId: "t-stop",
                    operationId: "op-stop",
                });
            });

            const { result } = renderHook(() =>
                useAIStream({
                    fileId: "file-stop-1",
                    editor,
                })
            );

            await act(async () => {
                await result.current.startAgentSession("Long running prompt");
            });

            expect(result.current.status).toBe("running_graph");

            act(() => {
                result.current.stopStream();
            });

            expect(result.current.status).toBe("aborted");
            expect(abortSpy).toHaveBeenCalled();
        });
    });
});
