/**
 * Conformal Adaptive Prediction Sets (Conformal APS) Classifier
 *
 * Implements the 5-step deterministic mathematical algorithm (zero LLM involvement)
 * governing architectural decision classification:
 *
 * 1. Abstention Gate & Probability Normalization:
 *    Isolates p_abstain = p("insufficient_evidence").
 *    Rejects if p_abstain >= 0.25 or evidenceGrounding < 0.50 -> UNRESOLVED.
 *    Normalizes valid option probabilities: \tilde{p}(a_k) = p(a_k) / (1 - p_abstain).
 * 2. Structural Impact Index:
 *    ImpactIndex(x) = CORE_ARCHITECTURAL if couplingLevel >= 1.5 || rollbackCost >= 1.5 else PERIPHERAL.
 * 3. Top-2 Probability Dominance Margin:
 *    m(x) = \tilde{p}_{(1)} - \tilde{p}_{(2)}.
 * 4. Conformal Prediction Set:
 *    Nonconformity score s(x, a_k) = 1 - \tilde{p}(a_k).
 *    C_{alpha_core}(x) = { a_k : s(x, a_k) <= qHatCore05 }.
 *    C_{alpha_periph}(x) = { a_k : s(x, a_k) <= qHatPeriph20 }.
 * 5. Deterministic Classification Rules:
 *    - APPROVED_DIRECT: |C_{alpha_core}| == 1 && m(x) >= 0.25 (isLoadBearing: true).
 *    - APPROVED_CONSERVATIVE: impactTier == "PERIPHERAL" && 1 <= |C_{alpha_periph}| <= 2 && m(x) >= 0.15 (isLoadBearing: false).
 *      STRICT INVARIANT: Prohibited if impactTier == "CORE_ARCHITECTURAL"!
 *    - UNRESOLVED: All other cases.
 */

export interface EvaluatedAlternativeRecord {
  optionKey: string;
  neutralSummary: string;
  rationaleAndPremises: string;
  normalizedProbability?: number;
}

export interface DecisionItemEvaluationInput {
  decisionId: string;
  topicSlug: string;
  questionPrompt: string;
  conceptTags: string[];
  evidenceGrounding: number; // [0, 1]
  couplingLevel: number; // [0, 2]
  rollbackCost: number; // [0, 2]
  probabilities: Record<string, number>; // optionKey -> probability, including "insufficient_evidence"
  options: Array<{
    optionKey: string;
    neutralSummary: string;
    rationaleAndPremises: string;
  }>;
  dependsOnDecisionIds?: string[];
  affectedSections?: Array<{ fileId: string; headingSlug: string }>;
}

export interface ConformalClassificationResult {
  decisionId: string;
  topicSlug: string;
  questionPrompt: string;
  conceptTags: string[];
  status: "APPROVED_DIRECT" | "APPROVED_CONSERVATIVE" | "UNRESOLVED";
  impactTier: "CORE_ARCHITECTURAL" | "PERIPHERAL";
  isLoadBearing: boolean;
  selectedOptionKey: string | null;
  selectionRationale: string;
  runnerUpOptionKey: string | null;
  evaluatedAlternatives: EvaluatedAlternativeRecord[];
  predictionSetCore: string[];
  predictionSetPeriph: string[];
  dominanceMargin: number;
  evidenceGrounding: number;
  reason?: string;
}

const EPSILON = 1e-9;
const ABSTENTION_KEY = "insufficient_evidence";
const TAU_ABSTAIN = 0.25;
const MIN_EVIDENCE_GROUNDING = 0.5;
const DIRECT_APPROVAL_MARGIN = 0.25;
const CONSERVATIVE_APPROVAL_MARGIN = 0.15;

/**
 * Classifies a decision item deterministically using Conformal Adaptive Prediction Sets (APS).
 */
export function classifyDecisionConformalAPS(
  input: DecisionItemEvaluationInput,
  priors: { qHatCore05: number; qHatPeriph20: number }
): ConformalClassificationResult {
  // Step 2 (Structural Impact Index) evaluated early to tag all outcome paths
  const isCore = input.couplingLevel >= 1.5 || input.rollbackCost >= 1.5;
  const impactTier: "CORE_ARCHITECTURAL" | "PERIPHERAL" = isCore
    ? "CORE_ARCHITECTURAL"
    : "PERIPHERAL";
  const isLoadBearing = impactTier === "CORE_ARCHITECTURAL";

  // Step 1: Abstention Gate & Normalization
  const pAbstain = input.probabilities[ABSTENTION_KEY] ?? 0;
  const denom = 1 - pAbstain;

  if (pAbstain >= TAU_ABSTAIN || input.evidenceGrounding < MIN_EVIDENCE_GROUNDING || denom <= 1e-6) {
    const evaluatedAlternatives: EvaluatedAlternativeRecord[] = input.options.map((opt) => ({
      optionKey: opt.optionKey,
      neutralSummary: opt.neutralSummary,
      rationaleAndPremises: opt.rationaleAndPremises,
      normalizedProbability: denom > 1e-6 ? (input.probabilities[opt.optionKey] ?? 0) / denom : 0,
    }));

    return {
      decisionId: input.decisionId,
      topicSlug: input.topicSlug,
      questionPrompt: input.questionPrompt,
      conceptTags: [...input.conceptTags],
      status: "UNRESOLVED",
      impactTier,
      isLoadBearing,
      selectedOptionKey: null,
      selectionRationale:
        "Decision unresolved: abstention gate triggered due to insufficient evidence or low evidence grounding.",
      runnerUpOptionKey: null,
      evaluatedAlternatives,
      predictionSetCore: [],
      predictionSetPeriph: [],
      dominanceMargin: 0,
      evidenceGrounding: input.evidenceGrounding,
      reason: "INSUFFICIENT_EVIDENCE_OR_GROUNDING",
    };
  }

  // Normalize valid option probabilities: \tilde{p}(a_k) = p(a_k) / (1 - p_abstain)
  const scoredOptions = input.options.map((opt) => {
    const rawP = input.probabilities[opt.optionKey] ?? 0;
    const normProb = rawP / denom;
    const nonconformityScore = 1 - normProb;
    return {
      optionKey: opt.optionKey,
      neutralSummary: opt.neutralSummary,
      rationaleAndPremises: opt.rationaleAndPremises,
      normProb,
      nonconformityScore,
    };
  });

  // Step 3: Top-2 Probability Dominance Margin
  const sortedOptions = [...scoredOptions].sort((a, b) => b.normProb - a.normProb);
  const a1 = sortedOptions[0];
  const a2 = sortedOptions.length > 1 ? sortedOptions[1] : undefined;
  const p1 = a1 ? a1.normProb : 0;
  const p2 = a2 ? a2.normProb : 0;
  const dominanceMargin = Math.max(0, p1 - p2);

  // Step 4: Conformal Prediction Set
  const predictionSetCore = sortedOptions
    .filter((opt) => opt.nonconformityScore <= priors.qHatCore05 + EPSILON)
    .map((opt) => opt.optionKey);

  const predictionSetPeriph = sortedOptions
    .filter((opt) => opt.nonconformityScore <= priors.qHatPeriph20 + EPSILON)
    .map((opt) => opt.optionKey);

  // Evaluated alternatives preserving original option ordering
  const evaluatedAlternatives: EvaluatedAlternativeRecord[] = input.options.map((opt) => {
    const scored = scoredOptions.find((s) => s.optionKey === opt.optionKey);
    return {
      optionKey: opt.optionKey,
      neutralSummary: opt.neutralSummary,
      rationaleAndPremises: opt.rationaleAndPremises,
      normalizedProbability: scored?.normProb ?? 0,
    };
  });

  const runnerUpKey = a2 ? a2.optionKey : null;

  // Step 5: Deterministic Classification Rules
  // Rule 1: Direct Full Approval (APPROVED_DIRECT)
  if (predictionSetCore.length === 1 && dominanceMargin >= DIRECT_APPROVAL_MARGIN) {
    return {
      decisionId: input.decisionId,
      topicSlug: input.topicSlug,
      questionPrompt: input.questionPrompt,
      conceptTags: [...input.conceptTags],
      status: "APPROVED_DIRECT",
      impactTier,
      isLoadBearing: true,
      selectedOptionKey: a1.optionKey,
      selectionRationale: a1.rationaleAndPremises,
      runnerUpOptionKey: runnerUpKey,
      evaluatedAlternatives,
      predictionSetCore,
      predictionSetPeriph,
      dominanceMargin,
      evidenceGrounding: input.evidenceGrounding,
    };
  }

  // Rule 2: Conditional Conservative Approval (APPROVED_CONSERVATIVE)
  // STRICT INVARIANT: Prohibited if impactTier == "CORE_ARCHITECTURAL"!
  if (
    impactTier === "PERIPHERAL" &&
    predictionSetPeriph.length >= 1 &&
    predictionSetPeriph.length <= 2 &&
    dominanceMargin >= CONSERVATIVE_APPROVAL_MARGIN
  ) {
    return {
      decisionId: input.decisionId,
      topicSlug: input.topicSlug,
      questionPrompt: input.questionPrompt,
      conceptTags: [...input.conceptTags],
      status: "APPROVED_CONSERVATIVE",
      impactTier: "PERIPHERAL",
      isLoadBearing: false,
      selectedOptionKey: a1.optionKey,
      selectionRationale: a1.rationaleAndPremises,
      runnerUpOptionKey: runnerUpKey,
      evaluatedAlternatives,
      predictionSetCore,
      predictionSetPeriph,
      dominanceMargin,
      evidenceGrounding: input.evidenceGrounding,
    };
  }

  // Rule 3: Escalation / Ambiguity (UNRESOLVED)
  let unresolvedReason = "CONFORMAL_THRESHOLD_UNMET";
  let explanation = "Decision unresolved: conformal prediction set criteria or dominance margin threshold not satisfied for automated approval.";

  if (impactTier === "CORE_ARCHITECTURAL" && predictionSetCore.length > 1) {
    unresolvedReason = "MULTI_OPTION_CORE_PREDICTION_SET";
    explanation = `Core architectural decision requires single prediction set member (|C_core| = 1), but got |C_core| = ${predictionSetCore.length}.`;
  } else if (dominanceMargin < CONSERVATIVE_APPROVAL_MARGIN) {
    unresolvedReason = "INSUFFICIENT_DOMINANCE_MARGIN";
    explanation = `Dominance margin (${dominanceMargin.toFixed(3)}) fell below minimal significance threshold.`;
  }

  return {
    decisionId: input.decisionId,
    topicSlug: input.topicSlug,
    questionPrompt: input.questionPrompt,
    conceptTags: [...input.conceptTags],
    status: "UNRESOLVED",
    impactTier,
    isLoadBearing,
    selectedOptionKey: null,
    selectionRationale: explanation,
    runnerUpOptionKey: runnerUpKey,
    evaluatedAlternatives,
    predictionSetCore,
    predictionSetPeriph,
    dominanceMargin,
    evidenceGrounding: input.evidenceGrounding,
    reason: unresolvedReason,
  };
}
