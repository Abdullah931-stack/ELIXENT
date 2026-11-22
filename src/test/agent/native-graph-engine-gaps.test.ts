/**
 * Phase 6 (Wave 6.1) — Native Graph Engine Gap-Closure Tests
 *
 * Closes remaining Phase 3-5 uncovered contracts in `src/core/agent/graph.ts` & `runner.ts`
 * without duplicating `langgraph-orchestration.test.ts`:
 * 1. End-to-end execution paths for the remaining 5 `InputIntentCategory` values:
 *    `DECISION_LEDGER_QUERY`, `NEW_DOC_DRAFTING`, `CONFLICTING_OVERRIDE`,
 *    `FILE_STRUCTURE_MUTATION`, and `COMPOUND_MULTI_INTENT`.
 * 2. End-to-end Gate `G-03..G-06` edge branches through `createElixentAgentGraph()`:
 *    - `G-03` zero assumptions + empty invalidation_map -> `WORKSPACE_MUTATOR_NODE` -> END
 *    - `G-04` `CONSTRAINED_BY_PRIOR` -> `JEV_CONFORMAL_SCORER_NODE` vs `ESCALATE_TO_HITL` -> `HITL_CLARIFICATION_NODE`
 *    - `G-06` no pending mutations (`targetFileIds: []`, empty `invalidation_map` & `pending_file_actions`) -> `DIRECT_RESPONSE_NODE` -> END
 * 3. `INSUFFICIENT_CREDITS` full checkpoint pause, zero-leak encrypted blob verification,
 *    and complete resumption to `END` once credits are topped up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createElixentAgentGraph,
  INTENT_AND_SCOPE_ROUTER_NODE,
  SEARCH_DISCOVERY_NODE,
  ASSUMPTION_EXTRACTOR_NODE,
  CONFLICT_AND_WEIGHT_GATE_NODE,
  JEV_CONFORMAL_SCORER_NODE,
  HITL_CLARIFICATION_NODE,
  LEDGER_COMMIT_NODE,
  WORKSPACE_MUTATOR_NODE,
  DIRECT_RESPONSE_NODE,
} from "@/core/agent/graph";
import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  AgentStreamEvent,
  ElixentNativeGraphRunner,
  GraphStreamYield,
} from "@/core/agent/engine/runner";
import {
  createInitialAgentGraphState,
  type AgentGraphState,
} from "@/core/agent/state";
import { isEncryptedCheckpointEnvelope } from "@/core/agent/checkpoint-serializer";
import type {
  DecisionLedgerDocument,
  HeadingNode,
  IWorkspaceProvider,
  LexicalMatchResult,
  SectionMergeOutcome,
  SectionReadResult,
  WorkspaceTreeEntry,
} from "@/core/workspace/provider";
import type { DecisionGraphNode } from "@/core/agent/atms/dag";

interface PersistedCheckpointRow {
  threadId: string;
  stepIndex: number;
  workspaceId: string;
  userId: string;
  nodeId: string;
  status: "RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED";
  nextNodeId: string | null;
  interruptReason:
    | "HITL_CLARIFICATION_REQUIRED"
    | "FILE_DELETION_APPROVAL_REQUIRED"
    | "ANTI_DOMINO_CONFIRMATION_REQUIRED"
    | "INSUFFICIENT_CREDITS"
    | null;
  encryptedStateBlob: Buffer;
}

const {
  checkpointRows,
  creditGateControl,
  mockExecuteStreamingGeneration,
  mockExecuteStructuredGeneration,
  mockExecuteToolAgentGeneration,
  mockGetApiKeys,
} = vi.hoisted(() => ({
  checkpointRows: new Map<string, PersistedCheckpointRow>(),
  creditGateControl: {
    failOnNodeId: null as string | null,
    availableMicro: 0,
    requiredMicro: 500_000,
  },
  mockExecuteStreamingGeneration: vi.fn(),
  mockExecuteStructuredGeneration: vi.fn(),
  mockExecuteToolAgentGeneration: vi.fn(),
  mockGetApiKeys: vi.fn<() => string[]>(),
}));

function extractSqlStringParams(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  if ("value" in record && typeof record.value === "string") {
    out.push(record.value);
    return out;
  }
  if (Array.isArray(record.queryChunks)) {
    for (const chunk of record.queryChunks) {
      extractSqlStringParams(chunk, out);
    }
  }
  return out;
}

vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  const mockDb = {
    insert: vi.fn(() => ({
      values: (row: PersistedCheckpointRow) => ({
        onConflictDoUpdate: async (opts: { set: Partial<PersistedCheckpointRow> }) => {
          const key = `${row.threadId}::${row.stepIndex}`;
          const existing = checkpointRows.get(key);
          checkpointRows.set(key, existing ? { ...existing, ...opts.set } : { ...row });
        },
      }),
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: (predicate: unknown) => {
          const [workspaceId, threadId] = extractSqlStringParams(predicate);
          return {
            orderBy: () => ({
              limit: async (limitCount: number) => {
                const matching = Array.from(checkpointRows.values())
                  .filter(
                    (row) =>
                      (!workspaceId || row.workspaceId === workspaceId) &&
                      (!threadId || row.threadId === threadId),
                  )
                  .sort((a, b) => b.stepIndex - a.stepIndex);
                return matching.slice(0, limitCount);
              },
            }),
          };
        },
      }),
    })),
  };
  return { ...actual, db: mockDb };
});

vi.mock("@/lib/ai/client", () => ({
  executeStreamingGeneration: mockExecuteStreamingGeneration,
  executeStructuredGeneration: mockExecuteStructuredGeneration,
  executeToolAgentGeneration: mockExecuteToolAgentGeneration,
}));

vi.mock("@/lib/ai/key-rotation", () => ({
  getApiKeys: mockGetApiKeys,
}));

vi.mock("@/lib/metering/node-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metering/node-gate")>();
  return {
    ...actual,
    withMeteredNodeGate: (
      nodeName: string,
      _modelId: string,
      nodeFn: AgentGraphNodeFn,
    ): AgentGraphNodeFn => {
      return async (state, ctx) => {
        if (creditGateControl.failOnNodeId === nodeName) {
          return {
            status: "INTERRUPTED",
            interruptReason: "INSUFFICIENT_CREDITS",
            stateDelta: {},
            interruptPayload: {
              availableMicro: creditGateControl.availableMicro,
              requiredMicro: creditGateControl.requiredMicro,
            },
          };
        }
        return nodeFn(state, ctx);
      };
    },
  };
});

function createMockWorkspaceProvider(
  ledgerNodes: DecisionLedgerDocument["nodes"] = {},
): IWorkspaceProvider {
  const workspaceId = "ws-gap-tests";
  const tree: WorkspaceTreeEntry[] = [
    {
      fileId: "cache.md",
      parentFolderId: null,
      title: "Caching Architecture",
      relativePath: "docs/cache.md",
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document",
      etag: "etag-cache-1",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
  ];

  const ledgerDoc: DecisionLedgerDocument = {
    schemaVersion: "2.0.0",
    workspaceId,
    updatedAt: "2026-11-20T00:00:00.000Z",
    decisions: {},
    nodes: ledgerNodes,
    edges: [],
    taxonomy: null,
  };

  return {
    workspaceId,
    userId: "user-gap-tests",
    listWorkspaceTree: vi.fn(async () => tree),
    listHeadingsTree: vi.fn(async (fileIds: string[] = []) => {
      const res: Record<string, HeadingNode[]> = {};
      for (const fileId of fileIds) {
        res[fileId] = [
          {
            headingSlug: "architecture-overview",
            title: "Architecture Overview",
            level: 2,
            breadcrumb: "Architecture Overview",
            startLine: 1,
            endLine: 15,
            startOffset: 0,
            endOffset: 300,
            contentHash: "a".repeat(64),
          },
        ];
      }
      return res;
    }),
    readSectionByHeading: vi.fn(
      async (fileId: string, headingSlug: string): Promise<SectionReadResult> => ({
        fileId,
        headingSlug,
        breadcrumb: `${fileId} > ${headingSlug}`,
        contentOrVaultRef: `## Architecture Overview\nBaseline content for ${fileId}#${headingSlug}.`,
        isVaultRef: false,
        sectionHash: `hash_${fileId}_${headingSlug}`,
        fileEtag: "etag-1",
        fileVersion: 1,
      }),
    ),
    searchLexicalWithASTBreadcrumb: vi.fn(
      async (params: { fileIds?: string[] }): Promise<LexicalMatchResult[]> =>
        (params.fileIds ?? []).map((fileId) => ({
          fileId,
          fileName: fileId,
          headingSlug: "architecture-overview",
          headingBreadcrumb: "Architecture Overview",
          matchedExcerpt: `Matched ${fileId}`,
          lineRange: [1, 5] as [number, number],
          bm25Score: 0.9,
        })),
    ),
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
    createWorkspaceFile: vi.fn(async ({ relativePath }) => ({
      fileId: "created-file-id",
      parentFolderId: null,
      title: relativePath,
      relativePath,
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document" as const,
      etag: "etag-new-1",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    })),
    deleteWorkspaceFile: vi.fn(async ({ fileId }) => ({
      fileId,
      deletedAt: "2026-11-20T00:00:00.000Z",
    })),
    readDecisionLedger: vi.fn(async () => ledgerDoc),
    writeDecisionLedger: vi.fn(async () => ({ etag: "etag-ledger-2", version: 2 })),
  };
}

function createRuntimeContext(
  workspaceProvider: IWorkspaceProvider,
  overrides: Partial<AgentRuntimeContext> = {},
): { ctx: AgentRuntimeContext; events: AgentStreamEvent[] } {
  const events: AgentStreamEvent[] = [];
  const ctx: AgentRuntimeContext = {
    userId: "user-gap-tests",
    workspaceId: workspaceProvider.workspaceId,
    threadId: "thread-gap-default",
    turnId: "turn-gap-1",
    permissionMode: "safe",
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

async function collectGraphStream(
  runner: ElixentNativeGraphRunner,
  input: Parameters<ElixentNativeGraphRunner["stream"]>[0],
  ctx: AgentRuntimeContext,
): Promise<{ yields: GraphStreamYield[]; finalState: AgentGraphState }> {
  const yields: GraphStreamYield[] = [];
  const gen = runner.stream(input, ctx);
  let next = await gen.next();
  while (!next.done) {
    yields.push(next.value);
    next = await gen.next();
  }
  return { yields, finalState: next.value };
}

function makePriorCacheNode(
  overrides: Partial<DecisionGraphNode> = {},
): DecisionGraphNode {
  return {
    decisionId: "dec_cache_prior",
    topicSlug: "caching_backend",
    questionPrompt: "Which cache backend should be used?",
    conceptTags: ["system_architecture", "caching"],
    selectedOptionKey: "redis_cluster",
    selectionRationale: "High throughput distributed cache.",
    runnerUpOptionKey: "in_memory",
    evaluatedAlternatives: [],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
    provenance: "USER_EXPLICIT_HITL",
    couplingLevel: 1.8,
    rollbackCost: 1.8,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [{ fileId: "cache.md", headingSlug: "architecture-overview" }],
    ...overrides,
  };
}

describe("Elixent Native Graph Engine — Phase 6 Gap-Closure Suite", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalJevKey = process.env.JEV_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    checkpointRows.clear();
    creditGateControl.failOnNodeId = null;
    creditGateControl.availableMicro = 0;
    creditGateControl.requiredMicro = 500_000;
    mockGetApiKeys.mockReturnValue([]);
    mockExecuteStructuredGeneration.mockReset();
    delete process.env.GEMINI_API_KEY;
    delete process.env.JEV_API_KEY;

    mockExecuteStreamingGeneration.mockResolvedValue({
      text: Promise.resolve("## Architecture Overview\nUpdated specification section."),
      textStream: (async function* () {
        yield "## Architecture Overview\nUpdated specification section.";
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

  describe("1. Remaining 5 InputIntentCategory End-to-End Paths", () => {
    it("executes DECISION_LEDGER_QUERY path: Node 1 -> Node 2 -> G-02 -> Node 9 -> END", async () => {
      const provider = createMockWorkspaceProvider({
        dec_cache_prior: makePriorCacheNode(),
      });
      const { ctx } = createRuntimeContext(provider, { threadId: "th-ledger-query" });
      const runner = createElixentAgentGraph();

      const { yields, finalState } = await collectGraphStream(
        runner,
        createInitialAgentGraphState({
          user_request: {
            prompt: "Why did we choose the current decision ledger caching strategy?",
            workspaceId: provider.workspaceId,
            turnId: "turn-lq-1",
            targetFileIds: ["cache.md"],
            permissionMode: "safe",
            selectedSystem2ModelId: "google/gemini-3.8-flash",
          },
        }),
        ctx,
      );

      expect(finalState.classified_intent).toBe("DECISION_LEDGER_QUERY");
      expect(yields.map((y) => y.nodeId)).toEqual([
        INTENT_AND_SCOPE_ROUTER_NODE,
        SEARCH_DISCOVERY_NODE,
        DIRECT_RESPONSE_NODE,
      ]);
      expect(provider.writeDecisionLedger).not.toHaveBeenCalled();
      expect(provider.mergeSectionThreeWay).not.toHaveBeenCalled();
      expect(finalState.messages.some((m) => m.role === "assistant")).toBe(true);
    });

    it.each([
      {
        intent: "NEW_DOC_DRAFTING" as const,
        prompt: "Draft a new specification document for billing architecture",
        threadId: "th-new-doc",
      },
      {
        intent: "FILE_STRUCTURE_MUTATION" as const,
        prompt: "Create file docs/glossary.md for shared domain terms",
        threadId: "th-file-struct",
      },
      {
        intent: "COMPOUND_MULTI_INTENT" as const,
        prompt: "Create file docs/events.md and update architecture spec",
        threadId: "th-compound",
      },
    ])(
      "executes $intent through the full 8-node pipeline to END",
      async ({ intent, prompt, threadId }) => {
        const provider = createMockWorkspaceProvider();
        const { ctx } = createRuntimeContext(provider, { threadId });
        const runner = createElixentAgentGraph();

        const { yields, finalState } = await collectGraphStream(
          runner,
          createInitialAgentGraphState({
            user_request: {
              prompt,
              workspaceId: provider.workspaceId,
              turnId: `turn-${intent}`,
              targetFileIds: ["cache.md"],
              permissionMode: "safe",
              selectedSystem2ModelId: "google/gemini-3.8-flash",
            },
          }),
          ctx,
        );

        expect(finalState.classified_intent).toBe(intent);
        expect(yields.map((y) => y.nodeId)).toEqual([
          INTENT_AND_SCOPE_ROUTER_NODE,
          SEARCH_DISCOVERY_NODE,
          ASSUMPTION_EXTRACTOR_NODE,
          CONFLICT_AND_WEIGHT_GATE_NODE,
          JEV_CONFORMAL_SCORER_NODE,
          LEDGER_COMMIT_NODE,
          WORKSPACE_MUTATOR_NODE,
        ]);
        expect(provider.writeDecisionLedger).toHaveBeenCalledTimes(1);
      },
    );

    it("executes CONFLICTING_OVERRIDE path and triggers Anti-Domino HITL escalation against high-weight prior", async () => {
      const provider = createMockWorkspaceProvider({
        dec_cache_prior: makePriorCacheNode(),
      });
      const { ctx } = createRuntimeContext(provider, { threadId: "th-conflict-override" });
      const runner = createElixentAgentGraph();

      const { yields, finalState } = await collectGraphStream(
        runner,
        createInitialAgentGraphState({
          user_request: {
            prompt: "Override and switch from Redis caching architecture in cache.md",
            workspaceId: provider.workspaceId,
            turnId: "turn-override-1",
            targetFileIds: ["cache.md"],
            permissionMode: "safe",
            selectedSystem2ModelId: "google/gemini-3.8-flash",
          },
        }),
        ctx,
      );

      expect(finalState.classified_intent).toBe("CONFLICTING_OVERRIDE");
      expect(yields.map((y) => [y.nodeId, y.status])).toEqual([
        [INTENT_AND_SCOPE_ROUTER_NODE, "COMPLETED"],
        [SEARCH_DISCOVERY_NODE, "COMPLETED"],
        [ASSUMPTION_EXTRACTOR_NODE, "COMPLETED"],
        [CONFLICT_AND_WEIGHT_GATE_NODE, "COMPLETED"],
        [HITL_CLARIFICATION_NODE, "INTERRUPTED"],
      ]);
      expect(yields[yields.length - 1].interruptReason).toBe(
        "ANTI_DOMINO_CONFIRMATION_REQUIRED",
      );
    });
  });

  describe("2. Gate G-03, G-04 & G-06 End-to-End Edge Branches", () => {
    it("G-03: skips Nodes 4, 5, 7 straight to WORKSPACE_MUTATOR_NODE when Node 3 produces zero assumptions and empty invalidation_map", async () => {
      const provider = createMockWorkspaceProvider();
      const runner = createElixentAgentGraph();
      const threadId = "th-g03-empty";

      // Seed an interrupted checkpoint at ASSUMPTION_EXTRACTOR_NODE with empty prompt
      // so Node 3 extracts 0 assumptions without heuristic prompt fallback.
      creditGateControl.failOnNodeId = ASSUMPTION_EXTRACTOR_NODE;
      const pass1 = createRuntimeContext(provider, { threadId, turnId: "turn-g03-1" });
      await collectGraphStream(
        runner,
        createInitialAgentGraphState({
          user_request: {
            prompt: "Draft a new specification document",
            workspaceId: provider.workspaceId,
            turnId: "turn-g03-1",
            targetFileIds: ["cache.md"],
            permissionMode: "safe",
            selectedSystem2ModelId: "google/gemini-3.8-flash",
          },
        }),
        pass1.ctx,
      );

      creditGateControl.failOnNodeId = null;
      const pass2 = createRuntimeContext(provider, { threadId, turnId: "turn-g03-2" });
      const { yields } = await collectGraphStream(
        runner,
        {
          resumeFromCheckpoint: true,
          stateOverrides: {
            user_request: {
              prompt: "",
              workspaceId: provider.workspaceId,
              turnId: "turn-g03-2",
              targetFileIds: ["cache.md"],
              permissionMode: "safe",
              selectedSystem2ModelId: "google/gemini-3.8-flash",
            },
          },
        },
        pass2.ctx,
      );

      expect(yields.map((y) => y.nodeId)).toEqual([
        ASSUMPTION_EXTRACTOR_NODE,
        WORKSPACE_MUTATOR_NODE,
      ]);
      expect(provider.writeDecisionLedger).not.toHaveBeenCalled();
    });

    it("G-04: CONSTRAINED_BY_PRIOR suppresses collateral assumption without HITL and routes to JEV_CONFORMAL_SCORER_NODE", async () => {
      mockGetApiKeys.mockReturnValue(["test-gemini-key"]);
      mockExecuteStructuredGeneration
        .mockResolvedValueOnce({
          object: {
            intentCategory: "ARCHITECTURAL_MODIFICATION",
            rationale: "Architecture edit",
          },
        })
        .mockResolvedValueOnce({
          object: {
            assumptions: [
              {
                assumptionId: "asmp_collateral",
                statement: "Override and switch from Redis to local in-memory cache",
                intentType: "INFERRED_COLLATERAL_ASSUMPTION",
                conceptTags: ["system_architecture", "caching"],
                affectedSections: [
                  { fileId: "cache.md", headingSlug: "architecture-overview" },
                ],
                dependsOn: [],
              },
            ],
            pendingFileActions: [],
          },
        });

      const provider = createMockWorkspaceProvider({
        dec_cache_prior: makePriorCacheNode(),
      });
      const { ctx } = createRuntimeContext(provider, { threadId: "th-g04-constrained" });
      const runner = createElixentAgentGraph();

      const { yields, finalState } = await collectGraphStream(
        runner,
        createInitialAgentGraphState({
          user_request: {
            prompt: "Update caching section",
            workspaceId: provider.workspaceId,
            turnId: "turn-g04-c",
            targetFileIds: ["cache.md"],
            permissionMode: "safe",
            selectedSystem2ModelId: "google/gemini-3.8-flash",
          },
        }),
        ctx,
      );

      expect(yields.map((y) => y.nodeId)).toEqual([
        INTENT_AND_SCOPE_ROUTER_NODE,
        SEARCH_DISCOVERY_NODE,
        ASSUMPTION_EXTRACTOR_NODE,
        CONFLICT_AND_WEIGHT_GATE_NODE,
        JEV_CONFORMAL_SCORER_NODE,
        LEDGER_COMMIT_NODE,
        WORKSPACE_MUTATOR_NODE,
      ]);
      expect(finalState.question_queue).toBeNull();
      expect(finalState.governing_constraints.map((c) => c.decisionId)).toContain(
        "dec_cache_prior",
      );
    });

    it("G-06: routes from LEDGER_COMMIT_NODE to DIRECT_RESPONSE_NODE (Node 9) when no .md mutations or file actions are pending", async () => {
      mockGetApiKeys.mockReturnValue(["test-gemini-key"]);
      mockExecuteStructuredGeneration
        .mockResolvedValueOnce({
          object: {
            intentCategory: "ARCHITECTURAL_MODIFICATION",
            rationale: "Conceptual decision without target markdown files.",
          },
        })
        .mockResolvedValueOnce({
          object: {
            assumptions: [
              {
                assumptionId: "asmp_conceptual",
                statement: "Standardize on UTC timestamps across services",
                intentType: "DIRECT_USER_INSTRUCTION",
                conceptTags: ["api_design"],
                affectedSections: [],
                dependsOn: [],
              },
            ],
            pendingFileActions: [],
          },
        });

      const provider = createMockWorkspaceProvider();
      const { ctx } = createRuntimeContext(provider, { threadId: "th-g06-no-mut" });
      const runner = createElixentAgentGraph();

      const { yields, finalState } = await collectGraphStream(
        runner,
        createInitialAgentGraphState({
          user_request: {
            prompt: "Record architectural decision to standardize on UTC timestamps",
            workspaceId: provider.workspaceId,
            turnId: "turn-g06",
            targetFileIds: [],
            permissionMode: "safe",
            selectedSystem2ModelId: "google/gemini-3.8-flash",
          },
        }),
        ctx,
      );

      expect(yields.map((y) => y.nodeId)).toEqual([
        INTENT_AND_SCOPE_ROUTER_NODE,
        SEARCH_DISCOVERY_NODE,
        ASSUMPTION_EXTRACTOR_NODE,
        CONFLICT_AND_WEIGHT_GATE_NODE,
        JEV_CONFORMAL_SCORER_NODE,
        LEDGER_COMMIT_NODE,
        DIRECT_RESPONSE_NODE,
      ]);
      expect(provider.writeDecisionLedger).toHaveBeenCalledTimes(1);
      expect(provider.mergeSectionThreeWay).not.toHaveBeenCalled();
      expect(finalState.messages.some((m) => m.role === "assistant")).toBe(true);
    });
  });

  describe("3. INSUFFICIENT_CREDITS Checkpoint Pause, Zero-Leak Encryption & Full Resumption", () => {
    it("pauses at SEARCH_DISCOVERY_NODE with encrypted zero-leak checkpoint and resumes to END after credit top-up", async () => {
      const secretPrompt = "TOP_SECRET_ARCHITECTURAL_CHANGE_TOKEN_9912";
      creditGateControl.failOnNodeId = SEARCH_DISCOVERY_NODE;
      creditGateControl.availableMicro = 100;
      creditGateControl.requiredMicro = 400_000;

      const provider = createMockWorkspaceProvider();
      const runner = createElixentAgentGraph();
      const threadId = "th-credit-resume-e2e";

      // Pass 1: Pauses at SEARCH_DISCOVERY_NODE
      const pass1 = createRuntimeContext(provider, { threadId, turnId: "turn-cr-1" });
      const { yields: yields1 } = await collectGraphStream(
        runner,
        createInitialAgentGraphState({
          user_request: {
            prompt: `Update architecture design: ${secretPrompt}`,
            workspaceId: provider.workspaceId,
            turnId: "turn-cr-1",
            targetFileIds: ["cache.md"],
            permissionMode: "safe",
            selectedSystem2ModelId: "google/gemini-3.8-flash",
          },
        }),
        pass1.ctx,
      );

      expect(yields1.map((y) => [y.nodeId, y.status])).toEqual([
        [INTENT_AND_SCOPE_ROUTER_NODE, "COMPLETED"],
        [SEARCH_DISCOVERY_NODE, "INTERRUPTED"],
      ]);
      expect(yields1[1].interruptReason).toBe("INSUFFICIENT_CREDITS");

      // Zero-leak encrypted checkpoint check: stored Buffer must be an encrypted envelope with zero plaintext leak
      const storedRows = Array.from(checkpointRows.values()).filter(
        (r) => r.threadId === threadId,
      );
      expect(storedRows.length).toBeGreaterThan(0);
      for (const row of storedRows) {
        const rawText = row.encryptedStateBlob.toString("utf8");
        expect(isEncryptedCheckpointEnvelope(JSON.parse(rawText))).toBe(true);
        expect(rawText).not.toContain(secretPrompt);
      }

      // Pass 2: Credits topped up -> resumeFromCheckpoint: true completes from SEARCH_DISCOVERY_NODE to END
      creditGateControl.failOnNodeId = null;
      const pass2 = createRuntimeContext(provider, { threadId, turnId: "turn-cr-2" });
      const { yields: yields2, finalState } = await collectGraphStream(
        runner,
        { resumeFromCheckpoint: true },
        pass2.ctx,
      );

      expect(yields2.map((y) => y.nodeId)).toEqual([
        SEARCH_DISCOVERY_NODE,
        ASSUMPTION_EXTRACTOR_NODE,
        CONFLICT_AND_WEIGHT_GATE_NODE,
        JEV_CONFORMAL_SCORER_NODE,
        LEDGER_COMMIT_NODE,
        WORKSPACE_MUTATOR_NODE,
      ]);
      expect(yields2.every((y) => y.status === "COMPLETED")).toBe(true);
      expect(finalState.user_request.prompt).toContain(secretPrompt);
      expect(provider.writeDecisionLedger).toHaveBeenCalledTimes(1);
    });
  });
});
