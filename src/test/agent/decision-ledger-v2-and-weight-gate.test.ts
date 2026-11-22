/**
 * Test Suite: DecisionLedgerDocument v2.0, Graph Traversal Tools, 4-Source W(d) & Anti-Domino Gate (Wave 3.1)
 *
 * Verifies ADR-012, ADR-014 & SRS-01 §4–§5 contracts:
 * 1. `assertAcyclicDecisionGraph` (3-color DFS cycle detection + diamond DAG acceptance)
 * 2. `normalizeLedgerGraphIntegrity`, `normalizeProviderLedgerToV2`, `toProviderLedgerDocument`
 * 3. 4 pure graph exploration functions: `searchDecisionLedger`, `getDecisionNodeDetails`,
 *    `traverseDecisionDependencies`, `getSectionGoverningDecisions`
 * 4. 4 Vercel AI SDK `tool()` wrappers in `createDecisionGraphTools`
 * 5. `computeDecisionChangeWeight` deterministic 4-source formula W(d) in [10, 100]
 * 6. `evaluateAntiDominoGate` intent-aware threshold matrix
 */

import { describe, it, expect } from "vitest";
import {
  assertAcyclicDecisionGraph,
  normalizeLedgerGraphIntegrity,
  normalizeProviderLedgerToV2,
  toProviderLedgerDocument,
  searchDecisionLedger,
  getDecisionNodeDetails,
  traverseDecisionDependencies,
  getSectionGoverningDecisions,
  type DecisionGraphNode,
  type DecisionLedgerDocument,
  type DirectedDecisionEdge,
} from "@/core/agent/atms/dag";
import { createDecisionGraphTools } from "@/core/agent/tools/decision-graph-tools";
import {
  computeDecisionChangeWeight,
  evaluateAntiDominoGate,
} from "@/core/agent/atms/invalidation";
import { PROJECT_TAXONOMY_SENTINEL_ID } from "@/core/agent/taxonomy/predefined-tags";

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
        neutralSummary: "Primary architectural option",
        rationaleAndPremises: "Meets latency target",
      },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "PERIPHERAL",
    isLoadBearing: false,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [],
    ...overrides,
  };
}

function createLedgerDoc(
  nodes: DecisionGraphNode[],
  edges: DirectedDecisionEdge[] = [],
  overrides: Partial<DecisionLedgerDocument> = {},
): DecisionLedgerDocument {
  const nodeMap: Record<string, DecisionGraphNode> = {};
  for (const n of nodes) {
    nodeMap[n.decisionId] = n;
  }
  return {
    schemaVersion: "2.0.0",
    workspaceId: "ws-ledger-test",
    updatedAt: "2026-11-20T00:00:00.000Z",
    taxonomy: null,
    nodes: nodeMap,
    edges,
    ...overrides,
  };
}

describe("1. DecisionLedgerDocument v2.0 Acyclicity & Graph Integrity (atms/dag.ts)", () => {
  describe("assertAcyclicDecisionGraph", () => {
    it("accepts a complex diamond DAG without false-positive cycle errors", () => {
      // Diamond: D -> B, D -> C, B -> A, C -> A
      const nodes: Record<string, DecisionGraphNode> = {
        A: createDecisionNode("A"),
        B: createDecisionNode("B", { dependsOn: ["A"] }),
        C: createDecisionNode("C", { dependsOn: ["A"] }),
        D: createDecisionNode("D", { dependsOn: ["B", "C"] }),
      };
      const edges: DirectedDecisionEdge[] = [
        { edgeId: "e1", sourceDecisionId: "B", targetDecisionId: "A", relation: "DEPENDS_ON" },
        { edgeId: "e2", sourceDecisionId: "C", targetDecisionId: "A", relation: "REFINES" },
        { edgeId: "e3", sourceDecisionId: "D", targetDecisionId: "B", relation: "DEPENDS_ON" },
        { edgeId: "e4", sourceDecisionId: "D", targetDecisionId: "C", relation: "DEPENDS_ON" },
      ];

      expect(() => assertAcyclicDecisionGraph(nodes, edges)).not.toThrow();
    });

    it.each<{
      name: string;
      nodes: Record<string, DecisionGraphNode>;
      edges: DirectedDecisionEdge[];
      expectedPathFragment: string;
    }>([
      {
        name: "self-loop in dependsOn",
        nodes: { A: createDecisionNode("A", { dependsOn: ["A"] }) },
        edges: [],
        expectedPathFragment: "A -> A",
      },
      {
        name: "2-node mutual cycle via dependsOn",
        nodes: {
          A: createDecisionNode("A", { dependsOn: ["B"] }),
          B: createDecisionNode("B", { dependsOn: ["A"] }),
        },
        edges: [],
        expectedPathFragment: "A -> B -> A",
      },
      {
        name: "3-node cycle introduced exclusively via edges[]",
        nodes: {
          A: createDecisionNode("A"),
          B: createDecisionNode("B"),
          C: createDecisionNode("C"),
        },
        edges: [
          { edgeId: "e1", sourceDecisionId: "A", targetDecisionId: "B", relation: "DEPENDS_ON" },
          { edgeId: "e2", sourceDecisionId: "B", targetDecisionId: "C", relation: "REFINES" },
          { edgeId: "e3", sourceDecisionId: "C", targetDecisionId: "A", relation: "DEPENDS_ON" },
        ],
        expectedPathFragment: "A -> B -> C -> A",
      },
    ])("throws cycle error naming path on $name", ({ nodes, edges, expectedPathFragment }) => {
      expect(() => assertAcyclicDecisionGraph(nodes, edges)).toThrow(
        new RegExp(`ATMS Decision Graph cycle detected:.*${expectedPathFragment}`),
      );
    });
  });

  describe("normalizeLedgerGraphIntegrity & Legacy Provider Bridge", () => {
    it("synchronizes edges[], dependsOn[], dependedBy[], mirrors decisions, preserves explicit REFINES, and strips sentinels/self-loops", () => {
      const rawDoc = createLedgerDoc(
        [
          createDecisionNode("dec_root", {
            dependedBy: ["dec_child", "dec_root", PROJECT_TAXONOMY_SENTINEL_ID],
          }),
          createDecisionNode("dec_child", {
            dependsOn: ["dec_root", "dec_child"],
          }),
          createDecisionNode("dec_leaf"),
          createDecisionNode(PROJECT_TAXONOMY_SENTINEL_ID),
        ],
        [
          {
            edgeId: "explicit-refines",
            sourceDecisionId: "dec_child",
            targetDecisionId: "dec_root",
            relation: "REFINES",
            justification: "Refines root policy",
          },
          {
            edgeId: "edge-leaf-to-child",
            sourceDecisionId: "dec_leaf",
            targetDecisionId: "dec_child",
            relation: "DEPENDS_ON",
          },
          {
            edgeId: "self-loop-edge",
            sourceDecisionId: "dec_leaf",
            targetDecisionId: "dec_leaf",
            relation: "DEPENDS_ON",
          },
          {
            edgeId: "sentinel-edge",
            sourceDecisionId: "dec_leaf",
            targetDecisionId: PROJECT_TAXONOMY_SENTINEL_ID,
            relation: "DEPENDS_ON",
          },
        ],
      );

      const normalized = normalizeLedgerGraphIntegrity(rawDoc);

      expect(normalized.schemaVersion).toBe("2.0.0");
      expect(Object.keys(normalized.nodes).sort()).toEqual([
        "dec_child",
        "dec_leaf",
        "dec_root",
      ]);
      expect(normalized.decisions).toEqual(normalized.nodes);

      // Bidirectional adjacency reconciled cleanly
      expect(normalized.nodes.dec_root.dependedBy).toEqual(["dec_child"]);
      expect(normalized.nodes.dec_child.dependsOn).toEqual(["dec_root"]);
      expect(normalized.nodes.dec_child.dependedBy).toEqual(["dec_leaf"]);
      expect(normalized.nodes.dec_leaf.dependsOn).toEqual(["dec_child"]);

      // Explicit REFINES edge preserved without duplicate synthesized DEPENDS_ON
      expect(normalized.edges).toHaveLength(2);
      expect(
        normalized.edges.find((e) => e.sourceDecisionId === "dec_child")
          ?.relation,
      ).toBe("REFINES");
    });

    it("upgrades legacy Phase 2 { decisions } payloads to validated v2.0 documents and serializes back via toProviderLedgerDocument", () => {
      const legacyPayload = {
        decisions: {
          dec_a: createDecisionNode("dec_a"),
          dec_b: createDecisionNode("dec_b", { dependsOn: ["dec_a"] }),
        },
      };

      const v2 = normalizeProviderLedgerToV2(legacyPayload, "ws-upgraded");
      expect(v2.schemaVersion).toBe("2.0.0");
      expect(v2.workspaceId).toBe("ws-upgraded");
      expect(v2.nodes.dec_a.dependedBy).toEqual(["dec_b"]);
      expect(v2.edges).toHaveLength(1);
      expect(v2.edges[0]).toMatchObject({
        sourceDecisionId: "dec_b",
        targetDecisionId: "dec_a",
        relation: "DEPENDS_ON",
      });

      const serialized = toProviderLedgerDocument(v2);
      expect(serialized.decisions).toEqual(serialized.nodes);
    });
  });
});

describe("2. Four Pure Graph Exploration Functions & Vercel AI SDK tool() Wrappers", () => {
  // Graph topology:
  // dec_crypto (CORE, loadBearing, W=85) <-- dec_auth (PERIPHERAL, not loadBearing, W=42) <-- dec_ui (PERIPHERAL, W=20)
  //                                     <-- dec_sync (CORE, loadBearing, W=70)
  const doc = normalizeLedgerGraphIntegrity(
    createLedgerDoc(
      [
        createDecisionNode("dec_crypto", {
          topicSlug: "vault_encryption",
          questionPrompt: "Select symmetric cipher for zero-knowledge vault",
          conceptTags: ["cryptography", "security"],
          selectedOptionKey: "aes_256_gcm",
          impactTier: "CORE_ARCHITECTURAL",
          isLoadBearing: true,
          changeWeight: { total: 85, structural: 45, provenance: 25, topology: 12, surface: 3 },
          affectedSections: [{ fileId: "doc-sec", headingSlug: "encryption" }],
        }),
        createDecisionNode("dec_auth", {
          topicSlug: "session_tokens",
          questionPrompt: "How should auth sessions bind to vault keys?",
          conceptTags: ["authentication", "security"],
          dependsOn: ["dec_crypto"],
          impactTier: "PERIPHERAL",
          isLoadBearing: false,
          changeWeight: { total: 42, structural: 20, provenance: 12, topology: 6, surface: 4 },
          affectedSections: [{ fileId: "doc-auth", headingSlug: "sessions" }],
        }),
        createDecisionNode("dec_sync", {
          topicSlug: "offline_sync",
          questionPrompt: "How to merge encrypted offline diffs?",
          conceptTags: ["sync", "cryptography"],
          dependsOn: ["dec_crypto"],
          impactTier: "CORE_ARCHITECTURAL",
          isLoadBearing: true,
          changeWeight: { total: 70, structural: 36, provenance: 25, topology: 0, surface: 9 },
          affectedSections: [
            { fileId: "doc-sync", headingSlug: "diff3-merge" },
            { fileId: "doc-sec", headingSlug: "sync-envelope" },
          ],
        }),
        createDecisionNode("dec_ui", {
          topicSlug: "login_banner",
          questionPrompt: "Display session status badge in sidebar",
          conceptTags: ["ui_ux"],
          dependsOn: ["dec_auth"],
          impactTier: "PERIPHERAL",
          isLoadBearing: false,
          changeWeight: { total: 20, structural: 14, provenance: 0, topology: 0, surface: 6 },
          affectedSections: [{ fileId: "doc-ui", headingSlug: "sidebar" }],
        }),
      ],
      [
        {
          edgeId: "e-auth-crypto",
          sourceDecisionId: "dec_auth",
          targetDecisionId: "dec_crypto",
          relation: "DEPENDS_ON",
        },
        {
          edgeId: "e-sync-crypto",
          sourceDecisionId: "dec_sync",
          targetDecisionId: "dec_crypto",
          relation: "REFINES",
        },
        {
          edgeId: "e-ui-auth",
          sourceDecisionId: "dec_ui",
          targetDecisionId: "dec_auth",
          relation: "DEPENDS_ON",
        },
      ],
    ),
  );

  it("searchDecisionLedger filters by query, case-insensitive conceptTags, and fileId, sorting by changeWeight.total descending", () => {
    const allSorted = searchDecisionLedger(doc, {});
    expect(allSorted.map((n) => n.decisionId)).toEqual([
      "dec_crypto",
      "dec_sync",
      "dec_auth",
      "dec_ui",
    ]);

    const byTag = searchDecisionLedger(doc, { conceptTags: ["CRYPTOGRAPHY"] });
    expect(byTag.map((n) => n.decisionId)).toEqual(["dec_crypto", "dec_sync"]);

    const byFileAndQuery = searchDecisionLedger(doc, {
      fileId: "doc-sec",
      query: "diff",
    });
    expect(byFileAndQuery.map((n) => n.decisionId)).toEqual(["dec_sync"]);

    // Deep-clone isolation
    allSorted[0].conceptTags.push("mutated");
    expect(doc.nodes.dec_crypto.conceptTags).not.toContain("mutated");
  });

  it("getDecisionNodeDetails returns cloned node with all incoming and outgoing incident edges, or null for unknown/sentinel IDs", () => {
    const details = getDecisionNodeDetails(doc, { decisionId: "dec_auth" });
    expect(details.node?.decisionId).toBe("dec_auth");
    expect(details.incidentEdges.map((e) => e.edgeId).sort()).toEqual([
      "e-auth-crypto",
      "e-ui-auth",
    ]);

    expect(
      getDecisionNodeDetails(doc, { decisionId: "nonexistent" }),
    ).toEqual({ node: null, incidentEdges: [] });
    expect(
      getDecisionNodeDetails(doc, { decisionId: PROJECT_TAXONOMY_SENTINEL_ID }),
    ).toEqual({ node: null, incidentEdges: [] });
  });

  it("traverseDecisionDependencies respects upstream, downstream, and both directions across maxDepth 1, 2, and 'all' with valid topological order", () => {
    const up1 = traverseDecisionDependencies(doc, {
      decisionId: "dec_ui",
      direction: "upstream",
      maxDepth: 1,
    });
    expect(up1.visitedNodes.map((n) => n.decisionId).sort()).toEqual([
      "dec_auth",
      "dec_ui",
    ]);

    const upAll = traverseDecisionDependencies(doc, {
      decisionId: "dec_ui",
      direction: "upstream",
      maxDepth: "all",
    });
    expect(upAll.visitedNodes.map((n) => n.decisionId).sort()).toEqual([
      "dec_auth",
      "dec_crypto",
      "dec_ui",
    ]);
    // Dependencies must appear before dependents in topologicalOrder
    expect(upAll.topologicalOrder.indexOf("dec_crypto")).toBeLessThan(
      upAll.topologicalOrder.indexOf("dec_auth"),
    );
    expect(upAll.topologicalOrder.indexOf("dec_auth")).toBeLessThan(
      upAll.topologicalOrder.indexOf("dec_ui"),
    );

    const down1 = traverseDecisionDependencies(doc, {
      decisionId: "dec_crypto",
      direction: "downstream",
      maxDepth: 1,
    });
    expect(down1.visitedNodes.map((n) => n.decisionId).sort()).toEqual([
      "dec_auth",
      "dec_crypto",
      "dec_sync",
    ]);

    const down2 = traverseDecisionDependencies(doc, {
      decisionId: "dec_crypto",
      direction: "downstream",
      maxDepth: 2,
    });
    expect(down2.visitedNodes.map((n) => n.decisionId).sort()).toEqual([
      "dec_auth",
      "dec_crypto",
      "dec_sync",
      "dec_ui",
    ]);

    const both1 = traverseDecisionDependencies(doc, {
      decisionId: "dec_auth",
      direction: "both",
      maxDepth: 1,
    });
    expect(both1.visitedNodes.map((n) => n.decisionId).sort()).toEqual([
      "dec_auth",
      "dec_crypto",
      "dec_ui",
    ]);
  });

  it("traverseDecisionDependencies terminates safely even on an unnormalized cyclic graph", () => {
    const cyclicDoc = createLedgerDoc([
      createDecisionNode("c1", { dependsOn: ["c2"], dependedBy: ["c2"] }),
      createDecisionNode("c2", { dependsOn: ["c1"], dependedBy: ["c1"] }),
    ]);

    const res = traverseDecisionDependencies(cyclicDoc, {
      decisionId: "c1",
      direction: "both",
      maxDepth: "all",
    });
    expect(res.visitedNodes.map((n) => n.decisionId).sort()).toEqual(["c1", "c2"]);
  });

  it("getSectionGoverningDecisions traverses through non-load-bearing intermediates to collect load-bearing ancestors", () => {
    // doc-ui#sidebar -> direct: dec_ui -> parent dec_auth (isLoadBearing: false) -> grandparent dec_crypto (isLoadBearing: true)
    const governing = getSectionGoverningDecisions(doc, {
      fileId: "doc-ui",
      headingSlug: "sidebar",
    });

    expect(governing.directNodes.map((n) => n.decisionId)).toEqual(["dec_ui"]);
    expect(governing.loadBearingAncestors.map((n) => n.decisionId)).toEqual([
      "dec_crypto",
    ]);
    expect(governing.allGoverningNodes.map((n) => n.decisionId)).toEqual([
      "dec_crypto",
      "dec_ui",
    ]);

    // File-level query without headingSlug matches all sections in doc-sec
    const fileLevel = getSectionGoverningDecisions(doc, { fileId: "doc-sec" });
    expect(fileLevel.directNodes.map((n) => n.decisionId)).toEqual([
      "dec_crypto",
      "dec_sync",
    ]);
  });

  it("createDecisionGraphTools wires all 4 Vercel AI SDK tool() wrappers with async provider support", async () => {
    const tools = createDecisionGraphTools(async () => doc);
    expect(Object.keys(tools).sort()).toEqual([
      "getDecisionNodeDetails",
      "getSectionGoverningDecisions",
      "searchDecisionLedger",
      "traverseDecisionDependencies",
    ]);

    const execCtx: Parameters<
      NonNullable<typeof tools.searchDecisionLedger.execute>
    >[1] = { toolCallId: "tc-1", messages: [], context: {} };

    const searchOut = await tools.searchDecisionLedger.execute!(
      { conceptTags: ["security"] },
      execCtx,
    );
    expect((searchOut as DecisionGraphNode[]).map((n) => n.decisionId)).toEqual(
      ["dec_crypto", "dec_auth"],
    );

    const detailsOut = await tools.getDecisionNodeDetails.execute!(
      { decisionId: "dec_sync" },
      execCtx,
    );
    expect((detailsOut as { node: DecisionGraphNode | null }).node?.decisionId).toBe(
      "dec_sync",
    );

    const traverseOut = await tools.traverseDecisionDependencies.execute!(
      { decisionId: "dec_ui", direction: "upstream", maxDepth: "all" },
      execCtx,
    );
    expect(
      (traverseOut as { topologicalOrder: string[] }).topologicalOrder,
    ).toEqual(["dec_crypto", "dec_auth", "dec_ui"]);

    const govOut = await tools.getSectionGoverningDecisions.execute!(
      { fileId: "doc-ui", headingSlug: "sidebar" },
      execCtx,
    );
    expect(
      (govOut as { loadBearingAncestors: DecisionGraphNode[] })
        .loadBearingAncestors.map((n) => n.decisionId),
    ).toEqual(["dec_crypto"]);
  });
});

describe("3. 4-Source Decision Change Weight W(d) & Anti-Domino Gate (atms/invalidation.ts)", () => {
  describe("computeDecisionChangeWeight (SRS-01 §5.1)", () => {
    it.each([
      {
        name: "minimum floor bounds (0 coupling, 0 rollback, no provenance, 0 deps, 0 sections)",
        node: createDecisionNode("d_min", {
          couplingLevel: 0,
          rollbackCost: 0,
          provenance: undefined,
          affectedSections: [],
        }),
        extraNodes: [] as DecisionGraphNode[],
        expected: { total: 10, structural: 10, provenance: 0, topology: 0, surface: 0 },
      },
      {
        name: "maximum ceiling bounds (2 coupling, 2 rollback, USER_EXPLICIT_HITL, 4 direct deps, 3 files/3 sections)",
        node: createDecisionNode("d_max", {
          couplingLevel: 2,
          rollbackCost: 2,
          provenance: "USER_EXPLICIT_HITL",
          dependedBy: ["c1", "c2", "c3", "c4"],
          affectedSections: [
            { fileId: "f1", headingSlug: "s1" },
            { fileId: "f2", headingSlug: "s2" },
            { fileId: "f3", headingSlug: "s3" },
          ],
        }),
        extraNodes: [
          createDecisionNode("c1"),
          createDecisionNode("c2"),
          createDecisionNode("c3"),
          createDecisionNode("c4"),
        ],
        expected: { total: 100, structural: 45, provenance: 25, topology: 20, surface: 10 },
      },
      {
        name: "SYSTEM1_DIRECT_APS margin scaling + diamond topology (2 direct + 1 unique indirect) + 2 files/2 sections",
        node: createDecisionNode("d_mid", {
          couplingLevel: 1.0,
          rollbackCost: 1.0,
          provenance: "SYSTEM1_DIRECT_APS",
          dominanceMargin: 0.6, // 10 + round(3) = 13
          dependedBy: ["b1", "b2"],
          affectedSections: [
            { fileId: "f1", headingSlug: "h1" },
            { fileId: "f1", headingSlug: "h1" }, // duplicate ignored
            { fileId: "f2", headingSlug: "h2" },
          ],
        }),
        extraNodes: [
          createDecisionNode("b1", { dependedBy: ["grandchild"] }),
          createDecisionNode("b2", { dependedBy: ["grandchild"] }),
          createDecisionNode("grandchild"),
        ],
        // structural: round(10 + 17.5 * 1) = 28
        // provenance: 10 + round(5 * 0.6) = 13
        // topology: 6*2 + 3*1 = 15 (grandchild counted once)
        // surface: 3*(2-1) + 2*2 = 7
        // total: 28 + 13 + 15 + 7 = 63
        expected: { total: 63, structural: 28, provenance: 13, topology: 15, surface: 7 },
      },
      {
        name: "defaults when couplingLevel/rollbackCost omitted (CORE -> 1.5 -> 36; out-of-range margin clamped)",
        node: createDecisionNode("d_core_default", {
          impactTier: "CORE_ARCHITECTURAL",
          provenance: "SYSTEM1_DIRECT_APS",
          dominanceMargin: 1.8, // clamped to 1 -> 15
          affectedSections: [{ fileId: "f1", headingSlug: "h1" }], // 3*0 + 2*1 = 2
        }),
        extraNodes: [],
        expected: { total: 53, structural: 36, provenance: 15, topology: 0, surface: 2 },
      },
      {
        name: "clamps NaN and negative/oversized structural inputs safely",
        node: createDecisionNode("d_clamp", {
          couplingLevel: Number.NaN, // clamped to 0
          rollbackCost: 99, // clamped to 2 -> avg 1 -> round(10 + 17.5) = 28
        }),
        extraNodes: [],
        expected: { total: 28, structural: 28, provenance: 0, topology: 0, surface: 0 },
      },
      {
        name: "clamps Infinity/-Infinity to min bounds and caps W(d) <= 100 across depth-3+ transitive dependents",
        node: createDecisionNode("d_inf_depth", {
          couplingLevel: Number.POSITIVE_INFINITY, // non-finite -> clamped to 0
          rollbackCost: Number.NEGATIVE_INFINITY, // non-finite -> clamped to 0 -> structural = 10
          provenance: "SYSTEM1_DIRECT_APS",
          dominanceMargin: Number.POSITIVE_INFINITY, // non-finite -> clamped to 0 -> provenance = 10
          dependedBy: ["d1", "d2", "d3", "d4"], // 4 direct (24 raw, capped at 20)
          affectedSections: [
            { fileId: "f1", headingSlug: "s1" },
            { fileId: "f2", headingSlug: "s2" },
            { fileId: "f3", headingSlug: "s3" },
            { fileId: "f4", headingSlug: "s4" },
          ], // raw surface > 10, capped at 10
        }),
        extraNodes: [
          createDecisionNode("d1", { dependedBy: ["d1_child"] }),
          createDecisionNode("d1_child", { dependedBy: ["d1_grandchild"] }),
          createDecisionNode("d1_grandchild", { dependedBy: ["d_inf_depth"] }), // cycle back to root safely ignored
          createDecisionNode("d2", { dependedBy: ["d2_child"] }),
          createDecisionNode("d2_child"),
          createDecisionNode("d3"),
          createDecisionNode("d4"),
        ],
        expected: { total: 50, structural: 10, provenance: 10, topology: 20, surface: 10 },
      },
    ])("computes exact 4-source breakdown for $name", ({ node, extraNodes, expected }) => {
      const allNodes: Record<string, DecisionGraphNode> = {
        [node.decisionId]: node,
      };
      for (const extra of extraNodes) {
        allNodes[extra.decisionId] = extra;
      }

      expect(computeDecisionChangeWeight(node, allNodes)).toEqual(expected);
    });
  });

  describe("evaluateAntiDominoGate (ADR-014 & SRS-01 §5.2)", () => {
    it.each([
      // --- INFERRED_COLLATERAL_ASSUMPTION ---
      {
        name: "collateral vs W=40 peripheral node -> CONSTRAINED_BY_PRIOR (exact threshold >= 40)",
        intentType: "INFERRED_COLLATERAL_ASSUMPTION" as const,
        priorNode: createDecisionNode("p_w40", {
          impactTier: "PERIPHERAL",
          couplingLevel: 1.0, // structural = 28
          rollbackCost: 1.0,
          provenance: "SYSTEM1_DIRECT_APS",
          dominanceMargin: 0.4, // provenance = 12 -> total = 40
        }),
        dependents: [] as DecisionGraphNode[],
        expected: "CONSTRAINED_BY_PRIOR",
      },
      {
        name: "collateral vs USER_EXPLICIT_HITL low-weight node -> CONSTRAINED_BY_PRIOR",
        intentType: "INFERRED_COLLATERAL_ASSUMPTION" as const,
        priorNode: createDecisionNode("p_hitl", {
          impactTier: "PERIPHERAL",
          couplingLevel: 0,
          rollbackCost: 0, // structural = 10
          provenance: "USER_EXPLICIT_HITL", // provenance = 25 -> total = 35 < 40, still shielded by HITL!
        }),
        dependents: [] as DecisionGraphNode[],
        expected: "CONSTRAINED_BY_PRIOR",
      },
      {
        name: "collateral vs CORE_ARCHITECTURAL low-weight node -> CONSTRAINED_BY_PRIOR",
        intentType: "INFERRED_COLLATERAL_ASSUMPTION" as const,
        priorNode: createDecisionNode("p_core", {
          impactTier: "CORE_ARCHITECTURAL",
          couplingLevel: 0,
          rollbackCost: 0, // total = 10, still shielded by CORE_ARCHITECTURAL!
        }),
        dependents: [] as DecisionGraphNode[],
        expected: "CONSTRAINED_BY_PRIOR",
      },
      {
        name: "collateral vs W=25 peripheral node with 0 dependents -> ESCALATE_TO_HITL (exact threshold >= 25)",
        intentType: "INFERRED_COLLATERAL_ASSUMPTION" as const,
        priorNode: createDecisionNode("p_w25", {
          impactTier: "PERIPHERAL",
          couplingLevel: 0.5,
          rollbackCost: 0.5, // structural = 19
          affectedSections: [
            { fileId: "f1", headingSlug: "s1" },
            { fileId: "f1", headingSlug: "s2" },
            { fileId: "f1", headingSlug: "s3" },
          ], // surface = 6 -> total = 25
        }),
        dependents: [] as DecisionGraphNode[],
        expected: "ESCALATE_TO_HITL",
      },
      {
        name: "collateral vs W=16 peripheral node with 1 dependent -> ESCALATE_TO_HITL (D+ >= 1)",
        intentType: "INFERRED_COLLATERAL_ASSUMPTION" as const,
        priorNode: createDecisionNode("p_dep1", {
          impactTier: "PERIPHERAL",
          couplingLevel: 0,
          rollbackCost: 0, // structural = 10
          dependedBy: ["child_1"], // topology = 6 -> total = 16 < 25, but D+ = 1
        }),
        dependents: [createDecisionNode("child_1")],
        expected: "ESCALATE_TO_HITL",
      },
      {
        name: "collateral vs W=24 peripheral node with 0 dependents -> LOCALIZED_OVERRIDE",
        intentType: "INFERRED_COLLATERAL_ASSUMPTION" as const,
        priorNode: createDecisionNode("p_w24", {
          impactTier: "PERIPHERAL",
          couplingLevel: 0.8,
          rollbackCost: 0.8, // structural = round(10 + 14) = 24
        }),
        dependents: [] as DecisionGraphNode[],
        expected: "LOCALIZED_OVERRIDE",
      },
      // --- DIRECT_USER_INSTRUCTION ---
      {
        name: "direct user instruction vs W=50 node with 0 dependents -> ESCALATE_TO_HITL (exact threshold >= 50)",
        intentType: "DIRECT_USER_INSTRUCTION" as const,
        priorNode: createDecisionNode("p_w50", {
          impactTier: "CORE_ARCHITECTURAL",
          couplingLevel: 1.0,
          rollbackCost: 1.0, // structural = 28
          provenance: "USER_EXPLICIT_HITL", // provenance = 25 -> total = 53 >= 50
        }),
        dependents: [] as DecisionGraphNode[],
        expected: "ESCALATE_TO_HITL",
      },
      {
        name: "direct user instruction vs W=16 node with 1 dependent -> ESCALATE_TO_HITL (D+ >= 1)",
        intentType: "DIRECT_USER_INSTRUCTION" as const,
        priorNode: createDecisionNode("p_dir_dep", {
          impactTier: "PERIPHERAL",
          couplingLevel: 0,
          rollbackCost: 0,
          dependedBy: ["child_2"],
        }),
        dependents: [createDecisionNode("child_2")],
        expected: "ESCALATE_TO_HITL",
      },
      {
        name: "direct user instruction vs W=49 isolated node (0 dependents) -> LOCALIZED_OVERRIDE",
        intentType: "DIRECT_USER_INSTRUCTION" as const,
        priorNode: createDecisionNode("p_w49", {
          impactTier: "CORE_ARCHITECTURAL",
          couplingLevel: 1.5,
          rollbackCost: 1.5, // structural = 36
          provenance: "SYSTEM1_DIRECT_APS",
          dominanceMargin: 0.6, // provenance = 13 -> total = 49 < 50, 0 dependents
        }),
        dependents: [] as DecisionGraphNode[],
        expected: "LOCALIZED_OVERRIDE",
      },
    ])("$name", ({ intentType, priorNode, dependents, expected }) => {
      const allNodes: Record<string, DecisionGraphNode> = {
        [priorNode.decisionId]: priorNode,
      };
      for (const dep of dependents) {
        allNodes[dep.decisionId] = dep;
      }

      expect(evaluateAntiDominoGate({ intentType }, priorNode, allNodes)).toBe(
        expected,
      );
    });
  });
});
