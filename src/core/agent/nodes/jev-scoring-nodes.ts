/**
 * Conformal Decision Scoring & Post-Adjudication Rationale Synthesis (Node 5)
 *
 * Implements Stage 3 canonical node `jev_conformal_scorer_node` for the Elixent
 * Native Graph Engine (`ADR-009`, `ADR-013`, `SRS-01` §4.3 — `BUG-01` fix):
 * - Evaluates assumptions using neutral pre-scoring options (`NeutralDecisionOptionInput[]`,
 *   zero `rationaleAndPremises` pre-scoring).
 * - Grounds evaluation with verbatim `workspaceEvidence` (dereferencing `vault_ref://` in RAM)
 *   and `governingPriorDecisions` from `state.governing_constraints`.
 * - Runs `evaluateDecisionBatch` (which executes `classifyDecisionConformalAPS` inline and
 *   synthesizes post-adjudication rationales via `synthesizePostAdjudicationRationales`).
 * - Populates `scored_decisions` and `unresolved_ledger`.
 */

import type { DecisionProvenance } from "@/core/agent/atms/dag";
import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type { AnalyzedAssumptionItem } from "@/core/agent/nodes/assumption-and-linker-nodes";
import type { NeutralDecisionOptionInput } from "@/core/agent/schemas/decision-schemas";
import type { AgentGraphState, UnresolvedDecision } from "@/core/agent/state";
import { resolveProjectConceptTags } from "@/core/agent/taxonomy/predefined-tags";
import {
  evaluateDecisionBatch,
  synthesizePostAdjudicationRationales,
  TIER1_DEFAULT_MODEL,
  type GoverningPriorDecisionContext,
  type GroundedDecisionEvaluationRequestItem,
  type GroundedWorkspaceEvidence,
} from "@/lib/jev/client";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import { resolveVaultRefJustInTime } from "@/lib/vault/ephemeral-memory-map";

/** Model identifier for single-pass conformal decision scoring */
export const DECISION_SCORER_MODEL_ID = TIER1_DEFAULT_MODEL;

function slugifyTopic(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.slice(0, 40) || "decision_topic";
}

function buildNeutralOptionsForAssumption(
  topicSlug: string,
  assumption: AnalyzedAssumptionItem,
): NeutralDecisionOptionInput[] {
  const existingNeutral = assumption.neutralOptions;
  if (Array.isArray(existingNeutral) && existingNeutral.length >= 3) {
    return existingNeutral.slice(0, 4).map((opt, idx) => ({
      optionKey: opt.optionKey.toLowerCase().replace(/[^a-z0-9_]/g, "_") || `option_${idx + 1}`,
      neutralSummary: opt.neutralSummary.slice(0, 220),
      technicalConstraints:
        opt.technicalConstraints.length > 0
          ? opt.technicalConstraints.slice(0, 4).map((c: string) => c.slice(0, 160))
          : ["Standard architectural constraint"],
    }));
  }

  return [
    {
      optionKey: `${topicSlug}_primary`,
      neutralSummary: "Standard implementation following modular component boundaries and direct integration.",
      technicalConstraints: ["Low implementation complexity", "Predictable local state management"],
    },
    {
      optionKey: `${topicSlug}_conservative`,
      neutralSummary: "Conservative provisional implementation with strict fallback boundaries.",
      technicalConstraints: ["Minimizes blast radius", "Reduces peripheral dependency coupling"],
    },
    {
      optionKey: `${topicSlug}_decoupled`,
      neutralSummary: "Fully decoupled asynchronous implementation utilizing isolated execution.",
      technicalConstraints: ["Maximizes architectural resilience", "Introduces coordination boundary"],
    },
  ];
}

/**
 * Unwrapped implementation of Node 5 (`jev_conformal_scorer_node`).
 */
export async function rawJevConformalScorerNode(
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> {
  const assumptions = ((state.assumptions ?? []) as AnalyzedAssumptionItem[]).filter(
    (a) => a.constrainedByPrior !== true,
  );
  if (assumptions.length === 0) {
    return {
      status: "COMPLETED",
      stateDelta: {
        scored_decisions: [],
        unresolved_ledger: [],
      },
    };
  }

  const activeTags = resolveProjectConceptTags(state.project_taxonomy);
  const masterLedger = state.master_ledger ?? {};

  const workspaceEvidence: GroundedWorkspaceEvidence[] = (
    state.search_report?.evidenceItems ?? []
  ).map((ev) => ({
    fileId: ev.fileId,
    headingSlug: ev.headingSlug,
    excerpt: resolveVaultRefJustInTime(ev.textExcerpt),
  }));

  const governingPriorDecisions: GoverningPriorDecisionContext[] = (
    state.governing_constraints ?? []
  ).map((node) => ({
    decisionId: node.decisionId,
    topicSlug: node.topicSlug,
    selectedOptionKey: node.selectedOptionKey,
    selectionRationale: node.selectionRationale,
    isLoadBearing: node.isLoadBearing,
    changeWeightTotal: node.changeWeight?.total,
  }));

  const items: GroundedDecisionEvaluationRequestItem[] = assumptions.map((asmp) => {
    const priorNode = masterLedger[asmp.assumptionId];
    const topicSlug = slugifyTopic(asmp.conceptTags[0] ?? asmp.statement);
    const validTags = (asmp.conceptTags ?? []).filter((t) => activeTags.includes(t));
    const assignedTags = validTags.length > 0 ? validTags.slice(0, 6) : [activeTags[0]];

    return {
      decisionId: asmp.assumptionId,
      topicSlug,
      questionPrompt: asmp.statement || "Canonical decision prompt",
      conceptTags: assignedTags,
      options: buildNeutralOptionsForAssumption(topicSlug, asmp),
      workspaceEvidence,
      governingPriorDecisions,
      dependsOnDecisionIds: [...(asmp.dependsOn ?? [])],
      affectedSections: [...(asmp.affectedSections ?? [])],
      ...(priorNode
        ? {
            priorDecisionContext: {
              reopenedFromDecisionId: priorNode.decisionId,
              previousSelectedOptionKey: priorNode.selectedOptionKey,
              previousSelectionRationale: priorNode.selectionRationale,
              triggerForReevaluation: "Reopened due to modified premises or changed evidence.",
            },
          }
        : {}),
    };
  });

  const rawResults = await evaluateDecisionBatch(
    { items },
    {
      modelId: DECISION_SCORER_MODEL_ID,
      activeConceptTags: activeTags,
      abortSignal: ctx.abortSignal,
      workspaceEvidence,
      governingPriorDecisions,
    },
  );

  const itemLookup = new Map<string, GroundedDecisionEvaluationRequestItem>();
  for (const item of items) {
    itemLookup.set(item.decisionId, item);
  }

  const scoredDecisions: Array<Record<string, unknown>> = [];
  const unresolvedItems: UnresolvedDecision[] = [];

  for (const rawResult of rawResults) {
    const matchingItem = itemLookup.get(rawResult.decisionId);
    const result =
      matchingItem && !rawResult.selectionRationale
        ? synthesizePostAdjudicationRationales(rawResult, matchingItem)
        : rawResult;

    const provenance: DecisionProvenance =
      (result as { wasEscalatedToTier2?: boolean }).wasEscalatedToTier2 === true ||
      result.status === "APPROVED_CONSERVATIVE"
        ? "SYSTEM2_ESCALATED_APS"
        : "SYSTEM1_DIRECT_APS";

    scoredDecisions.push({
      decisionId: result.decisionId,
      topicSlug: result.topicSlug,
      questionPrompt: result.questionPrompt,
      conceptTags: result.conceptTags,
      status: result.status,
      impactTier: result.impactTier,
      isLoadBearing: result.isLoadBearing,
      selectedOptionKey: result.selectedOptionKey,
      selectionRationale: result.selectionRationale,
      runnerUpOptionKey: result.runnerUpOptionKey,
      evaluatedAlternatives: result.evaluatedAlternatives,
      predictionSetCore: result.predictionSetCore,
      predictionSetPeriph: result.predictionSetPeriph,
      dominanceMargin: result.dominanceMargin,
      evidenceGrounding: result.evidenceGrounding,
      dependsOnDecisionIds: matchingItem?.dependsOnDecisionIds ?? [],
      affectedSections: matchingItem?.affectedSections ?? [],
      provenance,
      ...(result.reason ? { reason: result.reason } : {}),
    });

    if (result.status === "UNRESOLVED") {
      unresolvedItems.push({
        decisionId: result.decisionId,
        topicSlug: result.topicSlug,
        questionPrompt: result.questionPrompt,
        conceptTags: result.conceptTags,
        reason:
          result.reason ||
          "Failed conformal APS criteria (ambiguous or insufficient evidence)",
      });
    }
  }

  return {
    status: "COMPLETED",
    stateDelta: {
      scored_decisions: scoredDecisions,
      unresolved_ledger: unresolvedItems,
    },
  };
}

/**
 * Metered Node 5 (`jev_conformal_scorer_node`) wrapped with `withMeteredNodeGate`.
 */
export const jevConformalScorerNode: AgentGraphNodeFn = withMeteredNodeGate(
  "jev_conformal_scorer_node",
  DECISION_SCORER_MODEL_ID,
  rawJevConformalScorerNode,
);
