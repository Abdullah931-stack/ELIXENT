/**
 * Test Suite: Canonical Nodes 1, 2 & 9 — Intent Router, Dual-Domain Search Discovery & Direct Response (Wave 3.2)
 *
 * Verifies ADR-009, ADR-010, ADR-012 & SRS-01 §3.1 contracts across real internal seams:
 * - Node 1 (`intentAndScopeRouterNode`): tree & ledger loading, 9-intent classification, sentinel exclusion, message dedup
 * - Node 2 (`rawSearchDiscoveryNode`): 8-tool Dual Toolset, `maxSteps = 6`, `BUG-07` exact `toolCallId` -> `(fileId, headingSlug)` pairing,
 *   additive `search_loop_count` clamping via real `applyStateDelta`, and offline fallback
 * - Node 9 (`rawDirectResponseNode`): grounded streaming with RAM-only `vault_ref://` resolution, incremental SSE `update` frames, offline fallback
 * - Cross-contract Node 1 -> Node 2 -> Node 9 handoff via real `applyStateDelta`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StepResult, ToolSet } from "ai";
import { intentAndScopeRouterNode } from "@/core/agent/nodes/orchestrator-node";
import {
  rawSearchDiscoveryNode,
  SEARCH_AGENT_STEP_CEILING,
} from "@/core/agent/nodes/search-nodes";
import { rawDirectResponseNode } from "@/core/agent/nodes/direct-response-node";
import {
  applyStateDelta,
  createInitialAgentGraphState,
  type AgentGraphState,
  type InputIntentCategory,
} from "@/core/agent/state";
import type {
  AgentRuntimeContext,
  AgentStreamEvent,
} from "@/core/agent/engine/runner";
import type { DecisionGraphNode } from "@/core/agent/atms/dag";
import { PROJECT_TAXONOMY_SENTINEL_ID } from "@/core/agent/taxonomy/predefined-tags";
import type {
  DecisionLedgerDocument as ProviderDecisionLedgerDocument,
  HeadingNode,
  IWorkspaceProvider,
  LexicalMatchResult,
  SectionReadResult,
  WorkspaceTreeEntry,
} from "@/core/workspace/provider";
import type { StreamGovernor } from "@/lib/metering/stream-governor";
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
  resolveVaultRefJustInTime,
} from "@/lib/vault/ephemeral-memory-map";

const mockExecuteStructuredGeneration = vi.hoisted(() => vi.fn());
const mockExecuteToolAgentGeneration = vi.hoisted(() => vi.fn());
const mockExecuteStreamingGeneration = vi.hoisted(() => vi.fn());
const mockGetApiKeys = vi.hoisted(() => vi.fn<() => string[]>());

vi.mock("@/lib/ai/client", () => ({
  executeStructuredGeneration: mockExecuteStructuredGeneration,
  executeToolAgentGeneration: mockExecuteToolAgentGeneration,
  executeStreamingGeneration: mockExecuteStreamingGeneration,
}));

vi.mock("@/lib/ai/key-rotation", () => ({
  getApiKeys: mockGetApiKeys,
}));

function createDecisionNode(
  decisionId: string,
  overrides: Partial<DecisionGraphNode> = {},
): DecisionGraphNode {
  return {
    decisionId,
    topicSlug: `topic_${decisionId}`,
    questionPrompt: `Question for ${decisionId}`,
    conceptTags: ["system_architecture"],
    selectedOptionKey: "opt_a",
    selectionRationale: `Rationale for ${decisionId}`,
    runnerUpOptionKey: "opt_b",
    evaluatedAlternatives: [
      {
        optionKey: "opt_a",
        neutralSummary: "Primary option",
        rationaleAndPremises: "Selected rationale",
      },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [{ fileId: "doc-arch", headingSlug: "overview" }],
    ...overrides,
  };
}

function createMockWorkspaceProvider(
  overrides: Partial<IWorkspaceProvider> = {},
): IWorkspaceProvider {
  const defaultTree: WorkspaceTreeEntry[] = [
    {
      fileId: "doc-arch",
      parentFolderId: null,
      title: "Architecture",
      relativePath: "docs/architecture.md",
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document",
      etag: "etag-1",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
  ];

  const defaultLedger: ProviderDecisionLedgerDocument = {
    schemaVersion: "2.0.0",
    workspaceId: "ws-wave32",
    updatedAt: "2026-11-20T00:00:00.000Z",
    decisions: {},
    nodes: {},
    edges: [],
    taxonomy: null,
  };

  return {
    workspaceId: "ws-wave32",
    userId: "user-wave32",
    listWorkspaceTree: vi.fn(async () => defaultTree),
    listHeadingsTree: vi.fn(async () => ({}) as Record<string, HeadingNode[]>),
    readSectionByHeading: vi.fn(
      async (fileId: string, headingSlug: string): Promise<SectionReadResult> => ({
        fileId,
        headingSlug,
        breadcrumb: `${fileId} > ${headingSlug}`,
        contentOrVaultRef: `Content for ${fileId}#${headingSlug}`,
        isVaultRef: false,
        sectionHash: "hash-1",
        fileEtag: "etag-1",
        fileVersion: 1,
      }),
    ),
    searchLexicalWithASTBreadcrumb: vi.fn(
      async (): Promise<LexicalMatchResult[]> => [],
    ),
    mergeSectionThreeWay: vi.fn(),
    createWorkspaceFile: vi.fn(),
    deleteWorkspaceFile: vi.fn(),
    readDecisionLedger: vi.fn(async () => defaultLedger),
    writeDecisionLedger: vi.fn(async () => ({ etag: "etag-2", version: 2 })),
    ...overrides,
  };
}

function createRuntimeContext(
  workspaceProvider: IWorkspaceProvider,
  overrides: Partial<AgentRuntimeContext> = {},
): { ctx: AgentRuntimeContext; events: AgentStreamEvent[] } {
  const events: AgentStreamEvent[] = [];
  const ctx: AgentRuntimeContext = {
    userId: "user-wave32",
    workspaceId: "ws-wave32",
    threadId: "thread-wave32",
    turnId: "turn-wave32",
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

describe("Node 1: intent_and_scope_router_node (orchestrator-node.ts)", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKeys.mockReturnValue([]);
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("loads and normalizes decisions.ledger.json, filters system-reserved sentinels, seeds inspection paths, and deduplicates user prompt message", async () => {
    const decRoot = createDecisionNode("dec_root");
    const decChild = createDecisionNode("dec_child", { dependsOn: ["dec_root"] });
    const sentinel = createDecisionNode(PROJECT_TAXONOMY_SENTINEL_ID);

    const provider = createMockWorkspaceProvider({
      readDecisionLedger: vi.fn(async () => ({
        schemaVersion: "2.0.0",
        workspaceId: "ws-wave32",
        updatedAt: "2026-11-20T00:00:00.000Z",
        decisions: {
          dec_root: decRoot,
          dec_child: decChild,
          [PROJECT_TAXONOMY_SENTINEL_ID]: sentinel,
        },
        taxonomy: {
          projectId: "ws-wave32",
          addedTags: ["custom_zero_knowledge"],
          removedTags: [],
        },
      })),
    });

    const { ctx } = createRuntimeContext(provider);
    const initialState = createInitialAgentGraphState({
      user_request: {
        prompt: "Why did we adopt AES-256-GCM in the decision ledger?",
        workspaceId: "ws-wave32",
        turnId: "turn-wave32",
        targetFileIds: ["doc-arch"],
        permissionMode: "safe",
        selectedSystem2ModelId: "google/gemini-3.8-flash",
      },
    });

    const res = await intentAndScopeRouterNode(initialState, ctx);
    expect(res.status).toBe("COMPLETED");

    const nextState = applyStateDelta(initialState, res.stateDelta);
    expect(Object.keys(nextState.master_ledger).sort()).toEqual([
      "dec_child",
      "dec_root",
    ]);
    expect(nextState.master_ledger[PROJECT_TAXONOMY_SENTINEL_ID]).toBeUndefined();
    expect(nextState.ledger_edges).toHaveLength(1);
    expect(nextState.ledger_edges[0]).toMatchObject({
      sourceDecisionId: "dec_child",
      targetDecisionId: "dec_root",
      relation: "DEPENDS_ON",
    });
    expect(nextState.project_taxonomy?.addedTags).toEqual([
      "custom_zero_knowledge",
    ]);
    expect(nextState.classified_intent).toBe("DECISION_LEDGER_QUERY");
    expect(nextState.local_inspection_state).toEqual(["doc-arch"]);
    expect(nextState.messages).toHaveLength(1);
    expect(nextState.messages[0].role).toBe("user");

    // Re-running with same prompt already in state.messages does not append a duplicate
    const secondRes = await intentAndScopeRouterNode(nextState, ctx);
    expect(secondRes.stateDelta.messages).toBeUndefined();
  });

  it.each<{
    prompt: string;
    targetFileIds: string[];
    hasLedgerNodes: boolean;
    expectedIntent: InputIntentCategory;
  }>([
    {
      prompt: "Hello there, how are you?",
      targetFileIds: [],
      hasLedgerNodes: false,
      expectedIntent: "CHAT_ONLY",
    },
    {
      prompt: "Find where token rotation is explained",
      targetFileIds: [],
      hasLedgerNodes: false,
      expectedIntent: "WORKSPACE_READ_SEARCH",
    },
    {
      prompt: "Show all governing dependencies in the decision ledger",
      targetFileIds: [],
      hasLedgerNodes: true,
      expectedIntent: "DECISION_LEDGER_QUERY",
    },
    {
      prompt: "Fix typo in paragraph two",
      targetFileIds: ["doc-1"],
      hasLedgerNodes: false,
      expectedIntent: "FAST_LOCAL_EDIT",
    },
    {
      prompt: "Draft a new specification for offline conflict resolution",
      targetFileIds: [],
      hasLedgerNodes: false,
      expectedIntent: "NEW_DOC_DRAFTING",
    },
    {
      prompt: "Update database schema and auth protocol spec",
      targetFileIds: ["doc-arch"],
      hasLedgerNodes: false,
      expectedIntent: "ARCHITECTURAL_MODIFICATION",
    },
    {
      prompt: "Override and switch from PostgreSQL to SQLite",
      targetFileIds: [],
      hasLedgerNodes: true,
      expectedIntent: "CONFLICTING_OVERRIDE",
    },
    {
      prompt: "Delete file docs/legacy-notes.md",
      targetFileIds: [],
      hasLedgerNodes: false,
      expectedIntent: "FILE_STRUCTURE_MUTATION",
    },
    {
      prompt: "Create file docs/new-auth.md and update security architecture",
      targetFileIds: [],
      hasLedgerNodes: false,
      expectedIntent: "COMPOUND_MULTI_INTENT",
    },
  ])(
    "classifies offline prompt heuristically into $expectedIntent",
    async ({ prompt, targetFileIds, hasLedgerNodes, expectedIntent }) => {
      const provider = createMockWorkspaceProvider({
        readDecisionLedger: vi.fn(async () => ({
          schemaVersion: "2.0.0",
          workspaceId: "ws-wave32",
          updatedAt: "2026-11-20T00:00:00.000Z",
          decisions: hasLedgerNodes ? { dec_1: createDecisionNode("dec_1") } : {},
        })),
      });

      const { ctx } = createRuntimeContext(provider);
      const state = createInitialAgentGraphState({
        user_request: {
          prompt,
          workspaceId: "ws-wave32",
          turnId: "turn-h",
          targetFileIds,
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
      });

      const result = await intentAndScopeRouterNode(state, ctx);
      expect(result.stateDelta.classified_intent).toBe(expectedIntent);
    },
  );

  it("uses executeStructuredGeneration with ctx.selectedSystem2ModelId when API keys exist and rethrows AbortError", async () => {
    mockGetApiKeys.mockReturnValue(["test-gemini-key"]);
    mockExecuteStructuredGeneration.mockResolvedValueOnce({
      object: {
        intent: "CONFLICTING_OVERRIDE",
        rationale: "User requested replacing prior database decision.",
      },
    });

    const provider = createMockWorkspaceProvider();
    const { ctx } = createRuntimeContext(provider, {
      selectedSystem2ModelId: "google/gemini-4-argon",
    });
    const state = createInitialAgentGraphState({
      user_request: {
        prompt: "Let us rethink storage",
        workspaceId: "ws-wave32",
        turnId: "turn-llm",
        targetFileIds: [],
        permissionMode: "safe",
        selectedSystem2ModelId: "google/gemini-4-argon",
      },
    });

    const res = await intentAndScopeRouterNode(state, ctx);
    expect(res.stateDelta.classified_intent).toBe("CONFLICTING_OVERRIDE");
    expect(mockExecuteStructuredGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "google/gemini-4-argon",
      }),
    );

    const abortErr = new Error("Aborted");
    abortErr.name = "AbortError";
    mockExecuteStructuredGeneration.mockRejectedValueOnce(abortErr);
    await expect(intentAndScopeRouterNode(state, ctx)).rejects.toThrow("Aborted");
  });
});

describe("Node 2: search_discovery_node (search-nodes.ts — 8-Tool Dual Toolset & BUG-07)", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKeys.mockReturnValue([]);
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("exposes all 8 Dual Toolset tools (maxSteps=6) and pairs multiple readSectionByHeading calls via toolCallId (BUG-07)", async () => {
    mockGetApiKeys.mockReturnValue(["test-gemini-key"]);

    let capturedToolNames: string[] = [];
    let capturedMaxSteps: number | undefined;
    let capturedModelId: string | undefined;

    mockExecuteToolAgentGeneration.mockImplementationOnce(
      async (params: {
        modelId: string;
        tools: ToolSet;
        maxSteps: number;
      }) => {
        capturedToolNames = Object.keys(params.tools).sort();
        capturedMaxSteps = params.maxSteps;
        capturedModelId = params.modelId;

        // Exercise one decision graph tool live to prove it reads state.master_ledger
        const ledgerSearchTool = params.tools.searchDecisionLedger;
        const ledgerMatches = await ledgerSearchTool.execute!(
          { query: "aes" },
          { toolCallId: "tc-ledger", messages: [], context: {} },
        );
        expect(ledgerMatches).toHaveLength(1);

        // Return multi-section readSectionByHeading results where section objects intentionally omit fileId/headingSlug
        // to prove BUG-07 pairing falls back to exact toolCallId -> args attribution.
        const steps = [
          {
            toolCalls: [
              {
                toolCallId: "tc-read-1",
                toolName: "readSectionByHeading",
                input: { fileId: "doc-alpha", headingSlug: "sec-crypto" },
              },
              {
                toolCallId: "tc-read-2",
                toolName: "readSectionByHeading",
                input: { fileId: "doc-beta", headingSlug: "sec-sync" },
              },
            ],
            toolResults: [
              {
                toolCallId: "tc-read-2",
                toolName: "readSectionByHeading",
                output: {
                  breadcrumb: "Sync > Diff3",
                  contentOrVaultRef: "vault_ref://doc-beta#sec-sync",
                  isVaultRef: true,
                },
              },
              {
                toolCallId: "tc-read-1",
                toolName: "readSectionByHeading",
                output: {
                  breadcrumb: "Security > Crypto",
                  contentOrVaultRef: "AES-256-GCM cipher parameters",
                  isVaultRef: false,
                },
              },
            ],
          },
        ] as unknown as StepResult<ToolSet>[];

        return {
          text: "Discovered crypto and sync sections plus governing ledger node.",
          steps,
        };
      },
    );

    const provider = createMockWorkspaceProvider();
    const { ctx } = createRuntimeContext(provider, {
      selectedSystem2ModelId: "google/gemini-4-argon",
    });

    const state = createInitialAgentGraphState({
      classified_intent: "ARCHITECTURAL_MODIFICATION",
      master_ledger: {
        dec_aes: createDecisionNode("dec_aes", {
          topicSlug: "aes_cipher",
          selectionRationale: "AES-256-GCM authenticated encryption",
        }),
      },
      user_request: {
        prompt: "Review encryption and sync sections",
        workspaceId: "ws-wave32",
        turnId: "turn-search",
        targetFileIds: ["doc-alpha", "doc-beta"],
        permissionMode: "safe",
        selectedSystem2ModelId: "google/gemini-4-argon",
      },
    });

    const res = await rawSearchDiscoveryNode(state, ctx);
    expect(res.status).toBe("COMPLETED");
    expect(capturedMaxSteps).toBe(SEARCH_AGENT_STEP_CEILING);
    expect(capturedMaxSteps).toBe(6);
    expect(capturedModelId).toBe("google/gemini-4-argon");
    expect(capturedToolNames).toEqual([
      "getDecisionNodeDetails",
      "getSectionGoverningDecisions",
      "listHeadingsTree",
      "listWorkspaceTree",
      "readSectionByHeading",
      "searchDecisionLedger",
      "searchLexicalWithASTBreadcrumb",
      "traverseDecisionDependencies",
    ]);

    const evidence = res.stateDelta.search_report?.evidenceItems ?? [];
    expect(evidence).toHaveLength(2);

    // Out-of-order toolResults must still bind to exact (fileId, headingSlug) from their matching toolCallId!
    const betaEvidence = evidence.find((e) => e.fileId === "doc-beta");
    const alphaEvidence = evidence.find((e) => e.fileId === "doc-alpha");
    expect(betaEvidence).toMatchObject({
      fileId: "doc-beta",
      headingSlug: "sec-sync",
      breadcrumb: ["Sync", "Diff3"],
      vaultRef: "vault_ref://doc-beta#sec-sync",
    });
    expect(alphaEvidence).toMatchObject({
      fileId: "doc-alpha",
      headingSlug: "sec-crypto",
      breadcrumb: ["Security", "Crypto"],
      textExcerpt: "AES-256-GCM cipher parameters",
      vaultRef: undefined,
    });
    expect(res.stateDelta.search_loop_count).toBe(1);
  });

  it("increments search_loop_count additively across repeated runs and clamps at MAX_SEARCH_LOOPS (3) via applyStateDelta", async () => {
    const provider = createMockWorkspaceProvider({
      listHeadingsTree: vi.fn(async (): Promise<Record<string, HeadingNode[]>> => ({
        "doc-arch": [
          {
            headingSlug: "overview",
            title: "Overview",
            level: 2,
            breadcrumb: "Architecture > Overview",
            startLine: 1,
            endLine: 10,
            startOffset: 0,
            endOffset: 100,
            contentHash: "a".repeat(64),
          },
        ],
      })),
    });

    const { ctx } = createRuntimeContext(provider);
    let state: AgentGraphState = createInitialAgentGraphState({
      user_request: {
        prompt: "inspect overview",
        workspaceId: "ws-wave32",
        turnId: "turn-loop",
        targetFileIds: ["doc-arch"],
        permissionMode: "safe",
        selectedSystem2ModelId: "google/gemini-3.8-flash",
      },
    });

    for (let i = 1; i <= 4; i++) {
      const res = await rawSearchDiscoveryNode(state, ctx);
      expect(res.stateDelta.search_loop_count).toBe(1);
      state = applyStateDelta(state, res.stateDelta);
      expect(state.search_loop_count).toBe(Math.min(i, 3));
    }

    expect(state.local_inspection_state).toContain("doc-arch#overview");
    expect(state.search_report.evidenceItems).toHaveLength(1);
  });
});

describe("Node 9: direct_response_node (direct-response-node.ts) & Node 1 -> 2 -> 9 Handoff", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKeys.mockReturnValue([]);
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("resolves vault_ref:// evidence in RAM, streams chunks as incremental SSE updates, and appends final assistant message", async () => {
    mockGetApiKeys.mockReturnValue(["test-gemini-key"]);

    let capturedPrompt = "";
    mockExecuteStreamingGeneration.mockImplementationOnce(
      async (params: { prompt: string; modelId: string }) => {
        capturedPrompt = params.prompt;
        async function* chunks() {
          yield "The vault uses ";
          yield "AES-256-GCM.";
        }
        return { textStream: chunks() };
      },
    );

    const provider = createMockWorkspaceProvider();
    const { ctx, events } = createRuntimeContext(provider, {
      selectedSystem2ModelId: "google/gemini-4-argon",
    });

    await runWithEphemeralVaultScope(async () => {
      const ptr = storeEphemeralVaultSection(
        "doc-vault",
        "key-schedule",
        "HKDF-SHA256 derived 256-bit key schedule",
      );
      expect(resolveVaultRefJustInTime(ptr)).toContain("HKDF-SHA256");

      const state = createInitialAgentGraphState({
        classified_intent: "WORKSPACE_READ_SEARCH",
        user_request: {
          prompt: "Explain the vault key schedule",
          workspaceId: "ws-wave32",
          turnId: "turn-direct",
          targetFileIds: ["doc-vault"],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-4-argon",
        },
        search_report: {
          evidenceItems: [
            {
              fileId: "doc-vault",
              headingSlug: "key-schedule",
              breadcrumb: ["Vault", "Key Schedule"],
              textExcerpt: ptr,
              vaultRef: ptr,
            },
          ],
          inspectedPaths: ["doc-vault#key-schedule"],
          summary: "Found key schedule section",
        },
      });

      const res = await rawDirectResponseNode(state, ctx);
      expect(res.status).toBe("COMPLETED");
      expect(capturedPrompt).toContain("HKDF-SHA256 derived 256-bit key schedule");

      // Incremental SSE update events emitted per chunk
      const updates = events.filter((e) => e.type === "update");
      expect(updates).toHaveLength(2);

      const finalState = applyStateDelta(state, res.stateDelta);
      const lastMsg = finalState.messages.at(-1);
      expect(lastMsg?.role).toBe("assistant");
      expect(lastMsg?.content).toBe("The vault uses AES-256-GCM.");
    });
  });

  it("executes full offline cross-contract handoff Node 1 -> Node 2 -> Node 9 via real applyStateDelta", async () => {
    const provider = createMockWorkspaceProvider({
      readDecisionLedger: vi.fn(async () => ({
        schemaVersion: "2.0.0",
        workspaceId: "ws-wave32",
        updatedAt: "2026-11-20T00:00:00.000Z",
        decisions: { dec_1: createDecisionNode("dec_1") },
      })),
      listHeadingsTree: vi.fn(async (): Promise<Record<string, HeadingNode[]>> => ({
        "doc-arch": [
          {
            headingSlug: "overview",
            title: "Overview",
            level: 1,
            breadcrumb: "Overview",
            startLine: 1,
            endLine: 5,
            startOffset: 0,
            endOffset: 50,
            contentHash: "b".repeat(64),
          },
        ],
      })),
    });

    const { ctx } = createRuntimeContext(provider);
    let state = createInitialAgentGraphState({
      user_request: {
        prompt: "Summarize architecture overview",
        workspaceId: "ws-wave32",
        turnId: "turn-chain-129",
        targetFileIds: ["doc-arch"],
        permissionMode: "safe",
        selectedSystem2ModelId: "google/gemini-3.8-flash",
      },
    });

    const n1 = await intentAndScopeRouterNode(state, ctx);
    state = applyStateDelta(state, n1.stateDelta);
    expect(state.classified_intent).toBe("WORKSPACE_READ_SEARCH");

    const n2 = await rawSearchDiscoveryNode(state, ctx);
    state = applyStateDelta(state, n2.stateDelta);
    expect(state.search_loop_count).toBe(1);
    expect(state.search_report.evidenceItems.length).toBeGreaterThan(0);

    const n9 = await rawDirectResponseNode(state, ctx);
    state = applyStateDelta(state, n9.stateDelta);
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1].content).toContain("Active ATMS decisions: 1.");
  });
});
