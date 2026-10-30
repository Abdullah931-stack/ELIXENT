/**
 * Test Suite: Conformal APS Classifier, Calibration Store & Unified Decisions Client
 *
 * Implements rigorous verification for:
 * 1. Conformal Adaptive Prediction Sets (APS) Classifier (src/lib/jev/conformal-classifier.ts):
 *    - Abstention gate (p_abstain >= 0.25, evidenceGrounding < 0.50, denom <= 1e-6)
 *    - Probability normalization and isolation of p_abstain
 *    - Structural Impact Index (couplingLevel >= 1.5 || rollbackCost >= 1.5 -> CORE_ARCHITECTURAL vs PERIPHERAL)
 *    - Top-2 dominance margin m(x) = p(1) - p(2)
 *    - Conformal prediction sets C_alpha_core and C_alpha_periph
 *    - APPROVED_DIRECT (|C_core| == 1 && m(x) >= 0.25, isLoadBearing: true)
 *    - APPROVED_CONSERVATIVE (PERIPHERAL && 1 <= |C_periph| <= 2 && m(x) >= 0.15, isLoadBearing: false)
 *    - STRICT INVARIANT: APPROVED_CONSERVATIVE strictly prohibited on CORE_ARCHITECTURAL
 *    - UNRESOLVED classifications and distinct reason taxonomy
 *    - Evaluated alternatives and rationale preservation with runnerUpOptionKey
 *    - Numerical boundary edge cases (floating-point sums, EPSILON, single option, ties)
 *
 * 2. Universal Prior Calibration Store (src/lib/jev/calibration-store.ts):
 *    - Static priors retrieval from models.config.json and fallback defaults
 *    - In-memory sliding window FIFO eviction (capacity N = 200)
 *    - Numerical clamping to [0, 1] and non-number filtering
 *    - Empirical quantile rank computation when n >= 20:
 *      kCore = min(n, ceil((n + 1) * 0.95)), kPeriph = min(n, ceil((n + 1) * 0.80))
 *    - Window inspection, reset, and resilient Redis failure handling
 *
 * 3. Unified Decisions Client & Two-Tier Cascade (src/lib/jev/client.ts):
 *    - Closed-world concept tag validation (Commit Gate 7 Mandate)
 *    - Two-Tier Decision Cascade escalation (Tier 1 -> Tier 2 fastino/glide on ambiguous core decisions)
 *    - Relational links adjudication batching (INDEPENDENT, DEPENDS_ON, REOPENS_OR_OVERRIDES, REFINES)
 *    - Network API fetch flow, abort signal timeouts, and JevApiError representation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ZodError } from "zod";

import {
  classifyDecisionConformalAPS,
  type DecisionItemEvaluationInput,
} from "@/lib/jev/conformal-classifier";

import {
  CalibrationStore,
  calibrationStore,
  getStaticPriors,
  DEFAULT_FALLBACK_PRIORS,
  CALIBRATION_WINDOW_CAPACITY,
  MIN_EMPIRICAL_WINDOW_SIZE,
} from "@/lib/jev/calibration-store";

import {
  evaluateDecisionBatch,
  evaluateRelationalLinksBatch,
  JevApiError,
  TIER1_DEFAULT_MODEL,
} from "@/lib/jev/client";
import type {
  CanonicalDecisionBatch,
  DecisionEvaluationItem,
  RelationalLinkPairInput,
} from "@/core/agent/schemas/decision-schemas";

// ===========================================================================
// Helper Generators for Test Inputs
// ===========================================================================

function createSampleDecisionInput(
  overrides?: Partial<DecisionItemEvaluationInput>
): DecisionItemEvaluationInput {
  return {
    decisionId: "dec_sys_arch_001",
    topicSlug: "caching_layer_selection",
    questionPrompt: "Which caching tier architecture should be adopted?",
    conceptTags: ["caching_strategy", "system_architecture"],
    evidenceGrounding: 0.95,
    couplingLevel: 0.8,
    rollbackCost: 0.6,
    probabilities: {
      redis_cluster: 0.75,
      in_memory_lru: 0.15,
      insufficient_evidence: 0.10,
    },
    options: [
      {
        optionKey: "redis_cluster",
        neutralSummary: "Distributed Upstash Redis cluster with TTL caching",
        rationaleAndPremises:
          "Enables shared state across serverless nodes with minimal latency overhead",
      },
      {
        optionKey: "in_memory_lru",
        neutralSummary: "Node.js local LRU memory cache",
        rationaleAndPremises:
          "Zero network overhead but isolated per lambda container",
      },
    ],
    ...overrides,
  };
}

function createSampleBatchItem(
  overrides?: Partial<DecisionEvaluationItem>
): DecisionEvaluationItem {
  return {
    decisionId: "dec_1",
    topicSlug: "sys_arch",
    questionPrompt: "Select persistence engine",
    conceptTags: ["data_modeling", "schema_evolution"],
    options: [
      {
        optionKey: "opt_postgres",
        neutralSummary: "PostgreSQL on Neon",
        rationaleAndPremises: "Relational integrity and JSONB support",
      },
      {
        optionKey: "opt_sqlite",
        neutralSummary: "Embedded SQLite",
        rationaleAndPremises: "Local file-based lightweight storage",
      },
      {
        optionKey: "opt_kv",
        neutralSummary: "Key-Value store",
        rationaleAndPremises: "Fast unstructured key value lookup",
      },
    ],
    dependsOnDecisionIds: [],
    affectedSections: [],
    ...overrides,
  };
}

function createSampleRelationalPair(
  overrides?: Partial<RelationalLinkPairInput>
): RelationalLinkPairInput {
  return {
    assumptionId: "asmp_1",
    candidateDecisionId: "dec_1",
    assumptionStatement: "We depend on the confirmed PostgreSQL transaction isolation level",
    candidatePrompt: "Select database engine",
    candidateSelectedOption: "PostgreSQL on Neon",
    sharedConceptTags: [],
    ...overrides,
  };
}

describe("Commit Gate 7: Conformal APS & Decision Pipeline Test Suite", () => {
  // =========================================================================
  // SECTION 1: Conformal Adaptive Prediction Sets (APS) Classifier
  // =========================================================================
  describe("1. Conformal APS Deterministic Classifier (conformal-classifier.ts)", () => {
    const standardPriors = { qHatCore05: 0.20, qHatPeriph20: 0.40 };

    describe("1.1 Abstention Gate & Probability Normalization", () => {
      it("should trigger abstention when p_abstain >= 0.25 exactly", () => {
        const input = createSampleDecisionInput({
          evidenceGrounding: 0.90,
          probabilities: {
            opt_a: 0.45,
            opt_b: 0.30,
            insufficient_evidence: 0.25, // Boundary tau_abstain
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);

        expect(result.status).toBe("UNRESOLVED");
        expect(result.reason).toBe("INSUFFICIENT_EVIDENCE_OR_GROUNDING");
        expect(result.selectedOptionKey).toBeNull();
        expect(result.runnerUpOptionKey).toBeNull();
        expect(result.predictionSetCore).toEqual([]);
        expect(result.predictionSetPeriph).toEqual([]);
        expect(result.dominanceMargin).toBe(0);
        expect(result.selectionRationale).toContain("abstention gate triggered");
      });

      it("should trigger abstention when p_abstain strictly exceeds 0.25", () => {
        const input = createSampleDecisionInput({
          evidenceGrounding: 0.90,
          probabilities: {
            opt_a: 0.30,
            opt_b: 0.30,
            insufficient_evidence: 0.40,
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.status).toBe("UNRESOLVED");
        expect(result.reason).toBe("INSUFFICIENT_EVIDENCE_OR_GROUNDING");
      });

      it("should pass abstention when p_abstain is slightly below 0.25 (e.g., 0.2499)", () => {
        const input = createSampleDecisionInput({
          evidenceGrounding: 0.90,
          probabilities: {
            redis_cluster: 0.70,
            in_memory_lru: 0.0501,
            insufficient_evidence: 0.2499,
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.status).not.toBe("UNRESOLVED");
      });

      it("should trigger abstention when evidenceGrounding < 0.50 even if dominance is overwhelming", () => {
        const input = createSampleDecisionInput({
          evidenceGrounding: 0.499, // Below 0.50 minimum
          probabilities: {
            redis_cluster: 0.98,
            in_memory_lru: 0.01,
            insufficient_evidence: 0.01,
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.status).toBe("UNRESOLVED");
        expect(result.reason).toBe("INSUFFICIENT_EVIDENCE_OR_GROUNDING");
        expect(result.evidenceGrounding).toBe(0.499);
      });

      it("should pass abstention when evidenceGrounding is exactly 0.50", () => {
        const input = createSampleDecisionInput({
          evidenceGrounding: 0.50,
          probabilities: {
            redis_cluster: 0.90,
            in_memory_lru: 0.05,
            insufficient_evidence: 0.05,
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.status).toBe("APPROVED_DIRECT");
      });

      it("should trigger abstention safely when denominator <= 1e-6 (e.g., p_abstain = 1.0)", () => {
        const input = createSampleDecisionInput({
          evidenceGrounding: 0.90,
          probabilities: {
            redis_cluster: 0.0,
            in_memory_lru: 0.0,
            insufficient_evidence: 1.0,
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.status).toBe("UNRESOLVED");
        expect(result.reason).toBe("INSUFFICIENT_EVIDENCE_OR_GROUNDING");
        expect(result.evaluatedAlternatives[0].normalizedProbability).toBe(0);
      });

      it("should default p_abstain to 0 when insufficient_evidence key is omitted", () => {
        const input = createSampleDecisionInput({
          evidenceGrounding: 0.90,
          probabilities: {
            redis_cluster: 0.80,
            in_memory_lru: 0.20,
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        // denom = 1 - 0 = 1, normProbs = 0.80 and 0.20
        expect(result.status).toBe("APPROVED_DIRECT");
        expect(result.dominanceMargin).toBeCloseTo(0.60, 5);
      });

      it("should correctly isolate p_abstain and re-normalize option probabilities to sum to 1.0", () => {
        const input = createSampleDecisionInput({
          evidenceGrounding: 0.90,
          probabilities: {
            redis_cluster: 0.60,
            in_memory_lru: 0.20,
            insufficient_evidence: 0.20,
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);

        // denom = 1 - 0.20 = 0.80
        // redis_cluster = 0.60 / 0.80 = 0.75
        // in_memory_lru = 0.20 / 0.80 = 0.25
        const redisAlt = result.evaluatedAlternatives.find((a) => a.optionKey === "redis_cluster");
        const lruAlt = result.evaluatedAlternatives.find((a) => a.optionKey === "in_memory_lru");

        expect(redisAlt?.normalizedProbability).toBeCloseTo(0.75, 5);
        expect(lruAlt?.normalizedProbability).toBeCloseTo(0.25, 5);
        expect((redisAlt?.normalizedProbability ?? 0) + (lruAlt?.normalizedProbability ?? 0)).toBeCloseTo(1.0, 5);
      });
    });

    describe("1.2 Structural Impact Index (Core vs Peripheral)", () => {
      it("should tag as CORE_ARCHITECTURAL when couplingLevel >= 1.5", () => {
        const input = createSampleDecisionInput({
          couplingLevel: 1.5,
          rollbackCost: 0.2,
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.impactTier).toBe("CORE_ARCHITECTURAL");
        expect(result.isLoadBearing).toBe(true);
      });

      it("should tag as CORE_ARCHITECTURAL when rollbackCost >= 1.5", () => {
        const input = createSampleDecisionInput({
          couplingLevel: 0.2,
          rollbackCost: 1.5,
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.impactTier).toBe("CORE_ARCHITECTURAL");
        expect(result.isLoadBearing).toBe(true);
      });

      it("should tag as CORE_ARCHITECTURAL when both couplingLevel and rollbackCost >= 1.5", () => {
        const input = createSampleDecisionInput({
          couplingLevel: 2.0,
          rollbackCost: 1.9,
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.impactTier).toBe("CORE_ARCHITECTURAL");
        expect(result.isLoadBearing).toBe(true);
      });

      it("should tag as PERIPHERAL when both couplingLevel and rollbackCost are strictly below 1.5", () => {
        const input = createSampleDecisionInput({
          couplingLevel: 1.499,
          rollbackCost: 1.499,
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.impactTier).toBe("PERIPHERAL");
      });

      it("should preserve impactTier even when abstention gate is triggered", () => {
        const coreAbstain = createSampleDecisionInput({
          couplingLevel: 1.8,
          rollbackCost: 1.7,
          evidenceGrounding: 0.30,
        });
        const resCore = classifyDecisionConformalAPS(coreAbstain, standardPriors);
        expect(resCore.impactTier).toBe("CORE_ARCHITECTURAL");
        expect(resCore.isLoadBearing).toBe(true);
        expect(resCore.status).toBe("UNRESOLVED");

        const periphAbstain = createSampleDecisionInput({
          couplingLevel: 0.5,
          rollbackCost: 0.4,
          evidenceGrounding: 0.30,
        });
        const resPeriph = classifyDecisionConformalAPS(periphAbstain, standardPriors);
        expect(resPeriph.impactTier).toBe("PERIPHERAL");
        expect(resPeriph.isLoadBearing).toBe(false);
        expect(resPeriph.status).toBe("UNRESOLVED");
      });
    });

    describe("1.3 Top-2 Dominance Margin m(x)", () => {
      it("should compute m(x) = p(1) - p(2) accurately for multi-option sets", () => {
        const input = createSampleDecisionInput({
          probabilities: {
            redis_cluster: 0.54,
            in_memory_lru: 0.36,
            insufficient_evidence: 0.10,
          },
        });
        // denom = 0.90 -> p1 = 0.60, p2 = 0.40 -> m(x) = 0.20
        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.dominanceMargin).toBeCloseTo(0.20, 5);
        expect(result.runnerUpOptionKey).toBe("in_memory_lru");
      });

      it("should yield dominanceMargin = p(1) and runnerUpOptionKey = null when only 1 option is present", () => {
        const singleOptionInput: DecisionItemEvaluationInput = {
          decisionId: "dec_single_opt",
          topicSlug: "monolithic_choice",
          questionPrompt: "Is there only one viable path?",
          conceptTags: ["system_architecture"],
          evidenceGrounding: 0.90,
          couplingLevel: 0.4,
          rollbackCost: 0.3,
          probabilities: {
            only_viable: 0.95,
            insufficient_evidence: 0.05,
          },
          options: [
            {
              optionKey: "only_viable",
              neutralSummary: "Single deterministic path",
              rationaleAndPremises: "No alternative options exist",
            },
          ],
        };

        const result = classifyDecisionConformalAPS(singleOptionInput, standardPriors);
        expect(result.dominanceMargin).toBeCloseTo(1.0, 5);
        expect(result.runnerUpOptionKey).toBeNull();
      });

      it("should yield dominanceMargin = 0 when top two options are tied", () => {
        const input = createSampleDecisionInput({
          probabilities: {
            redis_cluster: 0.45,
            in_memory_lru: 0.45,
            insufficient_evidence: 0.10,
          },
        });

        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.dominanceMargin).toBeCloseTo(0.0, 5);
        expect(result.status).toBe("UNRESOLVED");
        expect(result.reason).toBe("INSUFFICIENT_DOMINANCE_MARGIN");
      });
    });

    describe("1.4 Conformal Prediction Set Membership & Nonconformity Scores", () => {
      it("should construct C_alpha_core and C_alpha_periph based on nonconformity scores s(x, a_k) = 1 - p_norm", () => {
        // Option A: normProb = 0.85 -> s = 0.15
        // Option B: normProb = 0.15 -> s = 0.85
        // Prior core: qHatCore05 = 0.20 (0.15 <= 0.20 -> A in C_core; B not in C_core)
        // Prior periph: qHatPeriph20 = 0.40 (0.15 <= 0.40 -> A in C_periph; B not in C_periph)
        const input = createSampleDecisionInput({
          probabilities: {
            redis_cluster: 0.85,
            in_memory_lru: 0.15,
            insufficient_evidence: 0.0,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.20,
          qHatPeriph20: 0.40,
        });

        expect(result.predictionSetCore).toEqual(["redis_cluster"]);
        expect(result.predictionSetPeriph).toEqual(["redis_cluster"]);
      });

      it("should include borderline scores into prediction set via EPSILON boundary", () => {
        // If s(x, a) == 0.2000000005, EPSILON (1e-9) includes it in C_core
        const input = createSampleDecisionInput({
          probabilities: {
            redis_cluster: 0.80,
            in_memory_lru: 0.20,
            insufficient_evidence: 0.0,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.20,
          qHatPeriph20: 0.40,
        });

        // s(redis_cluster) = 1 - 0.80 = 0.20 <= 0.20 + 1e-9 -> Included!
        expect(result.predictionSetCore).toContain("redis_cluster");
        // s(in_memory_lru) = 1 - 0.20 = 0.80 > 0.20 -> Not in core
        expect(result.predictionSetCore).not.toContain("in_memory_lru");
      });

      it("should populate multiple options into C_periph when nonconformity scores satisfy qHatPeriph20", () => {
        // Option A: normProb = 0.55 -> s = 0.45
        // Option B: normProb = 0.45 -> s = 0.55
        // If qHatPeriph20 = 0.60: both satisfy <= 0.60 -> |C_periph| = 2
        const input = createSampleDecisionInput({
          couplingLevel: 0.5,
          rollbackCost: 0.4, // PERIPHERAL
          probabilities: {
            redis_cluster: 0.55,
            in_memory_lru: 0.45,
            insufficient_evidence: 0.0,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.10,
          qHatPeriph20: 0.60,
        });

        expect(result.predictionSetPeriph).toEqual(["redis_cluster", "in_memory_lru"]);
      });
    });

    describe("1.5 APPROVED_DIRECT Classification Rule", () => {
      it("should approve directly when |C_core| == 1 and dominanceMargin >= 0.25 on CORE_ARCHITECTURAL", () => {
        const input = createSampleDecisionInput({
          couplingLevel: 1.8, // CORE_ARCHITECTURAL
          rollbackCost: 1.6,
          probabilities: {
            redis_cluster: 0.85,
            in_memory_lru: 0.10,
            insufficient_evidence: 0.05,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.15,
          qHatPeriph20: 0.35,
        });

        expect(result.status).toBe("APPROVED_DIRECT");
        expect(result.impactTier).toBe("CORE_ARCHITECTURAL");
        expect(result.isLoadBearing).toBe(true);
        expect(result.selectedOptionKey).toBe("redis_cluster");
        expect(result.runnerUpOptionKey).toBe("in_memory_lru");
        expect(result.selectionRationale).toBe(input.options[0].rationaleAndPremises);
      });

      it("should approve directly when |C_core| == 1 and dominanceMargin >= 0.25 on PERIPHERAL", () => {
        const input = createSampleDecisionInput({
          couplingLevel: 0.5, // PERIPHERAL
          rollbackCost: 0.4,
          probabilities: {
            redis_cluster: 0.85,
            in_memory_lru: 0.10,
            insufficient_evidence: 0.05,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.15,
          qHatPeriph20: 0.35,
        });

        expect(result.status).toBe("APPROVED_DIRECT");
        expect(result.impactTier).toBe("PERIPHERAL");
        expect(result.isLoadBearing).toBe(true); // Direct approval mandates isLoadBearing: true
        expect(result.selectedOptionKey).toBe("redis_cluster");
      });
    });

    describe("1.6 APPROVED_CONSERVATIVE Rule & Strict Invariant Enforcement", () => {
      it("should approve conservatively when PERIPHERAL, 1 <= |C_periph| <= 2, and dominanceMargin >= 0.15", () => {
        // normProb: A = 0.58, B = 0.42 -> m(x) = 0.16 >= 0.15
        // s: A = 0.42, B = 0.58
        // priors: qHatCore05 = 0.10 (|C_core| = 0), qHatPeriph20 = 0.60 (|C_periph| = 2)
        const input = createSampleDecisionInput({
          couplingLevel: 0.6,
          rollbackCost: 0.5, // PERIPHERAL
          probabilities: {
            redis_cluster: 0.58,
            in_memory_lru: 0.42,
            insufficient_evidence: 0.0,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.10,
          qHatPeriph20: 0.60,
        });

        expect(result.status).toBe("APPROVED_CONSERVATIVE");
        expect(result.impactTier).toBe("PERIPHERAL");
        expect(result.isLoadBearing).toBe(false);
        expect(result.selectedOptionKey).toBe("redis_cluster");
        expect(result.runnerUpOptionKey).toBe("in_memory_lru");
      });

      it("STRICT INVARIANT: must NEVER approve conservatively on CORE_ARCHITECTURAL (must return UNRESOLVED)", () => {
        // Identical probabilities to above, but couplingLevel = 1.8 -> CORE_ARCHITECTURAL!
        const input = createSampleDecisionInput({
          couplingLevel: 1.8, // CORE_ARCHITECTURAL
          rollbackCost: 1.6,
          probabilities: {
            redis_cluster: 0.58,
            in_memory_lru: 0.42,
            insufficient_evidence: 0.0,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.10,
          qHatPeriph20: 0.60,
        });

        // Must reject conservative approval and classify as UNRESOLVED
        expect(result.status).toBe("UNRESOLVED");
        expect(result.impactTier).toBe("CORE_ARCHITECTURAL");
        expect(result.isLoadBearing).toBe(true);
        expect(result.selectedOptionKey).toBeNull();
        expect(result.status).not.toBe("APPROVED_CONSERVATIVE");
      });
    });

    describe("1.7 UNRESOLVED Classification & Taxonomy of Reasons", () => {
      it("should classify as UNRESOLVED with MULTI_OPTION_CORE_PREDICTION_SET when core decision has |C_core| > 1", () => {
        // High probabilities for two options on CORE:
        // A = 0.52, B = 0.48 -> s_A = 0.48, s_B = 0.52
        // qHatCore05 = 0.55 -> |C_core| = 2
        const input = createSampleDecisionInput({
          couplingLevel: 1.8,
          rollbackCost: 1.7,
          probabilities: {
            redis_cluster: 0.52,
            in_memory_lru: 0.48,
            insufficient_evidence: 0.0,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.55,
          qHatPeriph20: 0.65,
        });

        expect(result.status).toBe("UNRESOLVED");
        expect(result.impactTier).toBe("CORE_ARCHITECTURAL");
        expect(result.reason).toBe("MULTI_OPTION_CORE_PREDICTION_SET");
        expect(result.selectionRationale).toContain("|C_core| = 2");
      });

      it("should classify as UNRESOLVED with INSUFFICIENT_DOMINANCE_MARGIN when m(x) < 0.15", () => {
        const input = createSampleDecisionInput({
          couplingLevel: 0.4,
          rollbackCost: 0.3, // PERIPHERAL
          probabilities: {
            redis_cluster: 0.54,
            in_memory_lru: 0.46,
            insufficient_evidence: 0.0,
          },
        });

        // m(x) = 0.54 - 0.46 = 0.08 < 0.15
        const result = classifyDecisionConformalAPS(input, standardPriors);
        expect(result.status).toBe("UNRESOLVED");
        expect(result.reason).toBe("INSUFFICIENT_DOMINANCE_MARGIN");
        expect(result.selectionRationale).toContain("Dominance margin (0.080) fell below");
      });

      it("should classify as UNRESOLVED with CONFORMAL_THRESHOLD_UNMET when prediction set criteria are not met", () => {
        // Peripheral with dominance margin 0.20 (>= 0.15), but |C_periph| = 0 (qHatPeriph20 = 0.01)
        const input = createSampleDecisionInput({
          couplingLevel: 0.4,
          rollbackCost: 0.3,
          probabilities: {
            redis_cluster: 0.60,
            in_memory_lru: 0.40,
            insufficient_evidence: 0.0,
          },
        });

        const result = classifyDecisionConformalAPS(input, {
          qHatCore05: 0.01,
          qHatPeriph20: 0.01,
        });

        expect(result.status).toBe("UNRESOLVED");
        expect(result.reason).toBe("CONFORMAL_THRESHOLD_UNMET");
      });

      it("should preserve all evaluatedAlternatives and original option ordering in all cases", () => {
        const input = createSampleDecisionInput();
        const result = classifyDecisionConformalAPS(input, standardPriors);

        expect(result.evaluatedAlternatives.length).toBe(input.options.length);
        expect(result.evaluatedAlternatives[0].optionKey).toBe(input.options[0].optionKey);
        expect(result.evaluatedAlternatives[1].optionKey).toBe(input.options[1].optionKey);
      });
    });
  });

  // =========================================================================
  // SECTION 2: Universal Prior Calibration Store
  // =========================================================================
  describe("2. Universal Prior Calibration Store (calibration-store.ts)", () => {
    let testStore: CalibrationStore;

    beforeEach(() => {
      testStore = new CalibrationStore(CALIBRATION_WINDOW_CAPACITY, MIN_EMPIRICAL_WINDOW_SIZE);
      calibrationStore.resetWindow();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe("2.1 Static Priors Loading (getStaticPriors)", () => {
      it("should load registered priors for typesafe/jev-1.13 from models.config.json", () => {
        const priors = getStaticPriors("typesafe/jev-1.13");
        expect(priors.qHatCore05).toBe(0.08);
        expect(priors.qHatPeriph20).toBe(0.22);
      });

      it("should load registered priors for fastino/glide from models.config.json", () => {
        const priors = getStaticPriors("fastino/glide");
        expect(priors.qHatCore05).toBe(0.09);
        expect(priors.qHatPeriph20).toBe(0.24);
      });

      it("should load registered priors for microsoft/decision-1", () => {
        const priors = getStaticPriors("microsoft/decision-1");
        expect(priors.qHatCore05).toBe(0.22);
        expect(priors.qHatPeriph20).toBe(0.42);
      });

      it("should fallback to DEFAULT_FALLBACK_PRIORS for models without priors (e.g. google/gemini-4-argon)", () => {
        const priors = getStaticPriors("google/gemini-4-argon");
        expect(priors).toEqual(DEFAULT_FALLBACK_PRIORS);
      });

      it("should fallback to DEFAULT_FALLBACK_PRIORS for unregistered model identifiers", () => {
        const priors = getStaticPriors("unregistered/unknown-model");
        expect(priors).toEqual(DEFAULT_FALLBACK_PRIORS);
      });
    });

    describe("2.2 In-Memory Sliding Window & Capacity Constraints", () => {
      it("should record valid scores into in-memory sliding window", async () => {
        const modelId = "test-model-1";
        await testStore.recordFeedbackScore(modelId, 0.15);
        await testStore.recordFeedbackScore(modelId, 0.35);

        expect(testStore.getWindowSize(modelId)).toBe(2);
      });

      it("should clamp nonconformity scores outside [0, 1] bounds", async () => {
        const store = new CalibrationStore(5, 3);
        const modelId = "clamp-model";

        await store.recordFeedbackScore(modelId, -0.5); // Should clamp to 0.0
        await store.recordFeedbackScore(modelId, 1.8);  // Should clamp to 1.0
        await store.recordFeedbackScore(modelId, 0.5);  // Preserved as 0.5

        expect(store.getWindowSize(modelId)).toBe(3);

        const priors = await store.getQuantilePriors(modelId);
        // Window is sorted: [0.0, 0.5, 1.0]
        // n = 3: kCore = min(3, ceil(4 * 0.95)) = min(3, 4) = 3 -> sorted[2] = 1.0
        expect(priors.qHatCore05).toBe(1.0);
      });

      it("should ignore NaN, null, and non-numeric score inputs", async () => {
        const modelId = "nan-model";
        await testStore.recordFeedbackScore(modelId, NaN);
        await testStore.recordFeedbackScore(modelId, "invalid" as unknown as number);
        await testStore.recordFeedbackScore(modelId, undefined as unknown as number);

        expect(testStore.getWindowSize(modelId)).toBe(0);
      });

      it("should enforce FIFO eviction when sliding window capacity is exceeded", async () => {
        const capacity = 5;
        const smallStore = new CalibrationStore(capacity, 3);
        const modelId = "fifo-model";

        for (let i = 1; i <= 7; i++) {
          await smallStore.recordFeedbackScore(modelId, i * 0.1);
        }

        expect(smallStore.getWindowSize(modelId)).toBe(capacity);
      });

      it("should reset window correctly for single model and globally", async () => {
        await testStore.recordFeedbackScore("model-a", 0.2);
        await testStore.recordFeedbackScore("model-b", 0.3);

        expect(testStore.getWindowSize("model-a")).toBe(1);
        expect(testStore.getWindowSize("model-b")).toBe(1);

        testStore.resetWindow("model-a");
        expect(testStore.getWindowSize("model-a")).toBe(0);
        expect(testStore.getWindowSize("model-b")).toBe(1);

        testStore.resetWindow();
        expect(testStore.getWindowSize("model-b")).toBe(0);
      });
    });

    describe("2.3 Empirical Quantile Computation (n >= 20)", () => {
      it("should return static priors when window size n < 20", async () => {
        const modelId = "typesafe/jev-1.13";
        for (let i = 0; i < 19; i++) {
          await testStore.recordFeedbackScore(modelId, 0.5);
        }

        expect(testStore.getWindowSize(modelId)).toBe(19);
        const priors = await testStore.getQuantilePriors(modelId);
        expect(priors.qHatCore05).toBe(0.08); // Static prior from models.config.json
        expect(priors.qHatPeriph20).toBe(0.22);
      });

      it("should compute empirical quantiles when n == 20 exactly", async () => {
        const modelId = "empirical-test-model";
        // Insert 20 scores from 0.05 to 1.00 in steps of 0.05
        for (let i = 1; i <= 20; i++) {
          await testStore.recordFeedbackScore(modelId, i * 0.05);
        }

        expect(testStore.getWindowSize(modelId)).toBe(20);

        const priors = await testStore.getQuantilePriors(modelId);

        // n = 20
        // kCore = min(20, ceil(21 * 0.95)) = min(20, ceil(19.95)) = 20 -> sorted[19] = 1.00
        // kPeriph = min(20, ceil(21 * 0.80)) = min(20, ceil(16.80)) = 17 -> sorted[16] = 17 * 0.05 = 0.85
        expect(priors.qHatCore05).toBeCloseTo(1.00, 5);
        expect(priors.qHatPeriph20).toBeCloseTo(0.85, 5);
      });

      it("should correctly handle un-ordered insertion and compute sorted ranks", async () => {
        const modelId = "unordered-model";
        const scores = [
          0.90, 0.10, 0.85, 0.20, 0.75, 0.30, 0.65, 0.40, 0.55, 0.50,
          0.95, 0.05, 0.80, 0.15, 0.70, 0.25, 0.60, 0.35, 1.00, 0.45,
        ]; // Exactly 20 scores

        for (const s of scores) {
          await testStore.recordFeedbackScore(modelId, s);
        }

        const priors = await testStore.getQuantilePriors(modelId);
        // Sorted: 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50,
        //         0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00
        // kCore = 20 -> 1.00
        // kPeriph = 17 -> 0.85
        expect(priors.qHatCore05).toBeCloseTo(1.00, 5);
        expect(priors.qHatPeriph20).toBeCloseTo(0.85, 5);
      });
    });

    describe("2.4 Resilient Redis Integration & Failure Fallbacks", () => {
      beforeEach(() => {
        process.env.UPSTASH_REDIS_REST_URL = "https://mock-redis.upstash.io";
        process.env.UPSTASH_REDIS_REST_TOKEN = "mock-secret-token";
      });

      it("should gracefully handle Redis errors during score recording without crashing", async () => {
        const { getRedisClient } = await import("@/lib/redis");
        const client = getRedisClient();
        vi.spyOn(client, "rpush").mockRejectedValue(new Error("Redis connection timed out"));

        const modelId = "redis-fail-model";
        // Should not throw
        await expect(testStore.recordFeedbackScore(modelId, 0.42)).resolves.not.toThrow();
        // In-memory window must remain updated
        expect(testStore.getWindowSize(modelId)).toBe(1);
      });

      it("should gracefully handle Redis read failures during quantile retrieval", async () => {
        const { getRedisClient } = await import("@/lib/redis");
        const client = getRedisClient();
        vi.spyOn(client, "lrange").mockRejectedValue(new Error("Redis connection refused"));

        const modelId = "typesafe/jev-1.13";
        // Should fallback to static priors safely
        const priors = await testStore.getQuantilePriors(modelId);
        expect(priors.qHatCore05).toBe(0.08);
      });

      it("should hydrate in-memory window from Redis when remote scores exist", async () => {
        const { getRedisClient } = await import("@/lib/redis");
        const client = getRedisClient();
        // Mock remote scores returning 20 valid floats
        const remoteScores = Array.from({ length: 20 }, (_, i) => (i + 1) * 0.05);
        vi.spyOn(client, "lrange").mockResolvedValue(remoteScores as any);

        const modelId = "redis-hydrated-model";
        const priors = await testStore.getQuantilePriors(modelId);

        expect(testStore.getWindowSize(modelId)).toBe(20);
        expect(priors.qHatCore05).toBeCloseTo(1.00, 5);
        expect(priors.qHatPeriph20).toBeCloseTo(0.85, 5);
      });
    });
  });

  // =========================================================================
  // SECTION 3: Unified Decisions Client & Two-Tier Cascade
  // =========================================================================
  describe("3. Unified Decisions Client & Cascade Orchestration (client.ts)", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      delete process.env.JEV_API_KEY;
      delete process.env.JEV_API_URL;
      calibrationStore.resetWindow();
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      vi.restoreAllMocks();
    });

    describe("3.1 Dynamic Concept Tag Validation (Commit Gate 7 Mandate)", () => {
      it("should validate and execute batch when all concept tags are from default taxonomy", async () => {
        const batch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_1",
              topicSlug: "sys_arch",
              questionPrompt: "Select persistence engine",
              conceptTags: ["data_modeling", "schema_evolution"],
              options: [
                {
                  optionKey: "opt_postgres",
                  neutralSummary: "PostgreSQL on Neon",
                  rationaleAndPremises: "Relational integrity and JSONB support",
                },
                {
                  optionKey: "opt_sqlite",
                  neutralSummary: "Embedded SQLite",
                  rationaleAndPremises: "Local file-based lightweight storage",
                },
                {
                  optionKey: "opt_kv",
                  neutralSummary: "Key-Value store",
                  rationaleAndPremises: "Fast unstructured key value lookup",
                },
              ],
            }),
          ],
        };

        const results = await evaluateDecisionBatch(batch);
        expect(results.length).toBe(1);
        expect(results[0].decisionId).toBe("dec_1");
      });

      it("should reject batch with ZodError when an unauthorized hallucinated concept tag is provided", async () => {
        const invalidBatch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_hallucinated",
              topicSlug: "ai_hallucination",
              questionPrompt: "Test hallucinated tag rejection",
              conceptTags: ["unauthorized_invented_tag_12345" as unknown as string],
              options: [
                {
                  optionKey: "opt_1",
                  neutralSummary: "Option 1",
                  rationaleAndPremises: "Premise 1",
                },
                {
                  optionKey: "opt_2",
                  neutralSummary: "Option 2",
                  rationaleAndPremises: "Premise 2",
                },
                {
                  optionKey: "opt_3",
                  neutralSummary: "Option 3",
                  rationaleAndPremises: "Premise 3",
                },
              ],
            }),
          ],
        };

        await expect(evaluateDecisionBatch(invalidBatch)).rejects.toThrow(ZodError);
      });

      it("should enforce project-scoped custom tags when activeConceptTags option is specified", async () => {
        const customTags = ["custom_cloud_infra", "custom_event_bus"] as const;

        const customBatch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_custom",
              topicSlug: "cloud_infra",
              questionPrompt: "Custom infra question",
              conceptTags: ["custom_cloud_infra"],
              options: [
                {
                  optionKey: "opt_a",
                  neutralSummary: "Infra A",
                  rationaleAndPremises: "Premise A",
                },
                {
                  optionKey: "opt_b",
                  neutralSummary: "Infra B",
                  rationaleAndPremises: "Premise B",
                },
                {
                  optionKey: "opt_c",
                  neutralSummary: "Infra C",
                  rationaleAndPremises: "Premise C",
                },
              ],
            }),
          ],
        };

        // Allowed with custom tags
        const results = await evaluateDecisionBatch(customBatch, {
          activeConceptTags: customTags,
        });
        expect(results.length).toBe(1);

        // Standard tag should now be rejected under custom scope
        const standardBatch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_std",
              topicSlug: "sys_arch",
              questionPrompt: "Standard tag under custom scope",
              conceptTags: ["system_architecture"], // Valid generally, but not in custom scope
              options: [
                {
                  optionKey: "opt_a",
                  neutralSummary: "Option A",
                  rationaleAndPremises: "Premise A",
                },
                {
                  optionKey: "opt_b",
                  neutralSummary: "Option B",
                  rationaleAndPremises: "Premise B",
                },
                {
                  optionKey: "opt_c",
                  neutralSummary: "Option C",
                  rationaleAndPremises: "Premise C",
                },
              ],
            }),
          ],
        };

        await expect(
          evaluateDecisionBatch(standardBatch, { activeConceptTags: customTags })
        ).rejects.toThrow(ZodError);
      });

      it("should enforce options array bounds (min 3, max 4)", async () => {
        // Less than 3 options:
        const tooFewOptionsBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_few",
              topicSlug: "sys_arch",
              questionPrompt: "Only 2 options",
              conceptTags: ["system_architecture"],
              options: [
                { optionKey: "opt_1", neutralSummary: "Opt 1", rationaleAndPremises: "Premise 1" },
                { optionKey: "opt_2", neutralSummary: "Opt 2", rationaleAndPremises: "Premise 2" },
              ] as unknown as DecisionEvaluationItem["options"],
            }),
          ],
        };
        await expect(evaluateDecisionBatch(tooFewOptionsBatch as unknown as CanonicalDecisionBatch)).rejects.toThrow(ZodError);

        // More than 4 options:
        const tooManyOptionsBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_many",
              topicSlug: "sys_arch",
              questionPrompt: "5 options",
              conceptTags: ["system_architecture"],
              options: [
                { optionKey: "opt_1", neutralSummary: "Opt 1", rationaleAndPremises: "Premise 1" },
                { optionKey: "opt_2", neutralSummary: "Opt 2", rationaleAndPremises: "Premise 2" },
                { optionKey: "opt_3", neutralSummary: "Opt 3", rationaleAndPremises: "Premise 3" },
                { optionKey: "opt_4", neutralSummary: "Opt 4", rationaleAndPremises: "Premise 4" },
                { optionKey: "opt_5", neutralSummary: "Opt 5", rationaleAndPremises: "Premise 5" },
              ] as unknown as DecisionEvaluationItem["options"],
            }),
          ],
        };
        await expect(evaluateDecisionBatch(tooManyOptionsBatch as unknown as CanonicalDecisionBatch)).rejects.toThrow(ZodError);
      });
    });

    describe("3.2 Two-Tier Decision Cascade Escalation Flow", () => {
      it("should escalate ambiguous core architectural decisions from Tier 1 to Tier 2 (fastino/glide)", async () => {
        // Seed Tier 1 model with empirical quantile priors so |C_core| = 2
        for (let i = 0; i < 20; i++) {
          await calibrationStore.recordFeedbackScore(TIER1_DEFAULT_MODEL, 0.60);
        }

        // "ambiguous core multi_option cascade" triggers mock Tier 1 multi-option prediction set,
        // which triggers Tier 2 fastino/glide thinking escalation to resolve ambiguity.
        const batch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_ambiguous_core_cascade",
              topicSlug: "core_state_management_ambiguous",
              questionPrompt: "Which core architectural state engine should be selected for cascade?",
              conceptTags: ["system_architecture", "state_management"],
              options: [
                {
                  optionKey: "opt_state_a",
                  neutralSummary: "Centralized state container",
                  rationaleAndPremises: "High cohesion and strict synchronization",
                },
                {
                  optionKey: "opt_state_b",
                  neutralSummary: "Decentralized event stream",
                  rationaleAndPremises: "Loose coupling with eventual consistency",
                },
                {
                  optionKey: "opt_state_c",
                  neutralSummary: "Hybrid local cached state",
                  rationaleAndPremises: "Intermediate complexity model",
                },
              ],
            }),
          ],
        };

        const results = await evaluateDecisionBatch(batch);
        expect(results.length).toBe(1);

        const item = results[0];
        expect(item.impactTier).toBe("CORE_ARCHITECTURAL");
        expect(item.isLoadBearing).toBe(true);
        // Escalated to Tier 2 (fastino/glide mock gives p1 = 0.93 -> APPROVED_DIRECT)
        expect(item.status).toBe("APPROVED_DIRECT");
        expect(item.selectedOptionKey).toBe("opt_state_a");
      });

      it("should NOT escalate peripheral or non-ambiguous core decisions", async () => {
        const batch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_peripheral_item",
              topicSlug: "peripheral_styling",
              questionPrompt: "Peripheral styling theme conservative",
              conceptTags: ["theming_design_system"],
              options: [
                {
                  optionKey: "theme_light",
                  neutralSummary: "Light theme",
                  rationaleAndPremises: "Default clean palette",
                },
                {
                  optionKey: "theme_dark",
                  neutralSummary: "Dark theme",
                  rationaleAndPremises: "Low-light ergonomic palette",
                },
                {
                  optionKey: "theme_system",
                  neutralSummary: "System theme",
                  rationaleAndPremises: "Follows OS preference setting",
                },
              ],
            }),
          ],
        };

        // microsoft/decision-1 has registered priors qHatCore05: 0.22, qHatPeriph20: 0.42
        const results = await evaluateDecisionBatch(batch, { modelId: "microsoft/decision-1" });
        expect(results.length).toBe(1);
        expect(results[0].impactTier).toBe("PERIPHERAL");
        expect(results[0].status).toBe("APPROVED_CONSERVATIVE");
      });
    });

    describe("3.3 Relational Link Evaluation Batching (evaluateRelationalLinksBatch)", () => {
      it("should return empty array for empty pairs input", async () => {
        const results = await evaluateRelationalLinksBatch([]);
        expect(results).toEqual([]);
      });

      it("should adjudicate relational links across all 4 relation types (mock fallback)", async () => {
        const pairs: RelationalLinkPairInput[] = [
          createSampleRelationalPair({
            assumptionId: "asmp_1",
            candidateDecisionId: "dec_1",
            assumptionStatement: "We depend on the confirmed PostgreSQL transaction isolation level",
            candidatePrompt: "Select database engine",
            candidateSelectedOption: "PostgreSQL on Neon",
          }),
          createSampleRelationalPair({
            assumptionId: "asmp_2",
            candidateDecisionId: "dec_2",
            assumptionStatement: "This requirement will override and supersede previous caching baseline",
            candidatePrompt: "Select caching tier",
            candidateSelectedOption: "In-memory LRU",
          }),
          createSampleRelationalPair({
            assumptionId: "asmp_3",
            candidateDecisionId: "dec_3",
            assumptionStatement: "A refine sub-spec elaborating detailed column encryption parameters",
            candidatePrompt: "Encryption scheme",
            candidateSelectedOption: "AES-256-GCM envelope",
          }),
          createSampleRelationalPair({
            assumptionId: "asmp_4",
            candidateDecisionId: "dec_4",
            assumptionStatement: "Separate UI styling tokens unrelated to persistence layer",
            candidatePrompt: "Select database engine",
            candidateSelectedOption: "PostgreSQL on Neon",
          }),
        ];

        const adjudicated = await evaluateRelationalLinksBatch(pairs);
        expect(adjudicated.length).toBe(4);

        expect(adjudicated[0].relationType).toBe("DEPENDS_ON");
        expect(adjudicated[1].relationType).toBe("REOPENS_OR_OVERRIDES");
        expect(adjudicated[2].relationType).toBe("REFINES");
        expect(adjudicated[3].relationType).toBe("INDEPENDENT");
      });

      it("should reject malformed relational link input pairs with ZodError", async () => {
        const invalidPairs = [
          {
            assumptionId: "asmp_bad",
            // Missing candidateDecisionId, assumptionStatement, etc.
          },
        ] as unknown as RelationalLinkPairInput[];

        await expect(evaluateRelationalLinksBatch(invalidPairs)).rejects.toThrow(ZodError);
      });
    });

    describe("3.4 Remote API Communication, Timeouts & Error Handling", () => {
      it("should send correct HTTP headers and payload format when JEV_API_KEY is configured", async () => {
        process.env.JEV_API_KEY = "test-fastino-api-key";
        process.env.JEV_API_URL = "https://mock.fastino.ai/v1";

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              decisions: [
                {
                  decisionId: "dec_remote_1",
                  evidenceGrounding: 0.95,
                  couplingLevel: 0.8,
                  rollbackCost: 0.6,
                  probabilities: {
                    opt_1: 0.95,
                    opt_2: 0.04,
                    opt_3: 0.00,
                    insufficient_evidence: 0.01,
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );

        const batch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_remote_1",
              topicSlug: "remote_test_topic",
              questionPrompt: "Test remote prompt",
              conceptTags: ["system_architecture"],
              options: [
                { optionKey: "opt_1", neutralSummary: "Opt 1", rationaleAndPremises: "Rationale 1" },
                { optionKey: "opt_2", neutralSummary: "Opt 2", rationaleAndPremises: "Rationale 2" },
                { optionKey: "opt_3", neutralSummary: "Opt 3", rationaleAndPremises: "Rationale 3" },
              ],
            }),
          ],
        };

        const results = await evaluateDecisionBatch(batch);
        expect(results.length).toBe(1);
        expect(results[0].status).toBe("APPROVED_DIRECT");

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, requestInit] = fetchSpy.mock.calls[0];
        expect(url).toBe("https://mock.fastino.ai/v1/decisions");
        expect((requestInit?.headers as Record<string, string>)?.Authorization).toBe(
          "Bearer test-fastino-api-key"
        );
      });

      it("should throw JevApiError with status code when remote HTTP request fails", async () => {
        process.env.JEV_API_KEY = "test-fastino-api-key";

        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            statusText: "Unauthorized",
          })
        );

        const batch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_fail",
              topicSlug: "topic_fail",
              questionPrompt: "Prompt fail",
              conceptTags: ["system_architecture"],
              options: [
                { optionKey: "opt_1", neutralSummary: "Opt 1", rationaleAndPremises: "Rationale 1" },
                { optionKey: "opt_2", neutralSummary: "Opt 2", rationaleAndPremises: "Rationale 2" },
                { optionKey: "opt_3", neutralSummary: "Opt 3", rationaleAndPremises: "Rationale 3" },
              ],
            }),
          ],
        };

        await expect(evaluateDecisionBatch(batch)).rejects.toThrow(JevApiError);
      });

      it("should abort request when caller AbortSignal is pre-aborted", async () => {
        process.env.JEV_API_KEY = "test-fastino-api-key";

        const controller = new AbortController();
        controller.abort(new Error("Caller cancelled"));

        const batch: CanonicalDecisionBatch = {
          items: [
            createSampleBatchItem({
              decisionId: "dec_aborted",
              topicSlug: "topic_aborted",
              questionPrompt: "Prompt aborted",
              conceptTags: ["system_architecture"],
              options: [
                { optionKey: "opt_1", neutralSummary: "Opt 1", rationaleAndPremises: "Rationale 1" },
                { optionKey: "opt_2", neutralSummary: "Opt 2", rationaleAndPremises: "Rationale 2" },
                { optionKey: "opt_3", neutralSummary: "Opt 3", rationaleAndPremises: "Rationale 3" },
              ],
            }),
          ],
        };

        await expect(
          evaluateDecisionBatch(batch, { abortSignal: controller.signal })
        ).rejects.toThrow();
      });
    });
  });
});
