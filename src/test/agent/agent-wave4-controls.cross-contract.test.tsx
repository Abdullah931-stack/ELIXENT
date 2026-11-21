/**
 * @vitest-environment jsdom
 *
 * Cross-Contract Integration Suite: Phase 4 Wave 4.2 Controls & Wire Loopback
 *
 * Wires REAL production modules end-to-end without internal mocking:
 *   AgentChatPanel -> useAIStream -> consumeAgentStream (stream-handler.ts)
 *   -> Hono agentRoutes (POST /api/agent/stream)
 *
 * Only true external system boundaries (session auth, Redis rate-limit,
 * elixentAgentGraph execution, settlement flush, DB) are stubbed.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
    AgentRuntimeContext,
    GraphStreamYield,
} from "@/core/agent/engine/runner";
import type { AgentGraphState } from "@/core/agent/state";
import { deriveDefaultWorkspaceId } from "@/server/db/schema/files";
import { getRpcClientFetch, setRpcClientFetch } from "@/client/rpc-client";
import { AgentChatPanel } from "@/components/agent/chat-panel";
import { useAIStream } from "@/hooks/use-ai-stream";

const { mockUser, graphState } = vi.hoisted(() => ({
    mockUser: {
        id: "user-wave42-wire-001",
        email: "wave42@elixent.ai",
    },
    graphState: {
        chunksToEmit: [] as unknown[],
        onStreamStart: null as ((ctx: AgentRuntimeContext) => void) | null,
        capturedInputs: [] as unknown[],
        capturedContexts: [] as AgentRuntimeContext[],
    },
}));

vi.mock("@/server/context/request-context", () => ({
    scheduleAfterResponse: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
    requireAuthenticatedUser: vi.fn(async () => mockUser),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
    return {
        ...actual,
        aiStreamRateLimiter: {
            limit: vi.fn(async () => ({
                success: true,
                remaining: 25,
                reset: Math.ceil(Date.now() / 1000) + 60,
                limit: 30,
                isDegraded: false,
            })),
        },
    };
});

vi.mock("@/core/agent/graph", () => ({
    elixentAgentGraph: {
        stream: vi.fn(async (input: unknown, ctx: AgentRuntimeContext) => {
            graphState.capturedInputs.push(input);
            graphState.capturedContexts.push(ctx);
            if (graphState.onStreamStart) {
                graphState.onStreamStart(ctx);
            }
            const chunks = [...graphState.chunksToEmit];
            async function* gen() {
                for (const c of chunks) {
                    yield c;
                }
            }
            return gen();
        }),
    },
}));

vi.mock("@/server/services/ai-settlement-service", () => ({
    flushPendingSettlementsToPostgres: vi.fn(async () => ({
        flushedCount: 0,
        netDeltaMicro: BigInt(0),
    })),
}));

vi.mock("@/server/db", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/server/db")>();
    return {
        ...actual,
        db: {
            query: {
                workspaces: {
                    findFirst: vi.fn(async () => undefined),
                },
                files: {
                    findFirst: vi.fn(async () => undefined),
                },
            },
            insert: vi.fn(() => ({
                values: vi.fn(() => ({
                    onConflictDoNothing: vi.fn(async () => undefined),
                })),
            })),
        },
    };
});

import { agentRoutes } from "@/server/routes/agent.routes";

function Harness({
    projectId = "legacy-project-wave42",
    editor,
    onAllHunksAccepted,
}: {
    projectId?: string;
    editor?: import("@/components/editor/markdown/types").EditorAdapter;
    onAllHunksAccepted?: (updatedContent: string) => void;
}) {
    const ai = useAIStream({
        fileId: "file-wire-1",
        projectId,
        editor,
        getLiveContent: () => editor?.getValue() ?? "# Architecture\n\nInitial draft.",
        onAllHunksAccepted,
    });

    return (
        <AgentChatPanel
            isOpen={true}
            status={ai.status}
            currentStage={ai.agentGraphStage}
            activeQuestionQueue={ai.activeQuestionQueue}
            masterDecisionLedger={ai.masterDecisionLedger}
            activeGhostHunks={ai.activeGhostHunks}
            activeGhostHunksCount={ai.activeGhostHunksCount}
            error={ai.error}
            selectedSystem2ModelId={ai.selectedSystem2ModelId}
            onSelectSystem2Model={ai.setSelectedSystem2ModelId}
            permissionMode={ai.permissionMode}
            onSelectPermissionMode={ai.setPermissionMode}
            onStartSession={ai.startAgentSession}
            onResumeInterrupt={ai.resumeAgentInterrupt}
            onResumeInsufficientCredits={ai.resumeInsufficientCreditsTask}
            onAcceptAllGhostHunks={ai.acceptAllGhostHunks}
            onStopSession={ai.stopStream}
            onResetSession={ai.reset}
            targetFileIds={["file-wire-1"]}
        />
    );
}

describe("Phase 4 Wave 4.2 Cross-Contract Loopback (AgentChatPanel -> useAIStream -> stream-handler -> agentRoutes)", () => {
    let prevFetch: typeof fetch | undefined;
    const rawBodiesSent: Array<Record<string, unknown>> = [];

    beforeEach(() => {
        vi.clearAllMocks();
        rawBodiesSent.length = 0;
        graphState.chunksToEmit = [];
        graphState.onStreamStart = null;
        graphState.capturedInputs = [];
        graphState.capturedContexts = [];

        prevFetch = getRpcClientFetch();
        setRpcClientFetch(async (_input, init) => {
            if (typeof init?.body === "string") {
                rawBodiesSent.push(JSON.parse(init.body) as Record<string, unknown>);
            }
            return agentRoutes.request("http://localhost/stream", init);
        });
    });

    afterEach(() => {
        setRpcClientFetch(prevFetch);
    });

    it("forwards selected System 2 model & permission mode without synthesized workspaceId, pauses on INSUFFICIENT_CREDITS SSE interrupt, and resumes with downgraded model", async () => {
        // Turn 1: Server yields native INSUFFICIENT_CREDITS interrupt (no trailing done frame)
        graphState.chunksToEmit = [
            {
                nodeId: "assumption_extractor_node",
                stepIndex: 2,
                status: "INTERRUPTED",
                interruptReason: "INSUFFICIENT_CREDITS",
                interruptPayload: { availableMicro: 100, requiredMicro: 95_000 },
            } satisfies Partial<GraphStreamYield>,
        ];

        render(<Harness projectId="legacy-project-wave42" />);

        // Select System 2 model & Full-Auto permission mode in AgentChatPanel
        fireEvent.change(screen.getByTestId("agent-system2-model-select"), {
            target: { value: "google/gemini-3.1-pro" },
        });
        fireEvent.click(screen.getByTestId("agent-permission-mode-full_auto"));

        fireEvent.change(screen.getByTestId("agent-prompt-input"), {
            target: { value: "Audit distributed lock safety" },
        });
        fireEvent.submit(screen.getByTestId("agent-prompt-form"));

        // Panel MUST transition to paused_insufficient_credits (not failed/completed) and show Resume Task card
        await waitFor(() => {
            expect(screen.getByTestId("agent-insufficient-credits-card")).toBeDefined();
            expect(screen.getByTestId("agent-status-badge").textContent).toContain(
                "paused_insufficient_credits"
            );
        });
        expect(screen.queryByTestId("agent-error-alert")).toBeNull();

        // Verify Turn 1 wire body omitted synthesized workspaceId & carried selected model + mode
        expect(rawBodiesSent).toHaveLength(1);
        expect("workspaceId" in rawBodiesSent[0]).toBe(false);
        expect(rawBodiesSent[0].projectId).toBe("legacy-project-wave42");
        expect(rawBodiesSent[0].selectedSystem2ModelId).toBe("google/gemini-3.1-pro");
        expect(rawBodiesSent[0].permissionMode).toBe("full_auto");

        const expectedDefaultWorkspaceId = deriveDefaultWorkspaceId(mockUser.id);
        expect(graphState.capturedContexts[0].workspaceId).toBe(expectedDefaultWorkspaceId);
        expect(graphState.capturedContexts[0].selectedSystem2ModelId).toBe("google/gemini-3.1-pro");
        expect(graphState.capturedContexts[0].permissionMode).toBe("full_auto");
        expect((graphState.capturedInputs[0] as AgentGraphState).user_request.selectedSystem2ModelId).toBe(
            "google/gemini-3.1-pro"
        );

        // Turn 2: User switches to cheaper Flash model + semi_auto mode and clicks Resume Task
        graphState.chunksToEmit = [
            { nodeId: "search_discovery_node", stepIndex: 3, status: "COMPLETED" },
        ];

        fireEvent.change(screen.getByTestId("agent-system2-model-select"), {
            target: { value: "google/gemini-3.8-flash" },
        });
        fireEvent.click(screen.getByTestId("agent-permission-mode-semi_auto"));
        fireEvent.click(screen.getByTestId("agent-resume-task-button"));

        await waitFor(() => {
            expect(screen.getByTestId("agent-status-badge").textContent).toContain("completed");
        });
        expect(screen.queryByTestId("agent-insufficient-credits-card")).toBeNull();

        // Verify Turn 2 wire body resumed checkpoint cleanly with updated model & permission mode
        expect(rawBodiesSent).toHaveLength(2);
        expect("workspaceId" in rawBodiesSent[1]).toBe(false);
        expect(rawBodiesSent[1].selectedSystem2ModelId).toBe("google/gemini-3.8-flash");
        expect(rawBodiesSent[1].permissionMode).toBe("semi_auto");
        expect(rawBodiesSent[1].resumePayload).toEqual({ resumeReason: "INSUFFICIENT_CREDITS" });

        expect(graphState.capturedInputs[1]).toEqual({
            resumeFromCheckpoint: true,
            stateOverrides: {
                clarification_answers: { resumeReason: "INSUFFICIENT_CREDITS" },
            },
        });
        expect(graphState.capturedContexts[1].selectedSystem2ModelId).toBe("google/gemini-3.8-flash");
        expect(graphState.capturedContexts[1].permissionMode).toBe("semi_auto");
    });

    it("decodes real Phase 4 event: ghost_hunk_proposed SSE frames across wire, ignores mismatched fileId, transitions to preview_ready, and commits on Accept All Hunks", async () => {
        let docContent = "# Architecture\n\nInitial draft.";
        const editor = {
            getValue: () => docContent,
            setValue: (next: string) => {
                docContent = next;
            },
            clearGhostSession: vi.fn(),
            clearStreamingGhost: vi.fn(),
            startGhostSession: vi.fn(),
            upsertGhostHunk: vi.fn(),
            acceptGhostHunk: vi.fn(),
            rejectGhostHunk: vi.fn(),
            acceptAllGhostHunks: vi.fn(),
        } as unknown as import("@/components/editor/markdown/types").EditorAdapter;
        const onAllHunksAccepted = vi.fn();

        graphState.onStreamStart = (ctx) => {
            // Mismatched fileId MUST be ignored by useAIStream
            ctx.emitSseEvent({
                type: "ghost_hunk_proposed",
                fileId: "file-other-unrelated",
                headingSlug: "architecture",
                hunks: [
                    {
                        hunkId: "hunk-wrong-file",
                        replacementText: "# Architecture\n\nWRONG FILE MUTATION",
                    },
                ],
            });
            // Matching fileId MUST decode cleanly via stream-handler -> useAIStream -> AgentChatPanel
            ctx.emitSseEvent({
                type: "ghost_hunk_proposed",
                fileId: "file-wire-1",
                headingSlug: "architecture",
                hunks: [
                    {
                        hunkId: "hunk-wire-1",
                        replacementText: "# Architecture\n\nUpgraded via Phase 4 SSE.",
                    },
                ],
            });
        };
        graphState.chunksToEmit = [
            { nodeId: "document_writer_node", stepIndex: 1, status: "COMPLETED" },
        ];

        render(<Harness editor={editor} onAllHunksAccepted={onAllHunksAccepted} />);

        fireEvent.change(screen.getByTestId("agent-prompt-input"), {
            target: { value: "Upgrade architecture section" },
        });
        fireEvent.submit(screen.getByTestId("agent-prompt-form"));

        await waitFor(() => {
            expect(screen.getByTestId("agent-status-badge").textContent).toContain("preview_ready");
            expect(screen.getByTestId("agent-ghost-review-bar")).toBeDefined();
        });

        expect(screen.getByTestId("agent-ghost-hunks-count").textContent).toBe("1 hunk");
        expect(screen.queryByTestId("agent-ghost-hunk-hunk-wrong-file")).toBeNull();
        expect(screen.getByTestId("agent-ghost-hunk-hunk-wire-1")).toBeDefined();

        fireEvent.click(screen.getByTestId("agent-accept-all-hunks"));

        await waitFor(() => {
            expect(screen.getByTestId("agent-status-badge").textContent).toContain("completed");
        });
        expect(docContent).toBe("# Architecture\n\nUpgraded via Phase 4 SSE.");
        expect(onAllHunksAccepted).toHaveBeenCalledWith("# Architecture\n\nUpgraded via Phase 4 SSE.");
    });
});
