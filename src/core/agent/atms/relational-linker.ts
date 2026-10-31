/**
 * Justification-Driven ATMS Relational Linker (ATMS Stage 2 — Step 2)
 *
 * Implements `ELIXENT-ARCH-02` §5.1 & §5.2 batched relational link evaluation between
 * newly extracted assumptions and deterministically retrieved prior candidate decisions.
 *
 * Key Architectural Invariants:
 * 1. Waterfall Prevention: Collects all assumption-candidate comparison pairs across all
 *    assumptions into a single flattened array for one unified `evaluateRelationalLinksBatch`
 *    call, avoiding N+1 serial network roundtrips.
 * 2. Deterministic Reconstruction: Reconstitutes adjudication results keyed by
 *    `(assumptionId, targetDecisionId)` while preserving:
 *      a) The exact ordering of the input `assumptions` array.
 *      b) The candidate ranking order produced by `retrieveCandidatePriorDecisions`.
 * 3. Boundary Defense: Safely short-circuits on empty assumptions, empty/uninitialized
 *    `masterLedger`, or empty candidate sets, returning empty relation groups without
 *    invoking the external evaluation service.
 * 4. Closed-World Concept Intersection: Computes `sharedConceptTags` via normalized
 *    taxonomic comparison (`normalizeConceptTag`), filtering invalid or empty strings.
 */

import type { ATMSDecisionNode } from "./dag";
import type { CandidateRetrievalInput } from "./candidate-retriever";
import {
  retrieveCandidatePriorDecisions,
  DEFAULT_MAX_CANDIDATE_DECISIONS,
} from "./candidate-retriever";
import { normalizeConceptTag } from "@/core/agent/taxonomy/predefined-tags";
import type {
  RelationalLinkType,
  RelationalLinkPairInput,
  RelationalAdjudicationItem,
} from "@/core/agent/schemas/decision-schemas";
import { evaluateRelationalLinksBatch } from "@/lib/jev/client";

// ============================================================================
// 1. Exported Types & Contracts
// ============================================================================

export interface LinkedAssumptionRelation {
  targetDecisionId: string;
  relationType: RelationalLinkType;
  confidence: number;
  justification: string;
}

export interface LinkedAssumptionGroup<
  TAssumption extends CandidateRetrievalInput = CandidateRetrievalInput,
> {
  assumption: TAssumption;
  relations: LinkedAssumptionRelation[];
}

export interface RelationalLinkerOptions {
  maxCandidates?: number;
  abortSignal?: AbortSignal;
}

// ============================================================================
// 2. Internal Context & Helper Functions
// ============================================================================

interface AssumptionRetrievalContext<TAssumption extends CandidateRetrievalInput> {
  readonly assumption: TAssumption;
  readonly candidates: readonly ATMSDecisionNode[];
}

function computeSharedConceptTags(
  assumptionTags: readonly string[] | undefined,
  candidateTags: readonly string[] | undefined
): string[] {
  if (
    !Array.isArray(assumptionTags) ||
    !Array.isArray(candidateTags) ||
    assumptionTags.length === 0 ||
    candidateTags.length === 0
  ) {
    return [];
  }

  const normalizedAssumptionTags = new Set<string>();
  for (const rawTag of assumptionTags) {
    if (typeof rawTag !== "string") continue;
    const normalized = normalizeConceptTag(rawTag);
    if (normalized.length > 0) {
      normalizedAssumptionTags.add(normalized);
    }
  }

  if (normalizedAssumptionTags.size === 0) {
    return [];
  }

  const sharedTags: string[] = [];
  const seenCandidateTags = new Set<string>();

  for (const rawTag of candidateTags) {
    if (typeof rawTag !== "string") continue;
    const normalized = normalizeConceptTag(rawTag);
    if (
      normalized.length > 0 &&
      normalizedAssumptionTags.has(normalized) &&
      !seenCandidateTags.has(normalized)
    ) {
      seenCandidateTags.add(normalized);
      sharedTags.push(normalized);
    }
  }

  return sharedTags;
}

function extractAssumptionStatement(assumption: CandidateRetrievalInput): string {
  const statement =
    typeof assumption.assumptionStatement === "string"
      ? assumption.assumptionStatement
      : typeof assumption.statement === "string"
        ? assumption.statement
        : "";
  return statement.trim();
}

function buildComparisonPair(
  assumption: CandidateRetrievalInput,
  candidate: ATMSDecisionNode
): RelationalLinkPairInput {
  return {
    assumptionId: assumption.assumptionId,
    candidateDecisionId: candidate.decisionId,
    assumptionStatement: extractAssumptionStatement(assumption),
    candidatePrompt: candidate.questionPrompt,
    candidateSelectedOption: candidate.selectedOptionKey,
    sharedConceptTags: computeSharedConceptTags(
      assumption.conceptTags,
      candidate.conceptTags
    ),
  };
}

function createCompositeKey(assumptionId: string, targetDecisionId: string): string {
  return `${assumptionId}::${targetDecisionId}`;
}

function indexAdjudications(
  adjudications: readonly RelationalAdjudicationItem[]
): Map<string, LinkedAssumptionRelation> {
  const lookup = new Map<string, LinkedAssumptionRelation>();
  for (const item of adjudications) {
    const key = createCompositeKey(item.assumptionId, item.targetDecisionId);
    lookup.set(key, {
      targetDecisionId: item.targetDecisionId,
      relationType: item.relationType,
      confidence: item.confidence,
      justification: item.justification,
    });
  }
  return lookup;
}

function assembleLinkedGroups<TAssumption extends CandidateRetrievalInput>(
  contexts: readonly AssumptionRetrievalContext<TAssumption>[],
  lookup: ReadonlyMap<string, LinkedAssumptionRelation>
): Array<LinkedAssumptionGroup<TAssumption>> {
  return contexts.map(({ assumption, candidates }) => {
    const relations: LinkedAssumptionRelation[] = [];
    for (const candidate of candidates) {
      const key = createCompositeKey(assumption.assumptionId, candidate.decisionId);
      const matched = lookup.get(key);
      if (matched) {
        relations.push(matched);
      }
    }
    return { assumption, relations };
  });
}

// ============================================================================
// 3. Exported Orchestrator Implementation
// ============================================================================

/**
 * Links newly extracted assumptions to prior decisions in `masterLedger` via deterministic
 * top-K candidate retrieval followed by a single batched relational adjudication call.
 *
 * Adheres to `ELIXENT-ARCH-02` §5.1 & §5.2:
 * - Retrieves candidates per assumption via `retrieveCandidatePriorDecisions`.
 * - Flattens all comparison pairs across assumptions to prevent N+1 waterfall calls.
 * - Adjudicates relations into `INDEPENDENT`, `DEPENDS_ON`, `REOPENS_OR_OVERRIDES`, `REFINES`.
 * - Restores deterministic grouping preserving input assumption and candidate ranking order.
 */
export async function linkAssumptionsToPriorDecisions<
  TAssumption extends CandidateRetrievalInput = CandidateRetrievalInput,
>(
  assumptions: readonly TAssumption[],
  masterLedger: Record<string, ATMSDecisionNode>,
  options?: RelationalLinkerOptions
): Promise<Array<LinkedAssumptionGroup<TAssumption>>> {
  if (!assumptions || !Array.isArray(assumptions) || assumptions.length === 0) {
    return [];
  }

  if (
    !masterLedger ||
    typeof masterLedger !== "object" ||
    Object.keys(masterLedger).length === 0
  ) {
    return assumptions.map((assumption) => ({
      assumption,
      relations: [],
    }));
  }

  const maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATE_DECISIONS;
  const contexts: Array<AssumptionRetrievalContext<TAssumption>> = [];
  const allPairs: RelationalLinkPairInput[] = [];

  for (const assumption of assumptions) {
    const candidates = retrieveCandidatePriorDecisions(
      assumption,
      masterLedger,
      maxCandidates
    );
    contexts.push({ assumption, candidates });

    for (const candidate of candidates) {
      allPairs.push(buildComparisonPair(assumption, candidate));
    }
  }

  if (allPairs.length === 0) {
    return assumptions.map((assumption) => ({
      assumption,
      relations: [],
    }));
  }

  const adjudications = await evaluateRelationalLinksBatch(allPairs, {
    abortSignal: options?.abortSignal,
  });

  const adjudicationLookup = indexAdjudications(adjudications);
  return assembleLinkedGroups(contexts, adjudicationLookup);
}
