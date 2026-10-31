/**
 * Test Suite: Phase 9 - Wave 9.2 (7-Stage Nodes & Routers)
 *
 * Exhaustive Unit & Contract Verification for:
 * - Stage 0: `orchestratorNode` (initialization of ledger, inspection state, loop count, taxonomy)
 * - Stage 1: `toolsCondition` router, `searchAgentNode`, `workspaceToolNode`, `searchSynthesizerNode`
 * - Stage 2: `assumptionAnalyzerNode`, `atmsRelationalLinkerNode`, `routeAfterAssumptions` router (G-5 3-way branching)
 * - Stage 3: `jevStructuringNode` (historical alternative re-injection), `decisionScorerNode`
 * - Stage 4: `confidenceClassifierNode` (deterministic, zero LLM), `ledgerCommitNode` (deterministic, master ledger sync)
 * - Stage 5: `internalGapPlannerNode` (loop increment, inspection path updates)
 * - Routers: `resolutionGateRouter` (G-6 4-way branching)
 * - Stage 6: `questionOrganizerNode`, `pureInterruptNode` (purity invariants, GraphInterrupt propagation, resumption)
 * - Stage 7: `documentWriterNode` (diff3 3-way merge, minimal section invalidation, section targets)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, interrupt } from "@langchain/langgraph";

import type {
  AgentGraphState,
  AssumptionItem,
  UnresolvedDecision,
} from "@/core/agent/state";
import {
  type ATMSDecisionNode,
  loadProjectDecisionLedger,
  syncMasterLedgerToProjectStore,
} from "@/core/agent/atms/dag";
import {
  PROJECT_TAXONOMY_SENTINEL_ID,
  type ProjectTaxonomyState,
} from "@/core/agent/taxonomy/predefined-tags";
import type {
  IWorkspaceProvider,
  HeadingNode,
  SectionReadResult,
  LexicalMatchResult,
} from "@/core/workspace/provider";

// Stage 0
import { orchestratorNode } from "@/core/agent/nodes/orchestrator-node";

// Stage 1
import {
  toolsCondition,
  workspaceToolNode,
  rawSearchSynthesizerNode,
  rawSearchAgentNode,
  SEARCH_AGENT_MODEL_ID,
  SEARCH_AGENT_STEP_CEILING,
} from "@/core/agent/nodes/search-nodes";

// Stage 2
import {
  rawAssumptionAnalyzerNode,
  atmsRelationalLinkerNode,
  routeAfterAssumptions,
  ASSUMPTION_ANALYZER_MODEL_ID,
} from "@/core/agent/nodes/assumption-and-linker-nodes";

// Stage 3
import {
  rawJevStructuringNode,
  rawDecisionScorerNode,
  CANONICAL_BATCH_MESSAGE_NAME,
  JEV_STRUCTURING_MODEL_ID,
  DECISION_SCORER_MODEL_ID,
} from "@/core/agent/nodes/jev-scoring-nodes";

// Stage 4 & 5
import {
  confidenceClassifierNode,
  ledgerCommitNode,
  internalGapPlannerNode,
  resolutionGateRouter,
} from "@/core/agent/nodes/resolution-and-ledger-nodes";

// Stage 6
import {
  questionOrganizerNode,
  pureInterruptNode,
} from "@/core/agent/nodes/hitl-nodes";

// Stage 7
import {
  documentWriterNode,
  synthesizeAgentSectionContent,
} from "@/core/agent/nodes/document-writer-node";

import { evaluateDecisionBatch, evaluateRelationalLinksBatch } from "@/lib/jev/client";

// ============================================================================
// Module Mocks
// ============================================================================

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/langgraph")>();
  return {
    ...actual,
    interrupt: vi.fn(),
  };
});

vi.mock("@/core/agent/atms/dag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/agent/atms/dag")>();
  return {
    ...actual,
    loadProjectDecisionLedger: vi.fn(actual.loadProjectDecisionLedger),
    syncMasterLedgerToProjectStore: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/jev/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jev/client")>();
  return {
    ...actual,
    evaluateDecisionBatch: vi.fn(actual.evaluateDecisionBatch),
    evaluateRelationalLinksBatch: vi.fn(actual.evaluateRelationalLinksBatch),
  };
});

// ============================================================================
// Test Fixtures & Mock Provider
// ============================================================================

function createTestDecisionNode(
  decisionId: string,
  overrides?: Partial<ATMSDecisionNode>,
): ATMSDecisionNode {
  return {
    decisionId,
    topicSlug: "system_architecture",
    questionPrompt: `Prompt for ${decisionId}`,
    conceptTags: ["system_architecture"],
    selectedOptionKey: "opt_modular",
    selectionRationale: "Modular approach minimizes blast radius.",
    runnerUpOptionKey: "opt_monolith",
    evaluatedAlternatives: [
      {
        optionKey: "opt_modular",
        neutralSummary: "Modular component boundaries",
        rationaleAndPremises: "Decouples lifecycle and failure domains",
        normalizedProbability: 0.85,
      },
      {
        optionKey: "opt_monolith",
        neutralSummary: "Unified monolithic architecture",
        rationaleAndPremises: "Lower operational coordination overhead",
        normalizedProbability: 0.15,
      },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [{ fileId: "arch.md", headingSlug: "system-overview" }],
    updatedAt: new Date(1700000000000).toISOString(),
    ...overrides,
  };
}

class MockWorkspaceProvider implements IWorkspaceProvider {
  listHeadingsTree = vi.fn().mockImplementation(async (fileIds: string[]) => {
    const res: Record<string, HeadingNode[]> = {};
    for (const fileId of fileIds) {
      res[fileId] = [
        {
          headingSlug: "system-overview",
          title: "System Overview",
          level: 1,
          breadcrumb: "Architecture > System Overview",
          startLine: 1,
          endLine: 25,
          startOffset: 0,
          endOffset: 600,
          contentHash: "hash_overview",
        },
      ];
    }
    return res;
  });

  readSectionByHeading = vi.fn().mockImplementation(
    async (fileId: string, headingSlug: string): Promise<SectionReadResult> => ({
      breadcrumb: `${fileId} > ${headingSlug}`,
      contentOrVaultRef: `Base text for ${fileId}#${headingSlug}`,
      isVaultRef: false,
    }),
  );

  searchLexicalWithASTBreadcrumb = vi.fn().mockImplementation(
    async (params: { fileIds: string[]; query: string; maxResults?: number }) => {
      return params.fileIds.map((fileId) => ({
        fileId,
        fileName: `${fileId}.md`,
        headingSlug: "system-overview",
        headingBreadcrumb: "Architecture > System Overview",
        matchedExcerpt: `Matched text for query "${params.query}" in ${fileId}`,
        lineRange: [2, 6] as [number, number],
        bm25Score: 1.25,
      }));
    },
  );

  mergeSectionThreeWay = vi.fn().mockImplementation(async (params: any) => ({
    status: "clean" as const,
    mergedDocumentContent: `# Clean Merged Document\n${params.agentProposedSectionContent}`,
    hunkRange: {
      from: 0,
      to: 100,
      replacementText: params.agentProposedSectionContent,
    },
  }));
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Phase 9 - Wave 9.2: 7-Stage Graph Nodes & Routers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Stage 0: orchestratorNode
  // ==========================================================================
  describe("Stage 0: orchestratorNode", () => {
    it("should initialize default state channels cleanly when user_request is empty", async () => {
      const state: AgentGraphState = {
        messages: [],
        user_request: { prompt: "", projectId: "", targetFileIds: [] },
        search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
        local_inspection_state: [],
        assumptions: [],
        master_ledger: {},
        project_taxonomy: null,
        unresolved_ledger: [],
        question_queue: null,
        invalidation_map: {},
        budget_tracking: { reservedMicro: "0", spentMicro: "0" },
        search_loop_count: 0,
      };

      const result = await orchestratorNode(state);

      expect(result.master_ledger).toEqual({});
      expect(result.project_taxonomy).toBeNull();
      expect(result.local_inspection_state).toEqual([]);
      expect(result.search_loop_count).toBe(0);
      expect(result.messages).toEqual([]);
    });

    it("should load master ledger and taxonomy sentinel from persistent store when projectId & userId exist", async () => {
      const mockNode = createTestDecisionNode("dec_existing_1");
      const mockTaxonomy: ProjectTaxonomyState = {
        projectId: "proj_abc",
        addedTags: ["crypto_primitives"],
        removedTags: [],
        updatedAt: new Date(1700000000000).toISOString(),
      };

      vi.mocked(loadProjectDecisionLedger).mockResolvedValueOnce({
        masterLedger: { dec_existing_1: mockNode },
        projectTaxonomy: mockTaxonomy,
      });

      const state: AgentGraphState = {
        messages: [],
        user_request: {
          prompt: "Design high-performance storage",
          projectId: "proj_abc",
          targetFileIds: ["storage.md", "cache.md"],
        },
        search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
        local_inspection_state: ["existing_file.md"],
        assumptions: [],
        master_ledger: {},
        project_taxonomy: null,
        unresolved_ledger: [],
        question_queue: null,
        invalidation_map: {},
        budget_tracking: { reservedMicro: "0", spentMicro: "0" },
        search_loop_count: 0,
      };

      const config: RunnableConfig = {
        configurable: { userId: "user_test_99" },
      };

      const result = await orchestratorNode(state, config);

      expect(loadProjectDecisionLedger).toHaveBeenCalledWith("proj_abc", "user_test_99");
      expect(result.master_ledger).toHaveProperty("dec_existing_1");
      expect(result.project_taxonomy).toEqual(mockTaxonomy);
      expect(result.local_inspection_state).toEqual([
        "existing_file.md",
        "storage.md",
        "cache.md",
      ]);
      expect(result.search_loop_count).toBe(0);
      expect(result.messages).toHaveLength(1);
      expect(result.messages![0]._getType()).toBe("human");
      expect((result.messages![0] as HumanMessage).content).toBe("Design high-performance storage");
    });

    it("should filter out system-reserved sentinels from master_ledger merge", async () => {
      const state: AgentGraphState = {
        messages: [],
        user_request: { prompt: "Refactor architecture", projectId: "", targetFileIds: [] },
        search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
        local_inspection_state: [],
        assumptions: [],
        master_ledger: {
          [PROJECT_TAXONOMY_SENTINEL_ID]: createTestDecisionNode(PROJECT_TAXONOMY_SENTINEL_ID),
          dec_valid: createTestDecisionNode("dec_valid"),
        },
        project_taxonomy: null,
        unresolved_ledger: [],
        question_queue: null,
        invalidation_map: {},
        budget_tracking: { reservedMicro: "0", spentMicro: "0" },
        search_loop_count: 1,
      };

      const result = await orchestratorNode(state);

      expect(result.master_ledger).not.toHaveProperty(PROJECT_TAXONOMY_SENTINEL_ID);
      expect(result.master_ledger).toHaveProperty("dec_valid");
      expect(result.search_loop_count).toBe(1);
    });

    it("should fall back gracefully when database loading throws an exception", async () => {
      vi.mocked(loadProjectDecisionLedger).mockRejectedValueOnce(new Error("Neon connection failed"));

      const state: AgentGraphState = {
        messages: [],
        user_request: { prompt: "Offline query", projectId: "proj_err", targetFileIds: [] },
        search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
        local_inspection_state: [],
        assumptions: [],
        master_ledger: {},
        project_taxonomy: null,
        unresolved_ledger: [],
        question_queue: null,
        invalidation_map: {},
        budget_tracking: { reservedMicro: "0", spentMicro: "0" },
        search_loop_count: 0,
      };

      const result = await orchestratorNode(state, { configurable: { user_id: "user_alt" } });

      expect(result.master_ledger).toEqual({});
      expect(result.project_taxonomy).toBeNull();
      expect(result.messages).toHaveLength(1);
    });

    it("should not duplicate HumanMessage if user prompt already exists in conversation history", async () => {
      const existingPrompt = "Evaluate caching layer";
      const state: AgentGraphState = {
        messages: [new HumanMessage({ content: existingPrompt })],
        user_request: { prompt: existingPrompt, projectId: "", targetFileIds: [] },
        search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
        local_inspection_state: [],
        assumptions: [],
        master_ledger: {},
        project_taxonomy: null,
        unresolved_ledger: [],
        question_queue: null,
        invalidation_map: {},
        budget_tracking: { reservedMicro: "0", spentMicro: "0" },
        search_loop_count: 0,
      };

      const result = await orchestratorNode(state);
      expect(result.messages).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Stage 1: Search & Exploration Nodes & Routers
  // ==========================================================================
  describe("Stage 1: Search & Exploration Nodes & Routers", () => {
    describe("toolsCondition router", () => {
      it("should route to workspace_tool_node when last message has pending tool calls", () => {
        const state = {
          messages: [
            new AIMessage({
              content: "Inspecting files...",
              tool_calls: [
                {
                  id: "call_1",
                  name: "listHeadingsTree",
                  args: { fileIds: ["doc.md"] },
                },
              ],
            }),
          ],
        } as unknown as AgentGraphState;

        expect(toolsCondition(state)).toBe("workspace_tool_node");
      });

      it("should route to search_synthesizer_node when last message has empty tool_calls array", () => {
        const state = {
          messages: [
            new AIMessage({
              content: "Exploration complete.",
              tool_calls: [],
            }),
          ],
        } as unknown as AgentGraphState;

        expect(toolsCondition(state)).toBe("search_synthesizer_node");
      });

      it("should route to search_synthesizer_node when last message is a regular AIMessage or HumanMessage", () => {
        const state = {
          messages: [new HumanMessage({ content: "Start analysis" })],
        } as unknown as AgentGraphState;

        expect(toolsCondition(state)).toBe("search_synthesizer_node");
      });

      it("should route to search_synthesizer_node when messages array is empty", () => {
        const state = { messages: [] } as unknown as AgentGraphState;
        expect(toolsCondition(state)).toBe("search_synthesizer_node");
      });
    });

    describe("workspaceToolNode", () => {
      it("should return empty object when last message has no tool calls", async () => {
        const state = {
          messages: [new AIMessage({ content: "No tool calls here" })],
        } as unknown as AgentGraphState;

        const result = await workspaceToolNode(state);
        expect(result).toEqual({});
      });

      it("should dispatch listHeadingsTree tool call and record visited paths", async () => {
        const mockProvider = new MockWorkspaceProvider();
        const state = {
          messages: [
            new AIMessage({
              content: "Inspecting headings",
              tool_calls: [
                {
                  id: "call_headings_1",
                  name: "listHeadingsTree",
                  args: { fileIds: ["arch.md"] },
                },
              ],
            }),
          ],
        } as unknown as AgentGraphState;

        const result = await workspaceToolNode(state, {
          configurable: { workspaceProvider: mockProvider },
        });

        expect(mockProvider.listHeadingsTree).toHaveBeenCalledWith(["arch.md"]);
        expect(result.messages).toHaveLength(1);
        expect(result.messages![0]._getType()).toBe("tool");
        expect(result.local_inspection_state).toEqual(["arch.md#system-overview"]);
      });

      it("should dispatch readSectionByHeading and record visited path", async () => {
        const mockProvider = new MockWorkspaceProvider();
        const state = {
          messages: [
            new AIMessage({
              content: "Reading section",
              tool_calls: [
                {
                  id: "call_read_1",
                  name: "readSectionByHeading",
                  args: { fileId: "doc.md", headingSlug: "security" },
                },
              ],
            }),
          ],
        } as unknown as AgentGraphState;

        const result = await workspaceToolNode(state, {
          configurable: { workspaceProvider: mockProvider },
        });

        expect(mockProvider.readSectionByHeading).toHaveBeenCalledWith("doc.md", "security");
        expect(result.messages).toHaveLength(1);
        expect(result.local_inspection_state).toEqual(["doc.md#security"]);
      });

      it("should dispatch searchLexicalWithASTBreadcrumb and record match paths", async () => {
        const mockProvider = new MockWorkspaceProvider();
        const state = {
          messages: [
            new AIMessage({
              content: "Lexical search",
              tool_calls: [
                {
                  id: "call_search_1",
                  name: "searchLexicalWithASTBreadcrumb",
                  args: { fileIds: ["doc.md"], query: "database cache", maxResults: 5 },
                },
              ],
            }),
          ],
        } as unknown as AgentGraphState;

        const result = await workspaceToolNode(state, {
          configurable: { workspaceProvider: mockProvider },
        });

        expect(mockProvider.searchLexicalWithASTBreadcrumb).toHaveBeenCalledWith({
          fileIds: ["doc.md"],
          query: "database cache",
          maxResults: 5,
        });
        expect(result.messages).toHaveLength(1);
        expect(result.local_inspection_state).toEqual(["doc.md#system-overview"]);
      });

      it("should handle unrecognized tool names with an error payload in ToolMessage", async () => {
        const mockProvider = new MockWorkspaceProvider();
        const state = {
          messages: [
            new AIMessage({
              content: "Invoking unknown",
              tool_calls: [
                {
                  id: "call_unknown",
                  name: "deleteDatabase",
                  args: {},
                },
              ],
            }),
          ],
        } as unknown as AgentGraphState;

        const result = await workspaceToolNode(state, {
          configurable: { workspaceProvider: mockProvider },
        });

        expect(result.messages).toHaveLength(1);
        const content = JSON.parse(result.messages![0].content as string);
        expect(content.error).toContain("Unrecognized workspace inspection tool");
      });
    });

    describe("searchSynthesizerNode & rawSearchSynthesizerNode", () => {
      it("should synthesize evidence from heading tree, section read, and lexical search ToolMessages", async () => {
        const headingTreePayload = {
          "arch.md": [
            {
              headingSlug: "system-design",
              title: "System Design",
              level: 2,
              breadcrumb: "Overview > System Design",
            },
          ],
        };

        const sectionReadPayload: SectionReadResult = {
          breadcrumb: "Overview > System Design",
          contentOrVaultRef: "The system uses event-driven CQRS pattern.",
          isVaultRef: false,
        };

        const lexicalMatchesPayload: LexicalMatchResult[] = [
          {
            fileId: "arch.md",
            fileName: "arch.md",
            headingSlug: "system-design",
            headingBreadcrumb: "Overview > System Design",
            matchedExcerpt: "CQRS event store",
            lineRange: [10, 15],
            bm25Score: 1.5,
          },
        ];

        const state: AgentGraphState = {
          messages: [
            new ToolMessage({
              tool_call_id: "c1",
              name: "listHeadingsTree",
              content: JSON.stringify(headingTreePayload),
            }),
            new ToolMessage({
              tool_call_id: "c2",
              name: "readSectionByHeading",
              content: JSON.stringify(sectionReadPayload),
            }),
            new ToolMessage({
              tool_call_id: "c3",
              name: "searchLexicalWithASTBreadcrumb",
              content: JSON.stringify(lexicalMatchesPayload),
            }),
          ],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: ["arch.md#system-design"],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawSearchSynthesizerNode(state);

        expect(result.search_report).toBeDefined();
        const report = result.search_report!;
        expect(report.evidenceItems.length).toBeGreaterThanOrEqual(3);
        expect(report.inspectedPaths).toEqual(["arch.md#system-design"]);
        expect(report.summary).toContain("Synthesized");
      });

      it("should skip non-tool messages and non-JSON tool messages gracefully", async () => {
        const state: AgentGraphState = {
          messages: [
            new HumanMessage({ content: "Hello" }),
            new AIMessage({ content: "Working..." }),
            new ToolMessage({ tool_call_id: "c_plain", name: "ping", content: "PONG" }),
          ],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawSearchSynthesizerNode(state);

        expect(result.search_report?.evidenceItems).toEqual([]);
        expect(result.search_report?.summary).toContain("no active section evidence extracted");
      });
    });

    describe("rawSearchAgentNode & simulation flow", () => {
      it("should emit listHeadingsTree tool call on initial exploration turn", async () => {
        const state: AgentGraphState = {
          messages: [],
          user_request: {
            prompt: "Inspect data model",
            projectId: "proj_1",
            targetFileIds: ["schema.md"],
          },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawSearchAgentNode(state);

        expect(result.messages).toHaveLength(1);
        const msg = result.messages![0] as AIMessage;
        expect(msg.tool_calls).toBeDefined();
        expect(msg.tool_calls![0].name).toBe("listHeadingsTree");
        expect(msg.tool_calls![0].args).toEqual({ fileIds: ["schema.md"] });
      });

      it("should conclude exploration when tool messages are already present", async () => {
        const state: AgentGraphState = {
          messages: [
            new ToolMessage({
              tool_call_id: "c_done",
              name: "listHeadingsTree",
              content: "{}",
            }),
          ],
          user_request: {
            prompt: "Inspect data model",
            projectId: "proj_1",
            targetFileIds: ["schema.md"],
          },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: ["schema.md#overview"],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawSearchAgentNode(state);

        expect(result.messages).toHaveLength(1);
        const msg = result.messages![0] as AIMessage;
        expect(msg.tool_calls ?? []).toHaveLength(0);
        expect(msg.content).toContain("Completed workspace inspection");
      });

      it("should export correct SEARCH_AGENT_MODEL_ID and SEARCH_AGENT_STEP_CEILING constants", () => {
        expect(SEARCH_AGENT_MODEL_ID).toBe("google/gemini-3.8-flash");
        expect(SEARCH_AGENT_STEP_CEILING).toBe(6);
      });
    });
  });

  // ==========================================================================
  // Stage 2: Assumption Analyzer, ATMS Relational Linker & Router
  // ==========================================================================
  describe("Stage 2: Assumption Analyzer, ATMS Relational Linker & Router", () => {
    describe("assumptionAnalyzerNode & rawAssumptionAnalyzerNode", () => {
      it("should extract assumptions with tags bounded to project taxonomy and enrich with candidate prior decisions", async () => {
        const existingNode = createTestDecisionNode("dec_prior_arch", {
          conceptTags: ["system_architecture"],
        });

        const state: AgentGraphState = {
          messages: [],
          user_request: {
            prompt: "Adopt micro-frontend modular architecture",
            projectId: "proj_1",
            targetFileIds: ["frontend.md"],
          },
          search_report: {
            evidenceItems: [
              {
                fileId: "frontend.md",
                headingSlug: "ui-architecture",
                breadcrumb: ["Frontend", "UI Architecture"],
                textExcerpt: "Module federation with React",
              },
            ],
            inspectedPaths: ["frontend.md#ui-architecture"],
            summary: "Evidence ready",
          },
          local_inspection_state: ["frontend.md#ui-architecture"],
          assumptions: [],
          master_ledger: { dec_prior_arch: existingNode },
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawAssumptionAnalyzerNode(state);

        expect(result.assumptions).toBeDefined();
        expect(result.assumptions!.length).toBeGreaterThan(0);
        const asmp = result.assumptions![0];
        expect(asmp.conceptTags.length).toBeGreaterThanOrEqual(1);
        expect(asmp.affectedSections).toEqual([
          { fileId: "frontend.md", headingSlug: "ui-architecture" },
        ]);
        expect(asmp).toHaveProperty("candidateDecisionIds");
      });

      it("should export correct ASSUMPTION_ANALYZER_MODEL_ID", () => {
        expect(ASSUMPTION_ANALYZER_MODEL_ID).toBe("google/gemini-3.8-flash");
      });
    });

    describe("atmsRelationalLinkerNode", () => {
      it("should return early when state.assumptions is empty", async () => {
        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await atmsRelationalLinkerNode(state);

        expect(result.master_ledger).toEqual({});
        expect(result.invalidation_map).toEqual({});
      });

      it("should execute relational adjudication, cascade BFS, and section invalidation aggregation", async () => {
        const priorNode = createTestDecisionNode("dec_parent", {
          conceptTags: ["system_architecture"],
          affectedSections: [{ fileId: "doc.md", headingSlug: "overview" }],
        });

        const assumption: AssumptionItem = {
          assumptionId: "asmp_1",
          statement: "Replace legacy database with Redis cluster",
          conceptTags: ["system_architecture"],
          affectedSections: [{ fileId: "doc.md", headingSlug: "database" }],
          dependsOn: [],
        };

        vi.mocked(evaluateRelationalLinksBatch).mockResolvedValueOnce([
          {
            assumptionId: "asmp_1",
            targetDecisionId: "dec_parent",
            relationType: "REOPENS_OR_OVERRIDES",
            confidence: 0.95,
            justification: "Direct architectural replacement",
          },
        ]);

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "Upgrade db", projectId: "proj_1", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [assumption],
          master_ledger: { dec_parent: priorNode },
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await atmsRelationalLinkerNode(state);

        expect(result.master_ledger).toBeDefined();
        expect(result.invalidation_map).toBeDefined();
        // dec_parent was overridden, so its sections must be in invalidation_map
        expect(result.invalidation_map).toHaveProperty("dec_parent");
        // Reopened node dec_parent must be staged in assumptions
        const assumptionIds = result.assumptions?.map((a) => a.assumptionId);
        expect(assumptionIds).toContain("asmp_1");
        expect(assumptionIds).toContain("dec_parent");
      });
    });

    describe("routeAfterAssumptions router (G-5 3-Way Branching)", () => {
      it("should route to document_writer_node when assumptions and invalidations are both empty", () => {
        const state = {
          assumptions: [],
          invalidation_map: {},
          search_loop_count: 0,
        } as unknown as AgentGraphState;

        expect(routeAfterAssumptions(state)).toBe("document_writer_node");
      });

      it("should route to jev_structuring_node when assumptions are empty BUT invalidations exist", () => {
        const state = {
          assumptions: [],
          invalidation_map: {
            dec_1: [{ fileId: "a.md", headingSlug: "h1" }],
          },
          search_loop_count: 0,
        } as unknown as AgentGraphState;

        expect(routeAfterAssumptions(state)).toBe("jev_structuring_node");
      });

      it("should route to search_agent_node when contextual gap is flagged and search_loop_count < 3", () => {
        const state = {
          assumptions: [
            {
              assumptionId: "asmp_gap",
              statement: "Needs inspection for third-party billing constraints",
              conceptTags: ["payments"],
              affectedSections: [],
              dependsOn: [],
            },
          ],
          invalidation_map: {},
          search_loop_count: 1,
        } as unknown as AgentGraphState;

        expect(routeAfterAssumptions(state)).toBe("search_agent_node");
      });

      it("should route to search_agent_node when targetFileIds exist with zero evidence and search_loop_count < 3", () => {
        const state = {
          assumptions: [
            {
              assumptionId: "asmp_1",
              statement: "Standard requirement",
              conceptTags: ["system_architecture"],
              affectedSections: [],
              dependsOn: [],
            },
          ],
          user_request: {
            prompt: "Test",
            projectId: "p1",
            targetFileIds: ["missing_evidence.md"],
          },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          search_loop_count: 0,
        } as unknown as AgentGraphState;

        expect(routeAfterAssumptions(state)).toBe("search_agent_node");
      });

      it("should route to jev_structuring_node when gap is present but search_loop_count >= 3 (stop ceiling)", () => {
        const state = {
          assumptions: [
            {
              assumptionId: "asmp_gap",
              statement: "Insufficient evidence for crypto key rotation",
              conceptTags: ["security"],
              affectedSections: [],
              dependsOn: [],
            },
          ],
          invalidation_map: {},
          search_loop_count: 3,
        } as unknown as AgentGraphState;

        expect(routeAfterAssumptions(state)).toBe("jev_structuring_node");
      });

      it("should route to jev_structuring_node for normal progression with clean assumptions", () => {
        const state = {
          assumptions: [
            {
              assumptionId: "asmp_normal",
              statement: "Use Argon2id for password hashing",
              conceptTags: ["security"],
              affectedSections: [],
              dependsOn: [],
            },
          ],
          search_report: {
            evidenceItems: [
              {
                fileId: "auth.md",
                headingSlug: "hashing",
                breadcrumb: ["Auth", "Hashing"],
                textExcerpt: "Argon2id config",
              },
            ],
            inspectedPaths: ["auth.md#hashing"],
            summary: "Done",
          },
          user_request: { targetFileIds: ["auth.md"] },
          search_loop_count: 0,
        } as unknown as AgentGraphState;

        expect(routeAfterAssumptions(state)).toBe("jev_structuring_node");
      });
    });
  });

  // ==========================================================================
  // Stage 3: JEV Structuring & Decision Scorer Nodes
  // ==========================================================================
  describe("Stage 3: JEV Structuring & Decision Scorer Nodes", () => {
    describe("jevStructuringNode & rawJevStructuringNode", () => {
      it("should format assumptions into CanonicalDecisionBatch and emit AIMessage named canonical_decision_batch", async () => {
        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [
            {
              assumptionId: "asmp_eval_1",
              statement: "Adopt Redis caching layer",
              conceptTags: ["system_architecture"],
              affectedSections: [{ fileId: "cache.md", headingSlug: "redis-layer" }],
              dependsOn: [],
            },
          ],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawJevStructuringNode(state);

        expect(result.messages).toHaveLength(1);
        const msg = result.messages![0] as AIMessage;
        expect((msg as any).name).toBe(CANONICAL_BATCH_MESSAGE_NAME);
        const parsed = JSON.parse(msg.content as string);
        expect(parsed.items).toHaveLength(1);
        expect(parsed.items[0].decisionId).toBe("asmp_eval_1");
        expect(parsed.items[0].options.length).toBeGreaterThanOrEqual(3);
      });

      it("should re-inject historical alternatives and prior context when re-evaluating an existing decision", async () => {
        const priorNode = createTestDecisionNode("dec_reopen_1", {
          selectedOptionKey: "opt_modular",
          selectionRationale: "Previously selected modular approach",
          evaluatedAlternatives: [
            {
              optionKey: "opt_modular",
              neutralSummary: "Modular boundary",
              rationaleAndPremises: "Isolates failure",
              normalizedProbability: 0.7,
            },
            {
              optionKey: "opt_monolith",
              neutralSummary: "Monolithic boundary",
              rationaleAndPremises: "Centralized execution",
              normalizedProbability: 0.2,
            },
            {
              optionKey: "opt_serverless",
              neutralSummary: "Serverless boundary",
              rationaleAndPremises: "On-demand execution",
              normalizedProbability: 0.1,
            },
          ],
        });

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [
            {
              assumptionId: "dec_reopen_1",
              statement: "Re-evaluating modular boundary under high load",
              conceptTags: ["system_architecture"],
              affectedSections: [],
              dependsOn: [],
            },
          ],
          master_ledger: { dec_reopen_1: priorNode },
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawJevStructuringNode(state);

        const msg = result.messages![0] as AIMessage;
        const parsed = JSON.parse(msg.content as string);
        const item = parsed.items[0];
        expect(item.priorDecisionContext).toBeDefined();
        expect(item.priorDecisionContext.reopenedFromDecisionId).toBe("dec_reopen_1");
        expect(item.priorDecisionContext.previousSelectedOptionKey).toBe("opt_modular");
        // Re-injected prior alternatives
        expect(item.options.map((o: any) => o.optionKey)).toContain("opt_modular");
        expect(item.options.map((o: any) => o.optionKey)).toContain("opt_monolith");
        expect(item.options.map((o: any) => o.optionKey)).toContain("opt_serverless");
      });

      it("should generate baseline architectural item when assumptions array is empty", async () => {
        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "Initial bootstrap", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawJevStructuringNode(state);

        const msg = result.messages![0] as AIMessage;
        const parsed = JSON.parse(msg.content as string);
        expect(parsed.items).toHaveLength(1);
        expect(parsed.items[0].questionPrompt).toBe("Initial bootstrap");
      });
    });

    describe("decisionScorerNode & rawDecisionScorerNode", () => {
      it("should score batch, triage UNRESOLVED into unresolved_ledger, and approved into master_ledger", async () => {
        const batchPayload = {
          items: [
            {
              decisionId: "dec_approved",
              topicSlug: "cache_tier",
              questionPrompt: "Select cache implementation",
              conceptTags: ["system_architecture"],
              options: [
                {
                  optionKey: "opt_redis",
                  neutralSummary: "Redis memory store",
                  rationaleAndPremises: "Sub-millisecond access",
                },
                {
                  optionKey: "opt_idb",
                  neutralSummary: "IndexedDB client store",
                  rationaleAndPremises: "Zero network latency",
                },
                {
                  optionKey: "opt_none",
                  neutralSummary: "No caching",
                  rationaleAndPremises: "Direct queries",
                },
              ],
              dependsOnDecisionIds: [],
              affectedSections: [{ fileId: "arch.md", headingSlug: "cache" }],
            },
            {
              decisionId: "dec_ambiguous",
              topicSlug: "crypto_primitive",
              questionPrompt: "Select encryption algorithm",
              conceptTags: ["system_architecture"],
              options: [
                {
                  optionKey: "opt_aes",
                  neutralSummary: "AES-GCM-256",
                  rationaleAndPremises: "Hardware accelerated",
                },
                {
                  optionKey: "opt_chacha",
                  neutralSummary: "ChaCha20-Poly1305",
                  rationaleAndPremises: "Software constant time",
                },
                {
                  optionKey: "opt_custom",
                  neutralSummary: "Custom scheme",
                  rationaleAndPremises: "Experimental",
                },
              ],
              dependsOnDecisionIds: [],
              affectedSections: [],
            },
          ],
        };

        vi.mocked(evaluateDecisionBatch).mockResolvedValueOnce([
          {
            decisionId: "dec_approved",
            topicSlug: "cache_tier",
            questionPrompt: "Select cache implementation",
            conceptTags: ["system_architecture"],
            status: "APPROVED_DIRECT",
            impactTier: "CORE_ARCHITECTURAL",
            isLoadBearing: true,
            selectedOptionKey: "opt_redis",
            selectionRationale: "Validated sub-millisecond access performance.",
            runnerUpOptionKey: "opt_idb",
            evaluatedAlternatives: [
              {
                optionKey: "opt_redis",
                neutralSummary: "Redis memory store",
                rationaleAndPremises: "Sub-millisecond access",
                normalizedProbability: 0.85,
              },
              {
                optionKey: "opt_idb",
                neutralSummary: "IndexedDB client store",
                rationaleAndPremises: "Zero network latency",
                normalizedProbability: 0.15,
              },
            ],
            predictionSetCore: ["opt_redis"],
            predictionSetPeriph: ["opt_redis"],
            dominanceMargin: 0.7,
            evidenceGrounding: 1.0,
          },
          {
            decisionId: "dec_ambiguous",
            topicSlug: "crypto_primitive",
            questionPrompt: "Select encryption algorithm",
            conceptTags: ["system_architecture"],
            status: "UNRESOLVED",
            impactTier: "CORE_ARCHITECTURAL",
            isLoadBearing: true,
            selectedOptionKey: null,
            selectionRationale: "",
            runnerUpOptionKey: null,
            evaluatedAlternatives: [],
            predictionSetCore: ["opt_aes", "opt_chacha"],
            predictionSetPeriph: ["opt_aes", "opt_chacha"],
            dominanceMargin: 0.05,
            evidenceGrounding: 0.4,
            reason: "Prediction set cardinality |C_core| = 2 exceeds direct approval threshold",
          },
        ]);

        const state: AgentGraphState = {
          messages: [
            new AIMessage({
              name: CANONICAL_BATCH_MESSAGE_NAME,
              content: JSON.stringify(batchPayload),
            }),
          ],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await rawDecisionScorerNode(state);

        expect(result.master_ledger).toHaveProperty("dec_approved");
        expect(result.master_ledger!["dec_approved"].status).toBe("APPROVED_DIRECT");
        expect(result.master_ledger!["dec_approved"].affectedSections).toEqual([
          { fileId: "arch.md", headingSlug: "cache" },
        ]);

        expect(result.unresolved_ledger).toHaveLength(1);
        expect(result.unresolved_ledger![0].decisionId).toBe("dec_ambiguous");
        expect(result.unresolved_ledger![0].reason).toContain("cardinality");

        expect(result.messages).toHaveLength(1);
        expect((result.messages![0] as AIMessage).content).toContain("1 decisions approved, 1 unresolved");
      });

      it("should export correct JEV_STRUCTURING_MODEL_ID and DECISION_SCORER_MODEL_ID constants", () => {
        expect(JEV_STRUCTURING_MODEL_ID).toBe("google/gemini-3.8-flash");
        expect(DECISION_SCORER_MODEL_ID).toBe("typesafe/jev-1.13");
      });
    });
  });

  // ==========================================================================
  // Stage 4: Confidence Classifier & ATMS Ledger Commit Nodes
  // ==========================================================================
  describe("Stage 4: Confidence Classifier & ATMS Ledger Commit Nodes", () => {
    describe("confidenceClassifierNode (Deterministic, zero LLM)", () => {
      it("should classify high-dominance candidates as staged and ambiguous candidates as unresolved", async () => {
        const candidateHigh = {
          decisionId: "cand_high",
          topicSlug: "db_layer",
          questionPrompt: "Choose DB",
          conceptTags: ["system_architecture"],
          options: [
            { optionKey: "opt_pg", neutralSummary: "Postgres", rationaleAndPremises: "ACID" },
            { optionKey: "opt_mongo", neutralSummary: "MongoDB", rationaleAndPremises: "Docs" },
          ],
          probabilities: { opt_pg: 0.95, opt_mongo: 0.05 },
          couplingLevel: 0,
          rollbackCost: 0,
        };

        const candidateAmbiguous = {
          decisionId: "cand_ambig",
          topicSlug: "queue_tier",
          questionPrompt: "Choose Queue",
          conceptTags: ["system_architecture"],
          options: [
            { optionKey: "opt_sqs", neutralSummary: "SQS", rationaleAndPremises: "Cloud" },
            { optionKey: "opt_kafka", neutralSummary: "Kafka", rationaleAndPremises: "Stream" },
          ],
          probabilities: { opt_sqs: 0.51, opt_kafka: 0.49 },
          couplingLevel: 0,
          rollbackCost: 0,
        };

        const state = {
          assumptions: [],
          master_ledger: {},
        } as unknown as AgentGraphState;

        const config: RunnableConfig = {
          configurable: {
            scored_decisions: [candidateHigh, candidateAmbiguous],
          },
        };

        const result = (await confidenceClassifierNode(state, config)) as any;

        expect(result.unresolved_ledger).toBeDefined();
        const unresolvedIds = result.unresolved_ledger.map((u: any) => u.decisionId);
        expect(unresolvedIds).toContain("cand_ambig");

        expect(result.staged_decisions).toBeDefined();
        const stagedIds = result.staged_decisions.map((s: any) => s.decisionId);
        expect(stagedIds).toContain("cand_high");
      });
    });

    describe("ledgerCommitNode (Deterministic, zero LLM)", () => {
      it("should convert staged decisions into ATMSDecisionNodes, maintain parent bidirectional dependedBy edges, and sync to store", async () => {
        const parentNode = createTestDecisionNode("dec_parent_node", {
          dependedBy: [],
        });

        const stagedCandidate = {
          decisionId: "dec_child_node",
          topicSlug: "cache_subsystem",
          questionPrompt: "Adopt in-memory cache",
          conceptTags: ["system_architecture"],
          status: "APPROVED_DIRECT" as const,
          impactTier: "CORE_ARCHITECTURAL" as const,
          isLoadBearing: true,
          selectedOptionKey: "opt_cache",
          selectionRationale: "Reduces Neon load",
          dependsOnDecisionIds: ["dec_parent_node"],
          affectedSections: [{ fileId: "perf.md", headingSlug: "latency" }],
        };

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "proj_ledger_test", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: { dec_parent_node: parentNode },
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const config: RunnableConfig = {
          configurable: {
            userId: "user_ledger_1",
            staged_decisions: [stagedCandidate],
          },
        };

        const result = await ledgerCommitNode(state, config);

        expect(result.master_ledger).toBeDefined();
        const updated = result.master_ledger!;
        expect(updated).toHaveProperty("dec_child_node");
        expect(updated.dec_child_node.status).toBe("APPROVED_DIRECT");
        expect(updated.dec_child_node.dependsOn).toEqual(["dec_parent_node"]);

        // Invariant: parent dependedBy edge updated
        expect(updated.dec_parent_node.dependedBy).toContain("dec_child_node");

        // Invariant: minimal section invalidation computed
        expect(result.invalidation_map).toBeDefined();

        // Invariant: syncMasterLedgerToProjectStore invoked with project and user
        expect(syncMasterLedgerToProjectStore).toHaveBeenCalledWith(
          "proj_ledger_test",
          "user_ledger_1",
          expect.any(Object),
          null,
        );
      });

      it("should skip committing decisions that are listed in unresolved_ledger", async () => {
        const stagedCandidate = {
          decisionId: "dec_staged_but_unresolved",
          status: "APPROVED_DIRECT" as const,
        };

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "p1", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [
            {
              decisionId: "dec_staged_but_unresolved",
              topicSlug: "t",
              questionPrompt: "q",
              conceptTags: [],
              reason: "Unmet conformal threshold",
            },
          ],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const config: RunnableConfig = {
          configurable: {
            staged_decisions: [stagedCandidate],
            skipStoreSync: true,
          },
        };

        const result = await ledgerCommitNode(state, config);

        expect(result.master_ledger).not.toHaveProperty("dec_staged_but_unresolved");
      });
    });
  });

  // ==========================================================================
  // Stage 5: Internal Gap Planner & Resolution Gate Router
  // ==========================================================================
  describe("Stage 5: Internal Gap Planner & Resolution Gate Router", () => {
    describe("internalGapPlannerNode (Deterministic, zero LLM)", () => {
      it("should increment search_loop_count by 1 and format target inspection paths from unresolved items", async () => {
        const unresolved: UnresolvedDecision[] = [
          {
            decisionId: "dec_gap_1",
            topicSlug: "session_storage",
            questionPrompt: "How to store sessions?",
            conceptTags: ["security", "system_architecture"],
            reason: "Ambiguous storage model",
          },
        ];

        const matchingAssumption: AssumptionItem = {
          assumptionId: "dec_gap_1",
          statement: "Store in JWT vs Redis",
          conceptTags: ["security"],
          affectedSections: [{ fileId: "auth.md", headingSlug: "session-mgmt" }],
          dependsOn: [],
        };

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [matchingAssumption],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: unresolved,
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await internalGapPlannerNode(state);

        expect(result.search_loop_count).toBe(1);
        expect(result.local_inspection_state).toEqual([
          "topic:session_storage",
          "concept:security",
          "concept:system_architecture",
          "auth.md#session-mgmt",
        ]);
      });
    });

    describe("resolutionGateRouter (Deterministic 4-Way Branching)", () => {
      it("Path 1: should route to pure_interrupt_node when credit failure / exhaustion is flagged", () => {
        const state1 = {
          credit_exhausted: true,
          unresolved_ledger: [],
          search_loop_count: 0,
        } as unknown as AgentGraphState;
        expect(resolutionGateRouter(state1)).toBe("pure_interrupt_node");

        const state2 = {
          code: "INSUFFICIENT_CREDITS",
          unresolved_ledger: [],
          search_loop_count: 0,
        } as unknown as AgentGraphState;
        expect(resolutionGateRouter(state2)).toBe("pure_interrupt_node");

        const state3 = {
          insufficient_credits: true,
          unresolved_ledger: [],
          search_loop_count: 0,
        } as unknown as AgentGraphState;
        expect(resolutionGateRouter(state3)).toBe("pure_interrupt_node");
      });

      it("Path 2: should route to document_writer_node when all decisions are resolved (unresolved_ledger is empty)", () => {
        const state = {
          unresolved_ledger: [],
          search_loop_count: 0,
        } as unknown as AgentGraphState;

        expect(resolutionGateRouter(state)).toBe("document_writer_node");
      });

      it("Path 3: should route to internal_gap_planner_node when unresolved items remain and search_loop_count < 3", () => {
        const state1 = {
          unresolved_ledger: [{ decisionId: "d1" }],
          search_loop_count: 0,
        } as unknown as AgentGraphState;
        expect(resolutionGateRouter(state1)).toBe("internal_gap_planner_node");

        const state2 = {
          unresolved_ledger: [{ decisionId: "d1" }],
          search_loop_count: 2,
        } as unknown as AgentGraphState;
        expect(resolutionGateRouter(state2)).toBe("internal_gap_planner_node");
      });

      it("Path 4: should route to question_organizer_node when unresolved items remain and search_loop_count >= 3", () => {
        const state1 = {
          unresolved_ledger: [{ decisionId: "d1" }],
          search_loop_count: 3,
        } as unknown as AgentGraphState;
        expect(resolutionGateRouter(state1)).toBe("question_organizer_node");

        const state2 = {
          unresolved_ledger: [{ decisionId: "d1" }],
          search_loop_count: 5,
        } as unknown as AgentGraphState;
        expect(resolutionGateRouter(state2)).toBe("question_organizer_node");
      });
    });
  });

  // ==========================================================================
  // Stage 6: Human-in-the-Loop (HITL) Nodes
  // ==========================================================================
  describe("Stage 6: Human-in-the-Loop (HITL) Nodes", () => {
    describe("questionOrganizerNode", () => {
      it("should synthesize unresolved decisions into a structured ClarifyingQuestionBatch in question_queue", async () => {
        const unresolvedItem: UnresolvedDecision = {
          decisionId: "dec_clarify_1",
          topicSlug: "offline_storage",
          questionPrompt: "Should offline documents be encrypted in IndexedDB?",
          conceptTags: ["security"],
          reason: "Both full encryption and plaintext cache have identical conformal scores.",
        };

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [unresolvedItem],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 3,
        };

        const result = await questionOrganizerNode(state);

        expect(result.question_queue).toBeDefined();
        const batch = result.question_queue!;
        expect(batch.questions).toHaveLength(1);
        const q = batch.questions[0];
        expect(q.questionId).toBe("dec_clarify_1");
        expect(q.topicSlug).toBe("offline_storage");
        expect(q.options.length).toBeGreaterThanOrEqual(3);
        expect(q.contextExplanation).toContain("Resolution escalated to user");
      });
    });

    describe("pureInterruptNode (Purity invariants & resumption)", () => {
      it("Purity Invariant: should never swallow GraphInterrupt / exception thrown by interrupt()", async () => {
        const customGraphInterrupt = new Error("GraphInterrupt");
        vi.mocked(interrupt).mockImplementationOnce(() => {
          throw customGraphInterrupt;
        });

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: {
            questions: [
              {
                questionId: "q1",
                topicSlug: "topic",
                questionPrompt: "Prompt",
                options: [
                  { optionKey: "opt_1", neutralSummary: "Opt 1", rationaleAndPremises: "R1" },
                  { optionKey: "opt_2", neutralSummary: "Opt 2", rationaleAndPremises: "R2" },
                ],
              },
            ],
          },
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 3,
        };

        await expect(pureInterruptNode(state)).rejects.toThrow("GraphInterrupt");
      });

      it("Financial Interrupt: should interrupt with credit failure payload when financial exhaustion occurs", async () => {
        vi.mocked(interrupt).mockReturnValueOnce({ answers: [] });

        const state = {
          credit_exhausted: true,
          availableMicro: 50,
          requiredMicro: 500,
          question_queue: null,
        } as unknown as AgentGraphState;

        await pureInterruptNode(state);

        expect(interrupt).toHaveBeenCalledWith({
          code: "INSUFFICIENT_CREDITS",
          availableMicro: 50,
          requiredMicro: 500,
          message: expect.stringContaining("Credit balance exhausted"),
        });
      });

      it("Resumption: should validate clarification answers, clear question_queue, and return Command goto assumption_analyzer_node", async () => {
        const resumePayload = {
          answers: [
            {
              questionId: "dec_clarify_1",
              selectedOptionKey: "opt_modular",
              customNotes: "Prefer modular for team scalability.",
            },
          ],
        };

        vi.mocked(interrupt).mockReturnValueOnce(resumePayload);

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [
            {
              decisionId: "dec_clarify_1",
              topicSlug: "arch",
              questionPrompt: "Choose arch",
              conceptTags: [],
              reason: "Requires user clarification",
            },
          ],
          question_queue: {
            questions: [
              {
                questionId: "dec_clarify_1",
                topicSlug: "arch",
                questionPrompt: "Choose arch",
                options: [
                  { optionKey: "opt_modular", neutralSummary: "Mod", rationaleAndPremises: "Prem" },
                  { optionKey: "opt_other", neutralSummary: "Oth", rationaleAndPremises: "Prem" },
                ],
              },
            ],
          },
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 3,
        };

        const command = await pureInterruptNode(state);

        expect(command).toBeInstanceOf(Command);
        // Type check Command properties
        const cmdObj = command as any;
        expect(cmdObj.goto).toEqual(["assumption_analyzer_node"]);
        expect(cmdObj.update.question_queue).toBeNull();
        expect(cmdObj.update.unresolved_ledger).toEqual([]);
        expect(cmdObj.update.clarification_answers).toEqual(resumePayload.answers);
        expect(cmdObj.update.messages).toHaveLength(1);
        expect(cmdObj.update.messages[0].content).toContain("User clarification submitted for 1 item(s)");
      });
    });
  });

  // ==========================================================================
  // Stage 7: Document Writer Node
  // ==========================================================================
  describe("Stage 7: Document Writer Node", () => {
    describe("synthesizeAgentSectionContent", () => {
      it("should create heading and alignment block when baseContent is empty", () => {
        const decision = createTestDecisionNode("dec_1", {
          topicSlug: "database_tier",
          selectedOptionKey: "opt_neon",
          selectionRationale: "Serverless Postgres with branching",
        });

        const result = synthesizeAgentSectionContent("", "database-storage", [decision]);

        expect(result).toContain("## Database Storage");
        expect(result).toContain("<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->");
        expect(result).toContain("- **database_tier** [opt_neon]: Serverless Postgres with branching");
        expect(result).toContain("<!-- END:AGENT_DECISION_ALIGNMENT -->");
      });

      it("should append alignment block to base content when no block exists", () => {
        const base = "## System Overview\nExisting introductory text.";
        const decision = createTestDecisionNode("dec_1");

        const result = synthesizeAgentSectionContent(base, "system-overview", [decision]);

        expect(result.startsWith(base)).toBe(true);
        expect(result).toContain("<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->");
        expect(result).toContain("<!-- END:AGENT_DECISION_ALIGNMENT -->");
      });

      it("should update alignment block cleanly in place when markers already exist", () => {
        const base = [
          "## System Overview",
          "Intro text before block.",
          "",
          "<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->",
          "- **old_topic** [opt_old]: Old rationale",
          "<!-- END:AGENT_DECISION_ALIGNMENT -->",
          "",
          "Outro text after block.",
        ].join("\n");

        const decision = createTestDecisionNode("dec_new", {
          topicSlug: "new_topic",
          selectedOptionKey: "opt_new",
          selectionRationale: "New rationale",
        });

        const result = synthesizeAgentSectionContent(base, "system-overview", [decision]);

        expect(result).toContain("Intro text before block.");
        expect(result).toContain("Outro text after block.");
        expect(result).toContain("- **new_topic** [opt_new]: New rationale");
        expect(result).not.toContain("Old rationale");
        // Markers must appear exactly once
        expect(result.indexOf("<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->")).toBe(
          result.lastIndexOf("<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->"),
        );
      });
    });

    describe("documentWriterNode", () => {
      it("should execute three-way merge for sections listed in invalidation_map and reset invalidation_map", async () => {
        const mockProvider = new MockWorkspaceProvider();

        const decision = createTestDecisionNode("dec_doc_1", {
          affectedSections: [{ fileId: "arch.md", headingSlug: "system-overview" }],
        });

        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "proj_doc", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: { dec_doc_1: decision },
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {
            dec_doc_1: [{ fileId: "arch.md", headingSlug: "system-overview" }],
          },
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const config: RunnableConfig = {
          configurable: {
            workspaceProvider: mockProvider,
          },
        };

        const result = await documentWriterNode(state, config);

        expect(mockProvider.readSectionByHeading).toHaveBeenCalledWith("arch.md", "system-overview");
        expect(mockProvider.mergeSectionThreeWay).toHaveBeenCalled();
        expect(result.invalidation_map).toEqual({});
        expect(result.messages).toHaveLength(1);
        expect(result.messages![0].content).toContain("1 section(s) cleanly merged");
      });

      it("should report no section modifications when invalidation_map and affectedSections are empty", async () => {
        const state: AgentGraphState = {
          messages: [],
          user_request: { prompt: "", projectId: "proj_doc", targetFileIds: [] },
          search_report: { evidenceItems: [], inspectedPaths: [], summary: "" },
          local_inspection_state: [],
          assumptions: [],
          master_ledger: {},
          project_taxonomy: null,
          unresolved_ledger: [],
          question_queue: null,
          invalidation_map: {},
          budget_tracking: { reservedMicro: "0", spentMicro: "0" },
          search_loop_count: 0,
        };

        const result = await documentWriterNode(state);

        expect(result.invalidation_map).toEqual({});
        expect(result.messages![0].content).toContain("no section modifications required");
      });
    });
  });
});
