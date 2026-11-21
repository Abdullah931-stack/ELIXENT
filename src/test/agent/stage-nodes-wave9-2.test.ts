/**
 * Cross-Contract Regression Suite: 9 Canonical Nodes & Anti-Domino / BUG-03 Handoffs
 * (Migrated from legacy Wave 9.2 14-node LangGraph suite to Native Graph Engine — ADR-009/010)
 *
 * Focuses on cross-node contracts and regression invariants not duplicated by per-node unit suites:
 * 1. Canonical node constants & transitional export aliases (`orchestratorNode`, `SEARCH_AGENT_STEP_CEILING`,
 *    `DECISION_SCORER_MODEL_ID`).
 * 2. Node 1 resilience when `listWorkspaceTree` and `readDecisionLedger` reject (graceful fallback).
 * 3. Cross-contract Anti-Domino `ESCALATE_TO_HITL` flow:
 *    Node 4 (`conflictAndWeightGateNode`) -> `gateG04` -> Node 6 (`hitlClarificationNode` INTERRUPTED) ->
 *    `confirm_override` resumption -> `gateAfterHitlClarification` -> Node 5 (`rawJevConformalScorerNode`) ->
 *    Node 7 (`ledgerCommitNode`) -> Node 8 (`rawWorkspaceMutatorNode`).
 * 4. Sacred `BUG-03` regression: `rawWorkspaceMutatorNode` never injects legacy
 *    `<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->` HTML comment blocks and clears `invalidation_map`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  intentAndScopeRouterNode,
  orchestratorNode,
} from "@/core/agent/nodes/orchestrator-node";
import { SEARCH_AGENT_STEP_CEILING } from "@/core/agent/nodes/search-nodes";
import {
  conflictAndWeightGateNode,
  type AnalyzedAssumptionItem,
} from "@/core/agent/nodes/assumption-and-linker-nodes";
import {
  rawJevConformalScorerNode,
  DECISION_SCORER_MODEL_ID,
} from "@/core/agent/nodes/jev-scoring-nodes";
import { hitlClarificationNode } from "@/core/agent/nodes/hitl-nodes";
import { ledgerCommitNode } from "@/core/agent/nodes/resolution-and-ledger-nodes";
import { rawWorkspaceMutatorNode } from "@/core/agent/nodes/document-writer-node";
import {
  gateG04,
  gateAfterHitlClarification,
  gateG06,
  HITL_CLARIFICATION_NODE,
  JEV_CONFORMAL_SCORER_NODE,
  WORKSPACE_MUTATOR_NODE,
} from "@/core/agent/graph";
import {
  applyStateDelta,
  createInitialAgentGraphState,
} from "@/core/agent/state";
import type {
  AgentRuntimeContext,
  AgentStreamEvent,
} from "@/core/agent/engine/runner";
import type { DecisionGraphNode } from "@/core/agent/atms/dag";
import { TIER1_DEFAULT_MODEL } from "@/lib/jev/client";
import type {
  DecisionLedgerDocument,
  HeadingNode,
  IWorkspaceProvider,
  SectionMergeOutcome,
  SectionReadResult,
  WorkspaceTreeEntry,
} from "@/core/workspace/provider";

const mockExecuteStreamingGeneration = vi.hoisted(() => vi.fn());
const mockGetApiKeys = vi.hoisted(() => vi.fn<() => string[]>());
const mockEvaluateRelationalLinksBatch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/client", () => ({
  executeStreamingGeneration: mockExecuteStreamingGeneration,
  executeStructuredGeneration: vi.fn(),
  executeToolAgentGeneration: vi.fn(),
}));

vi.mock("@/lib/ai/key-rotation", () => ({
  getApiKeys: mockGetApiKeys,
}));

vi.mock("@/lib/jev/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jev/client")>();
  return {
    ...actual,
    evaluateRelationalLinksBatch: (
      ...args: Parameters<typeof actual.evaluateRelationalLinksBatch>
    ) => {
      if (mockEvaluateRelationalLinksBatch.getMockImplementation()) {
        return mockEvaluateRelationalLinksBatch(...args);
      }
      return actual.evaluateRelationalLinksBatch(...args);
    },
  };
});

function createHeavyPriorDecision(decisionId: string): DecisionGraphNode {
  return {
    decisionId,
    topicSlug: "primary_database_engine",
    questionPrompt: "Select primary transactional database",
    conceptTags: ["data_modeling", "system_architecture"],
    selectedOptionKey: "postgres_neon",
    selectionRationale: "ACID relational store with branch isolation.",
    runnerUpOptionKey: "sqlite_local",
    evaluatedAlternatives: [
      {
        optionKey: "postgres_neon",
        neutralSummary: "PostgreSQL on Neon",
        rationaleAndPremises: "Strong ACID semantics",
        normalizedProbability: 0.9,
      },
      {
        optionKey: "sqlite_local",
        neutralSummary: "Embedded SQLite",
        rationaleAndPremises: "Single-file simplicity",
        normalizedProbability: 0.1,
      },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
    provenance: "USER_EXPLICIT_HITL",
    couplingLevel: 1.9,
    rollbackCost: 1.9,
    dependsOn: [],
    dependedBy: ["dec_child_1", "dec_child_2"],
    affectedSections: [
      { fileId: "arch.md", headingSlug: "storage-layer" },
      { fileId: "sync.md", headingSlug: "persistence" },
    ],
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

function createMockWorkspaceProvider(
  overrides: Partial<IWorkspaceProvider> = {},
): IWorkspaceProvider {
  const tree: WorkspaceTreeEntry[] = [
    {
      fileId: "arch.md",
      parentFolderId: null,
      title: "Architecture",
      relativePath: "docs/arch.md",
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document",
      etag: "etag-arch",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
    {
      fileId: "sync.md",
      parentFolderId: null,
      title: "Sync",
      relativePath: "docs/sync.md",
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document",
      etag: "etag-sync",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
  ];

  const ledgerDoc: DecisionLedgerDocument = {
    schemaVersion: "2.0.0",
    workspaceId: "ws-cc",
    updatedAt: "2026-11-20T00:00:00.000Z",
    decisions: {},
    nodes: {},
    edges: [],
    taxonomy: null,
  };

  return {
    workspaceId: "ws-cc",
    userId: "user-cc",
    listWorkspaceTree: vi.fn(async () => tree),
    listHeadingsTree: vi.fn(async () => ({}) as Record<string, HeadingNode[]>),
    readSectionByHeading: vi.fn(
      async (fileId: string, headingSlug: string): Promise<SectionReadResult> => ({
        fileId,
        headingSlug,
        breadcrumb: `${fileId} > ${headingSlug}`,
        contentOrVaultRef: `## ${headingSlug}\nBaseline content for ${fileId}.`,
        isVaultRef: false,
        sectionHash: `hash-${fileId}-${headingSlug}`,
        fileEtag: "etag-1",
        fileVersion: 1,
      }),
    ),
    searchLexicalWithASTBreadcrumb: vi.fn(async () => []),
    mergeSectionThreeWay: vi.fn(
      async (params): Promise<SectionMergeOutcome> => ({
        status: "clean",
        mergedDocumentContent: params.agentProposedSectionContent,
        hunkRange: {
          from: 0,
          to: params.agentProposedSectionContent.length,
          replacementText: params.agentProposedSectionContent,
        },
        diagnostics: [],
      }),
    ),
    createWorkspaceFile: vi.fn(),
    deleteWorkspaceFile: vi.fn(),
    readDecisionLedger: vi.fn(async () => ledgerDoc),
    writeDecisionLedger: vi.fn(async () => ({ etag: "etag-ledger", version: 2 })),
    ...overrides,
  };
}

function createRuntimeContext(
  workspaceProvider: IWorkspaceProvider,
  overrides: Partial<AgentRuntimeContext> = {},
): { ctx: AgentRuntimeContext; events: AgentStreamEvent[] } {
  const events: AgentStreamEvent[] = [];
  const ctx: AgentRuntimeContext = {
    userId: "user-cc",
    workspaceId: "ws-cc",
    threadId: "thread-cc",
    turnId: "turn-cc",
    permissionMode: "semi_auto",
    selectedSystem2ModelId: "google/gemini-3.8-flash",
    workspaceProvider,
    ephemeralVaultPayloads: new Map(),
    liveDocumentSnapshots: new Map(),
    emitSseEvent: (e) => events.push(e),
    abortSignal: new AbortController().signal,
    ...overrides,
  };
  return { ctx, events };
}

describe("Canonical 9-Node Cross-Contract & Regression Suite (Native Graph Engine)", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalJevKey = process.env.JEV_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKeys.mockReturnValue([]);
    mockEvaluateRelationalLinksBatch.mockReset();
    delete process.env.GEMINI_API_KEY;
    delete process.env.JEV_API_KEY;

    mockExecuteStreamingGeneration.mockResolvedValue({
      text: Promise.resolve(
        "## Storage Layer\nMigrated cleanly to the confirmed storage specification.",
      ),
      textStream: (async function* () {
        yield "## Storage Layer\nMigrated cleanly to the confirmed storage specification.";
      })(),
    });
  });

  afterEach(() => {
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    if (originalJevKey !== undefined) {
      process.env.JEV_API_KEY = originalJevKey;
    } else {
      delete process.env.JEV_API_KEY;
    }
  });

  describe("1. Canonical Constants, Aliases & Node 1 Provider Failure Resilience", () => {
    it("preserves canonical step ceiling, JEV scorer model binding, and orchestratorNode alias", () => {
      expect(orchestratorNode).toBe(intentAndScopeRouterNode);
      expect(SEARCH_AGENT_STEP_CEILING).toBe(6);
      expect(DECISION_SCORER_MODEL_ID).toBe(TIER1_DEFAULT_MODEL);
    });

    it("falls back gracefully in Node 1 when listWorkspaceTree and readDecisionLedger reject", async () => {
      const failingProvider = createMockWorkspaceProvider({
        listWorkspaceTree: vi.fn().mockRejectedValue(new Error("Tree read timeout")),
        readDecisionLedger: vi.fn().mockRejectedValue(new Error("Ledger read timeout")),
      });

      const { ctx } = createRuntimeContext(failingProvider);
      const initial = createInitialAgentGraphState({
        user_request: {
          prompt: "Explain the architecture overview",
          workspaceId: "ws-cc",
          turnId: "turn-resilience",
          targetFileIds: ["arch.md"],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
      });

      const result = await intentAndScopeRouterNode(initial, ctx);
      expect(result.status).toBe("COMPLETED");

      const nextState = applyStateDelta(initial, result.stateDelta);
      expect(nextState.master_ledger).toEqual({});
      expect(nextState.project_taxonomy).toBeNull();
      expect(nextState.classified_intent).toBe("WORKSPACE_READ_SEARCH");
      expect(nextState.local_inspection_state).toEqual(["arch.md"]);
      expect(nextState.messages).toHaveLength(1);
    });
  });

  describe("2. Cross-Contract Anti-Domino Override Confirmation -> Rescore -> Commit -> Mutate", () => {
    it("routes Node 4 ESCALATE_TO_HITL -> G-04 -> Node 6 INTERRUPTED -> confirm_override -> gateAfterHitlClarification -> Node 5 -> Node 7 -> G-06 -> Node 8 with zero legacy HTML alignment comments (BUG-03)", async () => {
      const priorRoot = createHeavyPriorDecision("dec_db_root");
      const child1: DecisionGraphNode = {
        ...priorRoot,
        decisionId: "dec_child_1",
        topicSlug: "cache_invalidation",
        dependsOn: ["dec_db_root"],
        dependedBy: [],
        affectedSections: [{ fileId: "arch.md", headingSlug: "storage-layer" }],
      };
      const child2: DecisionGraphNode = {
        ...priorRoot,
        decisionId: "dec_child_2",
        topicSlug: "sync_checkpointing",
        dependsOn: ["dec_db_root"],
        dependedBy: [],
        affectedSections: [{ fileId: "sync.md", headingSlug: "persistence" }],
      };

      const directOverrideAssumption: AnalyzedAssumptionItem = {
        assumptionId: "asmp_override_db",
        statement: "Replace PostgreSQL with embedded SQLite storage engine",
        intentType: "DIRECT_USER_INSTRUCTION",
        conceptTags: ["data_modeling", "system_architecture"],
        affectedSections: [{ fileId: "arch.md", headingSlug: "storage-layer" }],
        dependsOn: [],
        candidateDecisionIds: ["dec_db_root"],
        neutralOptions: [
          {
            optionKey: "embedded_sqlite",
            neutralSummary: "Switch storage to embedded SQLite",
            technicalConstraints: ["Local single-writer lock"],
          },
          {
            optionKey: "hybrid_postgres_sqlite",
            neutralSummary: "Maintain PostgreSQL cloud with SQLite local cache",
            technicalConstraints: ["Dual schema maintenance"],
          },
          {
            optionKey: "retain_postgres",
            neutralSummary: "Keep PostgreSQL on Neon as sole persistence engine",
            technicalConstraints: ["Requires network for cloud writes"],
          },
        ],
      };

      mockEvaluateRelationalLinksBatch.mockResolvedValueOnce([
        {
          assumptionId: "asmp_override_db",
          targetDecisionId: "dec_db_root",
          relationType: "REOPENS_OR_OVERRIDES",
          confidence: 0.96,
          justification: "Direct user request replaces primary database engine.",
        },
      ]);

      const provider = createMockWorkspaceProvider();
      const { ctx, events } = createRuntimeContext(provider);

      let state = createInitialAgentGraphState({
        classified_intent: "CONFLICTING_OVERRIDE",
        user_request: {
          prompt: "Replace PostgreSQL with embedded SQLite",
          workspaceId: "ws-cc",
          turnId: "turn-antidomino",
          targetFileIds: ["arch.md"],
          permissionMode: "semi_auto",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
        assumptions: [directOverrideAssumption],
        master_ledger: {
          dec_db_root: priorRoot,
          dec_child_1: child1,
          dec_child_2: child2,
        },
      });

      // Step A: Node 4 triggers Anti-Domino ESCALATE_TO_HITL
      const res4 = await conflictAndWeightGateNode(state, ctx);
      expect(res4.status).toBe("COMPLETED");
      state = applyStateDelta(state, res4.stateDelta);
      expect(state.question_queue).not.toBeNull();
      expect(gateG04(state)).toBe(HITL_CLARIFICATION_NODE);

      // Step B: Node 6 interrupts with ANTI_DOMINO_CONFIRMATION_REQUIRED
      const res6Interrupt = await hitlClarificationNode(state, ctx);
      expect(res6Interrupt.status).toBe("INTERRUPTED");
      if (res6Interrupt.status !== "INTERRUPTED") {
        expect.fail("Expected ANTI_DOMINO_CONFIRMATION_REQUIRED interrupt");
      }
      expect(res6Interrupt.interruptReason).toBe("ANTI_DOMINO_CONFIRMATION_REQUIRED");
      state = applyStateDelta(state, res6Interrupt.stateDelta);

      const antiDominoQuestionId = state.question_queue!.questions[0].questionId;

      // Step C: User confirms override on resumption -> gateAfterHitlClarification routes to Node 5
      state = applyStateDelta(state, {
        clarification_answers: {
          answers: [
            {
              questionId: antiDominoQuestionId,
              selectedOptionKey: "confirm_override",
            },
          ],
        },
      });
      const res6Resume = await hitlClarificationNode(state, ctx);
      expect(res6Resume.status).toBe("COMPLETED");
      state = applyStateDelta(state, res6Resume.stateDelta);
      expect(state.question_queue).toBeNull();
      expect(gateAfterHitlClarification(state)).toBe(JEV_CONFORMAL_SCORER_NODE);

      // Step D: Node 5 scores the confirmed override assumption
      const res5 = await rawJevConformalScorerNode(state, ctx);
      expect(res5.status).toBe("COMPLETED");
      state = applyStateDelta(state, res5.stateDelta);
      expect(state.scored_decisions.length).toBeGreaterThan(0);

      // Step E: Node 7 commits decisions.ledger.json & computes invalidation_map
      const res7 = await ledgerCommitNode(state, ctx);
      expect(res7.status).toBe("COMPLETED");
      state = applyStateDelta(state, res7.stateDelta);
      expect(provider.writeDecisionLedger).toHaveBeenCalledTimes(1);
      expect(gateG06(state)).toBe(WORKSPACE_MUTATOR_NODE);

      // Step F: Node 8 mutates invalidated sections without legacy HTML comment markers (BUG-03)
      const res8 = await rawWorkspaceMutatorNode(state, ctx);
      expect(res8.status).toBe("COMPLETED");
      state = applyStateDelta(state, res8.stateDelta);
      expect(state.invalidation_map).toEqual({});
      expect(provider.mergeSectionThreeWay).toHaveBeenCalled();

      const mergeCalls = vi.mocked(provider.mergeSectionThreeWay).mock.calls;
      for (const [callArg] of mergeCalls) {
        expect(callArg.agentProposedSectionContent).not.toContain(
          "<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->",
        );
        expect(callArg.agentProposedSectionContent).not.toContain(
          "<!-- END:AGENT_DECISION_ALIGNMENT -->",
        );
      }
      expect(events.some((e) => e.type === "file_mutated")).toBe(true);
    });
  });
});
