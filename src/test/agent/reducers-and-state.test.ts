/**
 * Test Suite: AgentGraphState Channels & Pure Reducers
 *
 * Verifies:
 * 1. Pure Reducer Contracts & Semantics (ELIXENT-ARCH-02 §2):
 *    - `reduceSearchReport`: Composite key deduplication (fileId:headingSlug), inspected paths union, summary fallback.
 *    - `reduceLocalInspectionState`: Deduplicated set union for visited paths.
 *    - `reduceAssumptions`: Upsert by assumptionId with deep field update.
 *    - `reduceMasterLedger`: ATMS DAG merge with strict sentinel filtering (__PROJECT_TAXONOMY__, __*).
 *    - `reduceProjectTaxonomy`: Null-coalescing last-write replacement.
 *    - `reduceInvalidationMap`: SectionTarget aggregation & deduplication by (fileId:headingSlug).
 *    - `reduceBudgetTracking`: Arbitrary-precision BigInt arithmetic serialized to JSON-safe decimal strings.
 *    - `reduceSearchLoopCount`: Monotonic loop counting with strict MAX_SEARCH_LOOPS (3) ceiling.
 * 2. LangGraph 12-Channel Annotation & StateGraph Lifecycle:
 *    - AgentGraphAnnotation root spec contains all 12 canonical channels.
 *    - Fresh default factory isolation across instances.
 *    - Compilation and execution inside real StateGraph workflow with partial node returns.
 * 3. Architectural Invariants:
 *    - Zero I/O, zero async, zero input mutation (verified under Object.freeze).
 *    - Lossless JSON serializability at channel boundaries.
 */

import { describe, it, expect } from "vitest";
import { StateGraph, START, END } from "@langchain/langgraph";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

import {
  reduceSearchReport,
  reduceLocalInspectionState,
  reduceAssumptions,
  reduceMasterLedger,
  reduceProjectTaxonomy,
  reduceInvalidationMap,
  reduceBudgetTracking,
  reduceSearchLoopCount,
  MAX_SEARCH_LOOPS,
  type SearchReport,
  type SearchReportEvidence,
  type UserRequest,
  type BudgetTrackingState,
  type UnresolvedDecision,
  type ClarifyingQuestionBatch,
} from "@/core/agent/reducers";

import {
  AgentGraphAnnotation,
  type AssumptionItem,
} from "@/core/agent/state";

import {
  PROJECT_TAXONOMY_SENTINEL_ID,
  type ProjectTaxonomyState,
} from "@/core/agent/taxonomy/predefined-tags";

import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import type { SectionTarget } from "@/core/agent/schemas/decision-schemas";

// ---------------------------------------------------------------------------
// Helper Fiactory Functions for Real Test Fixtures
// ---------------------------------------------------------------------------

function createTestDecisionNode(
  decisionId: string,
  overrides?: Partial<ATMSDecisionNode>,
): ATMSDecisionNode {
  return {
    decisionId,
    topicSlug: "topic_architecture",
    questionPrompt: `Decision prompt for ${decisionId}`,
    conceptTags: ["system_architecture_and_design"],
    selectedOptionKey: "opt_primary",
    selectionRationale: "Optimal architectural tradeoff",
    runnerUpOptionKey: "opt_fallback",
    evaluatedAlternatives: [
      {
        optionKey: "opt_primary",
        neutralSummary: "Primary option summary",
        rationaleAndPremises: "Approved based on simplicity",
      },
      {
        optionKey: "opt_fallback",
        neutralSummary: "Fallback option summary",
        rationaleAndPremises: "Rejected due to overhead",
      },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [],
    ...overrides,
  };
}

function createTestAssumptionItem(
  assumptionId: string,
  overrides?: Partial<AssumptionItem>,
): AssumptionItem {
  return {
    assumptionId,
    statement: `Assumption statement for ${assumptionId}`,
    conceptTags: ["data_modeling_storage_and_persistence"],
    affectedSections: [
      { fileId: "file-core.md", headingSlug: "architecture-overview" },
    ],
    dependsOn: [],
    ...overrides,
  };
}

describe("AgentGraphState Channels & Pure Reducers (Wave 9.1)", () => {
  // =========================================================================
  // 1. reduceSearchReport: Evidence & Path Merging
  // =========================================================================
  describe("1. reduceSearchReport", () => {
    it("should return empty report when merging two empty search reports", () => {
      const current: SearchReport = {
        evidenceItems: [],
        inspectedPaths: [],
        summary: "",
      };
      const update: SearchReport = {
        evidenceItems: [],
        inspectedPaths: [],
        summary: "",
      };

      const result = reduceSearchReport(current, update);

      expect(result.evidenceItems).toEqual([]);
      expect(result.inspectedPaths).toEqual([]);
      expect(result.summary).toBe("");
    });

    it("should merge non-overlapping evidence items and retain both", () => {
      const current: SearchReport = {
        evidenceItems: [
          {
            fileId: "doc-1.md",
            headingSlug: "intro",
            breadcrumb: ["Root", "Intro"],
            textExcerpt: "Intro excerpt",
          },
        ],
        inspectedPaths: ["doc-1.md#intro"],
        summary: "Current summary",
      };

      const update: SearchReport = {
        evidenceItems: [
          {
            fileId: "doc-2.md",
            headingSlug: "methods",
            breadcrumb: ["Root", "Methods"],
            textExcerpt: "Methods excerpt",
          },
        ],
        inspectedPaths: ["doc-2.md#methods"],
        summary: "Update summary",
      };

      const result = reduceSearchReport(current, update);

      expect(result.evidenceItems).toHaveLength(2);
      expect(result.evidenceItems[0].fileId).toBe("doc-1.md");
      expect(result.evidenceItems[1].fileId).toBe("doc-2.md");
      expect(result.inspectedPaths).toEqual([
        "doc-1.md#intro",
        "doc-2.md#methods",
      ]);
      expect(result.summary).toBe("Update summary");
    });

    it("should overwrite older duplicate evidence with newer entry matching composite key (fileId:headingSlug)", () => {
      const current: SearchReport = {
        evidenceItems: [
          {
            fileId: "doc-1.md",
            headingSlug: "architecture",
            breadcrumb: ["System"],
            textExcerpt: "Old architecture text",
          },
        ],
        inspectedPaths: ["doc-1.md#architecture"],
        summary: "Old summary",
      };

      const update: SearchReport = {
        evidenceItems: [
          {
            fileId: "doc-1.md",
            headingSlug: "architecture",
            breadcrumb: ["System", "Updated"],
            textExcerpt: "New refined architecture text",
            vaultRef: "vault_ref://doc-1#architecture",
          },
        ],
        inspectedPaths: ["doc-1.md#architecture"],
        summary: "Refined summary",
      };

      const result = reduceSearchReport(current, update);

      expect(result.evidenceItems).toHaveLength(1);
      expect(result.evidenceItems[0]).toEqual({
        fileId: "doc-1.md",
        headingSlug: "architecture",
        breadcrumb: ["System", "Updated"],
        textExcerpt: "New refined architecture text",
        vaultRef: "vault_ref://doc-1#architecture",
      });
      expect(result.summary).toBe("Refined summary");
    });

    it("should differentiate composite keys when fileId matches but headingSlug differs, or vice versa", () => {
      const current: SearchReport = {
        evidenceItems: [
          {
            fileId: "doc-common.md",
            headingSlug: "heading-alpha",
            breadcrumb: ["A"],
            textExcerpt: "Text A",
          },
          {
            fileId: "doc-alpha.md",
            headingSlug: "common-heading",
            breadcrumb: ["Common"],
            textExcerpt: "Text Alpha Common",
          },
        ],
        inspectedPaths: ["doc-common.md#heading-alpha", "doc-alpha.md#common-heading"],
        summary: "Initial",
      };

      const update: SearchReport = {
        evidenceItems: [
          {
            fileId: "doc-common.md",
            headingSlug: "heading-beta",
            breadcrumb: ["B"],
            textExcerpt: "Text B",
          },
          {
            fileId: "doc-beta.md",
            headingSlug: "common-heading",
            breadcrumb: ["Common"],
            textExcerpt: "Text Beta Common",
          },
        ],
        inspectedPaths: ["doc-common.md#heading-beta", "doc-beta.md#common-heading"],
        summary: "Updated",
      };

      const result = reduceSearchReport(current, update);

      expect(result.evidenceItems).toHaveLength(4);
      const keys = result.evidenceItems.map(
        (item) => `${item.fileId}:${item.headingSlug}`,
      );
      expect(keys).toEqual([
        "doc-common.md:heading-alpha",
        "doc-alpha.md:common-heading",
        "doc-common.md:heading-beta",
        "doc-beta.md:common-heading",
      ]);
    });

    it("should fallback to current summary if update summary is empty string", () => {
      const current: SearchReport = {
        evidenceItems: [],
        inspectedPaths: [],
        summary: "Preserved current summary",
      };
      const update: SearchReport = {
        evidenceItems: [],
        inspectedPaths: [],
        summary: "",
      };

      const result = reduceSearchReport(current, update);
      expect(result.summary).toBe("Preserved current summary");
    });

    it("should deduplicate inspectedPaths via set union preserving encounter order", () => {
      const current: SearchReport = {
        evidenceItems: [],
        inspectedPaths: ["p1", "p2", "p3"],
        summary: "",
      };
      const update: SearchReport = {
        evidenceItems: [],
        inspectedPaths: ["p2", "p3", "p4", "p5"],
        summary: "",
      };

      const result = reduceSearchReport(current, update);
      expect(result.inspectedPaths).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    });

    it("should not mutate input arguments even when frozen with Object.freeze", () => {
      const current = Object.freeze({
        evidenceItems: Object.freeze([
          Object.freeze({
            fileId: "f1",
            headingSlug: "h1",
            breadcrumb: Object.freeze(["b1"]),
            textExcerpt: "t1",
          }),
        ]),
        inspectedPaths: Object.freeze(["p1"]),
        summary: "frozen current",
      });

      const update = Object.freeze({
        evidenceItems: Object.freeze([
          Object.freeze({
            fileId: "f1",
            headingSlug: "h1",
            breadcrumb: Object.freeze(["b1_updated"]),
            textExcerpt: "t1_updated",
          }),
        ]),
        inspectedPaths: Object.freeze(["p1", "p2"]),
        summary: "frozen update",
      });

      expect(() => reduceSearchReport(current as any, update as any)).not.toThrow();
      const result = reduceSearchReport(current as any, update as any);
      expect(result.evidenceItems[0].textExcerpt).toBe("t1_updated");
      expect(result.inspectedPaths).toEqual(["p1", "p2"]);
    });
  });

  // =========================================================================
  // 2. reduceLocalInspectionState: Deduplicated Set Union
  // =========================================================================
  describe("2. reduceLocalInspectionState", () => {
    it("should produce a deduplicated union of paths preserving first encounter order", () => {
      const current = ["fileA#sec1", "fileB#sec2"];
      const update = ["fileB#sec2", "fileC#sec3", "fileA#sec1"];

      const result = reduceLocalInspectionState(current, update);
      expect(result).toEqual(["fileA#sec1", "fileB#sec2", "fileC#sec3"]);
    });

    it("should handle empty arrays on either or both sides", () => {
      expect(reduceLocalInspectionState([], [])).toEqual([]);
      expect(reduceLocalInspectionState(["a", "b"], [])).toEqual(["a", "b"]);
      expect(reduceLocalInspectionState([], ["x", "y"])).toEqual(["x", "y"]);
    });

    it("should eliminate internal duplicates present within either input array", () => {
      const current = ["dup1", "dup1", "uniqueA"];
      const update = ["dup2", "dup2", "uniqueB", "dup1"];

      const result = reduceLocalInspectionState(current, update);
      expect(result).toEqual(["dup1", "uniqueA", "dup2", "uniqueB"]);
    });

    it("should remain strictly pure without mutating inputs under Object.freeze", () => {
      const current = Object.freeze(["a", "b", "c"]);
      const update = Object.freeze(["c", "d", "e"]);

      expect(() => reduceLocalInspectionState(current as any, update as any)).not.toThrow();
      const result = reduceLocalInspectionState(current as any, update as any);
      expect(result).toEqual(["a", "b", "c", "d", "e"]);
      expect(current).toEqual(["a", "b", "c"]);
    });
  });

  // =========================================================================
  // 3. reduceAssumptions: Upsert by assumptionId
  // =========================================================================
  describe("3. reduceAssumptions", () => {
    it("should return empty array when both inputs are empty", () => {
      const result = reduceAssumptions([], []);
      expect(result).toEqual([]);
    });

    it("should append assumptions with distinct IDs", () => {
      const item1 = createTestAssumptionItem("asm_001");
      const item2 = createTestAssumptionItem("asm_002");

      const result = reduceAssumptions([item1], [item2]);
      expect(result).toHaveLength(2);
      expect(result.map((a) => a.assumptionId)).toEqual(["asm_001", "asm_002"]);
    });

    it("should replace existing assumption when update has matching assumptionId", () => {
      const original = createTestAssumptionItem("asm_001", {
        statement: "Original draft premise",
        dependsOn: ["prior_01"],
      });

      const updated = createTestAssumptionItem("asm_001", {
        statement: "Refined and validated premise",
        dependsOn: ["prior_01", "prior_02"],
        conceptTags: ["security_cryptography_and_privacy"],
      });

      const result = reduceAssumptions([original], [updated]);

      expect(result).toHaveLength(1);
      expect(result[0].statement).toBe("Refined and validated premise");
      expect(result[0].dependsOn).toEqual(["prior_01", "prior_02"]);
      expect(result[0].conceptTags).toEqual(["security_cryptography_and_privacy"]);
    });

    it("should resolve intra-batch duplicates in update by keeping the last occurrence", () => {
      const original = createTestAssumptionItem("asm_001", { statement: "v1" });
      const update1 = createTestAssumptionItem("asm_001", { statement: "v2" });
      const update2 = createTestAssumptionItem("asm_001", { statement: "v3_latest" });

      const result = reduceAssumptions([original], [update1, update2]);

      expect(result).toHaveLength(1);
      expect(result[0].statement).toBe("v3_latest");
    });

    it("should preserve input immutability when input arrays and objects are frozen", () => {
      const item1 = Object.freeze(createTestAssumptionItem("asm_f1"));
      const item2 = Object.freeze(createTestAssumptionItem("asm_f2"));
      const current = Object.freeze([item1]);
      const update = Object.freeze([item2]);

      expect(() => reduceAssumptions(current as any, update as any)).not.toThrow();
      const result = reduceAssumptions(current as any, update as any);
      expect(result).toHaveLength(2);
    });
  });

  // =========================================================================
  // 4. reduceMasterLedger: DAG Deep Merge & Sentinel Exclusion
  // =========================================================================
  describe("4. reduceMasterLedger", () => {
    it("should merge non-overlapping decisions from current and update", () => {
      const nodeA = createTestDecisionNode("dec_alpha");
      const nodeB = createTestDecisionNode("dec_beta");

      const current = { dec_alpha: nodeA };
      const update = { dec_beta: nodeB };

      const result = reduceMasterLedger(current, update);

      expect(Object.keys(result)).toEqual(["dec_alpha", "dec_beta"]);
      expect(result.dec_alpha).toEqual(nodeA);
      expect(result.dec_beta).toEqual(nodeB);
    });

    it("should overwrite existing decision with update node on matching decisionId", () => {
      const original = createTestDecisionNode("dec_alpha", {
        selectedOptionKey: "opt_v1",
        selectionRationale: "v1 rationale",
      });
      const updated = createTestDecisionNode("dec_alpha", {
        selectedOptionKey: "opt_v2",
        selectionRationale: "v2 rationale",
        isLoadBearing: false,
      });

      const result = reduceMasterLedger({ dec_alpha: original }, { dec_alpha: updated });

      expect(Object.keys(result)).toEqual(["dec_alpha"]);
      expect(result.dec_alpha.selectedOptionKey).toBe("opt_v2");
      expect(result.dec_alpha.selectionRationale).toBe("v2 rationale");
      expect(result.dec_alpha.isLoadBearing).toBe(false);
    });

    it("should strictly filter system-reserved sentinel __PROJECT_TAXONOMY__ from current", () => {
      const reservedNode = createTestDecisionNode(PROJECT_TAXONOMY_SENTINEL_ID);
      const validNode = createTestDecisionNode("dec_valid");

      const current = {
        [PROJECT_TAXONOMY_SENTINEL_ID]: reservedNode,
        dec_valid: validNode,
      };
      const update = {};

      const result = reduceMasterLedger(current, update);

      expect(result[PROJECT_TAXONOMY_SENTINEL_ID]).toBeUndefined();
      expect(result.dec_valid).toBeDefined();
      expect(Object.keys(result)).toEqual(["dec_valid"]);
    });

    it("should strictly filter system-reserved sentinel __PROJECT_TAXONOMY__ from update", () => {
      const reservedNode = createTestDecisionNode(PROJECT_TAXONOMY_SENTINEL_ID);
      const validNode = createTestDecisionNode("dec_valid");

      const current = { dec_valid: validNode };
      const update = { [PROJECT_TAXONOMY_SENTINEL_ID]: reservedNode };

      const result = reduceMasterLedger(current, update);

      expect(result[PROJECT_TAXONOMY_SENTINEL_ID]).toBeUndefined();
      expect(result.dec_valid).toBeDefined();
    });

    it("should filter out all system reserved IDs matching double underscore prefix (__*)", () => {
      const node1 = createTestDecisionNode("__INTERNAL_CHECKPOINT__");
      const node2 = createTestDecisionNode("__RESERVED_ROUTER__");
      const validNode = createTestDecisionNode("dec_valid_node");

      const current = { __INTERNAL_CHECKPOINT__: node1 };
      const update = { __RESERVED_ROUTER__: node2, dec_valid_node: validNode };

      const result = reduceMasterLedger(current, update);

      expect(Object.keys(result)).toEqual(["dec_valid_node"]);
      expect(result.dec_valid_node).toEqual(validNode);
    });

    it("should not mutate frozen record inputs", () => {
      const nodeA = Object.freeze(createTestDecisionNode("dec_a"));
      const nodeB = Object.freeze(createTestDecisionNode("dec_b"));
      const current = Object.freeze({ dec_a: nodeA });
      const update = Object.freeze({ dec_b: nodeB });

      expect(() => reduceMasterLedger(current as any, update as any)).not.toThrow();
      const result = reduceMasterLedger(current as any, update as any);
      expect(Object.keys(result)).toEqual(["dec_a", "dec_b"]);
    });
  });

  // =========================================================================
  // 5. reduceProjectTaxonomy: Null-Coalescing Replacement
  // =========================================================================
  describe("5. reduceProjectTaxonomy", () => {
    const sampleTaxonomyA: ProjectTaxonomyState = {
      projectId: "proj_123",
      addedTags: ["crypto_primitives"],
      removedTags: [],
      updatedAt: new Date(1700000000000).toISOString(),
    };

    const sampleTaxonomyB: ProjectTaxonomyState = {
      projectId: "proj_123",
      addedTags: ["crypto_primitives", "zero_knowledge_proofs"],
      removedTags: ["frontend_ui_ux_and_client_interaction"],
      updatedAt: new Date(1700000005000).toISOString(),
    };

    it("should return null when both current and update are null", () => {
      expect(reduceProjectTaxonomy(null, null)).toBeNull();
    });

    it("should set initial taxonomy when current is null and update is non-null", () => {
      const result = reduceProjectTaxonomy(null, sampleTaxonomyA);
      expect(result).toEqual(sampleTaxonomyA);
    });

    it("should replace current taxonomy when update is non-null", () => {
      const result = reduceProjectTaxonomy(sampleTaxonomyA, sampleTaxonomyB);
      expect(result).toEqual(sampleTaxonomyB);
    });

    it("should preserve current taxonomy when update is null (null-coalescing invariant)", () => {
      const result = reduceProjectTaxonomy(sampleTaxonomyA, null);
      expect(result).toBe(sampleTaxonomyA);
    });

    it("should preserve current taxonomy when update is undefined", () => {
      const result = reduceProjectTaxonomy(sampleTaxonomyA, undefined as any);
      expect(result).toBe(sampleTaxonomyA);
    });
  });

  // =========================================================================
  // 6. reduceInvalidationMap: SectionTarget Aggregation & Dedup
  // =========================================================================
  describe("6. reduceInvalidationMap", () => {
    it("should return empty record when both inputs are empty", () => {
      expect(reduceInvalidationMap({}, {})).toEqual({});
    });

    it("should merge disjoint decision IDs with their section targets intact", () => {
      const targetA: SectionTarget = {
        fileId: "fileA.md",
        headingSlug: "architecture",
      };
      const targetB: SectionTarget = {
        fileId: "fileB.md",
        headingSlug: "database",
      };

      const current = { dec_1: [targetA] };
      const update = { dec_2: [targetB] };

      const result = reduceInvalidationMap(current, update);

      expect(Object.keys(result)).toEqual(["dec_1", "dec_2"]);
      expect(result.dec_1).toEqual([targetA]);
      expect(result.dec_2).toEqual([targetB]);
    });

    it("should aggregate and deduplicate section targets within matching decisionId by composite key (fileId:headingSlug)", () => {
      const target1: SectionTarget = {
        fileId: "doc-1.md",
        headingSlug: "heading-alpha",
      };
      const targetDuplicate: SectionTarget = {
        fileId: "doc-1.md",
        headingSlug: "heading-alpha",
      };
      const target2: SectionTarget = {
        fileId: "doc-1.md",
        headingSlug: "heading-beta",
      };

      const current = { dec_001: [target1] };
      const update = { dec_001: [targetDuplicate, target2] };

      const result = reduceInvalidationMap(current, update);

      expect(result.dec_001).toHaveLength(2);
      expect(result.dec_001[0]).toEqual(target1);
      expect(result.dec_001[1]).toEqual(target2);
    });

    it("should deduplicate multiple matching section targets appearing inside update itself", () => {
      const target: SectionTarget = { fileId: "doc.md", headingSlug: "intro" };

      const current = {};
      const update = { dec_001: [target, { ...target }, { ...target }] };

      const result = reduceInvalidationMap(current, update);

      expect(result.dec_001).toHaveLength(1);
      expect(result.dec_001[0]).toEqual(target);
    });

    it("should treat sections with same fileId but different headingSlug as distinct targets", () => {
      const targetA: SectionTarget = { fileId: "shared.md", headingSlug: "section-1" };
      const targetB: SectionTarget = { fileId: "shared.md", headingSlug: "section-2" };

      const result = reduceInvalidationMap({ dec_1: [targetA] }, { dec_1: [targetB] });

      expect(result.dec_1).toHaveLength(2);
      expect(result.dec_1[0].headingSlug).toBe("section-1");
      expect(result.dec_1[1].headingSlug).toBe("section-2");
    });

    it("should treat sections with different fileId but same headingSlug as distinct targets", () => {
      const targetA: SectionTarget = { fileId: "fileA.md", headingSlug: "summary" };
      const targetB: SectionTarget = { fileId: "fileB.md", headingSlug: "summary" };

      const result = reduceInvalidationMap({ dec_1: [targetA] }, { dec_1: [targetB] });

      expect(result.dec_1).toHaveLength(2);
      expect(result.dec_1[0].fileId).toBe("fileA.md");
      expect(result.dec_1[1].fileId).toBe("fileB.md");
    });

    it("should not mutate frozen inputs", () => {
      const target = Object.freeze({ fileId: "f.md", headingSlug: "h" });
      const current = Object.freeze({ d1: Object.freeze([target]) });
      const update = Object.freeze({ d1: Object.freeze([target]) });

      expect(() => reduceInvalidationMap(current as any, update as any)).not.toThrow();
      const result = reduceInvalidationMap(current as any, update as any);
      expect(result.d1).toHaveLength(1);
    });
  });

  // =========================================================================
  // 7. reduceBudgetTracking: Decimal String BigInt Arithmetic
  // =========================================================================
  describe("7. reduceBudgetTracking", () => {
    it("should compute exact sums with zero identity", () => {
      const current: BudgetTrackingState = { reservedMicro: "0", spentMicro: "0" };
      const update: BudgetTrackingState = { reservedMicro: "5000", spentMicro: "2500" };

      const result = reduceBudgetTracking(current, update);

      expect(result).toEqual({
        reservedMicro: "5000",
        spentMicro: "2500",
      });
    });

    it("should accumulate standard incremental usage across multiple steps", () => {
      let state: BudgetTrackingState = { reservedMicro: "10000", spentMicro: "0" };

      state = reduceBudgetTracking(state, { reservedMicro: "0", spentMicro: "3500" });
      state = reduceBudgetTracking(state, { reservedMicro: "5000", spentMicro: "2500" });

      expect(state).toEqual({
        reservedMicro: "15000",
        spentMicro: "6000",
      });
    });

    it("should preserve exact precision for values exceeding Number.MAX_SAFE_INTEGER without rounding", () => {
      // Number.MAX_SAFE_INTEGER is 9007199254740991 (16 digits)
      const current: BudgetTrackingState = {
        reservedMicro: "9007199254740991000",
        spentMicro: "9007199254740991000",
      };
      const update: BudgetTrackingState = {
        reservedMicro: "9007199254740991000",
        spentMicro: "1000000000000000000",
      };

      const result = reduceBudgetTracking(current, update);

      expect(result.reservedMicro).toBe("18014398509481982000");
      expect(result.spentMicro).toBe("10007199254740991000");
      expect(typeof result.reservedMicro).toBe("string");
      expect(typeof result.spentMicro).toBe("string");
    });

    it("should handle multi-gigabit extreme 30-digit large numbers with zero precision loss", () => {
      const valA = "999999999999999999999999999999";
      const valB = "1";

      const result = reduceBudgetTracking(
        { reservedMicro: valA, spentMicro: valA },
        { reservedMicro: valB, spentMicro: valB },
      );

      expect(result.reservedMicro).toBe("1000000000000000000000000000000");
      expect(result.spentMicro).toBe("1000000000000000000000000000000");
    });

    it("should be strictly commutative: reduce(a, b) === reduce(b, a)", () => {
      const a: BudgetTrackingState = { reservedMicro: "1234567890123456", spentMicro: "9876543210" };
      const b: BudgetTrackingState = { reservedMicro: "8765432109876544", spentMicro: "1234567890" };

      const resAB = reduceBudgetTracking(a, b);
      const resBA = reduceBudgetTracking(b, a);

      expect(resAB).toEqual(resBA);
    });

    it("should return serializable plain JSON strings with no BigInt primitives at the boundary", () => {
      const result = reduceBudgetTracking(
        { reservedMicro: "100", spentMicro: "200" },
        { reservedMicro: "50", spentMicro: "50" },
      );

      // JSON.stringify must succeed without throwing "Do not know how to serialize a BigInt"
      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(result));
      expect(parsed).toEqual({ reservedMicro: "150", spentMicro: "250" });
    });

    it("should not mutate frozen input state", () => {
      const current = Object.freeze({ reservedMicro: "100", spentMicro: "200" });
      const update = Object.freeze({ reservedMicro: "300", spentMicro: "400" });

      expect(() => reduceBudgetTracking(current, update)).not.toThrow();
    });
  });

  // =========================================================================
  // 8. reduceSearchLoopCount: Monotonic Increment & MAX_SEARCH_LOOPS Clamping
  // =========================================================================
  describe("8. reduceSearchLoopCount & MAX_SEARCH_LOOPS", () => {
    it("should export MAX_SEARCH_LOOPS constant strictly equaling 3", () => {
      expect(MAX_SEARCH_LOOPS).toBe(3);
    });

    it.each([
      { current: 0, delta: 1, expected: 1 },
      { current: 1, delta: 1, expected: 2 },
      { current: 2, delta: 1, expected: 3 },
      { current: 3, delta: 1, expected: 3 }, // Clamped at ceiling
      { current: 3, delta: 2, expected: 3 }, // Clamped at ceiling
      { current: 0, delta: 5, expected: 3 }, // Overshoot clamped
      { current: 2, delta: 0, expected: 2 }, // Zero delta
      { current: 0, delta: 0, expected: 0 },
    ])(
      "should reduce current ($current) + delta ($delta) to $expected",
      ({ current, delta, expected }) => {
        expect(reduceSearchLoopCount(current, delta)).toBe(expected);
      },
    );

    it("should never exceed MAX_SEARCH_LOOPS even with extreme deltas", () => {
      expect(reduceSearchLoopCount(0, 999999)).toBe(MAX_SEARCH_LOOPS);
      expect(reduceSearchLoopCount(MAX_SEARCH_LOOPS, 100)).toBe(MAX_SEARCH_LOOPS);
    });
  });

  // =========================================================================
  // 9. AgentGraphAnnotation: 12-Channel LangGraph Spec & StateGraph Compilation
  // =========================================================================
  describe("9. AgentGraphAnnotation: 12-Channel Root Spec & StateGraph Lifecycle", () => {
    const CANONICAL_CHANNELS = [
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
    ] as const;

    it("should declare all 12 canonical state channels in AgentGraphAnnotation.spec", () => {
      const channelKeys = Object.keys(AgentGraphAnnotation.spec);
      expect(channelKeys).toHaveLength(12);
      expect(channelKeys.sort()).toEqual([...CANONICAL_CHANNELS].sort());
    });

    it("should initialize correct default values for each channel via its default factory", () => {
      const spec = AgentGraphAnnotation.spec as any;

      expect(spec.messages.initialValueFactory()).toEqual([]);
      expect(spec.user_request.initialValueFactory()).toEqual({
        prompt: "",
        projectId: "",
        targetFileIds: [],
      });
      expect(spec.search_report.initialValueFactory()).toEqual({
        evidenceItems: [],
        inspectedPaths: [],
        summary: "",
      });
      expect(spec.local_inspection_state.initialValueFactory()).toEqual([]);
      expect(spec.assumptions.initialValueFactory()).toEqual([]);
      expect(spec.master_ledger.initialValueFactory()).toEqual({});
      expect(spec.project_taxonomy.initialValueFactory()).toBeNull();
      expect(spec.unresolved_ledger.initialValueFactory()).toEqual([]);
      expect(spec.invalidation_map.initialValueFactory()).toEqual({});
      expect(spec.question_queue.initialValueFactory()).toBeNull();
      expect(spec.budget_tracking.initialValueFactory()).toEqual({
        reservedMicro: "0",
        spentMicro: "0",
      });
      expect(spec.search_loop_count.initialValueFactory()).toBe(0);
    });

    it("should produce fresh references from default factories (no cross-instance leakage)", () => {
      const spec = AgentGraphAnnotation.spec as any;

      const defaultArray1 = spec.messages.initialValueFactory();
      const defaultArray2 = spec.messages.initialValueFactory();
      expect(defaultArray1).not.toBe(defaultArray2);

      const defaultObj1 = spec.master_ledger.initialValueFactory();
      const defaultObj2 = spec.master_ledger.initialValueFactory();
      expect(defaultObj1).not.toBe(defaultObj2);

      const defaultBudget1 = spec.budget_tracking.initialValueFactory();
      const defaultBudget2 = spec.budget_tracking.initialValueFactory();
      expect(defaultBudget1).not.toBe(defaultBudget2);
    });

    it("should compile and execute inside a real LangGraph StateGraph workflow with partial node returns", async () => {
      // Construct a two-stage LangGraph workflow testing real reducer integration
      const workflow = new StateGraph(AgentGraphAnnotation)
        .addNode("step_orchestrator", () => ({
          user_request: {
            prompt: "Design cryptographic sync protocol",
            projectId: "proj_crypto",
            targetFileIds: ["crypto.md"],
          },
          local_inspection_state: ["crypto.md#spec"],
          budget_tracking: { reservedMicro: "1000", spentMicro: "0" },
          search_loop_count: 1,
        }))
        .addNode("step_search", () => ({
          search_report: {
            evidenceItems: [
              {
                fileId: "crypto.md",
                headingSlug: "spec",
                breadcrumb: ["Root", "Crypto"],
                textExcerpt: "AES-256-GCM authenticated encryption",
              },
            ],
            inspectedPaths: ["crypto.md#spec"],
            summary: "Extracted crypto spec",
          },
          local_inspection_state: ["crypto.md#spec", "vault.md#keys"],
          budget_tracking: { reservedMicro: "2000", spentMicro: "800" },
          search_loop_count: 1,
        }))
        .addEdge(START, "step_orchestrator")
        .addEdge("step_orchestrator", "step_search")
        .addEdge("step_search", END);

      const compiledApp = workflow.compile();

      const finalState = await compiledApp.invoke({});

      // Assert that state channels were correctly aggregated by their registered reducers
      expect(finalState.user_request.projectId).toBe("proj_crypto");
      expect(finalState.search_report.evidenceItems).toHaveLength(1);
      expect(finalState.search_report.evidenceItems[0].headingSlug).toBe("spec");
      expect(finalState.search_report.summary).toBe("Extracted crypto spec");

      // Deduplicated local_inspection_state: ["crypto.md#spec"] ∪ ["crypto.md#spec", "vault.md#keys"]
      expect(finalState.local_inspection_state).toEqual([
        "crypto.md#spec",
        "vault.md#keys",
      ]);

      // BudgetTracking BigInt addition: (1000 + 2000 = 3000 reserved, 0 + 800 = 800 spent)
      expect(finalState.budget_tracking).toEqual({
        reservedMicro: "3000",
        spentMicro: "800",
      });

      // Monotonic search loop counter: 0 -> 1 -> 2
      expect(finalState.search_loop_count).toBe(2);
    });

    it("should handle messages channel accumulation via LangGraph messagesStateReducer", async () => {
      const msg1 = new HumanMessage({ content: "Initial query", id: "msg-1" });
      const msg2 = new AIMessage({ content: "AI response 1", id: "msg-2" });
      const msg2Updated = new AIMessage({ content: "AI response 1 (edited)", id: "msg-2" });
      const msg3 = new HumanMessage({ content: "Follow-up query", id: "msg-3" });

      const workflow = new StateGraph(AgentGraphAnnotation)
        .addNode("node_initial", () => ({
          messages: [msg1, msg2],
        }))
        .addNode("node_update", () => ({
          messages: [msg2Updated, msg3],
        }))
        .addEdge(START, "node_initial")
        .addEdge("node_initial", "node_update")
        .addEdge("node_update", END);

      const app = workflow.compile();
      const finalState = await app.invoke({});

      expect(finalState.messages).toHaveLength(3);
      expect(finalState.messages[0].content).toBe("Initial query");
      expect(finalState.messages[1].content).toBe("AI response 1 (edited)"); // Updated by ID
      expect(finalState.messages[2].content).toBe("Follow-up query");
    });

    it("should verify last-write replacement channels (user_request, unresolved_ledger, question_queue)", async () => {
      const req1: UserRequest = { prompt: "first", projectId: "p1", targetFileIds: ["f1"] };
      const req2: UserRequest = { prompt: "second", projectId: "p2", targetFileIds: ["f2"] };

      const unres1: UnresolvedDecision[] = [
        {
          decisionId: "d1",
          topicSlug: "topic1",
          questionPrompt: "q1",
          conceptTags: ["tag1"],
          reason: "low confidence",
        },
      ];
      const unres2: UnresolvedDecision[] = [];

      const questions: ClarifyingQuestionBatch = {
        questions: [
          {
            questionId: "q_01",
            topicSlug: "topic_arch",
            questionPrompt: "Should we use sync mode?",
            options: [
              { optionKey: "opt_a", neutralSummary: "Mode A", rationaleAndPremises: "Fast" },
              { optionKey: "opt_b", neutralSummary: "Mode B", rationaleAndPremises: "Safe" },
            ],
          },
        ],
      };

      const workflow = new StateGraph(AgentGraphAnnotation)
        .addNode("node_a", () => ({
          user_request: req1,
          unresolved_ledger: unres1,
          question_queue: questions,
        }))
        .addNode("node_b", () => ({
          user_request: req2,
          unresolved_ledger: unres2,
          question_queue: null, // Reset upon resolution/resumption
        }))
        .addEdge(START, "node_a")
        .addEdge("node_a", "node_b")
        .addEdge("node_b", END);

      const app = workflow.compile();
      const finalState = await app.invoke({});

      expect(finalState.user_request).toEqual(req2);
      expect(finalState.unresolved_ledger).toEqual([]);
      expect(finalState.question_queue).toBeNull();
    });
  });

  // =========================================================================
  // 10. Comprehensive Edge Cases & Stress Battery
  // =========================================================================
  describe("10. Stress & High-Volume Reducer Execution", () => {
    it("should handle large batches of 500 search evidence items with duplicate keys deterministically", () => {
      const currentItems: SearchReportEvidence[] = [];
      const updateItems: SearchReportEvidence[] = [];

      for (let i = 0; i < 500; i++) {
        currentItems.push({
          fileId: `file_${i % 50}.md`,
          headingSlug: `heading_${i % 20}`,
          breadcrumb: ["B", `H_${i % 20}`],
          textExcerpt: `Initial excerpt ${i}`,
        });

        updateItems.push({
          fileId: `file_${(i + 25) % 50}.md`,
          headingSlug: `heading_${i % 20}`,
          breadcrumb: ["B", `H_${i % 20}`],
          textExcerpt: `Refined excerpt ${i}`,
        });
      }

      const currentReport: SearchReport = {
        evidenceItems: currentItems,
        inspectedPaths: currentItems.map((c) => `${c.fileId}#${c.headingSlug}`),
        summary: "Current big batch",
      };

      const updateReport: SearchReport = {
        evidenceItems: updateItems,
        inspectedPaths: updateItems.map((u) => `${u.fileId}#${u.headingSlug}`),
        summary: "Update big batch",
      };

      const result = reduceSearchReport(currentReport, updateReport);

      // Max unique combinations: 50 files * 20 headings = 1000 max unique keys
      const uniqueKeys = new Set(
        result.evidenceItems.map((e) => `${e.fileId}:${e.headingSlug}`),
      );
      expect(result.evidenceItems.length).toBe(uniqueKeys.size);
      expect(result.inspectedPaths.length).toBe(
        new Set(result.inspectedPaths).size,
      );
    });

    it("should aggregate 100 invalidation section targets across 20 decisions without duplicate leaks", () => {
      const currentMap: Record<string, SectionTarget[]> = {};
      const updateMap: Record<string, SectionTarget[]> = {};

      for (let d = 0; d < 20; d++) {
        const decId = `dec_${d}`;
        currentMap[decId] = [
          { fileId: "doc.md", headingSlug: `sec_${d % 5}` },
          { fileId: "doc.md", headingSlug: `sec_${(d + 1) % 5}` },
        ];
        updateMap[decId] = [
          { fileId: "doc.md", headingSlug: `sec_${d % 5}` }, // Overlap
          { fileId: "doc.md", headingSlug: `sec_${(d + 2) % 5}` },
        ];
      }

      const result = reduceInvalidationMap(currentMap, updateMap);

      for (let d = 0; d < 20; d++) {
        const decId = `dec_${d}`;
        const sections = result[decId];
        const keys = sections.map((s) => `${s.fileId}:${s.headingSlug}`);
        expect(new Set(keys).size).toBe(sections.length);
      }
    });
  });
});
