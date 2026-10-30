/**
 * Test Suite: Universal Concept Taxonomy & Dynamic Decision Zod Schemas
 *
 * Verifies:
 * 1. Universal Concept Taxonomy Across 9 Engineering Domains (DEFAULT_CONCEPT_TAGS)
 * 2. Tag Normalization, Strict Format Regex & Validation Helpers
 * 3. Project-Scoped Tag Registry Resolution: (base \ removed) ∪ added
 * 4. Tag Mutation Model Algebra: Add/Remove symmetry, roundtrip preservation & idempotency
 * 5. System-Reserved Decision Sentinel (__PROJECT_TAXONOMY__) Ledger Serialization Roundtrip
 * 6. Dynamic Zod Schemas & Closed-World Enum Guards against hallucinated tags
 * 7. Decision, Batch, Assumption, and Clarification schema edge cases and structural validation
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  DEFAULT_CONCEPT_TAGS,
  PREDEFINED_CONCEPT_TAGS,
  CONCEPT_TAG_DOMAINS,
  CONCEPT_TAG_FORMAT_REGEX,
  normalizeConceptTag,
  isValidConceptTagFormat,
  resolveProjectConceptTags,
  applyProjectTagMutations,
  isActiveConceptTag,
  EmptyProjectTaxonomyError,
  PROJECT_TAXONOMY_SENTINEL_ID,
  isSystemReservedDecisionId,
  toTaxonomyLedgerPayload,
  fromTaxonomyLedgerPayload,
  type ProjectTaxonomyState,
} from "@/core/agent/taxonomy/predefined-tags";

import {
  createConceptTagEnum,
  createDecisionEvaluationItemSchema,
  createCanonicalDecisionBatchSchema,
  createAssumptionItemSchema,
  createAssumptionExtractionBatchSchema,
  ConceptTagEnum,
  DecisionEvaluationItemSchema,
  CanonicalDecisionBatchSchema,
  AssumptionItemSchema,
  AssumptionExtractionBatchSchema,
  SectionTargetSchema,
  CanonicalOptionSchema,
  RelationalLinkTypeEnum,
  RelationalAdjudicationBatchSchema,
  QuestionQueueSchema,
  ClarificationResponseSchema,
  SearchReportSchema,
} from "@/core/agent/schemas/decision-schemas";

describe("Universal Concept Taxonomy & Dynamic Zod Schemas", () => {
  // =========================================================================
  // 1. Universal Concept Taxonomy & Domain Categorization
  // =========================================================================
  describe("1. Universal Concept Taxonomy Across 9 Domains", () => {
    it("should export exactly 65 immutable concept tags across 9 engineering domains", () => {
      expect(DEFAULT_CONCEPT_TAGS).toBeDefined();
      expect(DEFAULT_CONCEPT_TAGS.length).toBe(65);
      expect(PREDEFINED_CONCEPT_TAGS).toBe(DEFAULT_CONCEPT_TAGS);
    });

    it("should ensure all default concept tags conform to the strict format regex", () => {
      for (const tag of DEFAULT_CONCEPT_TAGS) {
        expect(isValidConceptTagFormat(tag)).toBe(true);
        expect(CONCEPT_TAG_FORMAT_REGEX.test(tag)).toBe(true);
      }
    });

    it("should contain zero duplicate tags across the default taxonomy", () => {
      const uniqueTags = new Set(DEFAULT_CONCEPT_TAGS);
      expect(uniqueTags.size).toBe(DEFAULT_CONCEPT_TAGS.length);
    });

    it("should partition all tags across exactly 9 engineering domains without orphans or foreign tags", () => {
      const domains = Object.keys(CONCEPT_TAG_DOMAINS);
      expect(domains.length).toBe(9);

      const allDomainTags: string[] = [];
      for (const domain of domains) {
        const domainTags = CONCEPT_TAG_DOMAINS[domain as keyof typeof CONCEPT_TAG_DOMAINS];
        expect(domainTags.length).toBeGreaterThanOrEqual(6);
        allDomainTags.push(...domainTags);
      }

      expect(allDomainTags.length).toBe(DEFAULT_CONCEPT_TAGS.length);
      for (const tag of allDomainTags) {
        expect(DEFAULT_CONCEPT_TAGS).toContain(tag);
      }
    });
  });

  // =========================================================================
  // 2. Tag Normalization & Format Validation
  // =========================================================================
  describe("2. Tag Normalization & Format Validation", () => {
    it("should normalize candidate tags with uppercase, whitespace, dashes, and extra underscores", () => {
      expect(normalizeConceptTag("SYSTEM_ARCHITECTURE")).toBe("system_architecture");
      expect(normalizeConceptTag("  Module Boundaries  ")).toBe("module_boundaries");
      expect(normalizeConceptTag("rate-limiting-backpressure")).toBe("rate_limiting_backpressure");
      expect(normalizeConceptTag("__concurrency___model__")).toBe("concurrency_model");
      expect(normalizeConceptTag("data--modeling")).toBe("data_modeling");
    });

    it("should validate valid tag formats adhering to 2-64 lowercase alphanumeric and underscore chars", () => {
      expect(isValidConceptTagFormat("system_architecture")).toBe(true);
      expect(isValidConceptTagFormat("tag_123")).toBe(true);
      expect(isValidConceptTagFormat("ab")).toBe(true);
      expect(isValidConceptTagFormat("a" + "_b".repeat(31))).toBe(true); // 63 chars
    });

    it("should reject invalid tag formats", () => {
      // Single character is rejected (must be at least 2 chars)
      expect(isValidConceptTagFormat("a")).toBe(false);
      // Leading numbers or underscores
      expect(isValidConceptTagFormat("1tag")).toBe(false);
      expect(isValidConceptTagFormat("_tag")).toBe(false);
      // Uppercase letters
      expect(isValidConceptTagFormat("Tag_name")).toBe(false);
      expect(isValidConceptTagFormat("TAG")).toBe(false);
      // Special characters or dashes
      expect(isValidConceptTagFormat("tag-name")).toBe(false);
      expect(isValidConceptTagFormat("tag.name")).toBe(false);
      expect(isValidConceptTagFormat("tag!name")).toBe(false);
      // Non-strings
      expect(isValidConceptTagFormat("")).toBe(false);
      expect(isValidConceptTagFormat(null)).toBe(false);
      expect(isValidConceptTagFormat(undefined)).toBe(false);
      expect(isValidConceptTagFormat(12345)).toBe(false);
      expect(isValidConceptTagFormat({})).toBe(false);
    });
  });

  // =========================================================================
  // 3. Project-Scoped Tag Registry Resolution
  // =========================================================================
  describe("3. Project-Scoped Concept Tag Resolution", () => {
    it("should resolve to default concept tags when state is null, undefined, or empty", () => {
      const fromNull = resolveProjectConceptTags(null);
      expect(fromNull).toEqual(DEFAULT_CONCEPT_TAGS);

      const fromUndefined = resolveProjectConceptTags(undefined);
      expect(fromUndefined).toEqual(DEFAULT_CONCEPT_TAGS);

      const fromEmpty = resolveProjectConceptTags({
        projectId: "proj_1",
        addedTags: [],
        removedTags: [],
      });
      expect(fromEmpty).toEqual(DEFAULT_CONCEPT_TAGS);
    });

    it("should correctly compute (baseTags \\ removedTags) ∪ addedTags", () => {
      const state: ProjectTaxonomyState = {
        projectId: "proj_custom",
        addedTags: ["wasm_sandboxing", "vector_embeddings"],
        removedTags: ["licensing_compliance", "theming_design_system"],
      };

      const resolved = resolveProjectConceptTags(state);
      expect(resolved).not.toContain("licensing_compliance");
      expect(resolved).not.toContain("theming_design_system");
      expect(resolved).toContain("wasm_sandboxing");
      expect(resolved).toContain("vector_embeddings");
      expect(resolved).toContain("system_architecture");
      expect(resolved.length).toBe(DEFAULT_CONCEPT_TAGS.length - 2 + 2);
    });

    it("should deduplicate tags if addedTags duplicates an active base tag", () => {
      const state: ProjectTaxonomyState = {
        projectId: "proj_dup",
        addedTags: ["system_architecture", "custom_tag"],
        removedTags: [],
      };

      const resolved = resolveProjectConceptTags(state);
      const systemArchOccurrences = resolved.filter((t) => t === "system_architecture");
      expect(systemArchOccurrences.length).toBe(1);
      expect(resolved).toContain("custom_tag");
    });

    it("should throw EmptyProjectTaxonomyError when all base tags are removed and no added tags exist", () => {
      const state: ProjectTaxonomyState = {
        projectId: "proj_wipeout",
        addedTags: [],
        removedTags: [...DEFAULT_CONCEPT_TAGS],
      };

      expect(() => resolveProjectConceptTags(state)).toThrow(EmptyProjectTaxonomyError);
    });

    it("should throw EmptyProjectTaxonomyError when custom baseTags is empty and addedTags is empty", () => {
      expect(() => resolveProjectConceptTags(null, [])).toThrow(EmptyProjectTaxonomyError);
    });
  });

  // =========================================================================
  // 4. Tag Mutation Model Algebra & Symmetry
  // =========================================================================
  describe("4. Tag Mutation Model Algebra & Roundtrip Symmetry", () => {
    const initialState: ProjectTaxonomyState = {
      projectId: "proj_algebra",
      addedTags: [],
      removedTags: [],
    };

    it("should add custom tags not in baseTags to addedTags", () => {
      const mutated = applyProjectTagMutations(initialState, {
        addTags: ["graph_neural_networks"],
      });
      expect(mutated.addedTags).toEqual(["graph_neural_networks"]);
      expect(mutated.removedTags).toEqual([]);
      expect(mutated.updatedAt).toBeDefined();
    });

    it("should not add base tags to addedTags when adding an already active base tag", () => {
      const mutated = applyProjectTagMutations(initialState, {
        addTags: ["system_architecture"],
      });
      expect(mutated.addedTags).toEqual([]);
      expect(mutated.removedTags).toEqual([]);
    });

    it("should reinstate a previously removed base tag by removing it from removedTags", () => {
      // Step 1: Remove a base tag
      const stateWithRemoval = applyProjectTagMutations(initialState, {
        removeTags: ["concurrency_model"],
      });
      expect(stateWithRemoval.removedTags).toEqual(["concurrency_model"]);
      expect(stateWithRemoval.addedTags).toEqual([]);

      // Step 2: Add the base tag back
      const reinstated = applyProjectTagMutations(stateWithRemoval, {
        addTags: ["concurrency_model"],
      });
      expect(reinstated.removedTags).toEqual([]);
      expect(reinstated.addedTags).toEqual([]);
    });

    it("should remove a custom tag previously added to addedTags", () => {
      // Step 1: Add custom tag
      const stateWithCustom = applyProjectTagMutations(initialState, {
        addTags: ["quantized_inference"],
      });
      expect(stateWithCustom.addedTags).toEqual(["quantized_inference"]);

      // Step 2: Remove the custom tag
      const reverted = applyProjectTagMutations(stateWithCustom, {
        removeTags: ["quantized_inference"],
      });
      expect(reverted.addedTags).toEqual([]);
      expect(reverted.removedTags).toEqual([]);
    });

    it("should preserve idempotency across duplicate mutation operations", () => {
      const step1 = applyProjectTagMutations(initialState, {
        addTags: ["edge_computing"],
      });
      const step2 = applyProjectTagMutations(step1, {
        addTags: ["edge_computing"],
      });
      expect(step2.addedTags).toEqual(["edge_computing"]);
      expect(step2.removedTags).toEqual([]);
    });

    it("should reject mutations containing invalid tag formats", () => {
      expect(() =>
        applyProjectTagMutations(initialState, {
          addTags: ["INVALID-TAG-WITH-CAPS"],
        })
      ).toThrow(/Invalid concept tag format/);

      expect(() =>
        applyProjectTagMutations(initialState, {
          removeTags: ["123_invalid_prefix"],
        })
      ).toThrow(/Invalid concept tag format/);
    });

    it("should throw EmptyProjectTaxonomyError if mutation leaves zero active tags", () => {
      expect(() =>
        applyProjectTagMutations(initialState, {
          removeTags: DEFAULT_CONCEPT_TAGS,
        })
      ).toThrow(EmptyProjectTaxonomyError);
    });
  });

  // =========================================================================
  // 5. Active Concept Tag Guard (isActiveConceptTag)
  // =========================================================================
  describe("5. Active Concept Tag Guard (isActiveConceptTag)", () => {
    it("should correctly identify active vs inactive tags using default taxonomy", () => {
      expect(isActiveConceptTag("system_architecture")).toBe(true);
      expect(isActiveConceptTag("data_pipeline")).toBe(true);
      expect(isActiveConceptTag("hallucinated_tag")).toBe(false);
      expect(isActiveConceptTag("")).toBe(false);
      expect(isActiveConceptTag(null)).toBe(false);
      expect(isActiveConceptTag(123)).toBe(false);
    });

    it("should check against explicit active tag list when provided", () => {
      const activeTags = ["custom_one", "custom_two"];
      expect(isActiveConceptTag("custom_one", activeTags)).toBe(true);
      expect(isActiveConceptTag("custom_two", activeTags)).toBe(true);
      expect(isActiveConceptTag("system_architecture", activeTags)).toBe(false);
    });
  });

  // =========================================================================
  // 6. System-Reserved Decision Sentinel & Ledger Serialization
  // =========================================================================
  describe("6. System-Reserved Decision Sentinel & Ledger Serialization", () => {
    it("should correctly identify system-reserved decision IDs", () => {
      expect(isSystemReservedDecisionId(PROJECT_TAXONOMY_SENTINEL_ID)).toBe(true);
      expect(isSystemReservedDecisionId("__ANY_RESERVED__")).toBe(true);
      expect(isSystemReservedDecisionId("dec_12345")).toBe(false);
      expect(isSystemReservedDecisionId("uuid-v4-standard-id")).toBe(false);
      expect(isSystemReservedDecisionId("_not_reserved")).toBe(false);
    });

    it("should convert ProjectTaxonomyState to a compliant project_decision_ledger row payload", () => {
      const state: ProjectTaxonomyState = {
        projectId: "proj_ledger_test",
        addedTags: ["neural_cache"],
        removedTags: ["licensing_compliance"],
      };

      const payload = toTaxonomyLedgerPayload(state);
      expect(payload.decisionId).toBe(PROJECT_TAXONOMY_SENTINEL_ID);
      expect(payload.topicSlug).toBe("project_taxonomy_configuration");
      expect(payload.status).toBe("APPROVED_DIRECT");
      expect(payload.impactTier).toBe("CORE_ARCHITECTURAL");
      expect(payload.isLoadBearing).toBe(true);
      expect(payload.conceptTags).toContain("neural_cache");
      expect(payload.conceptTags).not.toContain("licensing_compliance");

      const addedAlt = payload.evaluatedAlternatives.find((a) => a.optionKey === "added_tags");
      const removedAlt = payload.evaluatedAlternatives.find((a) => a.optionKey === "removed_tags");

      expect(addedAlt).toBeDefined();
      expect(JSON.parse(addedAlt!.rationaleAndPremises)).toEqual(["neural_cache"]);
      expect(removedAlt).toBeDefined();
      expect(JSON.parse(removedAlt!.rationaleAndPremises)).toEqual(["licensing_compliance"]);
    });

    it("should reconstitute ProjectTaxonomyState from a persisted ledger row with full roundtrip fidelity", () => {
      const originalState: ProjectTaxonomyState = {
        projectId: "proj_roundtrip",
        addedTags: ["quantum_kernel", "edge_sync"],
        removedTags: ["licensing_compliance", "theming_design_system"],
      };

      const ledgerPayload = toTaxonomyLedgerPayload(originalState);

      const reconstituted = fromTaxonomyLedgerPayload("proj_roundtrip", {
        conceptTags: ledgerPayload.conceptTags,
        evaluatedAlternatives: ledgerPayload.evaluatedAlternatives,
        updatedAt: new Date("2026-10-30T21:00:00Z"),
      });

      expect(reconstituted.projectId).toBe("proj_roundtrip");
      expect(reconstituted.addedTags).toEqual(["quantum_kernel", "edge_sync"]);
      expect(reconstituted.removedTags).toEqual(["licensing_compliance", "theming_design_system"]);
      expect(reconstituted.updatedAt).toBe("2026-10-30T21:00:00.000Z");
    });

    it("should safely handle malformed or missing evaluatedAlternatives during reconstitution", () => {
      const fallbackState = fromTaxonomyLedgerPayload("proj_malformed", {
        conceptTags: ["system_architecture"],
        evaluatedAlternatives: [
          { optionKey: "added_tags", rationaleAndPremises: "INVALID_JSON{[" },
          { optionKey: "other_key", rationaleAndPremises: "[]" },
          null,
        ],
        updatedAt: "2026-10-30T21:15:00Z",
      });

      expect(fallbackState.projectId).toBe("proj_malformed");
      expect(fallbackState.addedTags).toEqual([]);
      expect(fallbackState.removedTags).toEqual([]);
      expect(fallbackState.updatedAt).toBe("2026-10-30T21:15:00Z");
    });
  });

  // =========================================================================
  // 7. Dynamic Zod Schemas & Closed-World Enum Guards
  // =========================================================================
  describe("7. Dynamic Zod Schemas & Closed-World Enum Guards", () => {
    describe("createConceptTagEnum", () => {
      it("should construct a dynamic Zod enum constrained strictly to the provided active tags", () => {
        const allowedTags = ["system_architecture", "data_modeling", "custom_tag"];
        const DynamicEnum = createConceptTagEnum(allowedTags);

        expect(DynamicEnum.parse("system_architecture")).toBe("system_architecture");
        expect(DynamicEnum.parse("custom_tag")).toBe("custom_tag");

        // CLOSED-WORLD GUARD: Hallucinated tag must be rejected!
        expect(() => DynamicEnum.parse("hallucinated_ai_tag")).toThrow(z.ZodError);
        expect(() => DynamicEnum.parse("event_driven")).toThrow(z.ZodError);
      });

      it("should deduplicate input tags when constructing enum", () => {
        const duplicateTags = ["system_architecture", "system_architecture", "data_modeling"];
        const DynamicEnum = createConceptTagEnum(duplicateTags);
        expect(DynamicEnum.options).toEqual(["system_architecture", "data_modeling"]);
      });

      it("should throw EmptyProjectTaxonomyError when activeTags is empty array", () => {
        expect(() => createConceptTagEnum([])).toThrow(EmptyProjectTaxonomyError);
      });

      it("should default to all 65 DEFAULT_CONCEPT_TAGS when no argument is supplied", () => {
        const DefaultEnum = createConceptTagEnum();
        expect(DefaultEnum.options.length).toBe(65);
        expect(DefaultEnum.parse("system_architecture")).toBe("system_architecture");
        expect(() => DefaultEnum.parse("unknown_tag")).toThrow(z.ZodError);
      });
    });

    describe("createDecisionEvaluationItemSchema", () => {
      const projectTags = ["system_architecture", "module_boundaries", "state_management"];
      const DynamicSchema = createDecisionEvaluationItemSchema(projectTags);

      const validItem = {
        decisionId: "dec_sys_001",
        topicSlug: "state_management_architecture",
        questionPrompt: "Which state container should be selected for global store?",
        conceptTags: ["system_architecture", "state_management"],
        options: [
          {
            optionKey: "zustand",
            neutralSummary: "Zustand minimalistic state store",
            rationaleAndPremises: "Lightweight and hooks-friendly",
          },
          {
            optionKey: "redux_toolkit",
            neutralSummary: "Redux Toolkit structured slice model",
            rationaleAndPremises: "Strict unidirectional flow and middleware",
          },
          {
            optionKey: "jotai",
            neutralSummary: "Jotai atomic state model",
            rationaleAndPremises: "Fine-grained atom updates",
          },
        ],
        dependsOnDecisionIds: [],
        affectedSections: [
          {
            fileId: "file_arch_doc",
            headingSlug: "state-management",
          },
        ],
      };

      it("should parse a valid decision evaluation item", () => {
        const parsed = DynamicSchema.parse(validItem);
        expect(parsed.decisionId).toBe("dec_sys_001");
        expect(parsed.conceptTags).toEqual(["system_architecture", "state_management"]);
        expect(parsed.options.length).toBe(3);
      });

      it("should strictly reject decision item with hallucinated concept tag", () => {
        const itemWithHallucination = {
          ...validItem,
          conceptTags: ["system_architecture", "hallucinated_tag"],
        };

        expect(() => DynamicSchema.parse(itemWithHallucination)).toThrow(z.ZodError);
      });

      it("should strictly reject decision item with empty conceptTags (min 1)", () => {
        const itemWithoutTags = {
          ...validItem,
          conceptTags: [],
        };
        expect(() => DynamicSchema.parse(itemWithoutTags)).toThrow(z.ZodError);
      });

      it("should strictly reject decision item exceeding 6 conceptTags (max 6)", () => {
        const itemTooManyTags = {
          ...validItem,
          conceptTags: [
            "system_architecture",
            "module_boundaries",
            "state_management",
            "system_architecture",
            "module_boundaries",
            "state_management",
            "system_architecture", // 7 tags
          ],
        };
        expect(() => DynamicSchema.parse(itemTooManyTags)).toThrow(z.ZodError);
      });

      it("should strictly enforce options count between 3 and 4", () => {
        // Less than 3 options
        const itemTooFewOptions = {
          ...validItem,
          options: validItem.options.slice(0, 2),
        };
        expect(() => DynamicSchema.parse(itemTooFewOptions)).toThrow(z.ZodError);

        // More than 4 options
        const itemTooManyOptions = {
          ...validItem,
          options: [
            ...validItem.options,
            {
              optionKey: "opt_4",
              neutralSummary: "Option 4",
              rationaleAndPremises: "Rationale 4",
            },
            {
              optionKey: "opt_5",
              neutralSummary: "Option 5",
              rationaleAndPremises: "Rationale 5",
            },
          ],
        };
        expect(() => DynamicSchema.parse(itemTooManyOptions)).toThrow(z.ZodError);
      });

      it("should reject topicSlug with invalid characters", () => {
        const invalidSlug = {
          ...validItem,
          topicSlug: "Invalid-Topic-Slug!",
        };
        expect(() => DynamicSchema.parse(invalidSlug)).toThrow(z.ZodError);
      });
    });

    describe("createCanonicalDecisionBatchSchema", () => {
      const allowedTags = ["system_architecture", "module_boundaries"];
      const BatchSchema = createCanonicalDecisionBatchSchema(allowedTags);

      const singleItem = {
        decisionId: "dec_1",
        topicSlug: "module_decomposition",
        questionPrompt: "How to decouple module dependencies?",
        conceptTags: ["system_architecture"],
        options: [
          { optionKey: "a", neutralSummary: "Opt A", rationaleAndPremises: "Rat A" },
          { optionKey: "b", neutralSummary: "Opt B", rationaleAndPremises: "Rat B" },
          { optionKey: "c", neutralSummary: "Opt C", rationaleAndPremises: "Rat C" },
        ],
      };

      it("should parse a valid decision batch with 1 to 12 items", () => {
        const parsed = BatchSchema.parse({
          items: [singleItem],
        });
        expect(parsed.items.length).toBe(1);
      });

      it("should reject an empty decision batch (min 1)", () => {
        expect(() => BatchSchema.parse({ items: [] })).toThrow(z.ZodError);
      });

      it("should reject a batch exceeding 12 items (max 12)", () => {
        const thirteenItems = Array.from({ length: 13 }, (_, i) => ({
          ...singleItem,
          decisionId: `dec_${i}`,
        }));
        expect(() => BatchSchema.parse({ items: thirteenItems })).toThrow(z.ZodError);
      });

      it("should reject batch if any single item contains a hallucinated tag", () => {
        const invalidBatch = {
          items: [
            singleItem,
            {
              ...singleItem,
              decisionId: "dec_2",
              conceptTags: ["hallucinated_out_of_vocab"],
            },
          ],
        };
        expect(() => BatchSchema.parse(invalidBatch)).toThrow(z.ZodError);
      });
    });

    describe("createAssumptionItemSchema & createAssumptionExtractionBatchSchema", () => {
      const allowedTags = ["caching_strategy", "latency_throughput"];
      const AssumptionSchema = createAssumptionItemSchema(allowedTags);
      const AssumptionBatch = createAssumptionExtractionBatchSchema(allowedTags);

      const validAssumption = {
        assumptionId: "asmp_01",
        statement: "Redis cluster provides p99 read latency under 5ms",
        conceptTags: ["caching_strategy", "latency_throughput"],
        affectedSections: [{ fileId: "arch_doc", headingSlug: "redis-cache" }],
        dependsOn: [],
      };

      it("should parse a valid assumption item and batch", () => {
        expect(AssumptionSchema.parse(validAssumption).assumptionId).toBe("asmp_01");

        const batch = AssumptionBatch.parse({
          assumptions: [validAssumption],
        });
        expect(batch.assumptions.length).toBe(1);
      });

      it("should reject assumption with hallucinated tag", () => {
        const invalidAssumption = {
          ...validAssumption,
          conceptTags: ["unauthorized_tag"],
        };
        expect(() => AssumptionSchema.parse(invalidAssumption)).toThrow(z.ZodError);
      });

      it("should reject assumption with 0 conceptTags", () => {
        const emptyTags = {
          ...validAssumption,
          conceptTags: [],
        };
        expect(() => AssumptionSchema.parse(emptyTags)).toThrow(z.ZodError);
      });
    });

    describe("Pre-instantiated Default Schemas", () => {
      it("should validate ConceptTagEnum against default taxonomy", () => {
        expect(ConceptTagEnum.parse("system_architecture")).toBe("system_architecture");
        expect(ConceptTagEnum.parse("testing_strategy")).toBe("testing_strategy");
        expect(() => ConceptTagEnum.parse("hallucinated_tag")).toThrow(z.ZodError);
      });

      it("should validate DecisionEvaluationItemSchema and CanonicalDecisionBatchSchema", () => {
        const validItem = {
          decisionId: "dec_default_01",
          topicSlug: "testing_approach",
          questionPrompt: "What is the testing methodology?",
          conceptTags: ["testing_strategy"],
          options: [
            { optionKey: "unit_only", neutralSummary: "Unit tests", rationaleAndPremises: "Fast" },
            { optionKey: "e2e_heavy", neutralSummary: "E2E tests", rationaleAndPremises: "Real" },
            { optionKey: "pyramid", neutralSummary: "Test pyramid", rationaleAndPremises: "Balanced" },
          ],
        };

        const parsedItem = DecisionEvaluationItemSchema.parse(validItem);
        expect(parsedItem.decisionId).toBe("dec_default_01");

        const parsedBatch = CanonicalDecisionBatchSchema.parse({ items: [validItem] });
        expect(parsedBatch.items.length).toBe(1);
      });

      it("should validate AssumptionItemSchema and AssumptionExtractionBatchSchema", () => {
        const validAssumption = {
          assumptionId: "asmp_def_01",
          statement: "Testing pipeline finishes within 5 minutes",
          conceptTags: ["ci_cd_deployment"],
        };

        const parsed = AssumptionItemSchema.parse(validAssumption);
        expect(parsed.assumptionId).toBe("asmp_def_01");

        const parsedBatch = AssumptionExtractionBatchSchema.parse({
          assumptions: [validAssumption],
        });
        expect(parsedBatch.assumptions.length).toBe(1);
      });
    });

    // =========================================================================
    // 8. Static Structural & Workflow Schemas
    // =========================================================================
    describe("8. Static Structural & Workflow Schemas", () => {
      it("should validate SectionTargetSchema", () => {
        expect(
          SectionTargetSchema.parse({
            fileId: "file_01",
            headingSlug: "architecture-overview",
          })
        ).toEqual({
          fileId: "file_01",
          headingSlug: "architecture-overview",
        });

        expect(() => SectionTargetSchema.parse({ fileId: "", headingSlug: "heading" })).toThrow(
          z.ZodError
        );
      });

      it("should validate CanonicalOptionSchema constraints", () => {
        const validOption = {
          optionKey: "option_key_1",
          neutralSummary: "Summary text",
          rationaleAndPremises: "Rationale details",
        };
        expect(CanonicalOptionSchema.parse(validOption)).toEqual(validOption);

        // Invalid optionKey with capital letters
        expect(() =>
          CanonicalOptionSchema.parse({
            ...validOption,
            optionKey: "InvalidKey",
          })
        ).toThrow(z.ZodError);

        // Summary exceeding 220 chars
        expect(() =>
          CanonicalOptionSchema.parse({
            ...validOption,
            neutralSummary: "s".repeat(221),
          })
        ).toThrow(z.ZodError);

        // Rationale exceeding 400 chars
        expect(() =>
          CanonicalOptionSchema.parse({
            ...validOption,
            rationaleAndPremises: "r".repeat(401),
          })
        ).toThrow(z.ZodError);
      });

      it("should validate RelationalLinkTypeEnum and RelationalAdjudicationBatchSchema", () => {
        expect(RelationalLinkTypeEnum.parse("INDEPENDENT")).toBe("INDEPENDENT");
        expect(RelationalLinkTypeEnum.parse("DEPENDS_ON")).toBe("DEPENDS_ON");
        expect(RelationalLinkTypeEnum.parse("REOPENS_OR_OVERRIDES")).toBe("REOPENS_OR_OVERRIDES");
        expect(RelationalLinkTypeEnum.parse("REFINES")).toBe("REFINES");
        expect(() => RelationalLinkTypeEnum.parse("INVALID_RELATION")).toThrow(z.ZodError);

        const validBatch = {
          relations: [
            {
              assumptionId: "asmp_1",
              targetDecisionId: "dec_1",
              relationType: "DEPENDS_ON" as const,
              confidence: 0.95,
              justification: "Requires state container decision to hold true.",
            },
          ],
        };
        const parsed = RelationalAdjudicationBatchSchema.parse(validBatch);
        expect(parsed.relations.length).toBe(1);
        expect(parsed.relations[0].confidence).toBe(0.95);
      });

      it("should validate QuestionQueueSchema and ClarificationResponseSchema", () => {
        const validQuestionQueue = {
          questions: [
            {
              questionId: "q_01",
              topicSlug: "cache_invalidation",
              questionPrompt: "What invalidation policy is required?",
              options: [
                { optionKey: "ttl_only", neutralSummary: "TTL only", rationaleAndPremises: "Simple" },
                { optionKey: "tag_purge", neutralSummary: "Tag purge", rationaleAndPremises: "Targeted" },
              ],
            },
          ],
        };

        const parsedQueue = QuestionQueueSchema.parse(validQuestionQueue);
        expect(parsedQueue.questions.length).toBe(1);

        // Question with less than 2 options rejected
        expect(() =>
          QuestionQueueSchema.parse({
            questions: [
              {
                ...validQuestionQueue.questions[0],
                options: [validQuestionQueue.questions[0].options[0]],
              },
            ],
          })
        ).toThrow(z.ZodError);

        // Question queue with > 5 questions rejected
        const sixQuestions = Array.from({ length: 6 }, (_, i) => ({
          ...validQuestionQueue.questions[0],
          questionId: `q_${i}`,
        }));
        expect(() => QuestionQueueSchema.parse({ questions: sixQuestions })).toThrow(z.ZodError);

        const validResponse = {
          answers: [
            {
              questionId: "q_01",
              selectedOptionKey: "tag_purge",
              customNotes: "Targeted purge fits user expectations",
            },
          ],
        };
        const parsedResp = ClarificationResponseSchema.parse(validResponse);
        expect(parsedResp.answers[0].selectedOptionKey).toBe("tag_purge");
      });

      it("should validate SearchEvidenceItemSchema and SearchReportSchema", () => {
        const validReport = {
          evidenceItems: [
            {
              fileId: "doc_01",
              headingSlug: "caching",
              breadcrumb: ["Architecture", "Storage", "Caching"],
              textExcerpt: "Redis cluster used for session cache.",
              vaultRef: "vault_01",
            },
          ],
          inspectedPaths: ["/docs/arch.md"],
          summary: "Inspected architecture documentation for caching specifications.",
        };

        const parsed = SearchReportSchema.parse(validReport);
        expect(parsed.evidenceItems.length).toBe(1);
        expect(parsed.inspectedPaths[0]).toBe("/docs/arch.md");
      });
    });
  });
});
