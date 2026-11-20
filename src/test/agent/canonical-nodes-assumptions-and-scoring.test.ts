/**
 * Test Suite: Canonical Nodes 3, 4 & 5 — Assumption Extraction, Conflict/Anti-Domino Gate & JEV Conformal Scorer (Wave 3.2)
 *
 * Verifies ADR-010, ADR-013, ADR-014 & SRS-01 §3.1, §4.3, §5 across real internal seams:
 * - Node 3 (`rawAssumptionExtractorNode`): `intentType`, 3-4 neutral options (`NeutralOptionSchema`, zero `rationaleAndPremises`),
 *   merging tool-discovered decision IDs with `retrieveCandidatePriorDecisions`, and offline fallback
 * - Node 4 (`conflictAndWeightGateNode`): Anti-Domino Gate verdicts (`CONSTRAINED_BY_PRIOR`, `ESCALATE_TO_HITL`, `LOCALIZED_OVERRIDE`),
 *   `question_queue` blast-radius escalation, `resolveATMSCascadeBFS`, and `computeMinimalSectionInvalidationMap`
 * - Node 5 (`rawJevConformalScorerNode` — `BUG-01` fix): filtering `constrainedByPrior`, RAM `vault_ref://` evidence grounding,
 *   post-adjudication rationale synthesis, `scored_decisions` + `unresolved_ledger` population, and conservative provenance invariant
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  rawAssumptionExtractorNode,
  conflictAndWeightGateNode,
  type AnalyzedAssumptionItem,
} from "@/core/agent/nodes/assumption-and-linker-nodes";
import { rawJevConformalScorerNode } from "@/core/agent/nodes/jev-scoring-nodes";
import {
  applyStateDelta,
  createInitialAgentGraphState,
} from "@/core/agent/state";
import type { AgentRuntimeContext } from "@/core/agent/engine/runner";
import type { DecisionGraphNode } from "@/core/agent/atms/dag";
import type { IWorkspaceProvider } from "@/core/workspace/provider";
import type { StreamGovernor } from "@/lib/metering/stream-governor";
import { calibrationStore } from "@/lib/jev/calibration-store";
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
} from "@/lib/vault/ephemeral-memory-map";

const mockExecuteStructuredGeneration = vi.hoisted(() => vi.fn());
const mockGetApiKeys = vi.hoisted(() => vi.fn<() => string[]>());

vi.mock("@/lib/ai/client", () => ({
  executeStructuredGeneration: mockExecuteStructuredGeneration,
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
    questionPrompt: `Prior decision prompt for ${decisionId}`,
    conceptTags: ["data_modeling", "system_architecture"],
    selectedOptionKey: "postgres_neon",
    selectionRationale: "ACID relational store",
    runnerUpOptionKey: "sqlite_local",
    evaluatedAlternatives: [
      {
        optionKey: "postgres_neon",
        neutralSummary: "PostgreSQL on Neon",
        rationaleAndPremises: "Strong consistency",
      },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
    provenance: "USER_EXPLICIT_HITL",
    couplingLevel: 1.8,
    rollbackCost: 1.8,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [{ fileId: "doc-db", headingSlug: "storage" }],
    ...overrides,
  };
}

function createRuntimeContext(
  overrides: Partial<AgentRuntimeContext> = {},
): AgentRuntimeContext {
  return {
    userId: "user-n345",
    workspaceId: "ws-n345",
    threadId: "thread-n345",
    turnId: "turn-n345",
    permissionMode: "safe",
    selectedSystem2ModelId: "google/gemini-3.8-flash",
    workspaceProvider: {} as IWorkspaceProvider,
    streamGovernor: {} as StreamGovernor,
    ephemeralVaultPayloads: new Map(),
    liveDocumentSnapshots: new Map(),
    emitSseEvent: () => {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("Node 3: assumption_extractor_node (assumption-and-linker-nodes.ts)", () => {
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

  it("extracts neutral options with intentType via executeStructuredGeneration and merges tool-discovered & retrieved candidateDecisionIds", async () => {
    mockGetApiKeys.mockReturnValue(["test-gemini-key"]);
    mockExecuteStructuredGeneration.mockResolvedValueOnce({
      object: {
        assumptions: [
          {
            assumptionId: "asmp_cache_1",
            statement: "Introduce Redis read-through cache for workspace trees",
            intentType: "DIRECT_USER_INSTRUCTION",
            conceptTags: ["caching_strategy"],
            affectedSections: [{ fileId: "doc-cache", headingSlug: "redis" }],
            dependsOn: [],
            options: [
              {
                optionKey: "upstash_redis",
                neutralSummary: "Serverless Upstash Redis HTTP cache",
                technicalConstraints: ["Network hop per lookup"],
              },
              {
                optionKey: "local_lru",
                neutralSummary: "In-process LRU memory cache",
                technicalConstraints: ["Per-instance cache divergence"],
              },
              {
                optionKey: "no_cache",
                neutralSummary: "Direct database reads without cache tier",
                technicalConstraints: ["Higher Postgres read load"],
              },
            ],
          },
        ],
      },
    });

    const toolDiscoveredNode = createDecisionNode("dec_tool_found", {
      conceptTags: ["security_architecture"],
      affectedSections: [{ fileId: "doc-other", headingSlug: "other" }],
    });
    const tagMatchedNode = createDecisionNode("dec_cache_prior", {
      conceptTags: ["caching_strategy"],
      affectedSections: [{ fileId: "doc-cache", headingSlug: "redis" }],
    });

    const state = createInitialAgentGraphState({
      user_request: {
        prompt: "Add Redis read-through caching",
        workspaceId: "ws-n345",
        turnId: "turn-n3",
        targetFileIds: ["doc-cache"],
        permissionMode: "safe",
        selectedSystem2ModelId: "google/gemini-4-argon",
      },
      search_report: {
        evidenceItems: [
          {
            fileId: "doc-cache",
            headingSlug: "redis",
            breadcrumb: ["Cache", "Redis"],
            textExcerpt: "Related to prior decision dec_tool_found.",
          },
        ],
        inspectedPaths: ["doc-cache#redis"],
        summary: "Found reference to dec_tool_found",
      },
      master_ledger: {
        dec_tool_found: toolDiscoveredNode,
        dec_cache_prior: tagMatchedNode,
      },
    });

    const res = await rawAssumptionExtractorNode(
      state,
      createRuntimeContext({ selectedSystem2ModelId: "google/gemini-4-argon" }),
    );
    expect(res.status).toBe("COMPLETED");
    expect(mockExecuteStructuredGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "google/gemini-4-argon" }),
    );

    const extracted = (res.stateDelta.assumptions ?? []) as AnalyzedAssumptionItem[];
    expect(extracted).toHaveLength(1);
    expect(extracted[0].intentType).toBe("DIRECT_USER_INSTRUCTION");
    expect(extracted[0].neutralOptions).toHaveLength(3);
    for (const opt of extracted[0].neutralOptions ?? []) {
      expect("rationaleAndPremises" in opt).toBe(false);
    }
    // Merged both tool-discovered (`dec_tool_found`) and retriever-matched (`dec_cache_prior`)
    expect(extracted[0].candidateDecisionIds).toContain("dec_tool_found");
    expect(extracted[0].candidateDecisionIds).toContain("dec_cache_prior");
  });

  it("falls back to deterministic DIRECT_USER_INSTRUCTION assumption with 3 neutral options when offline", async () => {
    const state = createInitialAgentGraphState({
      user_request: {
        prompt: "Add rate limiting middleware",
        workspaceId: "ws-n345",
        turnId: "turn-offline",
        targetFileIds: ["doc-api"],
        permissionMode: "safe",
        selectedSystem2ModelId: "google/gemini-3.8-flash",
      },
      search_report: {
        evidenceItems: [
          {
            fileId: "doc-api",
            headingSlug: "middleware",
            breadcrumb: ["API", "Middleware"],
            textExcerpt: "Hono request pipeline",
          },
        ],
        inspectedPaths: ["doc-api#middleware"],
        summary: "Found API middleware",
      },
    });

    const res = await rawAssumptionExtractorNode(state, createRuntimeContext());
    const extracted = (res.stateDelta.assumptions ?? []) as AnalyzedAssumptionItem[];
    expect(extracted).toHaveLength(1);
    expect(extracted[0].intentType).toBe("DIRECT_USER_INSTRUCTION");
    expect(extracted[0].neutralOptions).toHaveLength(3);
    expect(extracted[0].affectedSections).toEqual([
      { fileId: "doc-api", headingSlug: "middleware" },
    ]);
  });
});

describe("Node 4: conflict_and_weight_gate_node (Anti-Domino Gate & ATMS Cascade)", () => {
  const originalJevKey = process.env.JEV_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.JEV_API_KEY;
  });

  afterEach(() => {
    if (originalJevKey !== undefined) {
      process.env.JEV_API_KEY = originalJevKey;
    } else {
      delete process.env.JEV_API_KEY;
    }
  });

  it("shields CORE/HITL prior decision against INFERRED_COLLATERAL_ASSUMPTION via CONSTRAINED_BY_PRIOR", async () => {
    const corePrior = createDecisionNode("dec_core_db", {
      impactTier: "CORE_ARCHITECTURAL",
      provenance: "USER_EXPLICIT_HITL",
      conceptTags: ["data_modeling"],
      affectedSections: [{ fileId: "doc-db", headingSlug: "storage" }],
    });

    // Statement includes "override" so offline JEV relational linker classifies REOPENS_OR_OVERRIDES
    const collateralOverride: AnalyzedAssumptionItem = {
      assumptionId: "asmp_collateral",
      statement: "Override storage engine to flat JSON files for convenience",
      intentType: "INFERRED_COLLATERAL_ASSUMPTION",
      conceptTags: ["data_modeling"],
      affectedSections: [{ fileId: "doc-db", headingSlug: "storage" }],
      dependsOn: [],
    };

    const state = createInitialAgentGraphState({
      assumptions: [collateralOverride],
      master_ledger: { dec_core_db: corePrior },
    });

    const res = await conflictAndWeightGateNode(state, createRuntimeContext());
    const nextState = applyStateDelta(state, res.stateDelta);

    const updatedAsmp = nextState.assumptions.find(
      (a) => a.assumptionId === "asmp_collateral",
    ) as AnalyzedAssumptionItem | undefined;
    expect(updatedAsmp?.constrainedByPrior).toBe(true);
    expect(nextState.governing_constraints.map((n) => n.decisionId)).toEqual([
      "dec_core_db",
    ]);
    expect(nextState.master_ledger.dec_core_db).toBeDefined();
    expect(nextState.question_queue).toBeNull();
  });

  it("escalates DIRECT_USER_INSTRUCTION overriding a heavy/dependent decision to question_queue (ESCALATE_TO_HITL) with blast-radius count", async () => {
    const corePrior = createDecisionNode("dec_auth_root", {
      impactTier: "CORE_ARCHITECTURAL",
      provenance: "USER_EXPLICIT_HITL",
      conceptTags: ["authentication"],
      dependedBy: ["dec_session_child"],
      affectedSections: [{ fileId: "doc-auth", headingSlug: "tokens" }],
    });
    const childDep = createDecisionNode("dec_session_child", {
      dependsOn: ["dec_auth_root"],
      dependedBy: ["dec_ui_grandchild"],
      conceptTags: ["authentication"],
      affectedSections: [{ fileId: "doc-auth", headingSlug: "sessions" }],
    });
    const grandChildDep = createDecisionNode("dec_ui_grandchild", {
      dependsOn: ["dec_session_child"],
      conceptTags: ["ui_ux"],
      affectedSections: [{ fileId: "doc-ui", headingSlug: "login" }],
    });

    const directOverride: AnalyzedAssumptionItem = {
      assumptionId: "asmp_user_override",
      statement: "Override authentication tokens to opaque session IDs",
      intentType: "DIRECT_USER_INSTRUCTION",
      conceptTags: ["authentication"],
      affectedSections: [{ fileId: "doc-auth", headingSlug: "tokens" }],
      dependsOn: [],
    };

    const state = createInitialAgentGraphState({
      assumptions: [directOverride],
      master_ledger: {
        dec_auth_root: corePrior,
        dec_session_child: childDep,
        dec_ui_grandchild: grandChildDep,
      },
    });

    const res = await conflictAndWeightGateNode(state, createRuntimeContext());
    const nextState = applyStateDelta(state, res.stateDelta);

    expect(nextState.question_queue).not.toBeNull();
    const q = nextState.question_queue!.questions.find(
      (item) => item.questionId === "antidomino_dec_auth_root",
    );
    expect(q).toBeDefined();
    expect(q?.options.map((o) => o.optionKey)).toEqual([
      "preserve_prior",
      "confirm_override",
    ]);
    // Must report both direct + indirect dependents (2 transitive dependents)
    expect(q?.contextExplanation).toContain("2 dependent decision(s)");
  });

  it("permits LOCALIZED_OVERRIDE on low-weight isolated peripheral decision and populates minimal invalidation_map", async () => {
    const lowPeripheral = createDecisionNode("dec_periph_fmt", {
      impactTier: "PERIPHERAL",
      isLoadBearing: false,
      provenance: undefined,
      couplingLevel: 0.2,
      rollbackCost: 0.2, // W = 14 (< 25, 0 dependents)
      conceptTags: ["documentation"],
      affectedSections: [{ fileId: "doc-style", headingSlug: "formatting" }],
    });

    const localizedOverride: AnalyzedAssumptionItem = {
      assumptionId: "asmp_local_fmt",
      statement: "Override formatting style to 2-space indentation",
      intentType: "DIRECT_USER_INSTRUCTION",
      conceptTags: ["documentation"],
      affectedSections: [{ fileId: "doc-style", headingSlug: "formatting" }],
      dependsOn: [],
    };

    const state = createInitialAgentGraphState({
      assumptions: [localizedOverride],
      master_ledger: { dec_periph_fmt: lowPeripheral },
    });

    const res = await conflictAndWeightGateNode(state, createRuntimeContext());
    // Evicted from Node 4's updatedLedger delta AND preserved across real applyStateDelta
    expect(res.stateDelta.master_ledger?.dec_periph_fmt).toBeUndefined();
    expect(res.stateDelta.replaceMasterLedger).toBe(true);
    const nextState = applyStateDelta(state, res.stateDelta);
    expect(nextState.master_ledger.dec_periph_fmt).toBeUndefined();
    expect(nextState.invalidation_map.dec_periph_fmt).toEqual([
      { fileId: "doc-style", headingSlug: "formatting" },
    ]);
    expect(nextState.question_queue).toBeNull();
  });
});

describe("Node 5: jev_conformal_scorer_node (jev-scoring-nodes.ts — BUG-01 & Epistemic Grounding)", () => {
  const originalJevKey = process.env.JEV_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.JEV_API_KEY;
    calibrationStore.resetWindow();
  });

  afterEach(() => {
    if (originalJevKey !== undefined) {
      process.env.JEV_API_KEY = originalJevKey;
    } else {
      delete process.env.JEV_API_KEY;
    }
  });

  it("skips constrainedByPrior assumptions, grounds evaluation in RAM-dereferenced vault evidence & governing constraints, and populates scored_decisions + unresolved_ledger (BUG-01)", async () => {
    await runWithEphemeralVaultScope(async () => {
      const vaultPtr = storeEphemeralVaultSection(
        "doc-secret",
        "compliance",
        "Strict zero-knowledge compliance rule",
      );

      const state = createInitialAgentGraphState({
        assumptions: [
          {
            assumptionId: "asmp_blocked",
            statement: "Blocked collateral assumption",
            intentType: "INFERRED_COLLATERAL_ASSUMPTION",
            conceptTags: ["system_architecture"],
            affectedSections: [],
            dependsOn: [],
            constrainedByPrior: true,
          } as AnalyzedAssumptionItem,
          {
            assumptionId: "asmp_clear_win",
            statement: "Select zero-knowledge checkpoint cipher",
            intentType: "DIRECT_USER_INSTRUCTION",
            conceptTags: ["security_cryptography"],
            affectedSections: [{ fileId: "doc-secret", headingSlug: "compliance" }],
            dependsOn: ["dec_prior_zk"],
          },
          {
            assumptionId: "asmp_abstain_low_grounding",
            statement: "Decision with insufficient_evidence requiring abstention",
            intentType: "DIRECT_USER_INSTRUCTION",
            conceptTags: ["system_architecture"],
            affectedSections: [{ fileId: "doc-secret", headingSlug: "compliance" }],
            dependsOn: [],
          },
        ],
        search_report: {
          evidenceItems: [
            {
              fileId: "doc-secret",
              headingSlug: "compliance",
              breadcrumb: ["Security", "Compliance"],
              textExcerpt: vaultPtr,
              vaultRef: vaultPtr,
            },
          ],
          inspectedPaths: ["doc-secret#compliance"],
          summary: "Compliance section inspected",
        },
        governing_constraints: [
          createDecisionNode("dec_prior_zk", {
            topicSlug: "zk_baseline",
            changeWeight: { total: 85, structural: 45, provenance: 25, topology: 12, surface: 3 },
          }),
        ],
      });

      const res = await rawJevConformalScorerNode(state, createRuntimeContext());
      const nextState = applyStateDelta(state, res.stateDelta);

      // Constrained assumption was skipped; 2 open assumptions scored
      expect(nextState.scored_decisions).toHaveLength(2);
      expect(
        nextState.scored_decisions.find((d) => d.decisionId === "asmp_blocked"),
      ).toBeUndefined();

      const clearWin = nextState.scored_decisions.find(
        (d) => d.decisionId === "asmp_clear_win",
      );
      expect(clearWin?.status).toBe("APPROVED_DIRECT");
      expect(String(clearWin?.selectionRationale)).toContain(
        "Evidence: [doc-secret#compliance].",
      );
      expect(String(clearWin?.selectionRationale)).toContain(
        "Prior governing decisions: [dec_prior_zk].",
      );

      // Unresolved item recorded in unresolved_ledger (BUG-01)
      expect(nextState.unresolved_ledger).toHaveLength(1);
      expect(nextState.unresolved_ledger[0].decisionId).toBe(
        "asmp_abstain_low_grounding",
      );
    });
  });

  it("ADR-014 / SRS-01 §5.1 invariant: APPROVED_CONSERVATIVE decision must NOT be stamped with SYSTEM1_DIRECT_APS provenance", async () => {
    // Use HTTP boundary stub returning calibrated probabilities that deterministically
    // classify as APPROVED_CONSERVATIVE under typesafe/jev-1.13 priors (qHatCore05=0.08, qHatPeriph20=0.22):
    // p1 = 0.80 / 0.99 = 0.808 -> s = 0.192 (> 0.08 so |C_core|=0, <= 0.22 so |C_periph|=1), margin = 0.616 >= 0.15
    process.env.JEV_API_KEY = "test-jev-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            decisions: [
              {
                decisionId: "asmp_peripheral_conservative",
                evidenceGrounding: 0.9,
                couplingLevel: 0.4,
                rollbackCost: 0.3,
                probabilities: {
                  opt_a: 0.8,
                  opt_b: 0.19,
                  opt_c: 0.0,
                  insufficient_evidence: 0.01,
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const state = createInitialAgentGraphState({
      assumptions: [
        {
          assumptionId: "asmp_peripheral_conservative",
          statement: "Choose peripheral conservative formatting option",
          intentType: "DIRECT_USER_INSTRUCTION",
          conceptTags: ["documentation"],
          affectedSections: [{ fileId: "doc-fmt", headingSlug: "style" }],
          dependsOn: [],
          neutralOptions: [
            {
              optionKey: "opt_a",
              neutralSummary: "Option A peripheral layout",
              technicalConstraints: ["Local formatting scope"],
            },
            {
              optionKey: "opt_b",
              neutralSummary: "Option B peripheral layout",
              technicalConstraints: ["Alternate spacing style"],
            },
            {
              optionKey: "opt_c",
              neutralSummary: "Option C peripheral layout",
              technicalConstraints: ["Minimalist style"],
            },
          ],
        } as AnalyzedAssumptionItem,
      ],
    });

    const res = await rawJevConformalScorerNode(state, createRuntimeContext());
    const scored = res.stateDelta.scored_decisions?.[0];
    expect(scored?.status).toBe("APPROVED_CONSERVATIVE");
    // Per ADR-014 §2.1 & SRS-01 §5.1, conservative approvals carry 0 provenance weight
    // and MUST NOT be tagged SYSTEM1_DIRECT_APS (which awards +10..15 provenance points).
    expect(scored?.provenance).not.toBe("SYSTEM1_DIRECT_APS");
  });
});
