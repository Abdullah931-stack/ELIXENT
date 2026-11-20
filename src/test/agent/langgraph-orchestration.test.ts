/**
 * Cross-Contract Integration Test Suite: Elixent Native Graph Engine Assembly (`src/core/agent/graph.ts`)
 *
 * Verifies ADR-009, ADR-010, ADR-012, ADR-013, ADR-014 & SRS-01 §3.1–§3.2 across real internal seams:
 * 1. Canonical 9-Node Registry, `elixentAgentGraph` singleton, and `maxSuperSteps: 25` invariant.
 * 2. All 6 Deterministic State-Predicate Routing Gates (`gateG01..gateG06`) + `gateAfterHitlClarification`.
 * 3. End-to-End Native Graph Execution Paths through real `createElixentAgentGraph()`:
 *    - `CHAT_ONLY`: Node 1 -> G-01 -> Node 9 -> END
 *    - `WORKSPACE_READ_SEARCH` / `DECISION_LEDGER_QUERY`: Node 1 -> G-01 -> Node 2 -> G-02 -> Node 9 -> END
 *    - `FAST_LOCAL_EDIT`: Node 1 -> G-01 -> Node 2 -> G-02 -> Node 8 -> END
 *    - Full Architectural Flow: Node 1 -> Node 2 -> Node 3 -> Node 4 -> Node 5 -> G-05 -> Node 7 -> G-06 -> Node 8 -> END
 * 4. Native HITL Clarification Interrupt & Encrypted Checkpoint Resumption (`resumeFromCheckpoint: true`).
 * 5. Financial Gate (`INSUFFICIENT_CREDITS`) Native Interruption (`BUG-06` regression).
 * 6. Multi-Thread Encrypted Checkpoint Isolation & `loadLatestCheckpoint` Decryption.
 *
 * Only true external I/O boundaries (`@/server/db`, `@/lib/ai/client`, `@/lib/ai/key-rotation`,
 * `@/lib/jev/client`, and Redis metering via `@/lib/metering/node-gate`) are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createElixentAgentGraph,
  elixentAgentGraph,
  INTENT_AND_SCOPE_ROUTER_NODE,
  SEARCH_DISCOVERY_NODE,
  ASSUMPTION_EXTRACTOR_NODE,
  CONFLICT_AND_WEIGHT_GATE_NODE,
  JEV_CONFORMAL_SCORER_NODE,
  HITL_CLARIFICATION_NODE,
  LEDGER_COMMIT_NODE,
  WORKSPACE_MUTATOR_NODE,
  DIRECT_RESPONSE_NODE,
  gateG01,
  gateG02,
  gateG03,
  gateG04,
  gateG05,
  gateAfterHitlClarification,
  gateG06,
} from "@/core/agent/graph";
import {
  ElixentNativeGraphRunner,
  type AgentGraphNodeFn,
  type AgentRuntimeContext,
  type AgentStreamEvent,
  type GraphStreamYield,
} from "@/core/agent/engine/runner";
import {
  createInitialAgentGraphState,
  type AgentGraphState,
  type InputIntentCategory,
  type PendingFileLifecycleAction,
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
import type { StreamGovernor } from "@/lib/metering/stream-governor";

// ---------------------------------------------------------------------------
// Hoisted In-Memory External Boundary Stubs (Postgres Checkpoints, AI, JEV, Credit Gate)
// ---------------------------------------------------------------------------

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
  mockEvaluateDecisionBatch,
} = vi.hoisted(() => {
  const checkpointRows = new Map<string, PersistedCheckpointRow>();
  const creditGateControl = {
    failOnNodeId: null as string | null,
    availableMicro: 0,
    requiredMicro: 500_000,
  };
  return {
    checkpointRows,
    creditGateControl,
    mockExecuteStreamingGeneration: vi.fn(),
    mockExecuteStructuredGeneration: vi.fn(),
    mockExecuteToolAgentGeneration: vi.fn(),
    mockGetApiKeys: vi.fn<() => string[]>(),
    mockEvaluateDecisionBatch: vi.fn(),
  };
});

/**
 * Extracts string parameter values from a Drizzle SQL predicate tree (`and(eq(...), eq(...))`)
 * so the in-memory `agentCheckpoints` table filters by the real `(workspaceId, threadId)` arguments.
 */
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
          const params = extractSqlStringParams(predicate);
          const [workspaceId, threadId] = params;
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

  return {
    ...actual,
    db: mockDb,
  };
});

vi.mock("@/lib/ai/client", () => ({
  executeStreamingGeneration: mockExecuteStreamingGeneration,
  executeStructuredGeneration: mockExecuteStructuredGeneration,
  executeToolAgentGeneration: mockExecuteToolAgentGeneration,
}));

vi.mock("@/lib/ai/key-rotation", () => ({
  getApiKeys: mockGetApiKeys,
}));

vi.mock("@/lib/jev/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jev/client")>();
  return {
    ...actual,
    evaluateDecisionBatch: (...args: Parameters<typeof actual.evaluateDecisionBatch>) => {
      if (mockEvaluateDecisionBatch.getMockImplementation()) {
        return mockEvaluateDecisionBatch(...args);
      }
      return actual.evaluateDecisionBatch(...args);
    },
  };
});

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

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function createMockWorkspaceProvider(
  workspaceId = "ws-graph-test",
  overrides: Partial<IWorkspaceProvider> = {},
): IWorkspaceProvider {
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
    {
      fileId: "sync.md",
      parentFolderId: null,
      title: "Sync Protocol",
      relativePath: "docs/sync.md",
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document",
      etag: "etag-sync-1",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
  ];

  const ledgerDoc: DecisionLedgerDocument = {
    schemaVersion: "2.0.0",
    workspaceId,
    updatedAt: "2026-11-20T00:00:00.000Z",
    decisions: {},
    nodes: {},
    edges: [],
    taxonomy: null,
  };

  return {
    workspaceId,
    userId: "user-graph-test",
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
      async (params: { fileIds?: string[]; query: string }): Promise<LexicalMatchResult[]> =>
        (params.fileIds ?? []).map((fileId) => ({
          fileId,
          fileName: fileId,
          headingSlug: "architecture-overview",
          headingBreadcrumb: "Architecture Overview",
          matchedExcerpt: `Excerpt for ${params.query} in ${fileId}`,
          lineRange: [1, 5],
          bm25Score: 1.8,
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
      fileId: `created-${relativePath}`,
      parentFolderId: null,
      title: relativePath,
      relativePath,
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document" as const,
      etag: "etag-created",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    })),
    deleteWorkspaceFile: vi.fn(async ({ fileId }) => ({
      fileId,
      deletedAt: "2026-11-20T00:00:00.000Z",
    })),
    readDecisionLedger: vi.fn(async () => ledgerDoc),
    writeDecisionLedger: vi.fn(async () => ({ etag: "etag-ledger-2", version: 2 })),
    ...overrides,
  };
}

function createRuntimeContext(
  workspaceProvider: IWorkspaceProvider,
  overrides: Partial<AgentRuntimeContext> = {},
): { ctx: AgentRuntimeContext; events: AgentStreamEvent[] } {
  const events: AgentStreamEvent[] = [];
  const ctx: AgentRuntimeContext = {
    userId: "user-graph-test",
    workspaceId: workspaceProvider.workspaceId,
    threadId: "thread-native-default",
    turnId: "turn-native-1",
    permissionMode: "safe",
    selectedSystem2ModelId: "google/gemini-3.8-flash",
    workspaceProvider,
    streamGovernor: {} as StreamGovernor,
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

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe("Elixent Native Graph Engine Assembly & Orchestration (src/core/agent/graph.ts)", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalJevKey = process.env.JEV_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    checkpointRows.clear();
    creditGateControl.failOnNodeId = null;
    creditGateControl.availableMicro = 0;
    creditGateControl.requiredMicro = 500_000;
    mockGetApiKeys.mockReturnValue([]);
    mockEvaluateDecisionBatch.mockReset();
    delete process.env.GEMINI_API_KEY;
    delete process.env.JEV_API_KEY;

    mockExecuteStreamingGeneration.mockResolvedValue({
      text: Promise.resolve("## Architecture Overview\nUpdated architectural specification section."),
      textStream: (async function* () {
        yield "## Architecture Overview\nUpdated architectural specification section.";
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

  // =========================================================================
  // Suite 1: Canonical 9-Node Registry & Runner Factory
  // =========================================================================
  describe("1. Canonical 9-Node Assembly & maxSuperSteps Contract", () => {
    it("exports all 9 canonical node identifiers, default maxSuperSteps: 25, and custom maxSuperSteps override", () => {
      const canonicalIds = [
        INTENT_AND_SCOPE_ROUTER_NODE,
        SEARCH_DISCOVERY_NODE,
        ASSUMPTION_EXTRACTOR_NODE,
        CONFLICT_AND_WEIGHT_GATE_NODE,
        JEV_CONFORMAL_SCORER_NODE,
        HITL_CLARIFICATION_NODE,
        LEDGER_COMMIT_NODE,
        WORKSPACE_MUTATOR_NODE,
        DIRECT_RESPONSE_NODE,
      ];

      expect(new Set(canonicalIds).size).toBe(9);
      expect(elixentAgentGraph).toBeInstanceOf(ElixentNativeGraphRunner);
      expect(elixentAgentGraph.maxSuperSteps).toBe(25);

      const customRunner = createElixentAgentGraph({ maxSuperSteps: 12 });
      expect(customRunner).toBeInstanceOf(ElixentNativeGraphRunner);
      expect(customRunner.maxSuperSteps).toBe(12);
    });
  });

  // =========================================================================
  // Suite 2: Deterministic State-Predicate Routing Gates (G-01..G-06 + HITL)
  // =========================================================================
  describe("2. Deterministic State-Predicate Routing Gates (SRS-01 §3.2)", () => {
    it.each<{ intent: InputIntentCategory | null; expected: string }>([
      { intent: "CHAT_ONLY", expected: DIRECT_RESPONSE_NODE },
      { intent: "WORKSPACE_READ_SEARCH", expected: SEARCH_DISCOVERY_NODE },
      { intent: "DECISION_LEDGER_QUERY", expected: SEARCH_DISCOVERY_NODE },
      { intent: "FAST_LOCAL_EDIT", expected: SEARCH_DISCOVERY_NODE },
      { intent: "NEW_DOC_DRAFTING", expected: SEARCH_DISCOVERY_NODE },
      { intent: "ARCHITECTURAL_MODIFICATION", expected: SEARCH_DISCOVERY_NODE },
      { intent: "CONFLICTING_OVERRIDE", expected: SEARCH_DISCOVERY_NODE },
      { intent: "FILE_STRUCTURE_MUTATION", expected: SEARCH_DISCOVERY_NODE },
      { intent: "COMPOUND_MULTI_INTENT", expected: SEARCH_DISCOVERY_NODE },
      { intent: null, expected: SEARCH_DISCOVERY_NODE },
    ])("gateG01 routes classified_intent=$intent -> $expected", ({ intent, expected }) => {
      const state = createInitialAgentGraphState({ classified_intent: intent });
      expect(gateG01(state)).toBe(expected);
    });

    it.each<{ intent: InputIntentCategory | null; expected: string }>([
      { intent: "WORKSPACE_READ_SEARCH", expected: DIRECT_RESPONSE_NODE },
      { intent: "DECISION_LEDGER_QUERY", expected: DIRECT_RESPONSE_NODE },
      { intent: "FAST_LOCAL_EDIT", expected: WORKSPACE_MUTATOR_NODE },
      { intent: "NEW_DOC_DRAFTING", expected: ASSUMPTION_EXTRACTOR_NODE },
      { intent: "ARCHITECTURAL_MODIFICATION", expected: ASSUMPTION_EXTRACTOR_NODE },
      { intent: "CONFLICTING_OVERRIDE", expected: ASSUMPTION_EXTRACTOR_NODE },
      { intent: "FILE_STRUCTURE_MUTATION", expected: ASSUMPTION_EXTRACTOR_NODE },
      { intent: "COMPOUND_MULTI_INTENT", expected: ASSUMPTION_EXTRACTOR_NODE },
      { intent: null, expected: ASSUMPTION_EXTRACTOR_NODE },
    ])("gateG02 routes classified_intent=$intent -> $expected", ({ intent, expected }) => {
      const state = createInitialAgentGraphState({ classified_intent: intent });
      expect(gateG02(state)).toBe(expected);
    });

    it.each<{ label: string; overrides: Partial<AgentGraphState>; expected: string }>([
      {
        label: "zero assumptions and empty invalidation_map -> workspace_mutator_node",
        overrides: { assumptions: [], invalidation_map: {} },
        expected: WORKSPACE_MUTATOR_NODE,
      },
      {
        label: "non-empty assumptions -> conflict_and_weight_gate_node",
        overrides: {
          assumptions: [
            {
              assumptionId: "a1",
              statement: "Use Postgres",
              conceptTags: ["data_modeling"],
              affectedSections: [],
              dependsOn: [],
            },
          ],
        },
        expected: CONFLICT_AND_WEIGHT_GATE_NODE,
      },
      {
        label: "empty assumptions with non-empty invalidation_map -> conflict_and_weight_gate_node",
        overrides: {
          assumptions: [],
          invalidation_map: { dec_1: [{ fileId: "doc.md", headingSlug: "db" }] },
        },
        expected: CONFLICT_AND_WEIGHT_GATE_NODE,
      },
    ])("gateG03: $label", ({ overrides, expected }) => {
      expect(gateG03(createInitialAgentGraphState(overrides))).toBe(expected);
    });

    it.each([
      {
        label: "Anti-Domino question_queue populated takes priority over evidence gap -> hitl_clarification_node",
        overrides: {
          question_queue: {
            questions: [
              {
                questionId: "antidomino_1",
                topicSlug: "auth",
                questionPrompt: "Confirm override?",
                options: [
                  { optionKey: "preserve_prior", neutralSummary: "Keep" },
                  { optionKey: "confirm_override", neutralSummary: "Override" },
                ],
              },
            ],
          },
          search_loop_count: 1,
          search_report: { evidenceItems: [], inspectedPaths: ["doc.md#sec"], summary: "" },
          assumptions: [
            {
              assumptionId: "a1",
              statement: "Gap",
              conceptTags: [],
              affectedSections: [{ fileId: "missing.md", headingSlug: "intro" }],
              dependsOn: [],
            },
          ],
        },
        expected: HITL_CLARIFICATION_NODE,
      },
      {
        label: "evidence gap with search_loop_count < 3 -> search_discovery_node",
        overrides: {
          search_loop_count: 2,
          search_report: {
            evidenceItems: [
              { fileId: "doc-a.md", headingSlug: "h1", breadcrumb: ["H1"], textExcerpt: "x" },
            ],
            inspectedPaths: ["doc-a.md#h1"],
            summary: "Partial",
          },
          assumptions: [
            {
              assumptionId: "a1",
              statement: "Touches doc-b",
              conceptTags: [],
              affectedSections: [{ fileId: "doc-b.md", headingSlug: "h2" }],
              dependsOn: [],
            },
          ],
        },
        expected: SEARCH_DISCOVERY_NODE,
      },
      {
        label: "evidence gap at MAX_SEARCH_LOOPS ceiling (3) -> jev_conformal_scorer_node",
        overrides: {
          search_loop_count: 3,
          search_report: {
            evidenceItems: [],
            inspectedPaths: ["doc-a.md#h1"],
            summary: "Ceiling reached",
          },
          assumptions: [
            {
              assumptionId: "a1",
              statement: "Touches doc-b",
              conceptTags: [],
              affectedSections: [{ fileId: "doc-b.md", headingSlug: "h2" }],
              dependsOn: [],
            },
          ],
        },
        expected: JEV_CONFORMAL_SCORER_NODE,
      },
      {
        label: "all affected sections covered by evidence -> jev_conformal_scorer_node",
        overrides: {
          search_loop_count: 1,
          search_report: {
            evidenceItems: [
              { fileId: "doc-a.md", headingSlug: "h1", breadcrumb: ["H1"], textExcerpt: "x" },
            ],
            inspectedPaths: ["doc-a.md#h1"],
            summary: "Complete",
          },
          assumptions: [
            {
              assumptionId: "a1",
              statement: "Covered",
              conceptTags: [],
              affectedSections: [{ fileId: "doc-a.md", headingSlug: "h1" }],
              dependsOn: [],
            },
          ],
        },
        expected: JEV_CONFORMAL_SCORER_NODE,
      },
    ])("gateG04: $label", ({ overrides, expected }) => {
      expect(gateG04(createInitialAgentGraphState(overrides))).toBe(expected);
    });

    it.each<{
      label: string;
      permissionMode: "safe" | "semi_auto" | "full_auto";
      unresolvedCount: number;
      actions: PendingFileLifecycleAction[];
      expected: string;
    }>([
      {
        label: "unresolved decisions -> hitl_clarification_node",
        permissionMode: "full_auto",
        unresolvedCount: 1,
        actions: [],
        expected: HITL_CLARIFICATION_NODE,
      },
      {
        label: "unapproved DELETE_FILE in safe mode -> hitl_clarification_node",
        permissionMode: "safe",
        unresolvedCount: 0,
        actions: [
          { actionId: "d1", type: "DELETE_FILE", relativePath: "old.md", fileId: "f1", rationale: "obsolete" },
        ],
        expected: HITL_CLARIFICATION_NODE,
      },
      {
        label: "unapproved DELETE_FILE in semi_auto mode -> hitl_clarification_node",
        permissionMode: "semi_auto",
        unresolvedCount: 0,
        actions: [
          { actionId: "d1", type: "DELETE_FILE", relativePath: "old.md", fileId: "f1", rationale: "obsolete" },
        ],
        expected: HITL_CLARIFICATION_NODE,
      },
      {
        label: "unapproved DELETE_FILE in full_auto mode -> ledger_commit_node",
        permissionMode: "full_auto",
        unresolvedCount: 0,
        actions: [
          { actionId: "d1", type: "DELETE_FILE", relativePath: "old.md", fileId: "f1", rationale: "obsolete" },
        ],
        expected: LEDGER_COMMIT_NODE,
      },
      {
        label: "approved DELETE_FILE in safe mode -> ledger_commit_node",
        permissionMode: "safe",
        unresolvedCount: 0,
        actions: [
          {
            actionId: "d1",
            type: "DELETE_FILE",
            relativePath: "old.md",
            fileId: "f1",
            rationale: "obsolete",
            approved: true,
          },
        ],
        expected: LEDGER_COMMIT_NODE,
      },
      {
        label: "all decisions resolved and no deletions -> ledger_commit_node",
        permissionMode: "safe",
        unresolvedCount: 0,
        actions: [
          { actionId: "c1", type: "CREATE_FILE", relativePath: "new.md", rationale: "new spec" },
        ],
        expected: LEDGER_COMMIT_NODE,
      },
    ])("gateG05: $label", ({ permissionMode, unresolvedCount, actions, expected }) => {
      const state = createInitialAgentGraphState({
        user_request: {
          prompt: "test",
          workspaceId: "ws-1",
          turnId: "t-1",
          targetFileIds: [],
          permissionMode,
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
        unresolved_ledger:
          unresolvedCount > 0
            ? [
                {
                  decisionId: "dec-u1",
                  topicSlug: "t",
                  questionPrompt: "q",
                  conceptTags: [],
                  reason: "ambiguous",
                },
              ]
            : [],
        pending_file_actions: actions,
      });
      expect(gateG05(state)).toBe(expected);
    });

    it.each([
      {
        label: "unconstrained assumptions with empty scored_decisions (Anti-Domino bypass) -> jev_conformal_scorer_node",
        overrides: {
          assumptions: [
            {
              assumptionId: "a1",
              statement: "Confirmed override assumption",
              conceptTags: [],
              affectedSections: [],
              dependsOn: [],
            },
          ],
          scored_decisions: [],
        },
        expected: JEV_CONFORMAL_SCORER_NODE,
      },
      {
        label: "scored_decisions already populated -> ledger_commit_node",
        overrides: {
          assumptions: [
            {
              assumptionId: "a1",
              statement: "Resolved via HITL",
              conceptTags: [],
              affectedSections: [],
              dependsOn: [],
            },
          ],
          scored_decisions: [{ decisionId: "a1", status: "APPROVED_DIRECT" }],
        },
        expected: LEDGER_COMMIT_NODE,
      },
      {
        label: "all assumptions constrainedByPrior -> ledger_commit_node",
        overrides: {
          assumptions: [
            {
              assumptionId: "a1",
              statement: "Preserved prior",
              conceptTags: [],
              affectedSections: [],
              dependsOn: [],
              constrainedByPrior: true,
            } as AgentGraphState["assumptions"][number],
          ],
          scored_decisions: [],
        },
        expected: LEDGER_COMMIT_NODE,
      },
    ])("gateAfterHitlClarification: $label", ({ overrides, expected }) => {
      expect(gateAfterHitlClarification(createInitialAgentGraphState(overrides))).toBe(expected);
    });

    it.each([
      {
        label: "no invalidations, no file actions, no target files -> direct_response_node",
        overrides: {},
        expected: DIRECT_RESPONSE_NODE,
      },
      {
        label: "invalidation_map non-empty -> workspace_mutator_node",
        overrides: { invalidation_map: { d1: [{ fileId: "doc.md", headingSlug: "intro" }] } },
        expected: WORKSPACE_MUTATOR_NODE,
      },
      {
        label: "pending_file_actions non-empty -> workspace_mutator_node",
        overrides: {
          pending_file_actions: [
            { actionId: "c1", type: "CREATE_FILE" as const, relativePath: "docs/new.md", rationale: "draft" },
          ],
        },
        expected: WORKSPACE_MUTATOR_NODE,
      },
      {
        label: "targetFileIds non-empty -> workspace_mutator_node",
        overrides: {
          user_request: {
            prompt: "edit",
            workspaceId: "ws-1",
            turnId: "t-1",
            targetFileIds: ["doc.md"],
            permissionMode: "safe" as const,
            selectedSystem2ModelId: "google/gemini-3.8-flash",
          },
        },
        expected: WORKSPACE_MUTATOR_NODE,
      },
    ])("gateG06: $label", ({ overrides, expected }) => {
      expect(gateG06(createInitialAgentGraphState(overrides))).toBe(expected);
    });
  });

  // =========================================================================
  // Suite 3: End-to-End Native Graph Execution Paths
  // =========================================================================
  describe("3. End-to-End Native Graph Execution Paths", () => {
    it("executes CHAT_ONLY fast path: Node 1 -> G-01 -> Node 9 -> END", async () => {
      const provider = createMockWorkspaceProvider();
      const { ctx } = createRuntimeContext(provider, { threadId: "th-chat-only" });
      const runner = createElixentAgentGraph();

      const initialState = createInitialAgentGraphState({
        user_request: {
          prompt: "Hello there, how are you?",
          workspaceId: provider.workspaceId,
          turnId: "turn-chat-1",
          targetFileIds: [],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
      });

      const { yields, finalState } = await collectGraphStream(runner, initialState, ctx);

      expect(yields.map((y) => y.nodeId)).toEqual([
        INTENT_AND_SCOPE_ROUTER_NODE,
        DIRECT_RESPONSE_NODE,
      ]);
      expect(finalState.classified_intent).toBe("CHAT_ONLY");
      expect(finalState.messages.some((m) => m.role === "assistant")).toBe(true);
      expect(provider.writeDecisionLedger).not.toHaveBeenCalled();
      expect(provider.mergeSectionThreeWay).not.toHaveBeenCalled();
    });

    it("executes WORKSPACE_READ_SEARCH path: Node 1 -> G-01 -> Node 2 -> G-02 -> Node 9 -> END", async () => {
      const provider = createMockWorkspaceProvider();
      const { ctx } = createRuntimeContext(provider, { threadId: "th-read-search" });
      const runner = createElixentAgentGraph();

      const initialState = createInitialAgentGraphState({
        user_request: {
          prompt: "Summarize the caching architecture documentation",
          workspaceId: provider.workspaceId,
          turnId: "turn-search-1",
          targetFileIds: ["cache.md"],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
      });

      const { yields, finalState } = await collectGraphStream(runner, initialState, ctx);

      expect(yields.map((y) => y.nodeId)).toEqual([
        INTENT_AND_SCOPE_ROUTER_NODE,
        SEARCH_DISCOVERY_NODE,
        DIRECT_RESPONSE_NODE,
      ]);
      expect(finalState.classified_intent).toBe("WORKSPACE_READ_SEARCH");
      expect(finalState.search_report.evidenceItems.length).toBeGreaterThan(0);
      expect(finalState.messages.some((m) => m.role === "assistant")).toBe(true);
    });

    it("executes FAST_LOCAL_EDIT path: Node 1 -> G-01 -> Node 2 -> G-02 -> Node 8 -> END with ghost_hunk_proposed", async () => {
      const provider = createMockWorkspaceProvider();
      const { ctx, events } = createRuntimeContext(provider, {
        threadId: "th-fast-edit",
        permissionMode: "safe",
      });
      const runner = createElixentAgentGraph();

      const initialState = createInitialAgentGraphState({
        user_request: {
          prompt: "Fix typo and polish the caching paragraph",
          workspaceId: provider.workspaceId,
          turnId: "turn-fast-1",
          targetFileIds: ["cache.md"],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
      });

      const { yields, finalState } = await collectGraphStream(runner, initialState, ctx);

      expect(yields.map((y) => y.nodeId)).toEqual([
        INTENT_AND_SCOPE_ROUTER_NODE,
        SEARCH_DISCOVERY_NODE,
        WORKSPACE_MUTATOR_NODE,
      ]);
      expect(finalState.classified_intent).toBe("FAST_LOCAL_EDIT");
      expect(finalState.invalidation_map).toEqual({});
      expect(provider.mergeSectionThreeWay).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.type === "ghost_hunk_proposed")).toBe(true);
    });

    it("executes full 8-node architectural modification pipeline with encrypted checkpoints and ledger commit", async () => {
      const provider = createMockWorkspaceProvider();
      const { ctx } = createRuntimeContext(provider, { threadId: "th-arch-full" });
      const runner = createElixentAgentGraph();

      const initialState = createInitialAgentGraphState({
        user_request: {
          prompt: "Update database architecture design for modular caching",
          workspaceId: provider.workspaceId,
          turnId: "turn-arch-1",
          targetFileIds: ["cache.md"],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
      });

      const { yields, finalState } = await collectGraphStream(runner, initialState, ctx);

      expect(yields.map((y) => y.nodeId)).toEqual([
        INTENT_AND_SCOPE_ROUTER_NODE,
        SEARCH_DISCOVERY_NODE,
        ASSUMPTION_EXTRACTOR_NODE,
        CONFLICT_AND_WEIGHT_GATE_NODE,
        JEV_CONFORMAL_SCORER_NODE,
        LEDGER_COMMIT_NODE,
        WORKSPACE_MUTATOR_NODE,
      ]);

      expect(finalState.classified_intent).toBe("ARCHITECTURAL_MODIFICATION");
      expect(Object.keys(finalState.master_ledger).length).toBeGreaterThan(0);
      expect(finalState.unresolved_ledger).toEqual([]);
      expect(finalState.invalidation_map).toEqual({});
      expect(provider.writeDecisionLedger).toHaveBeenCalledTimes(1);
      expect(provider.mergeSectionThreeWay).toHaveBeenCalledTimes(1);

      // Every completed node persisted 1 encrypted AES-256-GCM checkpoint row
      const persisted = Array.from(checkpointRows.values()).filter(
        (r) => r.threadId === "th-arch-full",
      );
      expect(persisted).toHaveLength(7);
      for (const row of persisted) {
        const parsed = JSON.parse(row.encryptedStateBlob.toString("utf-8"));
        expect(isEncryptedCheckpointEnvelope(parsed)).toBe(true);
      }
    });
  });

  // =========================================================================
  // Suite 4: Native HITL Interrupt & Checkpoint Resumption Lifecycle
  // =========================================================================
  describe("4. Native HITL Clarification Interrupt & Checkpoint Resumption", () => {
    it("suspends at hitl_clarification_node on unresolved JEV output and resumes cleanly into ledger_commit_node -> workspace_mutator_node", async () => {
      mockEvaluateDecisionBatch.mockResolvedValueOnce([
        {
          decisionId: "dec_sync_protocol",
          topicSlug: "sync_protocol",
          questionPrompt: "Adopt Diff3 three-way merge or CRDT Yjs?",
          conceptTags: ["system_architecture"],
          status: "UNRESOLVED",
          impactTier: "CORE_ARCHITECTURAL",
          isLoadBearing: true,
          selectedOptionKey: null,
          selectionRationale: "",
          runnerUpOptionKey: null,
          evaluatedAlternatives: [
            {
              optionKey: "adopt_diff3",
              neutralSummary: "Diff3 three-way merge",
              rationaleAndPremises: "Optimal for single-user offline sync.",
              normalizedProbability: 0.52,
            },
            {
              optionKey: "adopt_crdt",
              neutralSummary: "CRDT Yjs collaborative merge",
              rationaleAndPremises: "Enables real-time multi-user editing.",
              normalizedProbability: 0.48,
            },
          ],
          predictionSetCore: ["adopt_diff3", "adopt_crdt"],
          predictionSetPeriph: ["adopt_diff3", "adopt_crdt"],
          dominanceMargin: 0.04,
          evidenceGrounding: 0.5,
          reason: "Conformal APS multi-option set requires human choice",
        },
      ]);

      const provider = createMockWorkspaceProvider();
      const runner = createElixentAgentGraph();
      const threadId = "th-hitl-e2e-1";

      // Pass 1: Runs Node 1 -> 2 -> 3 -> 4 -> 5 -> G-05 -> Node 6 (INTERRUPTED)
      const pass1 = createRuntimeContext(provider, { threadId, turnId: "turn-hitl-1" });
      const initialState = createInitialAgentGraphState({
        user_request: {
          prompt: "Modify sync system architecture protocol",
          workspaceId: provider.workspaceId,
          turnId: "turn-hitl-1",
          targetFileIds: ["sync.md"],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
      });

      const { yields: yields1, finalState: suspendedState } = await collectGraphStream(
        runner,
        initialState,
        pass1.ctx,
      );

      const lastYield1 = yields1[yields1.length - 1];
      expect(lastYield1.nodeId).toBe(HITL_CLARIFICATION_NODE);
      expect(lastYield1.status).toBe("INTERRUPTED");
      expect(lastYield1.interruptReason).toBe("HITL_CLARIFICATION_REQUIRED");
      expect(suspendedState.question_queue?.questions).toHaveLength(1);
      expect(suspendedState.question_queue?.questions[0].questionId).toBe("dec_sync_protocol");

      const checkpoint1 = await runner.loadLatestCheckpoint(provider.workspaceId, threadId);
      expect(checkpoint1?.status).toBe("INTERRUPTED");
      expect(checkpoint1?.nodeId).toBe(HITL_CLARIFICATION_NODE);

      // Pass 2: Resume from encrypted checkpoint with user's choice -> Node 6 -> Node 7 -> Node 8 -> END
      const pass2 = createRuntimeContext(provider, { threadId, turnId: "turn-hitl-2" });
      const { yields: yields2, finalState: resumedState } = await collectGraphStream(
        runner,
        {
          resumeFromCheckpoint: true,
          stateOverrides: {
            clarification_answers: {
              answers: [
                {
                  questionId: "dec_sync_protocol",
                  selectedOptionKey: "adopt_diff3",
                  customNotes: "Diff3 fits single-user offline architecture.",
                },
              ],
            },
          },
        },
        pass2.ctx,
      );

      expect(yields2.map((y) => y.nodeId)).toEqual([
        HITL_CLARIFICATION_NODE,
        LEDGER_COMMIT_NODE,
        WORKSPACE_MUTATOR_NODE,
      ]);
      expect(resumedState.question_queue).toBeNull();
      expect(resumedState.unresolved_ledger).toEqual([]);
      expect(resumedState.master_ledger["dec_sync_protocol"]?.selectedOptionKey).toBe(
        "adopt_diff3",
      );
      expect(resumedState.master_ledger["dec_sync_protocol"]?.provenance).toBe(
        "USER_EXPLICIT_HITL",
      );
      expect(resumedState.invalidation_map).toEqual({});
      expect(provider.writeDecisionLedger).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Suite 5: Financial Gate Native Interrupt & Multi-Thread Isolation
  // =========================================================================
  describe("5. Financial Gate Interrupt & Multi-Thread Checkpoint Isolation", () => {
    it("freezes graph immediately with INSUFFICIENT_CREDITS when a metered node cannot afford reservation", async () => {
      creditGateControl.failOnNodeId = SEARCH_DISCOVERY_NODE;
      creditGateControl.availableMicro = 150;
      creditGateControl.requiredMicro = 420_000;

      const provider = createMockWorkspaceProvider();
      const { ctx, events } = createRuntimeContext(provider, {
        threadId: "th-credit-stop",
      });
      const runner = createElixentAgentGraph();

      const initialState = createInitialAgentGraphState({
        user_request: {
          prompt: "Update security architecture spec",
          workspaceId: provider.workspaceId,
          turnId: "turn-broke",
          targetFileIds: ["cache.md"],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-4-argon",
        },
      });

      const { yields } = await collectGraphStream(runner, initialState, ctx);

      expect(yields.map((y) => [y.nodeId, y.status])).toEqual([
        [INTENT_AND_SCOPE_ROUTER_NODE, "COMPLETED"],
        [SEARCH_DISCOVERY_NODE, "INTERRUPTED"],
      ]);
      expect(yields[1].interruptReason).toBe("INSUFFICIENT_CREDITS");
      expect(yields[1].interruptPayload).toEqual({
        availableMicro: 150,
        requiredMicro: 420_000,
      });
      expect(events.some((e) => e.type === "interrupt")).toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(false);

      const saved = await runner.loadLatestCheckpoint(provider.workspaceId, "th-credit-stop");
      expect(saved?.status).toBe("INTERRUPTED");
      expect(saved?.nodeId).toBe(SEARCH_DISCOVERY_NODE);
    });

    it("isolates encrypted checkpoints cleanly across concurrent thread IDs", async () => {
      const providerA = createMockWorkspaceProvider("ws-iso-a");
      const providerB = createMockWorkspaceProvider("ws-iso-b");
      const runner = createElixentAgentGraph();

      const ctxA = createRuntimeContext(providerA, { threadId: "thread-isolated-A" }).ctx;
      const ctxB = createRuntimeContext(providerB, { threadId: "thread-isolated-B" }).ctx;

      await runner.invoke(
        createInitialAgentGraphState({
          user_request: {
            prompt: "Hello from Thread A",
            workspaceId: "ws-iso-a",
            turnId: "turn-a",
            targetFileIds: [],
            permissionMode: "safe",
            selectedSystem2ModelId: "google/gemini-3.8-flash",
          },
        }),
        ctxA,
      );

      await runner.invoke(
        createInitialAgentGraphState({
          user_request: {
            prompt: "Hello from Thread B",
            workspaceId: "ws-iso-b",
            turnId: "turn-b",
            targetFileIds: [],
            permissionMode: "full_auto",
            selectedSystem2ModelId: "google/gemini-4-argon",
          },
        }),
        ctxB,
      );

      const snapA = await runner.loadLatestCheckpoint("ws-iso-a", "thread-isolated-A");
      const snapB = await runner.loadLatestCheckpoint("ws-iso-b", "thread-isolated-B");

      expect(snapA?.state.user_request.prompt).toBe("Hello from Thread A");
      expect(snapB?.state.user_request.prompt).toBe("Hello from Thread B");
      expect(snapA?.state.user_request.permissionMode).toBe("safe");
      expect(snapB?.state.user_request.permissionMode).toBe("full_auto");
    });
  });
});
