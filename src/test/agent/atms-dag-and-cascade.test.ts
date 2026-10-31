/**
 * Test Suite: Justification-Driven ATMS DAG Foundation & Deterministic Candidate Retriever
 *
 * Scope: Wave 8.1 / Commit Gate 8 (ELIXENT-ARCH-02 §2 & §5)
 *
 * Verifies:
 * 1. ATMS DAG Node & Master Ledger Normalization & Deep Cloning (cloneATMSDecisionNode, cloneMasterLedger)
 * 2. Multi-Tenant Project Decision Ledger Persistence & Sentinel Isolation (loadProjectDecisionLedger, syncMasterLedgerToProjectStore)
 * 3. AST Section Proximity Signal (Exact Match = 1.0, Hierarchical Slug = 0.5, Disjoint = 0.0)
 *    and Architectural Invariant (candidate retrieval signal NEVER forces an automatic dependency edge)
 * 4. Concept Tags Jaccard Similarity Signal with project-scoped normalization
 * 5. Okapi BM25 Lexical Matching over Prompts, Rationales, and Evaluated Alternatives
 * 6. Deterministic Composite Scoring, Top-K Filtering, and Strict Tie-Breaking Order
 * 7. Boundary Conditions, Limit Normalization, and Immutable State Defense-in-Depth
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cloneATMSDecisionNode,
  cloneMasterLedger,
  loadProjectDecisionLedger,
  syncMasterLedgerToProjectStore,
  type ATMSDecisionNode,
} from "@/core/agent/atms/dag";
import {
  retrieveCandidatePriorDecisions,
  scoreCandidatePriorDecisions,
  DEFAULT_MAX_CANDIDATE_DECISIONS,
  CANDIDATE_RETRIEVAL_WEIGHTS,
  type CandidateRetrievalInput,
} from "@/core/agent/atms/candidate-retriever";
import {
  PROJECT_TAXONOMY_SENTINEL_ID,
  toTaxonomyLedgerPayload,
  type ProjectTaxonomyState,
} from "@/core/agent/taxonomy/predefined-tags";
import { linkAssumptionsToPriorDecisions } from "@/core/agent/atms/relational-linker";
import {
  resolveATMSCascadeBFS,
  computeMinimalSectionInvalidationMap,
  type LinkedAssumptionInput,
} from "@/core/agent/atms/invalidation";
import { evaluateRelationalLinksBatch } from "@/lib/jev/client";
import { db } from "@/server/db";

vi.mock("@/lib/jev/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jev/client")>();
  return {
    ...actual,
    evaluateRelationalLinksBatch: vi.fn(actual.evaluateRelationalLinksBatch),
  };
});

// ============================================================================
// Database Client Mocking for Hermetic Unit Tests
// ============================================================================

vi.mock("@/server/db", () => {
  const mockSelectWhere = vi.fn();
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));

  const mockInsertConflict = vi.fn();
  const mockInsertValues = vi.fn(() => ({ onConflictDoUpdate: mockInsertConflict }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  const mockDeleteWhere = vi.fn();
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));

  const mockTx = {
    select: mockSelect,
    insert: mockInsert,
    delete: mockDelete,
  };

  const mockTransaction = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));

  return {
    db: {
      select: mockSelect,
      insert: mockInsert,
      delete: mockDelete,
      transaction: mockTransaction,
    },
    txDb: {
      select: mockSelect,
      insert: mockInsert,
      delete: mockDelete,
      transaction: mockTransaction,
    },
  };
});

// Helper factory for creating standard ATMSDecisionNode fixtures
function createTestDecisionNode(overrides: Partial<ATMSDecisionNode> = {}): ATMSDecisionNode {
  return {
    decisionId: "dec-auth-strategy",
    topicSlug: "authentication-flow",
    questionPrompt: "Which primary authentication mechanism should be adopted?",
    conceptTags: ["authentication", "security"],
    selectedOptionKey: "SESSION_JWT",
    selectionRationale: "Stateless verification with serverless edge caching reduces roundtrips.",
    runnerUpOptionKey: "STATEFUL_SESSION",
    evaluatedAlternatives: [
      {
        optionKey: "SESSION_JWT",
        neutralSummary: "Stateless JWT with short expiration and refresh cookies.",
        rationaleAndPremises: "Optimal for high concurrency across multi-region edge functions.",
        normalizedProbability: 0.75,
      },
      {
        optionKey: "STATEFUL_SESSION",
        neutralSummary: "Database-backed sessions via Redis store.",
        rationaleAndPremises: "High consistency but introduces network roundtrip per request.",
        normalizedProbability: 0.25,
      },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [
      { fileId: "doc-arch-01", headingSlug: "authentication-flow" },
    ],
    updatedAt: new Date("2026-10-31T10:00:00.000Z"),
    ...overrides,
  };
}

describe("ATMS DAG Foundation & Project Decision Ledger Store (dag.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. ATMS Decision Node Normalization & Deep Cloning
  // =========================================================================
  describe("1. cloneATMSDecisionNode — Normalization & Immutability", () => {
    it("should deep clone an ATMSDecisionNode so mutating the clone never alters the source", () => {
      const original = createTestDecisionNode();
      const cloned = cloneATMSDecisionNode(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.conceptTags).not.toBe(original.conceptTags);
      expect(cloned.dependsOn).not.toBe(original.dependsOn);
      expect(cloned.dependedBy).not.toBe(original.dependedBy);
      expect(cloned.affectedSections).not.toBe(original.affectedSections);
      expect(cloned.evaluatedAlternatives).not.toBe(original.evaluatedAlternatives);

      // Mutate clone arrays
      cloned.conceptTags.push("mutated-tag");
      cloned.dependsOn.push("mutated-dep");
      cloned.affectedSections.push({ fileId: "new-doc", headingSlug: "new-heading" });
      cloned.evaluatedAlternatives.push({
        optionKey: "NEW_OPTION",
        neutralSummary: "summary",
        rationaleAndPremises: "premises",
      });

      expect(original.conceptTags).toEqual(["authentication", "security"]);
      expect(original.dependsOn).toEqual([]);
      expect(original.affectedSections).toHaveLength(1);
      expect(original.evaluatedAlternatives).toHaveLength(2);
    });

    it("should trim strings and deduplicate concept tags and affected sections", () => {
      const nodeWithMessyData = createTestDecisionNode({
        decisionId: "  dec-trailing-spaces  ",
        topicSlug: "  trimmed-slug  ",
        selectedOptionKey: "  OPTION_A  ",
        conceptTags: ["auth", "  auth  ", "security", "", "   ", "security", "database"],
        runnerUpOptionKey: "   ",
        affectedSections: [
          { fileId: "doc-1", headingSlug: "auth" },
          { fileId: "  doc-1  ", headingSlug: "  auth  " }, // duplicate
          { fileId: "doc-1", headingSlug: "session" }, // different heading
          { fileId: "", headingSlug: "ignored" }, // empty fileId
          { fileId: "doc-2", headingSlug: "" }, // empty headingSlug
        ],
      });

      const cloned = cloneATMSDecisionNode(nodeWithMessyData);

      expect(cloned.decisionId).toBe("dec-trailing-spaces");
      expect(cloned.topicSlug).toBe("trimmed-slug");
      expect(cloned.selectedOptionKey).toBe("OPTION_A");
      expect(cloned.runnerUpOptionKey).toBeNull();
      expect(cloned.conceptTags).toEqual(["auth", "security", "database"]);
      expect(cloned.affectedSections).toEqual([
        { fileId: "doc-1", headingSlug: "auth" },
        { fileId: "doc-1", headingSlug: "session" },
      ]);
    });

    it("should strictly filter system-reserved sentinels from dependsOn and dependedBy edges", () => {
      const nodeWithSentinels = createTestDecisionNode({
        dependsOn: ["dec-prior-01", PROJECT_TAXONOMY_SENTINEL_ID, "dec-prior-02", "__INTERNAL_SENTINEL__"],
        dependedBy: [PROJECT_TAXONOMY_SENTINEL_ID, "dec-child-01", "dec-child-01"],
      });

      const cloned = cloneATMSDecisionNode(nodeWithSentinels);

      expect(cloned.dependsOn).toEqual(["dec-prior-01", "dec-prior-02"]);
      expect(cloned.dependedBy).toEqual(["dec-child-01"]);
    });

    it("should handle optional Date and string updatedAt representations", () => {
      const dateNode = createTestDecisionNode({ updatedAt: new Date("2026-10-31T12:00:00Z") });
      const clonedDate = cloneATMSDecisionNode(dateNode);
      expect(clonedDate.updatedAt).toBeInstanceOf(Date);
      expect(clonedDate.updatedAt).not.toBe(dateNode.updatedAt);
      expect((clonedDate.updatedAt as Date).toISOString()).toBe("2026-10-31T12:00:00.000Z");

      const stringNode = createTestDecisionNode({ updatedAt: "2026-10-31T12:00:00.000Z" });
      const clonedString = cloneATMSDecisionNode(stringNode);
      expect(clonedString.updatedAt).toBe("2026-10-31T12:00:00.000Z");

      const undefinedNode = createTestDecisionNode({ updatedAt: undefined });
      const clonedUndefined = cloneATMSDecisionNode(undefinedNode);
      expect(clonedUndefined.updatedAt).toBeUndefined();
    });

    it("should handle non-boolean isLoadBearing and alternatives without normalizedProbability", () => {
      const edgeNode = createTestDecisionNode({
        isLoadBearing: 1 as unknown as boolean,
        evaluatedAlternatives: [
          {
            optionKey: "OPT_1",
            neutralSummary: "Summary without probability",
            rationaleAndPremises: "Premises",
          },
        ],
      });

      const cloned = cloneATMSDecisionNode(edgeNode);
      expect(cloned.isLoadBearing).toBe(true);
      expect(cloned.evaluatedAlternatives[0].normalizedProbability).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. cloneMasterLedger — Sentinel Exclusion & Record Purification
  // =========================================================================
  describe("2. cloneMasterLedger — Sentinel Filtering & Ledger Hygiene", () => {
    it("should clone valid nodes and completely strip system-reserved sentinel entries", () => {
      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-1": createTestDecisionNode({ decisionId: "dec-1", topicSlug: "topic-1" }),
        [PROJECT_TAXONOMY_SENTINEL_ID]: createTestDecisionNode({
          decisionId: PROJECT_TAXONOMY_SENTINEL_ID,
          topicSlug: "taxonomy",
        }),
        "dec-2": createTestDecisionNode({ decisionId: "dec-2", topicSlug: "topic-2" }),
        "__RESERVED_CUSTOM__": createTestDecisionNode({
          decisionId: "__RESERVED_CUSTOM__",
          topicSlug: "reserved",
        }),
      };

      const cloned = cloneMasterLedger(masterLedger);

      expect(Object.keys(cloned).sort()).toEqual(["dec-1", "dec-2"]);
      expect(cloned["dec-1"].topicSlug).toBe("topic-1");
      expect(cloned["dec-2"].topicSlug).toBe("topic-2");
      expect(cloned[PROJECT_TAXONOMY_SENTINEL_ID]).toBeUndefined();
    });

    it("should return an empty object when passed null, undefined, arrays, or non-objects", () => {
      expect(cloneMasterLedger(null as unknown as Record<string, ATMSDecisionNode>)).toEqual({});
      expect(cloneMasterLedger(undefined as unknown as Record<string, ATMSDecisionNode>)).toEqual({});
      expect(cloneMasterLedger([] as unknown as Record<string, ATMSDecisionNode>)).toEqual({});
      expect(cloneMasterLedger("invalid" as unknown as Record<string, ATMSDecisionNode>)).toEqual({});
    });

    it("should skip malformed entries and fallback to key when node decisionId is empty", () => {
      const dirtyLedger = {
        "valid-id": createTestDecisionNode({ decisionId: "valid-id" }),
        "empty-node": null as unknown as ATMSDecisionNode,
        "   ": createTestDecisionNode({ decisionId: "   " }), // both key and id empty -> skipped
        "fallback-id": createTestDecisionNode({ decisionId: "   " }), // falls back to key
      };

      const cloned = cloneMasterLedger(dirtyLedger);
      expect(Object.keys(cloned).sort()).toEqual(["fallback-id", "valid-id"]);
      expect(cloned["fallback-id"].decisionId).toBe("fallback-id");
    });
  });

  // =========================================================================
  // 3. loadProjectDecisionLedger — Reading & Deserialization
  // =========================================================================
  describe("3. loadProjectDecisionLedger — Multi-Tenant Loading & Deserialization", () => {
    it("should reject empty projectId or userId with descriptive errors", async () => {
      await expect(loadProjectDecisionLedger("", "user-1")).rejects.toThrow(
        "ATMS Decision Ledger: projectId must be a non-empty string."
      );
      await expect(loadProjectDecisionLedger("   ", "user-1")).rejects.toThrow(
        "ATMS Decision Ledger: projectId must be a non-empty string."
      );
      await expect(loadProjectDecisionLedger("project-1", "")).rejects.toThrow(
        "ATMS Decision Ledger: userId must be a non-empty string."
      );
      await expect(loadProjectDecisionLedger("project-1", "   ")).rejects.toThrow(
        "ATMS Decision Ledger: userId must be a non-empty string."
      );
    });

    it("should load decision rows and parse project taxonomy sentinel correctly", async () => {
      const taxonomyState: ProjectTaxonomyState = {
        projectId: "proj-100",
        addedTags: ["wasm_security"],
        removedTags: ["kubernetes_deployment"],
        updatedAt: "2026-10-31T10:00:00.000Z",
      };
      const taxonomyPayload = toTaxonomyLedgerPayload(taxonomyState);

      const mockDbRows = [
        {
          projectId: "proj-100",
          userId: "user-abc",
          decisionId: "dec-cache",
          topicSlug: "cache-layer",
          questionPrompt: "Which cache layer?",
          conceptTags: ["caching", "performance"],
          selectedOptionKey: "REDIS",
          selectionRationale: "In-memory speed",
          runnerUpOptionKey: "MEMCACHED",
          evaluatedAlternatives: [],
          status: "APPROVED_DIRECT",
          impactTier: "CORE_ARCHITECTURAL",
          isLoadBearing: true,
          dependsOn: [],
          dependedBy: [],
          affectedSections: [{ fileId: "f1", headingSlug: "cache" }],
          updatedAt: new Date("2026-10-31T10:00:00Z"),
        },
        {
          projectId: "proj-100",
          userId: "user-abc",
          ...taxonomyPayload,
          updatedAt: new Date("2026-10-31T10:00:00Z"),
        },
      ];

      const selectMock = vi.mocked(db.select);
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mockDbRows),
      });
      selectMock.mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const result = await loadProjectDecisionLedger("proj-100", "user-abc");

      expect(result.masterLedger["dec-cache"]).toBeDefined();
      expect(result.masterLedger["dec-cache"].decisionId).toBe("dec-cache");
      expect(result.masterLedger["dec-cache"].selectedOptionKey).toBe("REDIS");
      expect(result.masterLedger[PROJECT_TAXONOMY_SENTINEL_ID]).toBeUndefined();

      expect(result.projectTaxonomy).toBeDefined();
      expect(result.projectTaxonomy?.projectId).toBe("proj-100");
      expect(result.projectTaxonomy?.addedTags).toEqual(["wasm_security"]);
      expect(result.projectTaxonomy?.removedTags).toEqual(["kubernetes_deployment"]);
    });

    it("should filter out rows belonging to another project or user and return empty state if no records match", async () => {
      const foreignRows = [
        {
          projectId: "proj-FOREIGN",
          userId: "user-abc",
          decisionId: "dec-leak-1",
        },
        {
          projectId: "proj-100",
          userId: "user-FOREIGN",
          decisionId: "dec-leak-2",
        },
      ];

      const selectMock = vi.mocked(db.select);
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(foreignRows),
      });
      selectMock.mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const result = await loadProjectDecisionLedger("proj-100", "user-abc");

      expect(result.masterLedger).toEqual({});
      expect(result.projectTaxonomy).toBeNull();
    });

    it("should safely handle database rows with null/missing array fields and fallback defaults", async () => {
      const edgeRow = [
        {
          projectId: "proj-fallback",
          userId: "user-fallback",
          decisionId: "dec-sparse",
          topicSlug: "sparse-topic",
          questionPrompt: "Sparse prompt?",
          conceptTags: null,
          selectedOptionKey: "OPT_A",
          selectionRationale: "Rationale",
          runnerUpOptionKey: null,
          evaluatedAlternatives: null,
          status: "UNKNOWN_STATUS" as unknown as "APPROVED_DIRECT",
          impactTier: "UNKNOWN_TIER" as unknown as "CORE_ARCHITECTURAL",
          isLoadBearing: false,
          dependsOn: null,
          dependedBy: null,
          affectedSections: null,
          updatedAt: undefined,
        },
      ];

      const selectMock = vi.mocked(db.select);
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(edgeRow),
      });
      selectMock.mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const result = await loadProjectDecisionLedger("proj-fallback", "user-fallback");
      const loadedNode = result.masterLedger["dec-sparse"];

      expect(loadedNode).toBeDefined();
      expect(loadedNode.conceptTags).toEqual([]);
      expect(loadedNode.evaluatedAlternatives).toEqual([]);
      expect(loadedNode.affectedSections).toEqual([]);
      expect(loadedNode.status).toBe("APPROVED_DIRECT");
      expect(loadedNode.impactTier).toBe("CORE_ARCHITECTURAL");
    });
  });

  // =========================================================================
  // 4. syncMasterLedgerToProjectStore — Persistence, Eviction & Multi-Tenancy
  // =========================================================================
  describe("4. syncMasterLedgerToProjectStore — Atomic Upsert & Eviction Pruning", () => {
    it("should validate input arguments and reject invalid masterLedger structures", async () => {
      await expect(
        syncMasterLedgerToProjectStore("", "user-1", {})
      ).rejects.toThrow("ATMS Decision Ledger: projectId must be a non-empty string.");

      await expect(
        syncMasterLedgerToProjectStore("proj-1", "", {})
      ).rejects.toThrow("ATMS Decision Ledger: userId must be a non-empty string.");

      await expect(
        syncMasterLedgerToProjectStore("proj-1", "user-1", [] as unknown as Record<string, ATMSDecisionNode>)
      ).rejects.toThrow("ATMS Decision Ledger: masterLedger must be a valid record object.");
    });

    it("should abort and throw when an existing project row is owned by a different userId (multi-tenant guard)", async () => {
      const foreignRow = [
        {
          projectId: "proj-shared",
          userId: "user-OTHER-TENANT",
          decisionId: "dec-conflict",
        },
      ];

      const selectMock = vi.mocked(db.select);
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(foreignRow),
      });
      selectMock.mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const masterLedger = {
        "dec-auth": createTestDecisionNode({ decisionId: "dec-auth" }),
      };

      await expect(
        syncMasterLedgerToProjectStore("proj-shared", "user-MY-TENANT", masterLedger)
      ).rejects.toThrow(
        'ATMS Decision Ledger: cross-tenant ownership conflict on project "proj-shared" decision "dec-conflict".'
      );
    });

    it("should prune evicted decisions not present in active masterLedger while strictly sparing sentinels", async () => {
      const persistedRows = [
        {
          projectId: "proj-1",
          userId: "user-1",
          decisionId: "dec-retained",
        },
        {
          projectId: "proj-1",
          userId: "user-1",
          decisionId: "dec-obsolete-to-prune",
        },
        {
          projectId: "proj-1",
          userId: "user-1",
          decisionId: PROJECT_TAXONOMY_SENTINEL_ID,
        },
      ];

      const selectMock = vi.mocked(db.select);
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(persistedRows),
      });
      selectMock.mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const insertMock = vi.mocked(db.insert);
      const insertValuesMock = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      });
      insertMock.mockReturnValue({ values: insertValuesMock } as unknown as ReturnType<typeof db.insert>);

      const deleteMock = vi.mocked(db.delete);
      const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
      deleteMock.mockReturnValue({ where: deleteWhereMock } as unknown as ReturnType<typeof db.delete>);

      const masterLedger = {
        "dec-retained": createTestDecisionNode({ decisionId: "dec-retained" }),
      };

      await syncMasterLedgerToProjectStore("proj-1", "user-1", masterLedger, null, { pruneEvicted: true });

      // Verifies delete was called for the evicted decision
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteWhereMock).toHaveBeenCalledTimes(1);

      // Verifies upsert was called for the retained node
      expect(insertMock).toHaveBeenCalledTimes(1);
    });

    it("should skip eviction deletion when pruneEvicted is explicitly set to false", async () => {
      const persistedRows = [
        {
          projectId: "proj-1",
          userId: "user-1",
          decisionId: "dec-not-in-active",
        },
      ];

      const selectMock = vi.mocked(db.select);
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(persistedRows),
      });
      selectMock.mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const insertMock = vi.mocked(db.insert);
      const insertValuesMock = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      });
      insertMock.mockReturnValue({ values: insertValuesMock } as unknown as ReturnType<typeof db.insert>);

      const deleteMock = vi.mocked(db.delete);

      const masterLedger = {
        "dec-active": createTestDecisionNode({ decisionId: "dec-active" }),
      };

      await syncMasterLedgerToProjectStore("proj-1", "user-1", masterLedger, null, { pruneEvicted: false });

      expect(deleteMock).not.toHaveBeenCalled();
      expect(insertMock).toHaveBeenCalledTimes(1);
    });

    it("should upsert project taxonomy sentinel row when projectTaxonomy is provided", async () => {
      const selectMock = vi.mocked(db.select);
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      });
      selectMock.mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const capturedRows: unknown[] = [];
      const insertMock = vi.mocked(db.insert);
      const insertValuesMock = vi.fn().mockImplementation((row) => {
        capturedRows.push(row);
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        };
      });
      insertMock.mockReturnValue({ values: insertValuesMock } as unknown as ReturnType<typeof db.insert>);

      const taxonomy: ProjectTaxonomyState = {
        projectId: "proj-1",
        addedTags: ["graphql_federation"],
        removedTags: [],
      };

      const masterLedger = {
        "dec-1": createTestDecisionNode({ decisionId: "dec-1" }),
      };

      await syncMasterLedgerToProjectStore("proj-1", "user-1", masterLedger, taxonomy);

      expect(capturedRows).toHaveLength(2);
      const taxonomyRow = capturedRows.find(
        (r) => (r as { decisionId: string }).decisionId === PROJECT_TAXONOMY_SENTINEL_ID
      );
      expect(taxonomyRow).toBeDefined();
    });

    it("should prune all prior decisions when active masterLedger is empty", async () => {
      const persistedRows = [
        {
          projectId: "proj-1",
          userId: "user-1",
          decisionId: "dec-to-prune-1",
        },
        {
          projectId: "proj-1",
          userId: "user-1",
          decisionId: "dec-to-prune-2",
        },
      ];

      const selectMock = vi.mocked(db.select);
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(persistedRows),
      });
      selectMock.mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const deleteMock = vi.mocked(db.delete);
      const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
      deleteMock.mockReturnValue({ where: deleteWhereMock } as unknown as ReturnType<typeof db.delete>);

      await syncMasterLedgerToProjectStore("proj-1", "user-1", {}, null, { pruneEvicted: true });

      expect(deleteMock).toHaveBeenCalledTimes(1);
    });

    it("should return early without database operations when ledger is empty and pruneEvicted is false", async () => {
      const selectMock = vi.mocked(db.select);
      const insertMock = vi.mocked(db.insert);
      const deleteMock = vi.mocked(db.delete);

      await syncMasterLedgerToProjectStore("proj-1", "user-1", {}, null, { pruneEvicted: false });

      expect(selectMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
      expect(deleteMock).not.toHaveBeenCalled();
    });
  });
});

describe("Deterministic Candidate Prior Decisions Retriever (candidate-retriever.ts)", () => {
  // Common test fixture decisions across different architectural concerns
  const decisionAuthSession = createTestDecisionNode({
    decisionId: "dec-auth-session",
    topicSlug: "auth-session-management",
    questionPrompt: "How should session tokens be stored on client?",
    conceptTags: ["authentication", "security", "cryptography"],
    selectedOptionKey: "HTTP_ONLY_COOKIES",
    selectionRationale: "Mitigates XSS token leakage with strict SameSite protection.",
    isLoadBearing: true,
    affectedSections: [
      { fileId: "doc-auth", headingSlug: "authentication-security" },
      { fileId: "doc-auth", headingSlug: "authentication-security-tokens" },
    ],
    updatedAt: new Date("2026-10-31T10:00:00.000Z"),
  });

  const decisionDatabaseOrm = createTestDecisionNode({
    decisionId: "dec-database-orm",
    topicSlug: "database-access-layer",
    questionPrompt: "Which ORM should be selected for Postgres access?",
    conceptTags: ["database", "backend_architecture", "performance"],
    selectedOptionKey: "DRIZZLE_ORM",
    selectionRationale: "Zero-dependency lightweight SQL-first queries without heavy engine overhead.",
    isLoadBearing: false,
    affectedSections: [
      { fileId: "doc-db", headingSlug: "database-schema-and-access" },
    ],
    updatedAt: new Date("2026-10-31T09:00:00.000Z"),
  });

  const decisionRateLimiter = createTestDecisionNode({
    decisionId: "dec-rate-limiter",
    topicSlug: "api-rate-limiting",
    questionPrompt: "Which rate limiting algorithm for public API endpoints?",
    conceptTags: ["security", "networking", "performance"],
    selectedOptionKey: "TOKEN_BUCKET_UPSTASH",
    selectionRationale: "Redis token bucket algorithm with edge latency.",
    isLoadBearing: false,
    affectedSections: [
      { fileId: "doc-api", headingSlug: "security-rate-limiting" },
    ],
    updatedAt: new Date("2026-10-31T11:00:00.000Z"),
  });

  const testMasterLedger: Record<string, ATMSDecisionNode> = {
    [decisionAuthSession.decisionId]: decisionAuthSession,
    [decisionDatabaseOrm.decisionId]: decisionDatabaseOrm,
    [decisionRateLimiter.decisionId]: decisionRateLimiter,
  };

  // =========================================================================
  // 5. Signal 1 — AST Section Proximity Scoring
  // =========================================================================
  describe("5. Signal 1 — AST Section Proximity & Architectural Invariant", () => {
    it("should assign exact heading proximity score = 1.0 (weighted = 3.0) for identical fileId and headingSlug", () => {
      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-auth-csrf",
        assumptionStatement: "CSRF token protection is enabled for all mutating routes.",
        conceptTags: [],
        affectedSections: [
          { fileId: "doc-auth", headingSlug: "authentication-security" },
        ],
      };

      const scored = scoreCandidatePriorDecisions(assumption, testMasterLedger);
      const authCandidate = scored.find((c) => c.node.decisionId === "dec-auth-session");

      expect(authCandidate).toBeDefined();
      expect(authCandidate?.astProximityScore).toBe(1.0);
      expect(authCandidate?.totalScore).toBeGreaterThanOrEqual(
        CANDIDATE_RETRIEVAL_WEIGHTS.astSectionProximity * 1.0
      );
    });

    it("should assign hierarchical heading proximity score = 0.5 (weighted = 1.5) for hyphen and slash prefixes", () => {
      // Test hyphen-delimited hierarchy ("authentication-security" parent of "authentication-security-tokens")
      const assumptionHyphen: CandidateRetrievalInput = {
        assumptionId: "asm-hierarchical-hyphen",
        assumptionStatement: "Generic token validation check.",
        conceptTags: [],
        affectedSections: [
          // "authentication-security-tokens-refresh" is a child of "authentication-security-tokens"
          { fileId: "doc-auth", headingSlug: "authentication-security-tokens-refresh" },
        ],
      };

      const scoredHyphen = scoreCandidatePriorDecisions(assumptionHyphen, testMasterLedger);
      const authCandidate = scoredHyphen.find((c) => c.node.decisionId === "dec-auth-session");

      expect(authCandidate).toBeDefined();
      expect(authCandidate?.astProximityScore).toBe(0.5);

      // Test slash-delimited hierarchy
      const slashNode = createTestDecisionNode({
        decisionId: "dec-slash-hierarchy",
        affectedSections: [{ fileId: "doc-slash", headingSlug: "auth/rbac" }],
      });
      const assumptionSlash: CandidateRetrievalInput = {
        assumptionId: "asm-hierarchical-slash",
        assumptionStatement: "Role based permissions check.",
        conceptTags: [],
        affectedSections: [{ fileId: "doc-slash", headingSlug: "auth/rbac/admin" }],
      };

      const scoredSlash = scoreCandidatePriorDecisions(assumptionSlash, {
        [slashNode.decisionId]: slashNode,
      });
      expect(scoredSlash[0]?.astProximityScore).toBe(0.5);
    });

    it("should prioritize exact heading match (1.0) when multiple section targets overlap", () => {
      const multiSectionNode = createTestDecisionNode({
        decisionId: "dec-multi-section",
        affectedSections: [
          { fileId: "doc-shared", headingSlug: "auth-hierarchical" },
          { fileId: "doc-shared", headingSlug: "auth-exact" },
        ],
      });

      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-multi",
        conceptTags: [],
        affectedSections: [
          { fileId: "doc-shared", headingSlug: "auth-hierarchical-child" }, // hierarchical (0.5)
          { fileId: "doc-shared", headingSlug: "auth-exact" }, // exact (1.0)
        ],
      };

      const scored = scoreCandidatePriorDecisions(assumption, {
        [multiSectionNode.decisionId]: multiSectionNode,
      });

      expect(scored[0]?.astProximityScore).toBe(1.0);
    });

    it("should assign 0.0 proximity score when fileId differs or heading slugs are completely disjoint", () => {
      const assumptionDisjoint: CandidateRetrievalInput = {
        assumptionId: "asm-disjoint",
        assumptionStatement: "Completely unrelated infrastructure topic.",
        conceptTags: [],
        affectedSections: [
          { fileId: "doc-unrelated", headingSlug: "authentication-security" }, // same heading, different fileId
          { fileId: "doc-auth", headingSlug: "unrelated-heading" }, // same fileId, unrelated heading
        ],
      };

      const scored = scoreCandidatePriorDecisions(assumptionDisjoint, testMasterLedger);
      const authCandidate = scored.find((c) => c.node.decisionId === "dec-auth-session");
      // Since concepts and lexical match are also absent or disjoint, total score should be 0 or astProximityScore = 0
      if (authCandidate) {
        expect(authCandidate.astProximityScore).toBe(0.0);
      }
    });

    it("ARCHITECTURAL INVARIANT: sharing (fileId, headingSlug) is strictly a candidate signal and does NOT force a dependency link", () => {
      // Multiple independent sub-decisions coexisting under the same document heading
      const subDecisionA = createTestDecisionNode({
        decisionId: "dec-sub-a-cookie-expiry",
        affectedSections: [{ fileId: "doc-auth", headingSlug: "authentication-security" }],
        dependsOn: [],
      });
      const subDecisionB = createTestDecisionNode({
        decisionId: "dec-sub-b-header-injection",
        affectedSections: [{ fileId: "doc-auth", headingSlug: "authentication-security" }],
        dependsOn: [],
      });

      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-sub-c",
        assumptionStatement: "Independent conservative sub-decision on rate limit headers.",
        conceptTags: [],
        affectedSections: [{ fileId: "doc-auth", headingSlug: "authentication-security" }],
      };

      const ledger = {
        [subDecisionA.decisionId]: subDecisionA,
        [subDecisionB.decisionId]: subDecisionB,
      };

      const candidates = retrieveCandidatePriorDecisions(assumption, ledger);

      // Both candidates are retrieved for relational evaluation
      expect(candidates.map((c) => c.decisionId)).toContain("dec-sub-a-cookie-expiry");
      expect(candidates.map((c) => c.decisionId)).toContain("dec-sub-b-header-injection");

      // Their dependsOn edges remain completely independent and unmutated
      expect(candidates.find((c) => c.decisionId === "dec-sub-a-cookie-expiry")?.dependsOn).toEqual([]);
      expect(candidates.find((c) => c.decisionId === "dec-sub-b-header-injection")?.dependsOn).toEqual([]);
    });
  });

  // =========================================================================
  // 6. Signal 2 — Concept Tags Jaccard Overlap
  // =========================================================================
  describe("6. Signal 2 — Concept Tags Jaccard Intersection", () => {
    it("should compute exact Jaccard similarity (|A ∩ B| / |A ∪ B|) normalized between 0 and 1", () => {
      // dec-auth-session has ["authentication", "security", "cryptography"] (size 3)
      // assumption has ["authentication", "security", "network"] (size 3)
      // Intersection: ["authentication", "security"] (size 2)
      // Union: ["authentication", "security", "cryptography", "network"] (size 4)
      // Jaccard: 2 / 4 = 0.5
      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-tag-jaccard",
        conceptTags: ["authentication", "security", "network"],
      };

      const scored = scoreCandidatePriorDecisions(assumption, testMasterLedger);
      const authCandidate = scored.find((c) => c.node.decisionId === "dec-auth-session");

      expect(authCandidate).toBeDefined();
      expect(authCandidate?.conceptTagScore).toBeCloseTo(0.5, 6);
    });

    it("should normalize candidate tags (case, whitespace, delimiters) before computing intersection", () => {
      const assumptionWithUnnormalizedTags: CandidateRetrievalInput = {
        assumptionId: "asm-norm-tags",
        conceptTags: ["  AUTHENTICATION  ", "Security", "CRYPTOGRAPHY"],
      };

      const scored = scoreCandidatePriorDecisions(assumptionWithUnnormalizedTags, testMasterLedger);
      const authCandidate = scored.find((c) => c.node.decisionId === "dec-auth-session");

      // Full overlap with dec-auth-session (size 3 / 3 = 1.0)
      expect(authCandidate?.conceptTagScore).toBeCloseTo(1.0, 6);
    });

    it("should return 0.0 concept tag score when either set is empty or tags are disjoint", () => {
      const emptyAssumption: CandidateRetrievalInput = {
        assumptionId: "asm-empty-tags",
        conceptTags: [],
      };
      const scoredEmpty = scoreCandidatePriorDecisions(emptyAssumption, testMasterLedger);
      for (const candidate of scoredEmpty) {
        expect(candidate.conceptTagScore).toBe(0.0);
      }

      const disjointAssumption: CandidateRetrievalInput = {
        assumptionId: "asm-disjoint-tags",
        conceptTags: ["completely_foreign_tag"],
      };
      const scoredDisjoint = scoreCandidatePriorDecisions(disjointAssumption, testMasterLedger);
      for (const candidate of scoredDisjoint) {
        expect(candidate.conceptTagScore).toBe(0.0);
      }
    });
  });

  // =========================================================================
  // 7. Signal 3 — BM25 Lexical Match Over Decisions & Alternatives
  // =========================================================================
  describe("7. Signal 3 — Okapi BM25 Lexical Matching", () => {
    it("should match query text across questionPrompt, selectionRationale, and evaluatedAlternatives", () => {
      // Query specifically targeting words in evaluatedAlternatives: "stateless verification with serverless edge caching"
      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-bm25-match",
        assumptionStatement: "Stateless JWT verification with serverless cookies",
        conceptTags: [],
      };

      const scored = scoreCandidatePriorDecisions(assumption, testMasterLedger);
      const authCandidate = scored.find((c) => c.node.decisionId === "dec-auth-session");

      expect(authCandidate).toBeDefined();
      expect(authCandidate?.lexicalBm25Score).toBeGreaterThan(0.0);
      expect(authCandidate?.lexicalBm25Score).toBeLessThan(1.0);
    });

    it("should fall back to statement field if assumptionStatement is missing or empty", () => {
      const assumptionWithFallback: CandidateRetrievalInput = {
        assumptionId: "asm-fallback",
        statement: "Stateless JWT cookies",
        conceptTags: [],
      };

      const scored = scoreCandidatePriorDecisions(assumptionWithFallback, testMasterLedger);
      const authCandidate = scored.find((c) => c.node.decisionId === "dec-auth-session");

      expect(authCandidate).toBeDefined();
      expect(authCandidate?.lexicalBm25Score).toBeGreaterThan(0.0);
    });

    it("should return 0.0 lexical score when query text is blank or has no overlapping tokens", () => {
      const blankAssumption: CandidateRetrievalInput = {
        assumptionId: "asm-blank",
        assumptionStatement: "   ",
        conceptTags: [],
      };

      const scored = scoreCandidatePriorDecisions(blankAssumption, testMasterLedger);
      for (const candidate of scored) {
        expect(candidate.lexicalBm25Score).toBe(0.0);
      }
    });
  });

  // =========================================================================
  // 8. Deterministic Composite Scoring, Ranking & Tie-Breaking
  // =========================================================================
  describe("8. Composite Ranking & Strict Deterministic Tie-Breaking", () => {
    it("should calculate exact composite totalScore based on defined weights", () => {
      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-weighted",
        assumptionStatement: "Drizzle ORM SQL queries",
        conceptTags: ["database", "backend_architecture"],
        affectedSections: [{ fileId: "doc-db", headingSlug: "database-schema-and-access" }],
      };

      const scored = scoreCandidatePriorDecisions(assumption, testMasterLedger);
      const dbCandidate = scored.find((c) => c.node.decisionId === "dec-database-orm");

      expect(dbCandidate).toBeDefined();
      if (!dbCandidate) return;

      const expectedTotal =
        CANDIDATE_RETRIEVAL_WEIGHTS.astSectionProximity * dbCandidate.astProximityScore +
        CANDIDATE_RETRIEVAL_WEIGHTS.conceptTagOverlap * dbCandidate.conceptTagScore +
        CANDIDATE_RETRIEVAL_WEIGHTS.lexicalBm25 * dbCandidate.lexicalBm25Score;

      expect(dbCandidate.totalScore).toBeCloseTo(expectedTotal, 8);
    });

    it("should break ties deterministically: (1) isLoadBearing, (2) updatedAt descending, (3) decisionId ascending", () => {
      // Create 4 decisions with identical scores (all signals zero except tag overlap)
      const baseNode = {
        questionPrompt: "prompt",
        conceptTags: ["shared_tag"],
        selectedOptionKey: "OPT",
        selectionRationale: "rationale",
        affectedSections: [],
      };

      const nodeA = createTestDecisionNode({
        ...baseNode,
        decisionId: "dec-aaa",
        isLoadBearing: false,
        updatedAt: new Date("2026-10-31T10:00:00.000Z"),
      });

      const nodeB = createTestDecisionNode({
        ...baseNode,
        decisionId: "dec-bbb",
        isLoadBearing: true, // Should win over non-load-bearing
        updatedAt: new Date("2026-10-31T09:00:00.000Z"),
      });

      const nodeC = createTestDecisionNode({
        ...baseNode,
        decisionId: "dec-ccc",
        isLoadBearing: false,
        updatedAt: new Date("2026-10-31T12:00:00.000Z"), // Newer timestamp, should beat nodeA
      });

      const nodeD = createTestDecisionNode({
        ...baseNode,
        decisionId: "dec-ddd",
        isLoadBearing: false,
        updatedAt: new Date("2026-10-31T10:00:00.000Z"), // Same timestamp as nodeA, but decisionId 'dec-aaa' < 'dec-ddd'
      });

      const tiedLedger: Record<string, ATMSDecisionNode> = {
        "dec-ddd": nodeD,
        "dec-ccc": nodeC,
        "dec-aaa": nodeA,
        "dec-bbb": nodeB,
      };

      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-tie",
        conceptTags: ["shared_tag"],
      };

      const candidates = retrieveCandidatePriorDecisions(assumption, tiedLedger, 10);
      const retrievedIds = candidates.map((c) => c.decisionId);

      // Expected tie-breaking order:
      // 1. nodeB (isLoadBearing: true)
      // 2. nodeC (updatedAt: 12:00 vs 10:00)
      // 3. nodeA (updatedAt: 10:00, id 'dec-aaa' < 'dec-ddd')
      // 4. nodeD (updatedAt: 10:00, id 'dec-ddd')
      expect(retrievedIds).toEqual(["dec-bbb", "dec-ccc", "dec-aaa", "dec-ddd"]);
    });

    it("should guarantee bit-identical candidate order regardless of masterLedger key insertion order", () => {
      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-order-test",
        assumptionStatement: "security tokens and database architecture",
        conceptTags: ["security", "database"],
      };

      const ledger1 = {
        "dec-auth-session": decisionAuthSession,
        "dec-database-orm": decisionDatabaseOrm,
        "dec-rate-limiter": decisionRateLimiter,
      };

      const ledger2 = {
        "dec-rate-limiter": decisionRateLimiter,
        "dec-database-orm": decisionDatabaseOrm,
        "dec-auth-session": decisionAuthSession,
      };

      const results1 = retrieveCandidatePriorDecisions(assumption, ledger1);
      const results2 = retrieveCandidatePriorDecisions(assumption, ledger2);

      expect(results1.map((r) => r.decisionId)).toEqual(results2.map((r) => r.decisionId));
    });

    it("should treat sub-1e-12 score differences as tied and activate tie-breaking logic", () => {
      // Both nodes have same tag overlap (score = 1.0)
      // Node A has updatedAt string, Node B has older Date, but Node B has isLoadBearing = true
      const nodeA = createTestDecisionNode({
        decisionId: "dec-sub-epsilon-a",
        conceptTags: ["shared_tag"],
        isLoadBearing: false,
        updatedAt: "2026-10-31T12:00:00Z",
      });
      const nodeB = createTestDecisionNode({
        decisionId: "dec-sub-epsilon-b",
        conceptTags: ["shared_tag"],
        isLoadBearing: true,
        updatedAt: "2026-10-31T10:00:00Z",
      });

      const ledger = {
        "dec-sub-epsilon-a": nodeA,
        "dec-sub-epsilon-b": nodeB,
      };

      const candidates = retrieveCandidatePriorDecisions(
        { assumptionId: "asm-eps", conceptTags: ["shared_tag"] },
        ledger
      );

      // Node B wins due to isLoadBearing = true even though its timestamp is earlier
      expect(candidates[0].decisionId).toBe("dec-sub-epsilon-b");
    });

    it("should safely handle malformed date string in updatedAt by falling back to timestamp 0", () => {
      const nodeInvalidDate = createTestDecisionNode({
        decisionId: "dec-invalid-date",
        conceptTags: ["shared_tag"],
        isLoadBearing: false,
        updatedAt: "not-a-valid-iso-date",
      });
      const nodeValidDate = createTestDecisionNode({
        decisionId: "dec-valid-date",
        conceptTags: ["shared_tag"],
        isLoadBearing: false,
        updatedAt: "2026-10-31T10:00:00Z",
      });

      const ledger = {
        "dec-invalid-date": nodeInvalidDate,
        "dec-valid-date": nodeValidDate,
      };

      const candidates = retrieveCandidatePriorDecisions(
        { assumptionId: "asm-date", conceptTags: ["shared_tag"] },
        ledger
      );

      // Valid date has positive timestamp, beating invalid date (timestamp 0)
      expect(candidates[0].decisionId).toBe("dec-valid-date");
    });
  });

  // =========================================================================
  // 9. Boundary Conditions, Limit Normalization & Input Immutability
  // =========================================================================
  describe("9. Edge Cases & Boundary Handling", () => {
    it("should normalize maxCandidates limits properly (0, negative, float, NaN, Infinity)", () => {
      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-limits",
        conceptTags: ["security"],
      };

      // 0 or negative -> empty array
      expect(retrieveCandidatePriorDecisions(assumption, testMasterLedger, 0)).toEqual([]);
      expect(retrieveCandidatePriorDecisions(assumption, testMasterLedger, -5)).toEqual([]);
      expect(retrieveCandidatePriorDecisions(assumption, testMasterLedger, Number.NaN)).toEqual([]);

      // Positive float -> floored
      const top1 = retrieveCandidatePriorDecisions(assumption, testMasterLedger, 1.99);
      expect(top1).toHaveLength(1);

      // Positive Infinity -> returns all candidates with score > 0
      const allScored = retrieveCandidatePriorDecisions(
        assumption,
        testMasterLedger,
        Number.POSITIVE_INFINITY
      );
      expect(allScored.length).toBeGreaterThanOrEqual(1);

      // Default parameter value is 8
      expect(DEFAULT_MAX_CANDIDATE_DECISIONS).toBe(8);
    });

    it("should return empty array when masterLedger or assumption is missing or null", () => {
      const validAssumption: CandidateRetrievalInput = {
        assumptionId: "asm-valid",
        conceptTags: ["security"],
      };

      expect(
        retrieveCandidatePriorDecisions(null as unknown as CandidateRetrievalInput, testMasterLedger)
      ).toEqual([]);
      expect(
        retrieveCandidatePriorDecisions(validAssumption, null as unknown as Record<string, ATMSDecisionNode>)
      ).toEqual([]);
      expect(
        retrieveCandidatePriorDecisions(validAssumption, {} as Record<string, ATMSDecisionNode>)
      ).toEqual([]);
    });

    it("should strictly exclude system-reserved sentinels from candidate retrieval", () => {
      const ledgerWithSentinel: Record<string, ATMSDecisionNode> = {
        ...testMasterLedger,
        [PROJECT_TAXONOMY_SENTINEL_ID]: createTestDecisionNode({
          decisionId: PROJECT_TAXONOMY_SENTINEL_ID,
          conceptTags: ["security"],
          selectionRationale: "System taxonomy payload",
        }),
      };

      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-test-sentinel",
        conceptTags: ["security"],
        assumptionStatement: "System taxonomy security",
      };

      const candidates = retrieveCandidatePriorDecisions(assumption, ledgerWithSentinel, 10);
      const candidateIds = candidates.map((c) => c.decisionId);

      expect(candidateIds).not.toContain(PROJECT_TAXONOMY_SENTINEL_ID);
    });

    it("should not mutate the input assumption or masterLedger objects", () => {
      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-immutable",
        assumptionStatement: "Security and caching",
        conceptTags: Object.freeze(["security", "caching"]) as unknown as string[],
        affectedSections: Object.freeze([
          Object.freeze({ fileId: "doc-auth", headingSlug: "auth" }),
        ]) as unknown as Array<{ fileId: string; headingSlug: string }>,
      };

      const ledgerCopy = cloneMasterLedger(testMasterLedger);
      retrieveCandidatePriorDecisions(assumption, testMasterLedger);

      expect(testMasterLedger).toEqual(ledgerCopy);
    });

    it("should default to retrieving exactly 8 candidates when maxCandidates is omitted", () => {
      // Build a ledger with 15 scored decisions
      const largeLedger: Record<string, ATMSDecisionNode> = {};
      for (let i = 1; i <= 15; i++) {
        const id = `dec-${String(i).padStart(2, "0")}`;
        largeLedger[id] = createTestDecisionNode({
          decisionId: id,
          conceptTags: ["security"],
          selectionRationale: `Security rationale ${i}`,
        });
      }

      const assumption: CandidateRetrievalInput = {
        assumptionId: "asm-default-eight",
        conceptTags: ["security"],
      };

      const candidates = retrieveCandidatePriorDecisions(assumption, largeLedger);
      expect(candidates).toHaveLength(8);
    });
  });
});

// ============================================================================
// Wave 8.2: Justification-Driven ATMS Relational Linker (relational-linker.ts)
// ============================================================================

describe("Justification-Driven ATMS Relational Linker (relational-linker.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockLedger: Record<string, ATMSDecisionNode> = {
    "dec-auth": createTestDecisionNode({
      decisionId: "dec-auth",
      topicSlug: "auth-strategy",
      questionPrompt: "Which auth mechanism?",
      conceptTags: ["authentication", "security"],
      selectedOptionKey: "SESSION_JWT",
      selectionRationale: "Stateless JWT tokens",
      impactTier: "CORE_ARCHITECTURAL",
      isLoadBearing: true,
      affectedSections: [{ fileId: "doc-auth", headingSlug: "auth-sec" }],
    }),
    "dec-db": createTestDecisionNode({
      decisionId: "dec-db",
      topicSlug: "database-layer",
      questionPrompt: "Which database?",
      conceptTags: ["database", "backend_architecture"],
      selectedOptionKey: "POSTGRESQL",
      selectionRationale: "Relational persistence with ACID guarantees",
      impactTier: "CORE_ARCHITECTURAL",
      isLoadBearing: true,
      affectedSections: [{ fileId: "doc-db", headingSlug: "db-sec" }],
    }),
    "dec-cache": createTestDecisionNode({
      decisionId: "dec-cache",
      topicSlug: "caching-layer",
      questionPrompt: "Which caching layer?",
      conceptTags: ["caching_strategy", "performance"],
      selectedOptionKey: "REDIS",
      selectionRationale: "In-memory caching",
      impactTier: "PERIPHERAL",
      isLoadBearing: false,
      affectedSections: [{ fileId: "doc-cache", headingSlug: "cache-sec" }],
    }),
  };

  describe("1. Boundary conditions & Short-Circuit Defense", () => {
    it("should return empty array without calling external evaluator when assumptions is empty, null, or undefined", async () => {
      const mockBatch = vi.mocked(evaluateRelationalLinksBatch);

      expect(await linkAssumptionsToPriorDecisions([], mockLedger)).toEqual([]);
      expect(
        await linkAssumptionsToPriorDecisions(
          null as unknown as CandidateRetrievalInput[],
          mockLedger
        )
      ).toEqual([]);
      expect(
        await linkAssumptionsToPriorDecisions(
          undefined as unknown as CandidateRetrievalInput[],
          mockLedger
        )
      ).toEqual([]);

      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("should return assumptions mapped with empty relations when masterLedger is empty, null, or undefined", async () => {
      const mockBatch = vi.mocked(evaluateRelationalLinksBatch);
      const assumptions: CandidateRetrievalInput[] = [
        { assumptionId: "asm-1", conceptTags: ["security"] },
        { assumptionId: "asm-2", conceptTags: ["database"] },
      ];

      const resEmpty = await linkAssumptionsToPriorDecisions(assumptions, {});
      expect(resEmpty).toHaveLength(2);
      expect(resEmpty[0].assumption.assumptionId).toBe("asm-1");
      expect(resEmpty[0].relations).toEqual([]);
      expect(resEmpty[1].assumption.assumptionId).toBe("asm-2");
      expect(resEmpty[1].relations).toEqual([]);

      const resNull = await linkAssumptionsToPriorDecisions(
        assumptions,
        null as unknown as Record<string, ATMSDecisionNode>
      );
      expect(resNull).toHaveLength(2);
      expect(resNull[0].relations).toEqual([]);

      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("should return assumptions with empty relations without calling evaluator when no candidates match or maxCandidates is 0", async () => {
      const mockBatch = vi.mocked(evaluateRelationalLinksBatch);
      const assumptions: CandidateRetrievalInput[] = [
        { assumptionId: "asm-1", conceptTags: ["quantum_computing_nonexistent"] },
      ];

      const result = await linkAssumptionsToPriorDecisions(assumptions, mockLedger, {
        maxCandidates: 0,
      });

      expect(result).toHaveLength(1);
      expect(result[0].relations).toEqual([]);
      expect(mockBatch).not.toHaveBeenCalled();
    });
  });

  describe("2. Single Flat Batch Pairing & Waterfall Prevention", () => {
    it("should collect all assumption-candidate comparison pairs across multiple assumptions into a single flat evaluateRelationalLinksBatch call", async () => {
      const mockBatch = vi.mocked(evaluateRelationalLinksBatch);

      const assumptions: CandidateRetrievalInput[] = [
        {
          assumptionId: "asm-auth",
          assumptionStatement: "We assume stateless JWT tokens for auth verification.",
          conceptTags: ["AUTHENTICATION", "security"], // mixed case to verify normalization
          affectedSections: [{ fileId: "doc-auth", headingSlug: "auth-sec" }],
        },
        {
          assumptionId: "asm-db",
          statement: "We assume Postgres database engine with ACID transactions.", // fallback .statement
          conceptTags: ["database", "backend_architecture"],
          affectedSections: [{ fileId: "doc-db", headingSlug: "db-sec" }],
        },
      ];

      const result = await linkAssumptionsToPriorDecisions(assumptions, mockLedger, {
        maxCandidates: 2,
      });

      // Crucial architectural invariant: Exactly 1 unified batch call (no N+1 waterfall!)
      expect(mockBatch).toHaveBeenCalledTimes(1);

      const calledPairs = mockBatch.mock.calls[0][0];
      expect(calledPairs.length).toBeGreaterThanOrEqual(2);

      // Verify pair properties
      const authPair = calledPairs.find((p) => p.assumptionId === "asm-auth" && p.candidateDecisionId === "dec-auth");
      expect(authPair).toBeDefined();
      expect(authPair?.assumptionStatement).toBe("We assume stateless JWT tokens for auth verification.");
      expect(authPair?.candidatePrompt).toBe("Which auth mechanism?");
      expect(authPair?.candidateSelectedOption).toBe("SESSION_JWT");
      // Verify normalized shared concept tags
      expect(authPair?.sharedConceptTags).toContain("authentication");
      expect(authPair?.sharedConceptTags).toContain("security");

      const dbPair = calledPairs.find((p) => p.assumptionId === "asm-db" && p.candidateDecisionId === "dec-db");
      expect(dbPair).toBeDefined();
      expect(dbPair?.assumptionStatement).toBe("We assume Postgres database engine with ACID transactions.");
      expect(dbPair?.candidatePrompt).toBe("Which database?");
      expect(dbPair?.candidateSelectedOption).toBe("POSTGRESQL");

      // Verify result structure
      expect(result).toHaveLength(2);
      expect(result[0].assumption.assumptionId).toBe("asm-auth");
      expect(result[1].assumption.assumptionId).toBe("asm-db");
    });
  });

  describe("3. Deterministic Ordering & Adjudication Mapping", () => {
    it("should strictly preserve input assumption order and candidate ranking order even with shuffled batch responses", async () => {
      const mockBatch = vi.mocked(evaluateRelationalLinksBatch);

      // Mock evaluateRelationalLinksBatch returning scrambled order
      mockBatch.mockResolvedValueOnce([
        {
          assumptionId: "asm-2",
          targetDecisionId: "dec-db",
          relationType: "DEPENDS_ON",
          confidence: 0.95,
          justification: "Database dependency",
        },
        {
          assumptionId: "asm-1",
          targetDecisionId: "dec-auth",
          relationType: "REFINES",
          confidence: 0.9,
          justification: "Auth refinement",
        },
      ]);

      const assumptions: CandidateRetrievalInput[] = [
        {
          assumptionId: "asm-1",
          assumptionStatement: "Auth assumption statement",
          conceptTags: ["authentication"],
        },
        {
          assumptionId: "asm-2",
          assumptionStatement: "DB assumption statement",
          conceptTags: ["database"],
        },
      ];

      const result = await linkAssumptionsToPriorDecisions(assumptions, mockLedger, {
        maxCandidates: 1,
      });

      // Input array order strictly preserved: asm-1 first, then asm-2
      expect(result).toHaveLength(2);
      expect(result[0].assumption.assumptionId).toBe("asm-1");
      expect(result[0].relations).toHaveLength(1);
      expect(result[0].relations[0].targetDecisionId).toBe("dec-auth");
      expect(result[0].relations[0].relationType).toBe("REFINES");

      expect(result[1].assumption.assumptionId).toBe("asm-2");
      expect(result[1].relations).toHaveLength(1);
      expect(result[1].relations[0].targetDecisionId).toBe("dec-db");
      expect(result[1].relations[0].relationType).toBe("DEPENDS_ON");
    });

    it("should gracefully handle batch evaluator omitting adjudication for a candidate without throwing", async () => {
      const mockBatch = vi.mocked(evaluateRelationalLinksBatch);

      // Evaluator returns empty array (e.g. dropped pairs)
      mockBatch.mockResolvedValueOnce([]);

      const assumptions: CandidateRetrievalInput[] = [
        {
          assumptionId: "asm-1",
          assumptionStatement: "Auth assumption statement",
          conceptTags: ["authentication"],
        },
      ];

      const result = await linkAssumptionsToPriorDecisions(assumptions, mockLedger, {
        maxCandidates: 2,
      });

      expect(result).toHaveLength(1);
      expect(result[0].assumption.assumptionId).toBe("asm-1");
      expect(result[0].relations).toEqual([]);
    });

    it("should pass through abortSignal to evaluateRelationalLinksBatch", async () => {
      const mockBatch = vi.mocked(evaluateRelationalLinksBatch);
      const controller = new AbortController();

      const assumptions: CandidateRetrievalInput[] = [
        {
          assumptionId: "asm-signal",
          assumptionStatement: "Testing abort signal pass-through",
          conceptTags: ["authentication"],
        },
      ];

      await linkAssumptionsToPriorDecisions(assumptions, mockLedger, {
        abortSignal: controller.signal,
      });

      expect(mockBatch).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ abortSignal: controller.signal })
      );
    });
  });
});

// ============================================================================
// Wave 8.2: ATMS Invalidation & Cascading BFS (invalidation.ts)
// ============================================================================

describe("Contagious Load-Bearing Promotion & Override Cascade BFS (invalidation.ts)", () => {
  describe("1. Sibling Sub-Decision Independence & Zero False Dependencies", () => {
    it("should leave sibling sub-decisions under the same section heading completely intact in updatedLedger when relation is INDEPENDENT", () => {
      const decSibling1 = createTestDecisionNode({
        decisionId: "dec-auth-session",
        topicSlug: "session-management",
        status: "APPROVED_DIRECT",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        affectedSections: [{ fileId: "doc-spec", headingSlug: "auth-module" }],
      });
      const decSibling2 = createTestDecisionNode({
        decisionId: "dec-auth-token-format",
        topicSlug: "token-format",
        status: "APPROVED_DIRECT",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        affectedSections: [{ fileId: "doc-spec", headingSlug: "auth-module" }],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-auth-session": decSibling1,
        "dec-auth-token-format": decSibling2,
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: {
            assumptionId: "asm-independent",
            conceptTags: ["security"],
          },
          relations: [
            {
              targetDecisionId: "dec-auth-session",
              relationType: "INDEPENDENT",
              confidence: 0.99,
              justification: "Completely orthogonal concerns",
            },
          ],
        },
      ];

      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      // Verifies zero false dependencies: nothing promoted, nothing cascaded
      expect(result.reopenedOrPromotedNodes).toEqual([]);
      expect(result.cascadedDependentNodes).toEqual([]);

      // Both siblings remain completely intact in updatedLedger
      expect(result.updatedLedger["dec-auth-session"]).toBeDefined();
      expect(result.updatedLedger["dec-auth-token-format"]).toBeDefined();
      expect(result.updatedLedger["dec-auth-session"]).toEqual(decSibling1);
      expect(result.updatedLedger["dec-auth-token-format"]).toEqual(decSibling2);
    });
  });

  describe("2. Upward Promotion Path (DEPENDS_ON & REFINES)", () => {
    it("should promote provisional APPROVED_CONSERVATIVE decision to CORE_ARCHITECTURAL (isLoadBearing: true) and traverse parent dependencies upward", () => {
      const decRootProvisional = createTestDecisionNode({
        decisionId: "dec-root-provisional",
        topicSlug: "root-topic",
        status: "APPROVED_CONSERVATIVE",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        dependsOn: [],
        dependedBy: ["dec-child-provisional"],
        evaluatedAlternatives: [
          {
            optionKey: "OPT_SAFE",
            neutralSummary: "Safe baseline",
            rationaleAndPremises: "Conservative fallback",
          },
        ],
      });

      const decChildProvisional = createTestDecisionNode({
        decisionId: "dec-child-provisional",
        topicSlug: "child-topic",
        status: "APPROVED_CONSERVATIVE",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        dependsOn: ["dec-root-provisional"],
        dependedBy: [],
        evaluatedAlternatives: [
          {
            optionKey: "OPT_CHILD",
            neutralSummary: "Child option",
            rationaleAndPremises: "Child rationale",
          },
        ],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-root-provisional": decRootProvisional,
        "dec-child-provisional": decChildProvisional,
      };

      const assumptionInput: CandidateRetrievalInput & { dependsOn: string[] } = {
        assumptionId: "asm-new-feature",
        conceptTags: ["architecture"],
        dependsOn: [],
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: assumptionInput,
          relations: [
            {
              targetDecisionId: "dec-child-provisional",
              relationType: "DEPENDS_ON",
              confidence: 0.95,
            },
          ],
        },
      ];

      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      // Verify assumption.dependsOn received the target ID
      expect(assumptionInput.dependsOn).toEqual(["dec-child-provisional"]);

      // Both provisional nodes are promoted and evicted from updatedLedger
      expect(result.updatedLedger["dec-child-provisional"]).toBeUndefined();
      expect(result.updatedLedger["dec-root-provisional"]).toBeUndefined();

      expect(result.reopenedOrPromotedNodes).toHaveLength(2);

      const promotedChild = result.reopenedOrPromotedNodes.find(
        (n) => n.decisionId === "dec-child-provisional"
      );
      expect(promotedChild).toBeDefined();
      expect(promotedChild?.impactTier).toBe("CORE_ARCHITECTURAL");
      expect(promotedChild?.isLoadBearing).toBe(true);
      // Alternative preservation
      expect(promotedChild?.evaluatedAlternatives).toEqual(decChildProvisional.evaluatedAlternatives);

      const promotedRoot = result.reopenedOrPromotedNodes.find(
        (n) => n.decisionId === "dec-root-provisional"
      );
      expect(promotedRoot).toBeDefined();
      expect(promotedRoot?.impactTier).toBe("CORE_ARCHITECTURAL");
      expect(promotedRoot?.isLoadBearing).toBe(true);
      expect(promotedRoot?.evaluatedAlternatives).toEqual(decRootProvisional.evaluatedAlternatives);
    });

    it("should promote with REFINES relationship and prevent duplicate dependsOn entries in assumption", () => {
      const decProvisional = createTestDecisionNode({
        decisionId: "dec-prov",
        status: "APPROVED_CONSERVATIVE",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        dependsOn: [],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-prov": decProvisional,
      };

      const assumptionInput = {
        assumptionId: "asm-refine",
        conceptTags: ["performance"],
        dependsOn: ["dec-prov"], // already has dec-prov
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: assumptionInput,
          relations: [
            {
              targetDecisionId: "dec-prov",
              relationType: "REFINES",
            },
          ],
        },
      ];

      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      // No duplicate in dependsOn
      expect(assumptionInput.dependsOn).toEqual(["dec-prov"]);
      expect(result.reopenedOrPromotedNodes).toHaveLength(1);
      expect(result.reopenedOrPromotedNodes[0].impactTier).toBe("CORE_ARCHITECTURAL");
      expect(result.reopenedOrPromotedNodes[0].isLoadBearing).toBe(true);
    });

    it("should not evict APPROVED_DIRECT parents during upward promotion but traverse their dependsOn to reach higher provisional nodes", () => {
      const decGrandparentProv = createTestDecisionNode({
        decisionId: "dec-gp-prov",
        status: "APPROVED_CONSERVATIVE",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        dependsOn: [],
      });
      const decParentDirect = createTestDecisionNode({
        decisionId: "dec-parent-direct",
        status: "APPROVED_DIRECT",
        impactTier: "CORE_ARCHITECTURAL",
        isLoadBearing: true,
        dependsOn: ["dec-gp-prov"],
      });
      const decChildProv = createTestDecisionNode({
        decisionId: "dec-child-prov",
        status: "APPROVED_CONSERVATIVE",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        dependsOn: ["dec-parent-direct"],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-gp-prov": decGrandparentProv,
        "dec-parent-direct": decParentDirect,
        "dec-child-prov": decChildProv,
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: { assumptionId: "asm-up", conceptTags: ["architecture"] },
          relations: [
            {
              targetDecisionId: "dec-child-prov",
              relationType: "DEPENDS_ON",
            },
          ],
        },
      ];

      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      // Child and Grandparent are provisional -> promoted and evicted
      expect(result.updatedLedger["dec-child-prov"]).toBeUndefined();
      expect(result.updatedLedger["dec-gp-prov"]).toBeUndefined();

      // Parent is APPROVED_DIRECT -> remains in updatedLedger
      expect(result.updatedLedger["dec-parent-direct"]).toBeDefined();
      expect(result.reopenedOrPromotedNodes.map((n) => n.decisionId).sort()).toEqual([
        "dec-child-prov",
        "dec-gp-prov",
      ]);
    });
  });

  describe("3. Downward Override Cascade (REOPENS_OR_OVERRIDES)", () => {
    it("should reopen target node to CORE_ARCHITECTURAL and cascade all dependent decisions via BFS into cascadedDependentNodes", () => {
      // Root decision
      const decRoot = createTestDecisionNode({
        decisionId: "dec-root",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        dependedBy: ["dec-child-1", "dec-child-2"],
        dependsOn: [],
      });
      // Direct children
      const decChild1 = createTestDecisionNode({
        decisionId: "dec-child-1",
        dependsOn: ["dec-root"],
        dependedBy: ["dec-grandchild-1"],
      });
      const decChild2 = createTestDecisionNode({
        decisionId: "dec-child-2",
        dependsOn: ["dec-root"],
        dependedBy: [],
      });
      // Grandchild
      const decGrandchild1 = createTestDecisionNode({
        decisionId: "dec-grandchild-1",
        dependsOn: ["dec-child-1"],
        dependedBy: [],
      });
      // Completely unrelated survivor
      const decUnrelated = createTestDecisionNode({
        decisionId: "dec-unrelated",
        dependsOn: [],
        dependedBy: [],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-root": decRoot,
        "dec-child-1": decChild1,
        "dec-child-2": decChild2,
        "dec-grandchild-1": decGrandchild1,
        "dec-unrelated": decUnrelated,
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: { assumptionId: "asm-override", conceptTags: ["architecture"] },
          relations: [
            {
              targetDecisionId: "dec-root",
              relationType: "REOPENS_OR_OVERRIDES",
              confidence: 0.98,
              justification: "Invalidating fundamental architectural premise",
            },
          ],
        },
      ];

      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      // Reopened root node promoted to CORE_ARCHITECTURAL (isLoadBearing: true)
      expect(result.reopenedOrPromotedNodes).toHaveLength(1);
      const reopenedRoot = result.reopenedOrPromotedNodes[0];
      expect(reopenedRoot.decisionId).toBe("dec-root");
      expect(reopenedRoot.impactTier).toBe("CORE_ARCHITECTURAL");
      expect(reopenedRoot.isLoadBearing).toBe(true);

      // Downward cascaded dependents via BFS: dec-child-1, dec-child-2, dec-grandchild-1
      expect(result.cascadedDependentNodes).toHaveLength(3);
      const cascadedIds = result.cascadedDependentNodes.map((n) => n.decisionId).sort();
      expect(cascadedIds).toEqual(["dec-child-1", "dec-child-2", "dec-grandchild-1"]);

      // updatedLedger contains ONLY the surviving unrelated node
      expect(Object.keys(result.updatedLedger)).toEqual(["dec-unrelated"]);
    });

    it("should prioritize promotion over cascadedDependentMap if a node is both promoted and depended upon", () => {
      // Node A is explicitly reopened, and also listed in Node B's dependedBy
      const decA = createTestDecisionNode({
        decisionId: "dec-a",
        dependsOn: ["dec-b"],
        dependedBy: [],
      });
      const decB = createTestDecisionNode({
        decisionId: "dec-b",
        dependsOn: [],
        dependedBy: ["dec-a"],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-a": decA,
        "dec-b": decB,
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: { assumptionId: "asm-dual", conceptTags: ["architecture"] },
          relations: [
            {
              targetDecisionId: "dec-a",
              relationType: "REOPENS_OR_OVERRIDES",
            },
            {
              targetDecisionId: "dec-b",
              relationType: "REOPENS_OR_OVERRIDES",
            },
          ],
        },
      ];

      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      // Both are in reopenedOrPromotedNodes, neither is in cascadedDependentNodes
      const reopenedIds = result.reopenedOrPromotedNodes.map((n) => n.decisionId).sort();
      expect(reopenedIds).toEqual(["dec-a", "dec-b"]);
      expect(result.cascadedDependentNodes).toEqual([]);
    });
  });

  describe("4. Cycle Protection & Deterministic BFS Termination", () => {
    it("should terminate safely without infinite recursion or loop when dependsOn has cyclic edges", () => {
      // Cyclic dependsOn: C1 -> C2 -> C1 (both provisional)
      const decC1 = createTestDecisionNode({
        decisionId: "dec-c1",
        status: "APPROVED_CONSERVATIVE",
        dependsOn: ["dec-c2"],
        dependedBy: [],
      });
      const decC2 = createTestDecisionNode({
        decisionId: "dec-c2",
        status: "APPROVED_CONSERVATIVE",
        dependsOn: ["dec-c1"],
        dependedBy: [],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-c1": decC1,
        "dec-c2": decC2,
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: { assumptionId: "asm-cycle-up", conceptTags: ["security"] },
          relations: [{ targetDecisionId: "dec-c1", relationType: "DEPENDS_ON" }],
        },
      ];

      // Must terminate immediately without hanging
      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      expect(result.reopenedOrPromotedNodes).toHaveLength(2);
      const promotedIds = result.reopenedOrPromotedNodes.map((n) => n.decisionId).sort();
      expect(promotedIds).toEqual(["dec-c1", "dec-c2"]);
      expect(result.updatedLedger).toEqual({});
    });

    it("should terminate safely without infinite recursion or loop when dependedBy has cyclic edges", () => {
      // Cyclic dependedBy: D1 -> D2 -> D1
      const decD1 = createTestDecisionNode({
        decisionId: "dec-d1",
        dependsOn: [],
        dependedBy: ["dec-d2"],
      });
      const decD2 = createTestDecisionNode({
        decisionId: "dec-d2",
        dependsOn: [],
        dependedBy: ["dec-d1"],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-d1": decD1,
        "dec-d2": decD2,
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: { assumptionId: "asm-cycle-down", conceptTags: ["database"] },
          relations: [{ targetDecisionId: "dec-d1", relationType: "REOPENS_OR_OVERRIDES" }],
        },
      ];

      // Must terminate immediately without hanging
      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      expect(result.reopenedOrPromotedNodes).toHaveLength(1);
      expect(result.reopenedOrPromotedNodes[0].decisionId).toBe("dec-d1");
      expect(result.cascadedDependentNodes).toHaveLength(1);
      expect(result.cascadedDependentNodes[0].decisionId).toBe("dec-d2");
      expect(result.updatedLedger).toEqual({});
    });

    it("should safely handle self-referencing decision loops (dependsOn self, dependedBy self)", () => {
      const decSelf = createTestDecisionNode({
        decisionId: "dec-self",
        status: "APPROVED_CONSERVATIVE",
        dependsOn: ["dec-self"],
        dependedBy: ["dec-self"],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-self": decSelf,
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: { assumptionId: "asm-self", conceptTags: ["architecture"] },
          relations: [{ targetDecisionId: "dec-self", relationType: "DEPENDS_ON" }],
        },
      ];

      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      expect(result.reopenedOrPromotedNodes).toHaveLength(1);
      expect(result.reopenedOrPromotedNodes[0].decisionId).toBe("dec-self");
      expect(result.cascadedDependentNodes).toEqual([]);
    });
  });

  describe("5. Graph Hygiene & Immutability Verification", () => {
    it("should cleanly prune evicted node IDs from dependsOn and dependedBy of surviving nodes in updatedLedger", () => {
      const decEvictedPromoted = createTestDecisionNode({
        decisionId: "dec-evicted-promoted",
        status: "APPROVED_CONSERVATIVE",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
        dependsOn: [],
        dependedBy: ["dec-survivor"],
      });
      const decEvictedOverride = createTestDecisionNode({
        decisionId: "dec-evicted-override",
        dependedBy: ["dec-evicted-child"],
      });
      const decEvictedChild = createTestDecisionNode({
        decisionId: "dec-evicted-child",
        dependsOn: ["dec-evicted-override"],
        dependedBy: [],
      });
      const decOtherSurvivor = createTestDecisionNode({
        decisionId: "dec-other-survivor",
        dependsOn: [],
        dependedBy: ["dec-survivor"],
      });
      const decOtherSurvivor2 = createTestDecisionNode({
        decisionId: "dec-other-survivor-2",
        dependsOn: ["dec-survivor"],
        dependedBy: [],
      });
      const decSurvivor = createTestDecisionNode({
        decisionId: "dec-survivor",
        dependsOn: ["dec-evicted-promoted", "dec-other-survivor"],
        dependedBy: ["dec-evicted-child", "dec-other-survivor-2"],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-evicted-promoted": decEvictedPromoted,
        "dec-evicted-override": decEvictedOverride,
        "dec-evicted-child": decEvictedChild,
        "dec-other-survivor": decOtherSurvivor,
        "dec-other-survivor-2": decOtherSurvivor2,
        "dec-survivor": decSurvivor,
      };

      const linkedAssumptions: LinkedAssumptionInput[] = [
        {
          assumption: { assumptionId: "asm-hygiene-promote", conceptTags: ["security"] },
          relations: [
            {
              targetDecisionId: "dec-evicted-promoted",
              relationType: "DEPENDS_ON",
            },
          ],
        },
        {
          assumption: { assumptionId: "asm-hygiene-override", conceptTags: ["database"] },
          relations: [
            {
              targetDecisionId: "dec-evicted-override",
              relationType: "REOPENS_OR_OVERRIDES",
            },
          ],
        },
      ];

      const result = resolveATMSCascadeBFS(linkedAssumptions, masterLedger);

      // Verify evicted: dec-evicted-promoted & dec-evicted-override (reopened/promoted)
      // and dec-evicted-child (downward cascade)
      const promotedIds = result.reopenedOrPromotedNodes.map((n) => n.decisionId).sort();
      expect(promotedIds).toEqual(["dec-evicted-override", "dec-evicted-promoted"]);

      const cascadedIds = result.cascadedDependentNodes.map((n) => n.decisionId);
      expect(cascadedIds).toEqual(["dec-evicted-child"]);

      // Verify surviving nodes: dec-survivor, dec-other-survivor, dec-other-survivor-2
      const surviving = result.updatedLedger["dec-survivor"];
      expect(surviving).toBeDefined();

      // Clean graph hygiene: evicted node IDs are stripped!
      expect(surviving.dependsOn).toEqual(["dec-other-survivor"]);
      expect(surviving.dependedBy).toEqual(["dec-other-survivor-2"]);
    });

    it("should strictly preserve input masterLedger immutability without side effects", () => {
      const decTarget = createTestDecisionNode({
        decisionId: "dec-immutable-target",
        status: "APPROVED_CONSERVATIVE",
        impactTier: "PERIPHERAL",
        isLoadBearing: false,
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-immutable-target": decTarget,
      };

      const originalCopy = cloneMasterLedger(masterLedger);

      resolveATMSCascadeBFS(
        [
          {
            assumption: { assumptionId: "asm-imm", conceptTags: ["security"] },
            relations: [{ targetDecisionId: "dec-immutable-target", relationType: "DEPENDS_ON" }],
          },
        ],
        masterLedger
      );

      // Input masterLedger must remain completely untouched
      expect(masterLedger).toEqual(originalCopy);
      expect(masterLedger["dec-immutable-target"].impactTier).toBe("PERIPHERAL");
      expect(masterLedger["dec-immutable-target"].isLoadBearing).toBe(false);
    });
  });
});

// ============================================================================
// Wave 8.2: Differential Section Invalidation Map (invalidation.ts)
// ============================================================================

describe("Differential Section Invalidation Map (invalidation.ts)", () => {
  describe("computeMinimalSectionInvalidationMap", () => {
    it("should accumulate deduplicated (fileId, headingSlug) section targets for modified roots and transitive dependents", () => {
      const decRoot = createTestDecisionNode({
        decisionId: "dec-root",
        dependedBy: ["dec-child-1", "dec-child-2"],
        affectedSections: [
          { fileId: "doc-arch", headingSlug: "architecture-core" },
          { fileId: "doc-arch", headingSlug: "architecture-core" }, // duplicate in same node
        ],
      });

      const decChild1 = createTestDecisionNode({
        decisionId: "dec-child-1",
        dependedBy: ["dec-grandchild"],
        affectedSections: [
          { fileId: "doc-api", headingSlug: "api-endpoints" },
          { fileId: "doc-arch", headingSlug: "architecture-core" },
        ],
      });

      const decChild2 = createTestDecisionNode({
        decisionId: "dec-child-2",
        dependedBy: [],
        affectedSections: [
          { fileId: "doc-db", headingSlug: "schema-tables" },
        ],
      });

      const decGrandchild = createTestDecisionNode({
        decisionId: "dec-grandchild",
        dependedBy: [],
        affectedSections: [
          { fileId: "doc-ui", headingSlug: "client-views" },
        ],
      });

      const masterLedger: Record<string, ATMSDecisionNode> = {
        "dec-root": decRoot,
        "dec-child-1": decChild1,
        "dec-child-2": decChild2,
        "dec-grandchild": decGrandchild,
      };

      const result = computeMinimalSectionInvalidationMap(["dec-root"], masterLedger);

      // Root affectedSections: deduplicated to 1 item
      expect(result["dec-root"]).toEqual([
        { fileId: "doc-arch", headingSlug: "architecture-core" },
      ]);

      // Child 1 affectedSections: 2 items
      expect(result["dec-child-1"]).toEqual([
        { fileId: "doc-api", headingSlug: "api-endpoints" },
        { fileId: "doc-arch", headingSlug: "architecture-core" },
      ]);

      // Child 2 affectedSections: 1 item
      expect(result["dec-child-2"]).toEqual([
        { fileId: "doc-db", headingSlug: "schema-tables" },
      ]);

      // Grandchild affectedSections: 1 item
      expect(result["dec-grandchild"]).toEqual([
        { fileId: "doc-ui", headingSlug: "client-views" },
      ]);
    });

    it("should filter out section targets with empty or whitespace fileId or headingSlug", () => {
      const decWithSparseSections = createTestDecisionNode({
        decisionId: "dec-sparse-sections",
        affectedSections: [
          { fileId: "   ", headingSlug: "heading-1" },
          { fileId: "doc-valid", headingSlug: "   " },
          { fileId: "  doc-trimmed  ", headingSlug: "  slug-trimmed  " },
        ],
      });

      const masterLedger = {
        "dec-sparse-sections": decWithSparseSections,
      };

      const result = computeMinimalSectionInvalidationMap(
        ["dec-sparse-sections"],
        masterLedger
      );

      expect(result["dec-sparse-sections"]).toEqual([
        { fileId: "doc-trimmed", headingSlug: "slug-trimmed" },
      ]);
    });

    it("should skip nodes with empty affectedSections while still traversing their dependedBy children", () => {
      const decRootEmpty = createTestDecisionNode({
        decisionId: "dec-empty-root",
        dependedBy: ["dec-child"],
        affectedSections: [],
      });
      const decChild = createTestDecisionNode({
        decisionId: "dec-child",
        dependedBy: [],
        affectedSections: [{ fileId: "doc-child", headingSlug: "child-heading" }],
      });

      const masterLedger = {
        "dec-empty-root": decRootEmpty,
        "dec-child": decChild,
      };

      const result = computeMinimalSectionInvalidationMap(
        ["dec-empty-root"],
        masterLedger
      );

      expect(result["dec-empty-root"]).toBeUndefined();
      expect(result["dec-child"]).toEqual([
        { fileId: "doc-child", headingSlug: "child-heading" },
      ]);
    });

    it("should return empty object for empty rootDecisionIds, empty ledger, or non-existent roots", () => {
      const masterLedger = {
        "dec-1": createTestDecisionNode({ decisionId: "dec-1" }),
      };

      expect(computeMinimalSectionInvalidationMap([], masterLedger)).toEqual({});
      expect(
        computeMinimalSectionInvalidationMap(
          null as unknown as string[],
          masterLedger
        )
      ).toEqual({});
      expect(
        computeMinimalSectionInvalidationMap(["dec-1"], {})
      ).toEqual({});
      expect(
        computeMinimalSectionInvalidationMap(
          ["dec-1"],
          null as unknown as Record<string, ATMSDecisionNode>
        )
      ).toEqual({});
      expect(
        computeMinimalSectionInvalidationMap(["dec-non-existent"], masterLedger)
      ).toEqual({});
    });

    it("should safely terminate without infinite loop when dependedBy contains cyclic graphs", () => {
      const decCycleA = createTestDecisionNode({
        decisionId: "dec-cycle-a",
        dependedBy: ["dec-cycle-b"],
        affectedSections: [{ fileId: "doc-a", headingSlug: "sec-a" }],
      });
      const decCycleB = createTestDecisionNode({
        decisionId: "dec-cycle-b",
        dependedBy: ["dec-cycle-a"],
        affectedSections: [{ fileId: "doc-b", headingSlug: "sec-b" }],
      });

      const masterLedger = {
        "dec-cycle-a": decCycleA,
        "dec-cycle-b": decCycleB,
      };

      const result = computeMinimalSectionInvalidationMap(
        ["dec-cycle-a"],
        masterLedger
      );

      expect(result["dec-cycle-a"]).toEqual([{ fileId: "doc-a", headingSlug: "sec-a" }]);
      expect(result["dec-cycle-b"]).toEqual([{ fileId: "doc-b", headingSlug: "sec-b" }]);
    });
  });
});

