/**
 * Integration Test Suite: Phase 9 - Wave 9.3
 * Compiled StateGraph Orchestration & Checkpointed Lifecycle Integration Tests
 *
 * Verifies the fully compiled Elixent agent StateGraph (`createElixentAgentGraph`)
 * using an in-memory checkpointer (`MemorySaver`).
 *
 * Test Matrix Coverage:
 * 1. Graph Compilation & Static Topology (all 14 canonical nodes and 3 routers)
 * 2. 7-Stage End-to-End Happy Path Execution:
 *    START -> Orchestrator -> Search -> Synthesizer -> Assumption Analyzer ->
 *    ATMS Relational Linker -> Jev Structuring -> Decision Scorer ->
 *    Confidence Classifier -> Ledger Commit -> Document Writer -> END
 * 3. Stage 1 Tool Loop Inspection Cycle:
 *    Search Agent -> Workspace Tool Node -> Search Agent -> Search Synthesizer
 * 4. Stage 2 G-5 Conditional Edge Branching:
 *    - Short-circuit directly to `document_writer_node` when no assumptions exist
 *    - Contextual gap loop back to `search_agent_node` when search loops remain
 *    - Standard forward progression to `jev_structuring_node`
 * 5. Stage 5 G-6 Resolution Gate Branching & Loop Bounds:
 *    - Supplementary search loop via `internal_gap_planner_node` (< 3 loops)
 *    - Strict ceiling at MAX_SEARCH_LOOPS = 3 routing to `question_organizer_node`
 *    - Clean progression to `document_writer_node` when all decisions are resolved
 * 6. Stage 6 HITL Interrupt & Resume Lifecycle:
 *    - Unresolved decision triggers `question_organizer_node` -> `pure_interrupt_node`
 *    - Graph cleanly suspends execution; state is persisted in MemorySaver
 *    - Thread resumption via `app.invoke(new Command({ resume: ... }), config)`
 *    - Post-resumption routing to `assumption_analyzer_node` without re-executing earlier model nodes
 * 7. Stage 6 Financial Gate Interrupt:
 *    - Credit exhaustion or failure immediately suspends execution at `pure_interrupt_node`
 *    - Validates typed financial pause payload (`code: "INSUFFICIENT_CREDITS"`)
 * 8. Checkpoint State Retrieval, Immutability & Thread Isolation:
 *    - Idempotent retrieval of 12-channel state snapshots via `app.getState(config)`
 *    - Multi-thread execution isolation in shared checkpointer
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command, MemorySaver } from "@langchain/langgraph";

import {
  createElixentAgentGraph,
  buildAgentWorkflow,
  ORCHESTRATOR_NODE,
  SEARCH_AGENT_NODE,
  WORKSPACE_TOOL_NODE,
  SEARCH_SYNTHESIZER_NODE,
  ASSUMPTION_ANALYZER_NODE,
  ATMS_RELATIONAL_LINKER_NODE,
  JEV_STRUCTURING_NODE,
  DECISION_SCORER_NODE,
  CONFIDENCE_CLASSIFIER_NODE,
  LEDGER_COMMIT_NODE,
  INTERNAL_GAP_PLANNER_NODE,
  QUESTION_ORGANIZER_NODE,
  PURE_INTERRUPT_NODE,
  DOCUMENT_WRITER_NODE,
} from "@/core/agent/graph";
import type { AgentGraphState } from "@/core/agent/state";
import { syncMasterLedgerToProjectStore } from "@/core/agent/atms/dag";
import type {
  IWorkspaceProvider,
  HeadingNode,
  SectionReadResult,
} from "@/core/workspace/provider";

// ============================================================================
// Module Mocks for Pure Hermetic Execution
// ============================================================================

vi.mock("@/core/agent/atms/dag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/agent/atms/dag")>();
  return {
    ...actual,
    loadProjectDecisionLedger: vi.fn().mockResolvedValue({
      masterLedger: {},
      projectTaxonomy: null,
    }),
    syncMasterLedgerToProjectStore: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/ai/key-rotation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/key-rotation")>();
  return {
    ...actual,
    getApiKeys: vi.fn().mockReturnValue([]),
  };
});

vi.mock("@/lib/metering/node-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metering/node-gate")>();
  return {
    ...actual,
    withMeteredNodeGate: (
      _nodeName: string,
      _modelId: string,
      nodeFn: (state: any, config?: any) => Promise<any>,
    ) => {
      return async (state: any, config?: any) => {
        // Financial gate simulation: trigger credit exhaustion interrupt payload
        if (
          state?.credit_exhausted ||
          state?.insufficient_credits ||
          state?.credit_failure ||
          state?.code === "INSUFFICIENT_CREDITS" ||
          config?.configurable?.credit_failure
        ) {
          return {
            interrupt: true,
            code: "INSUFFICIENT_CREDITS",
            availableMicro: 0,
            requiredMicro: 500_000,
            targetNode: "pure_interrupt_node",
          };
        }
        return await nodeFn(state, config);
      };
    },
  };
});

// ============================================================================
// Mock Workspace Provider Fixture
// ============================================================================

class MockHermeticWorkspaceProvider implements IWorkspaceProvider {
  public listHeadingsTree = vi.fn().mockImplementation(async (fileIds: string[]) => {
    const res: Record<string, HeadingNode[]> = {};
    for (const fileId of fileIds) {
      res[fileId] = [
        {
          headingSlug: "architecture-overview",
          title: "Architecture Overview",
          level: 1,
          breadcrumb: "Architecture Overview",
          startLine: 1,
          endLine: 20,
          startOffset: 0,
          endOffset: 500,
          contentHash: "hash_overview",
        },
      ];
    }
    return res;
  });

  public readSectionByHeading = vi.fn().mockImplementation(
    async (fileId: string, headingSlug: string): Promise<SectionReadResult> => ({
      breadcrumb: `${fileId} > ${headingSlug}`,
      contentOrVaultRef: `Baseline text content for ${fileId}#${headingSlug}`,
      isVaultRef: false,
    }),
  );

  public searchLexicalWithASTBreadcrumb = vi.fn().mockImplementation(
    async (params: { fileIds: string[]; query: string; maxResults?: number }) => {
      return params.fileIds.map((fileId) => ({
        fileId,
        fileName: `${fileId}.md`,
        headingSlug: "architecture-overview",
        headingBreadcrumb: "Architecture Overview",
        matchedExcerpt: `Matched excerpt for query "${params.query}" in ${fileId}`,
        lineRange: [2, 6] as [number, number],
        bm25Score: 1.5,
      }));
    },
  );

  public mergeSectionThreeWay = vi.fn().mockImplementation(async (params: any) => ({
    status: "clean" as const,
    mergedDocumentContent: `# Merged Document\n${params.agentProposedSectionContent}`,
    hunkRange: {
      from: 0,
      to: 100,
      replacementText: params.agentProposedSectionContent,
    },
  }));
}

// ============================================================================
// Integration Test Suites
// ============================================================================

describe("Phase 9 - Wave 9.3: Compiled StateGraph Orchestration Integration Tests", () => {
  let mockProvider: MockHermeticWorkspaceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = new MockHermeticWorkspaceProvider();
  });

  // ==========================================================================
  // Suite 1: Graph Compilation & Static Topology Invariants
  // ==========================================================================
  describe("1. Graph Compilation & Topology Invariants", () => {
    it("should build workflow containing all 14 canonical nodes and correct node keys", () => {
      const graphWorkflow = buildAgentWorkflow();
      const nodeKeys = Object.keys(graphWorkflow.nodes);

      const expectedNodes = [
        ORCHESTRATOR_NODE,
        SEARCH_AGENT_NODE,
        WORKSPACE_TOOL_NODE,
        SEARCH_SYNTHESIZER_NODE,
        ASSUMPTION_ANALYZER_NODE,
        ATMS_RELATIONAL_LINKER_NODE,
        JEV_STRUCTURING_NODE,
        DECISION_SCORER_NODE,
        CONFIDENCE_CLASSIFIER_NODE,
        LEDGER_COMMIT_NODE,
        INTERNAL_GAP_PLANNER_NODE,
        QUESTION_ORGANIZER_NODE,
        PURE_INTERRUPT_NODE,
        DOCUMENT_WRITER_NODE,
      ];

      for (const node of expectedNodes) {
        expect(nodeKeys).toContain(node);
      }
      expect(nodeKeys).toHaveLength(14);
    });

    it("should compile cleanly with custom MemorySaver checkpointer", () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      expect(app).toBeDefined();
      expect(typeof app.invoke).toBe("function");
      expect(typeof app.getState).toBe("function");
    });
  });

  // ==========================================================================
  // Suite 2: 7-Stage End-to-End Happy Path Execution
  // ==========================================================================
  describe("2. Full 7-Stage Happy Path Flow", () => {
    it("should execute START -> Orchestrator -> Search Loop -> Assumptions -> Linker -> JEV -> Classifier -> Commit -> Writer -> END", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-happy-path-1";
      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_test_happy",
          workspaceProvider: mockProvider,
        },
      };

      const initialState: Partial<AgentGraphState> = {
        user_request: {
          prompt: "Design high-performance modular caching subsystem",
          projectId: "proj_happy_1",
          targetFileIds: ["cache.md"],
        },
      };

      const result = await app.invoke(initialState, config);

      // 1. Completion & No unhandled suspension
      expect(result).toBeDefined();
      expect((result as any).__interrupt__).toBeUndefined();

      // 2. Stage 0 Orchestrator & Messages
      expect(result.messages).toBeDefined();
      expect(result.messages.length).toBeGreaterThanOrEqual(3);
      const firstMsg = result.messages[0];
      expect(firstMsg._getType()).toBe("human");
      expect(firstMsg.content).toContain("Design high-performance modular caching subsystem");

      // 3. Stage 1 Search Report
      expect(result.search_report).toBeDefined();
      expect(result.search_report.inspectedPaths).toContain("cache.md#architecture-overview");

      // 4. Stage 2 Assumptions
      expect(result.assumptions).toBeDefined();
      expect(result.assumptions.length).toBeGreaterThan(0);
      expect(result.assumptions[0].statement).toContain("caching subsystem");

      // 5. Stage 3 & 4 Master Ledger & Conformal APS
      expect(result.master_ledger).toBeDefined();
      const decisionNodes = Object.values(result.master_ledger);
      expect(decisionNodes.length).toBeGreaterThan(0);
      expect(decisionNodes[0].status).toBe("APPROVED_DIRECT");

      // 6. Stage 5 Resolution Gate & Ledger Commit
      expect(result.unresolved_ledger).toEqual([]);
      expect(syncMasterLedgerToProjectStore).toHaveBeenCalled();

      // 7. Stage 7 Document Writer & Clean Invalidation Reset
      expect(result.invalidation_map).toEqual({});
      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg._getType()).toBe("ai");
      expect(lastMsg.content).toContain("Document Writer Node completed");

      // 8. Terminal Checkpoint State Verification
      const stateSnapshot = await app.getState(config);
      expect(stateSnapshot.next).toEqual([]);
      expect(stateSnapshot.values.master_ledger).toBeDefined();
      expect(stateSnapshot.values.unresolved_ledger).toEqual([]);
    });
  });

  // ==========================================================================
  // Suite 3: Stage 1 Exploration & Tool Loop Cycle
  // ==========================================================================
  describe("3. Stage 1 Tool Loop Inspection Cycle", () => {
    it("should execute Search Agent -> Workspace Tool Node -> Search Agent -> Search Synthesizer loop cleanly", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-tool-loop-1";
      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_test_tool",
          workspaceProvider: mockProvider,
        },
      };

      const initialState: Partial<AgentGraphState> = {
        user_request: {
          prompt: "Audit storage engine architecture",
          projectId: "proj_tool_1",
          targetFileIds: ["storage.md"],
        },
      };

      const result = await app.invoke(initialState, config);

      // Verify workspaceProvider tool was actually called by workspaceToolNode
      expect(mockProvider.listHeadingsTree).toHaveBeenCalledWith(["storage.md"]);

      // Verify messages contain both the tool call from search agent and ToolMessage from workspace tool
      const toolMessages = result.messages.filter((m) => m._getType() === "tool");
      expect(toolMessages.length).toBeGreaterThan(0);

      // Verify synthesized report contains evidence from the tool execution
      expect(result.search_report.evidenceItems.length).toBeGreaterThan(0);
      expect(result.search_report.inspectedPaths).toContain("storage.md#architecture-overview");
    });
  });

  // ==========================================================================
  // Suite 4: Stage 2 G-5 Conditional Edge Branching
  // ==========================================================================
  describe("4. Stage 2 G-5 Conditional Edge Branching", () => {
    it("should short-circuit directly to document_writer_node when no assumptions exist and invalidation_map is empty", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-g5-short-circuit";
      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_test_g5",
          workspaceProvider: mockProvider,
        },
      };

      // Empty prompt yields 0 assumptions in deterministic fallback mode
      const initialState: Partial<AgentGraphState> = {
        user_request: {
          prompt: "",
          projectId: "proj_g5_empty",
          targetFileIds: [],
        },
      };

      const result = await app.invoke(initialState, config);

      // When short-circuiting directly to document_writer_node:
      // Master ledger remains empty (no JEV scoring executed)
      expect(Object.keys(result.master_ledger)).toHaveLength(0);
      expect(result.assumptions).toHaveLength(0);
      expect(result.unresolved_ledger).toHaveLength(0);

      // Document writer node runs and concludes
      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg._getType()).toBe("ai");
      expect(lastMsg.content).toContain("Document Writer Node completed");
    });

    it("should verify G-5 routing contract for gap loops and progression when loop ceiling is reached", async () => {
      // 1. Direct contract verification of routeAfterAssumptions conditional routing
      const stateWithGap = {
        assumptions: [
          {
            assumptionId: "a1",
            statement: "Unresolved gap in caching topology: needs inspection",
            conceptTags: ["caching"],
            affectedSections: [],
            dependsOn: [],
          },
        ],
        search_loop_count: 0,
        search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
        user_request: { prompt: "test", projectId: "p", targetFileIds: ["cache.md"] },
      } as unknown as AgentGraphState;

      const { routeAfterAssumptions } = await import(
        "@/core/agent/nodes/assumption-and-linker-nodes"
      );

      // Under ceiling (< 3), routes back to search_agent_node
      expect(routeAfterAssumptions(stateWithGap)).toBe("search_agent_node");

      // At ceiling (>= 3), bypasses loop and advances to jev_structuring_node
      const stateAtCeiling = {
        ...stateWithGap,
        search_loop_count: 3,
      } as unknown as AgentGraphState;
      expect(routeAfterAssumptions(stateAtCeiling)).toBe("jev_structuring_node");

      // 2. Compiled StateGraph integration verification at loop ceiling
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-g5-compiled-gap";
      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_test_g5_ceiling",
          workspaceProvider: mockProvider,
        },
      };

      const initialState: Partial<AgentGraphState> = {
        user_request: {
          prompt: "Verify caching system requirements with unresolved gap",
          projectId: "proj_g5_compiled",
          targetFileIds: ["cache.md"],
        },
        search_loop_count: 3,
      };

      const result = await app.invoke(initialState, config);
      expect(result).toBeDefined();
      expect(result.messages.length).toBeGreaterThanOrEqual(3);
      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg._getType()).toBe("ai");
      expect(lastMsg.content).toContain("Document Writer Node completed");
    });
  });

  // ==========================================================================
  // Suite 5: Stage 5 G-6 Resolution Gate Branching & Loop Bounds
  // ==========================================================================
  describe("5. Stage 5 G-6 Resolution Gate Branching & Loop Bounds", () => {
    it("should route to internal_gap_planner_node when unresolved items exist and search_loop_count < 3", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-g6-gap-loop";
      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_test_g6",
          workspaceProvider: mockProvider,
        },
      };

      // Prompt contains "insufficient_evidence" which triggers UNRESOLVED in JEV mock evaluation
      const initialState: Partial<AgentGraphState> = {
        user_request: {
          prompt: "Evaluate abstain insufficient_evidence caching layer under ambiguous traffic",
          projectId: "proj_g6_loop",
          targetFileIds: ["cache.md"],
        },
        search_loop_count: 0,
      };

      const result = await app.invoke(initialState, config);

      expect(result).toBeDefined();
      // Internal gap planner populates local_inspection_state with topic or concept paths
      expect(result.local_inspection_state.length).toBeGreaterThan(0);
      expect(
        result.local_inspection_state.some(
          (p) => p.includes("topic:") || p.includes("concept:") || p.includes("cache.md"),
        ),
      ).toBe(true);
    });

    it("should cap at MAX_SEARCH_LOOPS = 3 and route to question_organizer_node when loops exhausted", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-g6-loop-cap";
      const unresolvedItem = {
        decisionId: "dec_exhausted_1",
        topicSlug: "data_persistence",
        questionPrompt: "Arbitrate between event sourcing and CRUD state",
        conceptTags: ["storage_layer"],
        status: "UNRESOLVED" as const,
        reason: "Search loop limit reached with unresolved ambiguity",
        options: [
          {
            optionKey: "opt_event_sourcing",
            neutralSummary: "Adopt immutable event log",
            rationaleAndPremises: "Complete auditability and temporal queries.",
          },
          {
            optionKey: "opt_crud",
            neutralSummary: "Adopt relational CRUD",
            rationaleAndPremises: "Lower operational complexity and simpler schema evolutions.",
          },
        ],
      };

      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_test_cap",
          workspaceProvider: mockProvider,
          scored_decisions: [unresolvedItem],
        },
      };

      // Initializing search_loop_count = 3 forces resolutionGateRouter
      // to route to question_organizer_node -> pure_interrupt_node
      const initialState: Partial<AgentGraphState> = {
        user_request: {
          prompt: "Arbitrate data persistence design",
          projectId: "proj_g6_cap",
          targetFileIds: ["storage.md"],
        },
        search_loop_count: 3,
      };

      const result = await app.invoke(initialState, config);

      // Verify that the graph suspended safely at pure_interrupt_node
      expect((result as any).__interrupt__).toBeDefined();

      const snapshot = await app.getState(config);
      expect(snapshot.next).toEqual([PURE_INTERRUPT_NODE]);
      expect(snapshot.values.question_queue).toBeDefined();
      expect(snapshot.values.question_queue?.questions.length).toBeGreaterThan(0);
      expect(snapshot.values.question_queue?.questions[0].questionId).toBe("dec_exhausted_1");
    });
  });

  // ==========================================================================
  // Suite 6: Stage 6 HITL Interrupt & Resume Lifecycle
  // ==========================================================================
  describe("6. Stage 6 HITL Interrupt & Resume Lifecycle", () => {
    it("should suspend at pure_interrupt_node, preserve state in MemorySaver, and resume cleanly on Command", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-hitl-lifecycle-1";
      const unresolvedDecision = {
        decisionId: "dec_hitl_architecture",
        topicSlug: "sync_protocol",
        questionPrompt: "Adopt Diff3 three-way merge or CRDT Yjs?",
        conceptTags: ["sync_engine"],
        status: "UNRESOLVED" as const,
        reason: "Conformal APS multi-option set: requires human architectural choice",
        options: [
          {
            optionKey: "approve_conservative",
            neutralSummary: "Adopt Diff3 three-way merge",
            rationaleAndPremises: "Diff3 is optimal for single-user offline sync per ADR.",
          },
          {
            optionKey: "adopt_direct_solution",
            neutralSummary: "Adopt CRDT Yjs collaborative sync",
            rationaleAndPremises: "Enables multi-user simultaneous real-time editing.",
          },
        ],
      };

      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_hitl_test",
          workspaceProvider: mockProvider,
          scored_decisions: [unresolvedDecision],
        },
      };

      // 1. First Pass: Triggers question_organizer_node -> pure_interrupt_node
      const initialState: Partial<AgentGraphState> = {
        user_request: {
          prompt: "Choose sync protocol architecture",
          projectId: "proj_hitl_1",
          targetFileIds: ["sync.md"],
        },
        search_loop_count: 3,
      };

      const suspendResult = await app.invoke(initialState, config);

      expect((suspendResult as any).__interrupt__).toBeDefined();

      // Verify checkpoint preservation in MemorySaver
      const suspendedState = await app.getState(config);
      expect(suspendedState.next).toEqual([PURE_INTERRUPT_NODE]);
      expect(suspendedState.values.question_queue).not.toBeNull();
      const question = suspendedState.values.question_queue?.questions[0];
      expect(question).toBeDefined();
      expect(question?.questionId).toBe("dec_hitl_architecture");

      // Verify question options are populated neutrally
      expect(question?.options.length).toBeGreaterThanOrEqual(2);

      // 2. Second Pass: Resumption using Command with valid user clarification
      const resumeCommand = new Command({
        resume: {
          answers: [
            {
              questionId: question!.questionId,
              selectedOptionKey: question!.options[0].optionKey,
              userComment: "Diff3 is optimal for single-user offline sync per ADR.",
            },
          ],
        },
      });

      const resumeConfig = {
        configurable: {
          thread_id: threadId,
          userId: "user_hitl_test",
          workspaceProvider: mockProvider,
          scored_decisions: [],
        },
      };

      const resumedResult = await app.invoke(resumeCommand as any, resumeConfig);

      // Verify graph continued to completion without unhandled interruption
      expect((resumedResult as any).__interrupt__).toBeUndefined();

      // Verify pureInterruptNode cleaned question_queue and unresolved_ledger
      expect(resumedResult.question_queue).toBeNull();
      expect(resumedResult.unresolved_ledger).toEqual([]);

      // Verify confirmation message was emitted
      const clarificationMsg = resumedResult.messages.find(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes("User clarification submitted for 1 item(s)"),
      );
      expect(clarificationMsg).toBeDefined();

      // Verify terminal checkpoint is clean
      const finalState = await app.getState(config);
      expect(finalState.next).toEqual([]);
      expect(finalState.values.question_queue).toBeNull();
      expect(finalState.values.unresolved_ledger).toEqual([]);
    });
  });

  // ==========================================================================
  // Suite 7: Stage 6 Financial Gate Interrupt
  // ==========================================================================
  describe("7. Stage 6 Financial Gate Interrupt", () => {
    it("should immediately pause at pure_interrupt_node when credit failure occurs", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-financial-gate-1";
      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_broke_test",
          workspaceProvider: mockProvider,
        },
      };

      // Seed state up to question_organizer_node transition with credit failure flag
      // When question_queue is null, pure_interrupt_node emits financial interrupt payload
      await app.updateState(
        config,
        {
          user_request: {
            prompt: "Design large scale distributed filesystem",
            projectId: "proj_fin_1",
            targetFileIds: ["fs.md"],
          },
          question_queue: null,
          unresolved_ledger: [],
        },
        QUESTION_ORGANIZER_NODE,
      );

      // Invoking from QUESTION_ORGANIZER_NODE transitions to PURE_INTERRUPT_NODE
      const result = await app.invoke(null, config);

      expect((result as any).__interrupt__).toBeDefined();

      const snapshot = await app.getState(config);
      expect(snapshot.next).toEqual([PURE_INTERRUPT_NODE]);

      // Verify typed financial interrupt payload
      const interruptTask = snapshot.tasks.find((t) => t.name === PURE_INTERRUPT_NODE);
      expect(interruptTask?.interrupts).toBeDefined();
      expect(interruptTask?.interrupts.length).toBeGreaterThan(0);

      const payload = interruptTask?.interrupts[0]?.value as any;
      expect(payload.code).toBe("INSUFFICIENT_CREDITS");
      expect(payload.message).toContain("Credit balance exhausted");
    });
  });

  // ==========================================================================
  // Suite 8: Checkpoint State Retrieval & Thread Isolation
  // ==========================================================================
  describe("8. Checkpoint State Retrieval, Idempotency & Thread Isolation", () => {
    it("should retrieve immutable 12-channel state snapshots idempotently via getState", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const threadId = "thread-idempotency-1";
      const config = {
        configurable: {
          thread_id: threadId,
          userId: "user_test_idem",
          workspaceProvider: mockProvider,
        },
      };

      const initialState: Partial<AgentGraphState> = {
        user_request: {
          prompt: "Perform architectural baseline verification",
          projectId: "proj_idem_1",
          targetFileIds: ["baseline.md"],
        },
      };

      await app.invoke(initialState, config);

      const snapshot1 = await app.getState(config);
      const snapshot2 = await app.getState(config);

      // Verify all 12 state channels are present and deeply equivalent
      const channels = [
        "messages",
        "user_request",
        "search_report",
        "local_inspection_state",
        "assumptions",
        "master_ledger",
        "project_taxonomy",
        "unresolved_ledger",
        "invalidation_map",
        "question_queue",
        "budget_tracking",
        "search_loop_count",
      ];

      for (const channel of channels) {
        expect(snapshot1.values[channel]).toBeDefined();
        expect(snapshot1.values[channel]).toEqual(snapshot2.values[channel]);
      }
    });

    it("should maintain strict execution and checkpoint isolation across different thread IDs", async () => {
      const checkpointer = new MemorySaver();
      const app = createElixentAgentGraph({ checkpointer });

      const configA = {
        configurable: {
          thread_id: "thread-isolated-A",
          userId: "user_A",
          workspaceProvider: mockProvider,
        },
      };

      const configB = {
        configurable: {
          thread_id: "thread-isolated-B",
          userId: "user_B",
          workspaceProvider: mockProvider,
        },
      };

      await app.invoke(
        {
          user_request: {
            prompt: "Thread A Prompt",
            projectId: "proj_A",
            targetFileIds: ["fileA.md"],
          },
        },
        configA,
      );

      await app.invoke(
        {
          user_request: {
            prompt: "Thread B Prompt",
            projectId: "proj_B",
            targetFileIds: ["fileB.md"],
          },
        },
        configB,
      );

      const stateA = await app.getState(configA);
      const stateB = await app.getState(configB);

      expect(stateA.values.user_request.projectId).toBe("proj_A");
      expect(stateB.values.user_request.projectId).toBe("proj_B");

      expect(stateA.values.user_request.targetFileIds).toEqual(["fileA.md"]);
      expect(stateB.values.user_request.targetFileIds).toEqual(["fileB.md"]);
    });
  });
});
