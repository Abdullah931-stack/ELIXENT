/**
 * Unified /v1/decisions Client & Conformal APS Orchestrator
 *
 * Implements the client for POST /v1/decisions, evaluating the four orthogonal dimensions
 * in parallel (evidence_grounding, coupling_level, rollback_cost, probabilities), executing
 * the Two-Tier Decision Cascade (Tier 1 fast pass -> Tier 2 thinking escalation for ambiguous
 * core architectural decisions), and providing batched relational link evaluation.
 *
 * Configuration:
 * - Base URL: process.env.JEV_API_URL ?? "https://api.fastino.ai/v1"
 * - API Key: process.env.JEV_API_KEY (deterministic fallback mock generator when unconfigured)
 * - Request timeout: 30,000ms
 */

import {
  createCanonicalDecisionBatchSchema,
  RelationalLinkPairInput,
  RelationalLinkPairInputSchema,
  RelationalAdjudicationItem,
  RelationalAdjudicationBatchSchema,
  CanonicalDecisionBatch,
  DecisionEvaluationItem,
} from "@/core/agent/schemas/decision-schemas";

import { calibrationStore } from "./calibration-store";
import {
  classifyDecisionConformalAPS,
  ConformalClassificationResult,
  DecisionItemEvaluationInput,
} from "./conformal-classifier";

export const DEFAULT_JEV_API_URL = "https://api.fastino.ai/v1";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const TIER1_DEFAULT_MODEL = "typesafe/jev-1.13";
export const TIER2_THINKING_MODEL = "fastino/glide";

export class JevApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown
  ) {
    super(message);
    this.name = "JevApiError";
  }
}

/**
 * Creates a combined AbortSignal merging the specified timeout and an optional caller signal.
 */
function createCombinedSignal(
  timeoutMs: number,
  userSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`JEV API request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let abortHandler: (() => void) | undefined;
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort(userSignal.reason);
    } else {
      abortHandler = () => controller.abort(userSignal.reason);
      userSignal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (userSignal && abortHandler) {
      userSignal.removeEventListener("abort", abortHandler);
    }
  };

  return { signal: controller.signal, cleanup };
}

/**
 * Internal helper to query POST /v1/decisions or invoke the mock generator if unconfigured.
 */
async function queryJevDecisionsApi(
  items: DecisionEvaluationItem[],
  modelId: string,
  userSignal?: AbortSignal
): Promise<DecisionItemEvaluationInput[]> {
  const apiKey = process.env.JEV_API_KEY;

  // Fallback deterministic mock generator for dev/test when JEV_API_KEY is not configured
  if (!apiKey) {
    return items.map((item) => generateMockEvaluation(item, modelId));
  }

  const baseUrl = process.env.JEV_API_URL ?? DEFAULT_JEV_API_URL;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/decisions`;
  const { signal, cleanup } = createCombinedSignal(DEFAULT_REQUEST_TIMEOUT_MS, userSignal);

  try {
    const payload = {
      model: modelId,
      items: items.map((item) => ({
        decisionId: item.decisionId,
        topicSlug: item.topicSlug,
        questionPrompt: item.questionPrompt,
        conceptTags: item.conceptTags,
        options: [
          ...item.options,
          {
            optionKey: "insufficient_evidence",
            neutralSummary: "Insufficient evidence or grounding to make a decision",
            rationaleAndPremises:
              "The available evidence does not support a definitive conclusion",
          },
        ],
        dependsOnDecisionIds: item.dependsOnDecisionIds ?? [],
        affectedSections: item.affectedSections ?? [],
        priorDecisionContext: item.priorDecisionContext,
      })),
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new JevApiError(
        `JEV API request failed with HTTP ${response.status}: ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    const json = await response.json();
    const rawItems: Array<{
      decisionId: string;
      evidenceGrounding?: number;
      evidence_grounding?: number;
      couplingLevel?: number;
      coupling_level?: number;
      rollbackCost?: number;
      rollback_cost?: number;
      probabilities?: Record<string, number>;
      selected_option?: Record<string, number>;
    }> = Array.isArray(json)
      ? json
      : Array.isArray(json.decisions)
      ? json.decisions
      : Array.isArray(json.items)
      ? json.items
      : [];

    return items.map((origItem) => {
      const match = rawItems.find((r) => r.decisionId === origItem.decisionId);
      const evidenceGrounding =
        match?.evidenceGrounding ?? match?.evidence_grounding ?? 0.8;
      const couplingLevel = match?.couplingLevel ?? match?.coupling_level ?? 0.5;
      const rollbackCost = match?.rollbackCost ?? match?.rollback_cost ?? 0.5;
      const probabilities =
        match?.probabilities ?? match?.selected_option ?? {};

      return {
        decisionId: origItem.decisionId,
        topicSlug: origItem.topicSlug,
        questionPrompt: origItem.questionPrompt,
        conceptTags: [...origItem.conceptTags],
        evidenceGrounding,
        couplingLevel,
        rollbackCost,
        probabilities,
        options: origItem.options,
        dependsOnDecisionIds: origItem.dependsOnDecisionIds,
        affectedSections: origItem.affectedSections,
      };
    });
  } finally {
    cleanup();
  }
}

/**
 * Deterministic mock generator for local tests and environments without external API keys.
 */
function generateMockEvaluation(
  item: DecisionEvaluationItem,
  modelId: string
): DecisionItemEvaluationInput {
  const isEscalatedTier2 = modelId === TIER2_THINKING_MODEL;
  const text = `${item.decisionId} ${item.questionPrompt} ${item.topicSlug}`.toLowerCase();

  // 1. Abstention test cases
  if (
    text.includes("insufficient_evidence") ||
    text.includes("abstain") ||
    text.includes("low_grounding")
  ) {
    const opts = item.options;
    return {
      decisionId: item.decisionId,
      topicSlug: item.topicSlug,
      questionPrompt: item.questionPrompt,
      conceptTags: [...item.conceptTags],
      evidenceGrounding: 0.35,
      couplingLevel: 0.8,
      rollbackCost: 0.8,
      probabilities: {
        insufficient_evidence: 0.4,
        [opts[0].optionKey]: 0.35,
        [opts[1].optionKey]: 0.25,
      },
      options: item.options,
      dependsOnDecisionIds: item.dependsOnDecisionIds,
      affectedSections: item.affectedSections,
    };
  }

  // 2. High coupling / rollback cost -> CORE_ARCHITECTURAL
  const isCore =
    text.includes("core") ||
    text.includes("architectural") ||
    text.includes("high_coupling") ||
    item.conceptTags.some((t) => t.includes("architecture") || t.includes("module"));

  const couplingLevel = isCore ? 1.8 : 0.6;
  const rollbackCost = isCore ? 1.7 : 0.4;
  const evidenceGrounding = 0.95;

  // 3. Ambiguous / multi-option core test case
  if (
    isCore &&
    (text.includes("ambiguous") ||
      text.includes("multi_option") ||
      text.includes("cascade"))
  ) {
    if (!isEscalatedTier2) {
      // Tier 1 produces multi-option core prediction set
      const p1 = 0.5;
      const p2 = 0.48;
      const p3 = Math.max(0, 1 - p1 - p2 - 0.01);
      return {
        decisionId: item.decisionId,
        topicSlug: item.topicSlug,
        questionPrompt: item.questionPrompt,
        conceptTags: [...item.conceptTags],
        evidenceGrounding,
        couplingLevel,
        rollbackCost,
        probabilities: {
          [item.options[0].optionKey]: p1,
          [item.options[1].optionKey]: p2,
          ...(item.options[2] ? { [item.options[2].optionKey]: p3 } : {}),
          insufficient_evidence: 0.01,
        },
        options: item.options,
        dependsOnDecisionIds: item.dependsOnDecisionIds,
        affectedSections: item.affectedSections,
      };
    } else {
      // Tier 2 thinking model resolves ambiguity with high probability dominance
      return {
        decisionId: item.decisionId,
        topicSlug: item.topicSlug,
        questionPrompt: item.questionPrompt,
        conceptTags: [...item.conceptTags],
        evidenceGrounding,
        couplingLevel,
        rollbackCost,
        probabilities: {
          [item.options[0].optionKey]: 0.93,
          [item.options[1].optionKey]: 0.05,
          ...(item.options[2] ? { [item.options[2].optionKey]: 0.01 } : {}),
          insufficient_evidence: 0.01,
        },
        options: item.options,
        dependsOnDecisionIds: item.dependsOnDecisionIds,
        affectedSections: item.affectedSections,
      };
    }
  }

  // 4. Peripheral conservative test case
  if (text.includes("peripheral") || text.includes("conservative")) {
    return {
      decisionId: item.decisionId,
      topicSlug: item.topicSlug,
      questionPrompt: item.questionPrompt,
      conceptTags: [...item.conceptTags],
      evidenceGrounding: 0.85,
      couplingLevel: 0.4,
      rollbackCost: 0.3,
      probabilities: {
        [item.options[0].optionKey]: 0.65,
        [item.options[1].optionKey]: 0.28,
        ...(item.options[2] ? { [item.options[2].optionKey]: 0.05 } : {}),
        insufficient_evidence: 0.02,
      },
      options: item.options,
      dependsOnDecisionIds: item.dependsOnDecisionIds,
      affectedSections: item.affectedSections,
    };
  }

  // 5. Default clear win
  return {
    decisionId: item.decisionId,
    topicSlug: item.topicSlug,
    questionPrompt: item.questionPrompt,
    conceptTags: [...item.conceptTags],
    evidenceGrounding: 0.96,
    couplingLevel: isCore ? 1.6 : 0.6,
    rollbackCost: isCore ? 1.6 : 0.4,
    probabilities: {
      [item.options[0].optionKey]: 0.94,
      [item.options[1].optionKey]: 0.04,
      ...(item.options[2] ? { [item.options[2].optionKey]: 0.01 } : {}),
      insufficient_evidence: 0.01,
    },
    options: item.options,
    dependsOnDecisionIds: item.dependsOnDecisionIds,
    affectedSections: item.affectedSections,
  };
}

/**
 * Evaluates a batch of canonical decisions through the Two-Tier Conformal APS Pipeline.
 *
 * Execution Steps:
 * 1. Validates batch input schema against active concept tags.
 * 2. Runs Tier 1 pass (typesafe/jev-1.13 or microsoft/decision-1).
 * 3. Classifies with classifyDecisionConformalAPS and CalibrationStore priors.
 * 4. Two-Tier Cascade Escalation: If any item is CORE_ARCHITECTURAL with |C_{alpha_core}| > 1,
 *    escalates to Tier 2 thinking model (fastino/glide), re-classifies, and updates results.
 */
export async function evaluateDecisionBatch(
  batch: CanonicalDecisionBatch,
  options?: {
    modelId?: string;
    activeConceptTags?: readonly string[];
    abortSignal?: AbortSignal;
  }
): Promise<ConformalClassificationResult[]> {
  // Validate batch schema
  const schema = createCanonicalDecisionBatchSchema(options?.activeConceptTags);
  const validatedBatch = schema.parse(batch);

  // Tier 1 model evaluation
  const tier1ModelId = options?.modelId ?? TIER1_DEFAULT_MODEL;
  const tier1Evaluations = await queryJevDecisionsApi(
    validatedBatch.items,
    tier1ModelId,
    options?.abortSignal
  );

  const tier1Priors = await calibrationStore.getQuantilePriors(tier1ModelId);
  const results: ConformalClassificationResult[] = tier1Evaluations.map((evalInput) =>
    classifyDecisionConformalAPS(evalInput, tier1Priors)
  );

  // Two-Tier Cascade Escalation:
  // If impactTier == "CORE_ARCHITECTURAL" && |C_{alpha_core}| > 1, escalate to Tier 2 thinking model
  const escalationItems: DecisionEvaluationItem[] = [];
  const escalationIndices: number[] = [];

  for (let i = 0; i < validatedBatch.items.length; i++) {
    const item = validatedBatch.items[i];
    const initialResult = results[i];

    if (
      initialResult.impactTier === "CORE_ARCHITECTURAL" &&
      initialResult.predictionSetCore.length > 1
    ) {
      escalationItems.push(item);
      escalationIndices.push(i);
    }
  }

  if (escalationItems.length > 0) {
    const tier2ModelId = TIER2_THINKING_MODEL;
    const tier2Evaluations = await queryJevDecisionsApi(
      escalationItems,
      tier2ModelId,
      options?.abortSignal
    );
    const tier2Priors = await calibrationStore.getQuantilePriors(tier2ModelId);

    for (let k = 0; k < escalationItems.length; k++) {
      const origIndex = escalationIndices[k];
      const escalatedEval = tier2Evaluations[k];
      const escalatedResult = classifyDecisionConformalAPS(escalatedEval, tier2Priors);
      results[origIndex] = escalatedResult;
    }
  }

  return results;
}

/**
 * Evaluates relational links between new assumptions and prior decisions.
 * Classifies relations into: INDEPENDENT | DEPENDS_ON | REOPENS_OR_OVERRIDES | REFINES.
 */
export async function evaluateRelationalLinksBatch(
  pairs: RelationalLinkPairInput[],
  options?: { abortSignal?: AbortSignal }
): Promise<RelationalAdjudicationItem[]> {
  if (pairs.length === 0) {
    return [];
  }

  // Validate input pairs
  const validatedPairs = pairs.map((p) => RelationalLinkPairInputSchema.parse(p));
  const apiKey = process.env.JEV_API_KEY;

  // Fallback mock generator when API key is unconfigured
  if (!apiKey) {
    const relations: RelationalAdjudicationItem[] = validatedPairs.map((pair) => {
      const text = `${pair.assumptionStatement} ${pair.candidatePrompt} ${pair.candidateSelectedOption}`.toLowerCase();
      let relationType: RelationalAdjudicationItem["relationType"] = "INDEPENDENT";
      let justification =
        "Evaluated as independent concerns with distinct architectural boundaries.";

      if (
        text.includes("override") ||
        text.includes("reopen") ||
        text.includes("supersede") ||
        text.includes("invalidat")
      ) {
        relationType = "REOPENS_OR_OVERRIDES";
        justification =
          "Direct premise invalidation or priority shift overrides prior decision.";
      } else if (
        text.includes("depend") ||
        text.includes("require") ||
        text.includes("builds on")
      ) {
        relationType = "DEPENDS_ON";
        justification =
          "Logical dependency requires confirmed baseline from candidate decision.";
      } else if (
        text.includes("refine") ||
        text.includes("sub-spec") ||
        text.includes("elaborate")
      ) {
        relationType = "REFINES";
        justification =
          "Compatible sub-specification elaborating detailed parameters.";
      }

      return {
        assumptionId: pair.assumptionId,
        targetDecisionId: pair.candidateDecisionId,
        relationType,
        confidence: 0.95,
        justification,
      };
    });

    const validatedBatch = RelationalAdjudicationBatchSchema.parse({ relations });
    return validatedBatch.relations;
  }

  const baseUrl = process.env.JEV_API_URL ?? DEFAULT_JEV_API_URL;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/relational-adjudication`;
  const { signal, cleanup } = createCombinedSignal(DEFAULT_REQUEST_TIMEOUT_MS, options?.abortSignal);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ pairs: validatedPairs }),
      signal,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new JevApiError(
        `JEV relational adjudication failed with HTTP ${response.status}: ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    const data = await response.json();
    const validated = RelationalAdjudicationBatchSchema.parse(data);
    return validated.relations;
  } finally {
    cleanup();
  }
}
