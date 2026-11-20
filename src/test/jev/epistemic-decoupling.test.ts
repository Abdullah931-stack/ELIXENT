/**
 * Test Suite: Epistemic Framing Decoupling — NeutralOptionSchema, Grounded JEV Batch & Post-Adjudication Rationales (Wave 3.1)
 *
 * Verifies ADR-013 & SRS-01 §4.3 contracts across:
 * - `src/core/agent/schemas/decision-schemas.ts` (`NeutralOptionSchema`, `AssumptionIntentTypeEnum`, optional `rationaleAndPremises`)
 * - `src/lib/jev/conformal-classifier.ts` (neutral option scoring without pre-scoring `rationaleAndPremises`)
 * - `src/lib/jev/client.ts` (`evaluateDecisionBatch` with `workspaceEvidence` & `governingPriorDecisions`,
 *   HTTP payload transmission, and `synthesizePostAdjudicationRationales`)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ZodError } from "zod";
import {
  NeutralOptionSchema,
  AssumptionItemSchema,
  CanonicalDecisionBatchSchema,
  type NeutralDecisionOptionInput,
} from "@/core/agent/schemas/decision-schemas";
import {
  classifyDecisionConformalAPS,
  type DecisionItemEvaluationInput,
} from "@/lib/jev/conformal-classifier";
import {
  evaluateDecisionBatch,
  synthesizePostAdjudicationRationales,
  type GroundedDecisionEvaluationRequestItem,
} from "@/lib/jev/client";
import { calibrationStore } from "@/lib/jev/calibration-store";

function createNeutralOptions(): NeutralDecisionOptionInput[] {
  return [
    {
      optionKey: "postgres_neon",
      neutralSummary: "Serverless PostgreSQL hosted on Neon with branch isolation",
      technicalConstraints: ["Requires SQL schema migrations", "ACID transactions"],
    },
    {
      optionKey: "sqlite_local",
      neutralSummary: "Single-file embedded SQLite database stored on disk",
      technicalConstraints: ["Single-writer concurrency limit"],
    },
    {
      optionKey: "upstash_kv",
      neutralSummary: "HTTP key-value store backed by Redis protocol",
      technicalConstraints: ["No relational joins", "Eventual multi-region consistency"],
    },
  ];
}

function createGroundedItem(
  overrides: Partial<GroundedDecisionEvaluationRequestItem> = {},
): GroundedDecisionEvaluationRequestItem {
  return {
    decisionId: "dec_storage_01",
    topicSlug: "primary_storage_engine",
    questionPrompt: "Select primary persistence store for workspace checkpoints",
    conceptTags: ["data_modeling", "system_architecture"],
    options: createNeutralOptions(),
    workspaceEvidence: [
      {
        fileId: "doc-arch",
        headingSlug: "storage-layer",
        excerpt: "System requires atomic multi-row transactions and JSONB indexing.",
      },
      {
        fileId: "doc-arch",
        headingSlug: "storage-layer",
        excerpt: "Duplicate section pointer should be deduplicated in citations.",
      },
    ],
    governingPriorDecisions: [
      {
        decisionId: "dec_zk_01",
        topicSlug: "zk_encryption",
        selectedOptionKey: "aes_256_gcm",
        selectionRationale: "Client-side AES-256-GCM encryption",
        isLoadBearing: true,
        changeWeightTotal: 85,
      },
    ],
    dependsOnDecisionIds: ["dec_zk_01"],
    affectedSections: [{ fileId: "doc-arch", headingSlug: "storage-layer" }],
    ...overrides,
  };
}

describe("1. NeutralOptionSchema & AssumptionIntentTypeEnum (decision-schemas.ts)", () => {
  it("validates neutral options with zero rationaleAndPremises and accepts them in CanonicalDecisionBatchSchema", () => {
    const neutralOpts = createNeutralOptions();
    for (const opt of neutralOpts) {
      const parsed = NeutralOptionSchema.parse(opt);
      expect(parsed).toEqual(opt);
      expect("rationaleAndPremises" in parsed).toBe(false);
    }

    const batch = CanonicalDecisionBatchSchema.parse({
      items: [
        {
          decisionId: "dec_neutral_1",
          topicSlug: "storage_engine",
          questionPrompt: "Choose storage engine",
          conceptTags: ["data_modeling"],
          options: neutralOpts,
        },
      ],
    });
    expect(batch.items[0].options[0].rationaleAndPremises).toBeUndefined();
    expect(batch.items[0].options[0].technicalConstraints).toEqual([
      "Requires SQL schema migrations",
      "ACID transactions",
    ]);
  });

  it.each([
    {
      name: "uppercase optionKey",
      candidate: {
        optionKey: "Postgres_Neon",
        neutralSummary: "Valid summary length",
        technicalConstraints: ["One constraint"],
      },
    },
    {
      name: "neutralSummary shorter than 5 chars",
      candidate: {
        optionKey: "opt_a",
        neutralSummary: "tiny",
        technicalConstraints: ["One constraint"],
      },
    },
    {
      name: "neutralSummary exceeding 220 chars",
      candidate: {
        optionKey: "opt_a",
        neutralSummary: "x".repeat(221),
        technicalConstraints: ["One constraint"],
      },
    },
    {
      name: "empty technicalConstraints array (min 1)",
      candidate: {
        optionKey: "opt_a",
        neutralSummary: "Valid neutral summary",
        technicalConstraints: [],
      },
    },
    {
      name: "more than 4 technicalConstraints (max 4)",
      candidate: {
        optionKey: "opt_a",
        neutralSummary: "Valid neutral summary",
        technicalConstraints: ["c1", "c2", "c3", "c4", "c5"],
      },
    },
  ])("rejects invalid NeutralOptionSchema candidate with $name", ({ candidate }) => {
    expect(() => NeutralOptionSchema.parse(candidate)).toThrow(ZodError);
  });

  it("defaults AssumptionItemSchema.intentType to INFERRED_COLLATERAL_ASSUMPTION and accepts DIRECT_USER_INSTRUCTION", () => {
    const defaulted = AssumptionItemSchema.parse({
      assumptionId: "asm-1",
      statement: "Adopt serverless Postgres",
      conceptTags: ["data_modeling"],
    });
    expect(defaulted.intentType).toBe("INFERRED_COLLATERAL_ASSUMPTION");

    const explicit = AssumptionItemSchema.parse({
      assumptionId: "asm-2",
      statement: "User explicitly requested switching to SQLite",
      intentType: "DIRECT_USER_INSTRUCTION",
      conceptTags: ["data_modeling"],
    });
    expect(explicit.intentType).toBe("DIRECT_USER_INSTRUCTION");
  });
});

describe("2. Conformal APS Classifier with Neutral Options (conformal-classifier.ts)", () => {
  it("classifies neutral options without pre-scoring rationaleAndPremises and preserves technicalConstraints", () => {
    const input: DecisionItemEvaluationInput = {
      decisionId: "dec_neutral_aps",
      topicSlug: "storage_engine",
      questionPrompt: "Select database",
      conceptTags: ["data_modeling"],
      evidenceGrounding: 0.92,
      couplingLevel: 1.7,
      rollbackCost: 1.6,
      probabilities: {
        postgres_neon: 0.91,
        sqlite_local: 0.06,
        upstash_kv: 0.02,
        insufficient_evidence: 0.01,
      },
      options: createNeutralOptions(),
    };

    const result = classifyDecisionConformalAPS(input, {
      qHatCore05: 0.12,
      qHatPeriph20: 0.3,
    });

    expect(result.status).toBe("APPROVED_DIRECT");
    expect(result.selectedOptionKey).toBe("postgres_neon");
    expect(result.selectionRationale).toContain("Requires SQL schema migrations");
    expect(result.evaluatedAlternatives[0].technicalConstraints).toEqual([
      "Requires SQL schema migrations",
      "ACID transactions",
    ]);
  });
});

describe("3. Post-Adjudication Rationale Synthesis & Grounded evaluateDecisionBatch (jev/client.ts)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_API_URL;
    calibrationStore.resetWindow();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("synthesizePostAdjudicationRationales cites winning option, technicalConstraints, deduplicated workspaceEvidence, prior decisions, and conformal metrics", () => {
    const item = createGroundedItem();
    const rawClassification = classifyDecisionConformalAPS(
      {
        decisionId: item.decisionId,
        topicSlug: item.topicSlug,
        questionPrompt: item.questionPrompt,
        conceptTags: item.conceptTags,
        evidenceGrounding: 0.94,
        couplingLevel: 1.6,
        rollbackCost: 1.6,
        probabilities: {
          postgres_neon: 0.92,
          sqlite_local: 0.05,
          upstash_kv: 0.02,
          insufficient_evidence: 0.01,
        },
        options: item.options,
      },
      { qHatCore05: 0.12, qHatPeriph20: 0.28 },
    );

    const synthesized = synthesizePostAdjudicationRationales(
      rawClassification,
      item,
    );

    expect(synthesized.selectionRationale).toContain('Selected "postgres_neon"');
    expect(synthesized.selectionRationale).toContain(
      "Serverless PostgreSQL hosted on Neon",
    );
    expect(synthesized.selectionRationale).toContain(
      "Technical constraints: Requires SQL schema migrations; ACID transactions.",
    );
    // Duplicate evidence section must appear exactly once
    expect(synthesized.selectionRationale).toContain(
      "Evidence: [doc-arch#storage-layer].",
    );
    expect(synthesized.selectionRationale).toContain(
      "Prior governing decisions: [dec_zk_01].",
    );
    expect(synthesized.selectionRationale).toContain(
      "Conformal APS (APPROVED_DIRECT, margin=",
    );

    const winnerAlt = synthesized.evaluatedAlternatives.find(
      (a) => a.optionKey === "postgres_neon",
    );
    const loserAlt = synthesized.evaluatedAlternatives.find(
      (a) => a.optionKey === "sqlite_local",
    );
    expect(winnerAlt?.rationaleAndPremises).toContain("(selected)");
    expect(loserAlt?.rationaleAndPremises).toContain("(alternative)");
  });

  it("synthesizePostAdjudicationRationales falls back to affectedSections and preserves UNRESOLVED state without fabricating a winner", () => {
    const item = createGroundedItem({
      workspaceEvidence: [],
      governingPriorDecisions: [],
      affectedSections: [{ fileId: "doc-fallback", headingSlug: "db-section" }],
    });

    const unresolved = classifyDecisionConformalAPS(
      {
        decisionId: item.decisionId,
        topicSlug: item.topicSlug,
        questionPrompt: item.questionPrompt,
        conceptTags: item.conceptTags,
        evidenceGrounding: 0.3,
        couplingLevel: 1.6,
        rollbackCost: 1.6,
        probabilities: {
          postgres_neon: 0.35,
          sqlite_local: 0.25,
          upstash_kv: 0.1,
          insufficient_evidence: 0.3,
        },
        options: item.options,
      },
      { qHatCore05: 0.12, qHatPeriph20: 0.28 },
    );

    const synthesized = synthesizePostAdjudicationRationales(unresolved, item);
    expect(synthesized.status).toBe("UNRESOLVED");
    expect(synthesized.selectedOptionKey).toBeNull();
    expect(synthesized.selectionRationale).not.toContain("Selected ");
    expect(synthesized.selectionRationale).toContain(
      "Evidence: [doc-fallback#db-section].",
    );
    expect(synthesized.selectionRationale).toContain("Conformal APS (UNRESOLVED");
  });

  it("evaluateDecisionBatch propagates batch-level workspaceEvidence & governingPriorDecisions and automatically synthesizes post-adjudication rationales", async () => {
    const neutralItem: GroundedDecisionEvaluationRequestItem = {
      decisionId: "dec_batch_neutral",
      topicSlug: "storage_choice",
      questionPrompt: "Choose persistence store",
      conceptTags: ["data_modeling"],
      options: createNeutralOptions(),
    };

    const results = await evaluateDecisionBatch(
      { items: [neutralItem] },
      {
        workspaceEvidence: [
          {
            fileId: "doc-batch",
            headingSlug: "persistence",
            excerpt: "Must support atomic ACID updates",
          },
        ],
        governingPriorDecisions: [
          {
            decisionId: "dec_parent_99",
            topicSlug: "acid_guarantees",
            selectedOptionKey: "strict_serializable",
            selectionRationale: "Atomic ledger writes",
            isLoadBearing: true,
            changeWeightTotal: 75,
          },
        ],
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("APPROVED_DIRECT");
    expect(results[0].selectionRationale).toContain(
      "Evidence: [doc-batch#persistence].",
    );
    expect(results[0].selectionRationale).toContain(
      "Prior governing decisions: [dec_parent_99].",
    );
  });

  it("evaluateDecisionBatch transmits workspaceEvidence and governingPriorDecisions over POST /v1/decisions when JEV_API_KEY is set", async () => {
    process.env.JEV_API_KEY = "test-jev-api-key";
    process.env.JEV_API_URL = "https://jev.example.test/v1";

    const capturedBodies: Array<{ items: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBodies.push(
          JSON.parse(String(init?.body ?? "{}")) as {
            items: Array<Record<string, unknown>>;
          },
        );
        return new Response(
          JSON.stringify({
            decisions: [
              {
                decisionId: "dec_storage_01",
                evidenceGrounding: 0.95,
                couplingLevel: 1.7,
                rollbackCost: 1.6,
                probabilities: {
                  postgres_neon: 0.93,
                  sqlite_local: 0.04,
                  upstash_kv: 0.02,
                  insufficient_evidence: 0.01,
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const item = createGroundedItem();
    const results = await evaluateDecisionBatch({ items: [item] });

    expect(capturedBodies).toHaveLength(1);
    const sentItems = capturedBodies[0].items;
    expect(sentItems).toHaveLength(1);
    expect(sentItems[0].workspaceEvidence).toEqual(item.workspaceEvidence);
    expect(sentItems[0].governingPriorDecisions).toEqual(
      item.governingPriorDecisions,
    );
    // Neutral options + synthetic insufficient_evidence abstention option
    const sentOptions = sentItems[0].options as Array<{ optionKey: string }>;
    expect(sentOptions.map((o) => o.optionKey)).toContain(
      "insufficient_evidence",
    );

    expect(results[0].status).toBe("APPROVED_DIRECT");
    expect(results[0].selectedOptionKey).toBe("postgres_neon");
    expect(results[0].selectionRationale).toContain(
      "Evidence: [doc-arch#storage-layer].",
    );
  });
});
