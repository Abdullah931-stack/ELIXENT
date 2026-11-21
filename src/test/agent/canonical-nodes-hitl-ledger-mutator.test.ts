/**
 * Test Suite: Canonical Nodes 6, 7 & 8 — HITL Clarification, Ledger Commit & Workspace Mutator (Wave 3.2)
 *
 * Verifies ADR-009, ADR-010, ADR-012, ADR-014, ADR-016 & SRS-01 §3.1 across real internal seams:
 * - Node 6 (`hitlClarificationNode`): `INTERRUPTED` reasons (`HITL_CLARIFICATION_REQUIRED`,
 *   `ANTI_DOMINO_CONFIRMATION_REQUIRED`, `FILE_DELETION_APPROVAL_REQUIRED`), `BUG-02` conformal
 *   calibration feedback `1 - p_tilde(a_user)`, `USER_EXPLICIT_HITL` provenance stamping,
 *   Anti-Domino `confirm_override` / `preserve_prior` resumptions, and `DELETE_FILE` approval mapping
 * - Node 7 (`ledgerCommitNode`): DAG cycle validation, `normalizeLedgerGraphIntegrity`,
 *   4-source `changeWeight` recomputation on modified + connected nodes, `writeDecisionLedger`,
 *   and encrypted `vault_file_commit_required` emission
 * - Node 8 (`rawWorkspaceMutatorNode`): `BUG-03` purge of `<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->`,
 *   file lifecycle (`CREATE_FILE` / `DELETE_FILE`) gating by `permissionMode`, `mergeSectionThreeWay`,
 *   SSE branching (`safe` -> `ghost_hunk_proposed`, `semi_auto`/`full_auto` -> `file_mutated` or
 *   `vault_file_commit_required`), `FAST_LOCAL_EDIT` heading fallback, and `clearInvalidationMap: true`
 * - End-to-end cross-contract Node 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 handoff via real `applyStateDelta`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { intentAndScopeRouterNode } from "@/core/agent/nodes/orchestrator-node";
import { rawSearchDiscoveryNode } from "@/core/agent/nodes/search-nodes";
import {
  rawAssumptionExtractorNode,
  conflictAndWeightGateNode,
  type AnalyzedAssumptionItem,
} from "@/core/agent/nodes/assumption-and-linker-nodes";
import { rawJevConformalScorerNode } from "@/core/agent/nodes/jev-scoring-nodes";
import { hitlClarificationNode } from "@/core/agent/nodes/hitl-nodes";
import { ledgerCommitNode } from "@/core/agent/nodes/resolution-and-ledger-nodes";
import { rawWorkspaceMutatorNode } from "@/core/agent/nodes/document-writer-node";
import {
  applyStateDelta,
  createInitialAgentGraphState,
  type AgentPermissionMode,
  type PendingFileLifecycleAction,
} from "@/core/agent/state";
import type {
  AgentRuntimeContext,
  AgentStreamEvent,
} from "@/core/agent/engine/runner";
import type { DecisionGraphNode } from "@/core/agent/atms/dag";
import { calibrationStore } from "@/lib/jev/calibration-store";
import { TIER1_DEFAULT_MODEL } from "@/lib/jev/client";
import type {
  DecisionLedgerDocument as ProviderDecisionLedgerDocument,
  HeadingNode,
  IWorkspaceProvider,
  SectionMergeOutcome,
  SectionReadResult,
  WorkspaceTreeEntry,
} from "@/core/workspace/provider";
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
} from "@/lib/vault/ephemeral-memory-map";

const mockExecuteStreamingGeneration = vi.hoisted(() => vi.fn());
const mockExecuteStructuredGeneration = vi.hoisted(() => vi.fn());
const mockExecuteToolAgentGeneration = vi.hoisted(() => vi.fn());
const mockGetApiKeys = vi.hoisted(() => vi.fn<() => string[]>());

vi.mock("@/lib/ai/client", () => ({
  executeStreamingGeneration: mockExecuteStreamingGeneration,
  executeStructuredGeneration: mockExecuteStructuredGeneration,
  executeToolAgentGeneration: mockExecuteToolAgentGeneration,
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
    provenance: "USER_EXPLICIT_HITL",
    couplingLevel: 1.8,
    rollbackCost: 1.7,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [{ fileId: "doc-arch", headingSlug: "architecture" }],
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
      etag: "etag-arch",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
    {
      fileId: "ledger-file",
      parentFolderId: null,
      title: "decisions.ledger.json",
      relativePath: "decisions.ledger.json",
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "decision_ledger",
      etag: "etag-ledger",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
  ];

  return {
    workspaceId: "ws-n678",
    userId: "user-n678",
    listWorkspaceTree: vi.fn(async () => defaultTree),
    listHeadingsTree: vi.fn(
      async (): Promise<Record<string, HeadingNode[]>> => ({
        "doc-arch": [
          {
            headingSlug: "architecture",
            title: "Architecture",
            level: 2,
            breadcrumb: "Architecture",
            startLine: 1,
            endLine: 8,
            startOffset: 0,
            endOffset: 80,
            contentHash: "c".repeat(64),
          },
        ],
      }),
    ),
    readSectionByHeading: vi.fn(
      async (fileId: string, headingSlug: string): Promise<SectionReadResult> => ({
        fileId,
        headingSlug,
        breadcrumb: `${fileId} > ${headingSlug}`,
        contentOrVaultRef: `## ${headingSlug}\nOriginal section body.`,
        isVaultRef: false,
        sectionHash: "hash-sec",
        fileEtag: "etag-arch",
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
    createWorkspaceFile: vi.fn(async ({ relativePath }) => ({
      fileId: "file-created-1",
      parentFolderId: null,
      title: relativePath,
      relativePath,
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document" as const,
      etag: "etag-new",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    })),
    deleteWorkspaceFile: vi.fn(async ({ fileId }) => ({
      fileId,
      deletedAt: "2026-11-20T00:00:00.000Z",
    })),
    readDecisionLedger: vi.fn(
      async (): Promise<ProviderDecisionLedgerDocument> => ({
        schemaVersion: "2.0.0",
        workspaceId: "ws-n678",
        updatedAt: "2026-11-20T00:00:00.000Z",
        decisions: {},
        nodes: {},
        edges: [],
        taxonomy: null,
      }),
    ),
    writeDecisionLedger: vi.fn(async () => ({ etag: "etag-w", version: 2 })),
    ...overrides,
  };
}

function createRuntimeContext(
  workspaceProvider: IWorkspaceProvider,
  overrides: Partial<AgentRuntimeContext> = {},
): { ctx: AgentRuntimeContext; events: AgentStreamEvent[] } {
  const events: AgentStreamEvent[] = [];
  const ctx: AgentRuntimeContext = {
    userId: "user-n678",
    workspaceId: "ws-n678",
    threadId: "thread-n678",
    turnId: "turn-n678",
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

describe("Node 6: hitl_clarification_node (hitl-nodes.ts — BUG-02, Anti-Domino & File Deletion)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calibrationStore.resetWindow();
  });

  it.each<{
    name: string;
    permissionMode: AgentPermissionMode;
    stateOverrides: Parameters<typeof createInitialAgentGraphState>[0];
    expectedReason:
      | "HITL_CLARIFICATION_REQUIRED"
      | "ANTI_DOMINO_CONFIRMATION_REQUIRED"
      | "FILE_DELETION_APPROVAL_REQUIRED";
    expectedQuestionIds: string[];
  }>([
    {
      name: "unresolved_ledger triggers HITL_CLARIFICATION_REQUIRED",
      permissionMode: "safe",
      stateOverrides: {
        unresolved_ledger: [
          {
            decisionId: "dec_u1",
            topicSlug: "queue_backend",
            questionPrompt: "Select queue backend?",
            conceptTags: ["system_architecture"],
            reason: "MULTI_OPTION_CORE_PREDICTION_SET",
          },
        ],
      },
      expectedReason: "HITL_CLARIFICATION_REQUIRED",
      expectedQuestionIds: ["dec_u1"],
    },
    {
      name: "pre-populated Anti-Domino question_queue triggers ANTI_DOMINO_CONFIRMATION_REQUIRED",
      permissionMode: "safe",
      stateOverrides: {
        question_queue: {
          questions: [
            {
              questionId: "antidomino_dec_root",
              topicSlug: "auth_strategy",
              questionPrompt: "Confirm override?",
              options: [
                { optionKey: "preserve_prior", neutralSummary: "Keep prior" },
                { optionKey: "confirm_override", neutralSummary: "Override" },
              ],
            },
          ],
        },
      },
      expectedReason: "ANTI_DOMINO_CONFIRMATION_REQUIRED",
      expectedQuestionIds: ["antidomino_dec_root"],
    },
    {
      name: "unapproved DELETE_FILE in semi_auto mode triggers FILE_DELETION_APPROVAL_REQUIRED",
      permissionMode: "semi_auto",
      stateOverrides: {
        pending_file_actions: [
          {
            actionId: "del-1",
            type: "DELETE_FILE",
            relativePath: "docs/obsolete.md",
            fileId: "file-obs",
            rationale: "Superseded design",
          },
        ],
      },
      expectedReason: "FILE_DELETION_APPROVAL_REQUIRED",
      expectedQuestionIds: ["del-1"],
    },
  ])(
    "interrupts on entry when $name",
    async ({ permissionMode, stateOverrides, expectedReason, expectedQuestionIds }) => {
      const provider = createMockWorkspaceProvider();
      const { ctx } = createRuntimeContext(provider, { permissionMode });
      const state = createInitialAgentGraphState(stateOverrides);

      const res = await hitlClarificationNode(state, ctx);
      expect(res.status).toBe("INTERRUPTED");
      if (res.status === "INTERRUPTED") {
        expect(res.interruptReason).toBe(expectedReason);
        const qIds =
          res.stateDelta.question_queue?.questions.map((q) => q.questionId) ?? [];
        expect(qIds).toEqual(expectedQuestionIds);
      }
    },
  );

  it("resumes with user answers: stamps USER_EXPLICIT_HITL, records empirical nonconformity score 1 - p_tilde(a_user) into calibrationStore (BUG-02), and updates DELETE_FILE approvals", async () => {
    const recordSpy = vi.spyOn(calibrationStore, "recordFeedbackScore");

    const provider = createMockWorkspaceProvider();
    const { ctx } = createRuntimeContext(provider);

    const state = createInitialAgentGraphState({
      scored_decisions: [
        {
          decisionId: "dec_u1",
          topicSlug: "queue_backend",
          questionPrompt: "Select queue backend?",
          status: "UNRESOLVED",
          selectionRationale: "Ambiguous core set",
          evaluatedAlternatives: [
            {
              optionKey: "upstash_qstash",
              neutralSummary: "Upstash QStash",
              rationaleAndPremises: "HTTP serverless queue",
              normalizedProbability: 0.65,
            },
            {
              optionKey: "pg_boss",
              neutralSummary: "PostgreSQL pg-boss",
              rationaleAndPremises: "Shared DB queue",
              normalizedProbability: 0.35,
            },
          ],
        },
      ],
      unresolved_ledger: [
        {
          decisionId: "dec_u1",
          topicSlug: "queue_backend",
          questionPrompt: "Select queue backend?",
          conceptTags: ["system_architecture"],
          reason: "MULTI_OPTION_CORE_PREDICTION_SET",
        },
      ],
      pending_file_actions: [
        {
          actionId: "del-approve",
          type: "DELETE_FILE",
          relativePath: "docs/old.md",
          fileId: "f-old",
          rationale: "Deprecated",
        },
        {
          actionId: "del-reject",
          type: "DELETE_FILE",
          relativePath: "docs/keep.md",
          fileId: "f-keep",
          rationale: "Requested removal",
        },
      ],
      clarification_answers: {
        answers: [
          {
            questionId: "dec_u1",
            selectedOptionKey: "pg_boss",
            customNotes: "Avoid extra infrastructure dependency",
          },
          { questionId: "del-approve", selectedOptionKey: "approve_delete" },
          { questionId: "del-reject", selectedOptionKey: "reject_delete" },
        ],
      },
    });

    const res = await hitlClarificationNode(state, ctx);
    expect(res.status).toBe("COMPLETED");

    // BUG-02: Empirical nonconformity score s(x, pg_boss) = 1 - 0.35 = 0.65
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      TIER1_DEFAULT_MODEL,
      expect.closeTo(0.65, 6),
    );
    expect(calibrationStore.getWindowSize(TIER1_DEFAULT_MODEL)).toBe(1);

    const nextState = applyStateDelta(state, res.stateDelta);
    expect(nextState.unresolved_ledger).toEqual([]);
    expect(nextState.question_queue).toBeNull();
    expect(nextState.clarification_answers).toBeNull();

    const resolvedDecision = nextState.scored_decisions[0];
    expect(resolvedDecision.status).toBe("APPROVED_DIRECT");
    expect(resolvedDecision.provenance).toBe("USER_EXPLICIT_HITL");
    expect(resolvedDecision.selectedOptionKey).toBe("pg_boss");
    expect(String(resolvedDecision.selectionRationale)).toContain(
      "Avoid extra infrastructure dependency",
    );

    expect(nextState.pending_file_actions).toEqual([
      expect.objectContaining({ actionId: "del-approve", approved: true }),
      expect.objectContaining({ actionId: "del-reject", approved: false }),
    ]);
  });

  it("handles Anti-Domino preserve_prior resumption by adding priorNode to governing_constraints and flagging matching assumptions constrainedByPrior", async () => {
    const priorNode = createDecisionNode("dec_root");
    const matchingAssumption: AnalyzedAssumptionItem = {
      assumptionId: "asmp_override",
      statement: "Override root decision",
      intentType: "DIRECT_USER_INSTRUCTION",
      conceptTags: ["system_architecture"],
      affectedSections: [],
      dependsOn: [],
      candidateDecisionIds: ["dec_root"],
    };

    const state = createInitialAgentGraphState({
      master_ledger: { dec_root: priorNode },
      assumptions: [matchingAssumption],
      clarification_answers: {
        answers: [
          {
            questionId: "antidomino_dec_root",
            selectedOptionKey: "preserve_prior",
          },
        ],
      },
    });

    const provider = createMockWorkspaceProvider();
    const { ctx } = createRuntimeContext(provider);

    const res = await hitlClarificationNode(state, ctx);
    const nextState = applyStateDelta(state, res.stateDelta);

    expect(nextState.governing_constraints.map((n) => n.decisionId)).toEqual([
      "dec_root",
    ]);
    const updatedAsmp = nextState.assumptions[0] as AnalyzedAssumptionItem;
    expect(updatedAsmp.constrainedByPrior).toBe(true);
    expect(nextState.master_ledger.dec_root).toBeDefined();
  });

  it("handles Anti-Domino confirm_override resumption by cascading invalidations and evicting overridden node + dependents through applyStateDelta", async () => {
    const priorRoot = createDecisionNode("dec_root", {
      dependedBy: ["dec_child"],
      affectedSections: [{ fileId: "doc-arch", headingSlug: "root" }],
    });
    const dependentChild = createDecisionNode("dec_child", {
      dependsOn: ["dec_root"],
      affectedSections: [{ fileId: "doc-child", headingSlug: "child" }],
    });

    const state = createInitialAgentGraphState({
      master_ledger: {
        dec_root: priorRoot,
        dec_child: dependentChild,
      },
      clarification_answers: {
        answers: [
          {
            questionId: "antidomino_dec_root",
            selectedOptionKey: "confirm_override",
          },
        ],
      },
    });

    const provider = createMockWorkspaceProvider();
    const { ctx } = createRuntimeContext(provider);

    const res = await hitlClarificationNode(state, ctx);
    expect(res.status).toBe("COMPLETED");
    // Invalidation map captures both root and cascaded child sections
    expect(res.stateDelta.invalidation_map).toEqual({
      dec_root: [{ fileId: "doc-arch", headingSlug: "root" }],
      dec_child: [{ fileId: "doc-child", headingSlug: "child" }],
    });
    // Node 6's delta evicted both nodes via resolveATMSCascadeBFS
    expect(res.stateDelta.master_ledger).toEqual({});

    // Cross-contract invariant: applying Node 6's stateDelta via real applyStateDelta
    // MUST preserve the eviction rather than resurrecting evicted nodes from current.master_ledger!
    const nextState = applyStateDelta(state, res.stateDelta);
    expect(nextState.master_ledger.dec_root).toBeUndefined();
    expect(nextState.master_ledger.dec_child).toBeUndefined();
  });
});

describe("Node 7: ledger_commit_node (resolution-and-ledger-nodes.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits approved decisions, recomputes W(d) for committed + connected parent nodes, writes v2.0 ledger, and emits vault_file_commit_required when ledger is encrypted", async () => {
    const parentNode = createDecisionNode("dec_parent", {
      couplingLevel: 1.5,
      rollbackCost: 1.5,
      provenance: "USER_EXPLICIT_HITL",
      affectedSections: [{ fileId: "doc-arch", headingSlug: "base" }],
    });

    const encryptedTree: WorkspaceTreeEntry[] = [
      {
        fileId: "ledger-enc-id",
        parentFolderId: null,
        title: "decisions.ledger.json",
        relativePath: "decisions.ledger.json",
        isFolder: false,
        isEncrypted: true,
        isAiExcluded: false,
        artifactRole: "decision_ledger",
        etag: "etag-l",
        version: 1,
        updatedAt: "2026-11-20T00:00:00.000Z",
      },
    ];

    const writeSpy = vi.fn(async () => ({ etag: "etag-2", version: 2 }));
    const provider = createMockWorkspaceProvider({
      listWorkspaceTree: vi.fn(async () => encryptedTree),
      writeDecisionLedger: writeSpy,
    });

    const { ctx, events } = createRuntimeContext(provider);

    const state = createInitialAgentGraphState({
      master_ledger: { dec_parent: parentNode },
      scored_decisions: [
        {
          decisionId: "dec_child_new",
          topicSlug: "child_feature",
          questionPrompt: "Select child feature pattern",
          conceptTags: ["system_architecture"],
          status: "APPROVED_DIRECT",
          provenance: "USER_EXPLICIT_HITL",
          impactTier: "CORE_ARCHITECTURAL",
          isLoadBearing: true,
          selectedOptionKey: "opt_fast",
          selectionRationale: "User selected fast path",
          dependsOnDecisionIds: ["dec_parent"],
          affectedSections: [{ fileId: "doc-arch", headingSlug: "child" }],
          couplingLevel: 1.2,
          rollbackCost: 1.0,
        },
        {
          decisionId: "dec_still_unresolved",
          status: "UNRESOLVED",
        },
      ],
    });

    const res = await ledgerCommitNode(state, ctx);
    expect(res.status).toBe("COMPLETED");
    expect(writeSpy).toHaveBeenCalledTimes(1);

    const nextState = applyStateDelta(state, res.stateDelta);
    expect(nextState.master_ledger.dec_child_new).toBeDefined();
    expect(nextState.master_ledger.dec_still_unresolved).toBeUndefined();

    // Parent node's dependedBy and changeWeight.topology must be recomputed (+6 for 1 direct dependent)
    expect(nextState.master_ledger.dec_parent.dependedBy).toEqual([
      "dec_child_new",
    ]);
    expect(nextState.master_ledger.dec_parent.changeWeight?.topology).toBe(6);
    expect(nextState.master_ledger.dec_child_new.changeWeight?.total).toBeGreaterThanOrEqual(
      10,
    );

    expect(nextState.ledger_edges).toContainEqual(
      expect.objectContaining({
        sourceDecisionId: "dec_child_new",
        targetDecisionId: "dec_parent",
        relation: "DEPENDS_ON",
      }),
    );
    expect(nextState.invalidation_map.dec_child_new).toEqual([
      { fileId: "doc-arch", headingSlug: "child" },
    ]);

    // Encrypted decision ledger emits vault_file_commit_required SSE event
    const vaultEvent = events.find((e) => e.type === "vault_file_commit_required");
    expect(vaultEvent).toBeDefined();
    if (vaultEvent?.type === "vault_file_commit_required") {
      expect(vaultEvent.fileId).toBe("ledger-enc-id");
      expect(vaultEvent.relativePath).toBe("decisions.ledger.json");
      const parsed = JSON.parse(vaultEvent.mergedContent) as {
        schemaVersion: string;
        nodes: Record<string, unknown>;
      };
      expect(parsed.schemaVersion).toBe("2.0.0");
      expect(parsed.nodes.dec_child_new).toBeDefined();
    }
  });

  it("rejects committing a decision that introduces a dependency cycle before writing decisions.ledger.json", async () => {
    const writeSpy = vi.fn();
    const provider = createMockWorkspaceProvider({
      writeDecisionLedger: writeSpy,
    });
    const { ctx } = createRuntimeContext(provider);

    const state = createInitialAgentGraphState({
      master_ledger: {
        dec_a: createDecisionNode("dec_a", { dependsOn: ["dec_b"] }),
      },
      scored_decisions: [
        {
          decisionId: "dec_b",
          topicSlug: "cycle_b",
          questionPrompt: "Cycle node",
          status: "APPROVED_DIRECT",
          selectedOptionKey: "opt_a",
          dependsOnDecisionIds: ["dec_a"],
        },
      ],
    });

    await expect(ledgerCommitNode(state, ctx)).rejects.toThrow(
      /ATMS Decision Graph cycle detected/,
    );
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("Node 8: workspace_mutator_node (document-writer-node.ts — BUG-03, Permission Modes & Diff3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<{
    name: string;
    permissionMode: AgentPermissionMode;
    isEncrypted: boolean;
    expectedSseType:
      | "ghost_hunk_proposed"
      | "file_mutated"
      | "vault_file_commit_required";
  }>([
    {
      name: "safe mode proposes ghost hunk without mutating persisted file",
      permissionMode: "safe",
      isEncrypted: false,
      expectedSseType: "ghost_hunk_proposed",
    },
    {
      name: "semi_auto on unencrypted file emits file_mutated",
      permissionMode: "semi_auto",
      isEncrypted: false,
      expectedSseType: "file_mutated",
    },
    {
      name: "full_auto on encrypted file emits vault_file_commit_required",
      permissionMode: "full_auto",
      isEncrypted: true,
      expectedSseType: "vault_file_commit_required",
    },
  ])(
    "streams clean markdown without HTML decision comments (BUG-03), merges via mergeSectionThreeWay, clears invalidation_map, and $name",
    async ({ permissionMode, isEncrypted, expectedSseType }) => {
      mockExecuteStreamingGeneration.mockResolvedValueOnce({
        text: Promise.resolve("## architecture\nUpdated clean architectural prose."),
      });

      const tree: WorkspaceTreeEntry[] = [
        {
          fileId: "doc-arch",
          parentFolderId: null,
          title: "Architecture",
          relativePath: "docs/architecture.md",
          isFolder: false,
          isEncrypted,
          isAiExcluded: false,
          artifactRole: "document",
          etag: "etag-1",
          version: 1,
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      ];

      await runWithEphemeralVaultScope(async () => {
        const ptr = isEncrypted
          ? storeEphemeralVaultSection(
              "doc-arch",
              "architecture",
              "## architecture\nDecrypted base vault prose.",
            )
          : "## architecture\nOriginal plain base prose.";

        const mergeSpy = vi.fn(
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
        );

        const provider = createMockWorkspaceProvider({
          listWorkspaceTree: vi.fn(async () => tree),
          readSectionByHeading: vi.fn(async () => ({
            fileId: "doc-arch",
            headingSlug: "architecture",
            breadcrumb: "Architecture",
            contentOrVaultRef: ptr,
            isVaultRef: isEncrypted,
            sectionHash: "h1",
            fileEtag: "etag-1",
            fileVersion: 1,
          })),
          mergeSectionThreeWay: mergeSpy,
        });

        const { ctx, events } = createRuntimeContext(provider, {
          permissionMode,
          selectedSystem2ModelId: "google/gemini-4-argon",
        });

        const state = createInitialAgentGraphState({
          user_request: {
            prompt: "Update architecture section",
            workspaceId: "ws-n678",
            turnId: "turn-mut",
            targetFileIds: ["doc-arch"],
            permissionMode,
            selectedSystem2ModelId: "google/gemini-4-argon",
          },
          invalidation_map: {
            dec_1: [{ fileId: "doc-arch", headingSlug: "architecture" }],
          },
        });

        const res = await rawWorkspaceMutatorNode(state, ctx);
        expect(res.status).toBe("COMPLETED");
        expect(res.stateDelta.clearInvalidationMap).toBe(true);

        // BUG-03: Zero HTML alignment comment injection in proposed content
        expect(mergeSpy).toHaveBeenCalledTimes(1);
        const proposedArg = mergeSpy.mock.calls[0][0].agentProposedSectionContent;
        expect(proposedArg).toBe("## architecture\nUpdated clean architectural prose.");
        expect(proposedArg).not.toContain("<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->");

        expect(events.map((e) => e.type)).toEqual([expectedSseType]);

        // Real applyStateDelta clears invalidation_map completely
        const nextState = applyStateDelta(state, res.stateDelta);
        expect(nextState.invalidation_map).toEqual({});
      });
    },
  );

  it("enforces permissionMode gating on CREATE_FILE and DELETE_FILE lifecycle actions", async () => {
    const createSpy = vi.fn(async ({ relativePath }) => ({
      fileId: "new-f",
      parentFolderId: null,
      title: relativePath,
      relativePath,
      isFolder: false,
      isEncrypted: false,
      isAiExcluded: false,
      artifactRole: "document" as const,
      etag: "e-new",
      version: 1,
      updatedAt: "2026-11-20T00:00:00.000Z",
    }));
    const deleteSpy = vi.fn(async ({ fileId }) => ({
      fileId,
      deletedAt: "2026-11-20T00:00:00.000Z",
    }));

    const provider = createMockWorkspaceProvider({
      createWorkspaceFile: createSpy,
      deleteWorkspaceFile: deleteSpy,
    });

    const actions: PendingFileLifecycleAction[] = [
      {
        actionId: "create-unapproved",
        type: "CREATE_FILE",
        relativePath: "docs/new-spec.md",
        initialContent: "# Spec",
        rationale: "New doc",
      },
      {
        actionId: "delete-unapproved",
        type: "DELETE_FILE",
        relativePath: "docs/legacy.md",
        fileId: "file-leg",
        rationale: "Cleanup",
      },
      {
        actionId: "delete-approved",
        type: "DELETE_FILE",
        relativePath: "docs/approved-del.md",
        fileId: "file-del-ok",
        rationale: "User approved deletion",
        approved: true,
      },
      {
        actionId: "create-rejected",
        type: "CREATE_FILE",
        relativePath: "docs/rejected.md",
        rationale: "Denied",
        approved: false,
      },
    ];

    // In semi_auto: unapproved CREATE_FILE executes, unapproved DELETE_FILE is held back,
    // approved DELETE_FILE executes, explicitly rejected CREATE_FILE is held back.
    const { ctx, events } = createRuntimeContext(provider, {
      permissionMode: "semi_auto",
    });

    const res = await rawWorkspaceMutatorNode(
      createInitialAgentGraphState({ pending_file_actions: actions }),
      ctx,
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({
      relativePath: "docs/new-spec.md",
      initialContent: "# Spec",
    });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith({ fileId: "file-del-ok" });

    expect(
      res.stateDelta.pending_file_actions?.map((a) => a.actionId).sort(),
    ).toEqual(["create-rejected", "delete-unapproved"]);
    expect(events).toEqual([
      {
        type: "file_mutated",
        fileId: "new-f",
        relativePath: "docs/new-spec.md",
        action: "created",
      },
      {
        type: "file_mutated",
        fileId: "file-del-ok",
        relativePath: "docs/approved-del.md",
        action: "deleted",
      },
    ]);
  });

  it("targets first heading from listHeadingsTree for FAST_LOCAL_EDIT when invalidation_map is empty", async () => {
    mockExecuteStreamingGeneration.mockResolvedValueOnce({
      text: Promise.resolve("## architecture\nPolished typo-free section."),
    });

    const provider = createMockWorkspaceProvider();
    const { ctx, events } = createRuntimeContext(provider, {
      permissionMode: "semi_auto",
    });

    const state = createInitialAgentGraphState({
      classified_intent: "FAST_LOCAL_EDIT",
      user_request: {
        prompt: "Fix typo in architecture heading",
        workspaceId: "ws-n678",
        turnId: "turn-fast",
        targetFileIds: ["doc-arch"],
        permissionMode: "semi_auto",
        selectedSystem2ModelId: "google/gemini-3.8-flash",
      },
    });

    const res = await rawWorkspaceMutatorNode(state, ctx);
    expect(res.status).toBe("COMPLETED");
    expect(provider.listHeadingsTree).toHaveBeenCalledWith(["doc-arch"]);
    expect(provider.mergeSectionThreeWay).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      type: "file_mutated",
      fileId: "doc-arch",
      action: "updated",
    });
  });
});

describe("Cross-Contract Pipeline Handoff: Node 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 (Real applyStateDelta)", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalJevKey = process.env.JEV_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiKeys.mockReturnValue([]);
    delete process.env.GEMINI_API_KEY;
    delete process.env.JEV_API_KEY;
    calibrationStore.resetWindow();
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

  it("propagates state cleanly across all 8 mutation-track canonical nodes including HITL suspend/resume, ledger commit, and section merge", async () => {
    mockExecuteStreamingGeneration.mockResolvedValueOnce({
      text: Promise.resolve("## architecture\nFinalized consensus specification."),
    });

    const provider = createMockWorkspaceProvider();
    const { ctx, events } = createRuntimeContext(provider, {
      permissionMode: "semi_auto",
    });

    // Prompt triggers insufficient_evidence in offline JEV mock so Node 5 produces UNRESOLVED -> Node 6 interrupts & resumes -> Node 7 -> Node 8!
    let state = createInitialAgentGraphState({
      user_request: {
        prompt: "Update architecture spec with low_grounding protocol choice",
        workspaceId: "ws-n678",
        turnId: "turn-e2e-32",
        targetFileIds: ["doc-arch"],
        permissionMode: "semi_auto",
        selectedSystem2ModelId: "google/gemini-3.8-flash",
      },
    });

    // Node 1: Intent & Scope Router
    const n1 = await intentAndScopeRouterNode(state, ctx);
    state = applyStateDelta(state, n1.stateDelta);
    expect(state.classified_intent).toBe("ARCHITECTURAL_MODIFICATION");

    // Node 2: Search Discovery (offline fallback inspects doc-arch#architecture)
    const n2 = await rawSearchDiscoveryNode(state, ctx);
    state = applyStateDelta(state, n2.stateDelta);
    expect(state.search_loop_count).toBe(1);
    expect(state.search_report.evidenceItems[0]).toMatchObject({
      fileId: "doc-arch",
      headingSlug: "architecture",
    });

    // Node 3: Assumption Extractor (offline fallback extracts assumption touching doc-arch#architecture)
    const n3 = await rawAssumptionExtractorNode(state, ctx);
    state = applyStateDelta(state, n3.stateDelta);
    expect(state.assumptions).toHaveLength(1);
    const extractedId = state.assumptions[0].assumptionId;

    // Node 4: Conflict & Weight Gate
    const n4 = await conflictAndWeightGateNode(state, ctx);
    state = applyStateDelta(state, n4.stateDelta);
    expect(state.question_queue).toBeNull();

    // Node 5: JEV Conformal Scorer -> classifies UNRESOLVED (low_grounding)
    const n5 = await rawJevConformalScorerNode(state, ctx);
    state = applyStateDelta(state, n5.stateDelta);
    expect(state.scored_decisions).toHaveLength(1);
    expect(state.unresolved_ledger).toHaveLength(1);

    // Node 6 (Entry): Interrupts for HITL clarification
    const n6Interrupt = await hitlClarificationNode(state, ctx);
    expect(n6Interrupt.status).toBe("INTERRUPTED");
    state = applyStateDelta(state, n6Interrupt.stateDelta);
    const offeredOptionKey =
      state.question_queue!.questions[0].options[0].optionKey;

    // Node 6 (Resume): User selects offered option
    state = applyStateDelta(state, {
      clarification_answers: {
        answers: [
          {
            questionId: extractedId,
            selectedOptionKey: offeredOptionKey,
          },
        ],
      },
    });
    const n6Resume = await hitlClarificationNode(state, ctx);
    expect(n6Resume.status).toBe("COMPLETED");
    state = applyStateDelta(state, n6Resume.stateDelta);
    expect(state.unresolved_ledger).toEqual([]);
    expect(state.scored_decisions[0].provenance).toBe("USER_EXPLICIT_HITL");

    // Node 7: Ledger Commit -> persists to decisions.ledger.json & populates invalidation_map
    const n7 = await ledgerCommitNode(state, ctx);
    state = applyStateDelta(state, n7.stateDelta);
    expect(provider.writeDecisionLedger).toHaveBeenCalledTimes(1);
    expect(state.master_ledger[extractedId]?.provenance).toBe(
      "USER_EXPLICIT_HITL",
    );
    expect(state.invalidation_map[extractedId]).toEqual([
      { fileId: "doc-arch", headingSlug: "architecture" },
    ]);

    // Node 8: Workspace Mutator -> merges section, emits file_mutated, clears invalidation_map
    const n8 = await rawWorkspaceMutatorNode(state, ctx);
    state = applyStateDelta(state, n8.stateDelta);
    expect(provider.mergeSectionThreeWay).toHaveBeenCalledTimes(1);
    expect(state.invalidation_map).toEqual({});
    expect(events).toContainEqual({
      type: "file_mutated",
      fileId: "doc-arch",
      relativePath: "docs/architecture.md",
      action: "updated",
    });
  });
});
