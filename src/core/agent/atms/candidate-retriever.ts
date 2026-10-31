/**
 * Deterministic Local Candidate Decision Retriever (ATMS Stage 2 — Step 1)
 *
 * Implements `ELIXENT-ARCH-02` §5.1 deterministic top-K candidate retrieval over
 * `state.master_ledger` prior to relational link adjudication (`POST /v1/decisions`),
 * combining three orthogonal retrieval signals:
 *
 * 1. AST Section Proximity (`astProximityScore` in `[0, 1]`):
 *    Structural overlap across `(fileId, headingSlug)` targets (exact match = 1.0,
 *    hierarchical slug ancestor/child prefix = 0.5, disjoint = 0.0).
 *    STRICT ARCHITECTURAL INVARIANT: Sharing `fileId` and `headingSlug` is strictly
 *    a candidate retrieval signal for comparison, NEVER an automatic dependency edge —
 *    allowing multiple independent conservative sub-decisions to coexist under the
 *    same document heading without false forced linking.
 *
 * 2. Concept Tags Intersection (`conceptTagScore` in `[0, 1]`):
 *    Jaccard similarity (`|T_A ∩ T_D| / |T_A ∪ T_D|`) across project-scoped `conceptTags`
 *    with zero hardcoded tag whitelist restrictions.
 *
 * 3. BM25 Lexical Match (`lexicalBm25Score` in `[0, 1)`):
 *    Okapi BM25 similarity (`bm25 / (1 + bm25)`) between the assumption statement and
 *    each prior decision's `topicSlug`, `questionPrompt`, `selectedOptionKey`,
 *    `selectionRationale`, and `evaluatedAlternatives`.
 */

import {
  LexicalBM25SearchEngine,
  tokenizeLexicalText,
  type DocumentChunk,
} from "@/core/workspace/lexical-bm25";
import {
  isSystemReservedDecisionId,
  normalizeConceptTag,
} from "../taxonomy/predefined-tags";
import type { ATMSDecisionNode } from "./dag";

// ============================================================================
// 1. Exported Constants & Contracts
// ============================================================================

export const DEFAULT_MAX_CANDIDATE_DECISIONS = 8;

export const CANDIDATE_RETRIEVAL_WEIGHTS = {
  astSectionProximity: 3.0,
  conceptTagOverlap: 2.0,
  lexicalBm25: 1.5,
} as const;

export interface CandidateRetrievalInput {
  assumptionId: string;
  statement?: string;
  assumptionStatement?: string;
  conceptTags: readonly string[];
  affectedSections?: ReadonlyArray<{ fileId: string; headingSlug: string }>;
  dependsOn?: readonly string[];
}

export interface ScoredCandidateDecision {
  node: ATMSDecisionNode;
  totalScore: number;
  astProximityScore: number;
  conceptTagScore: number;
  lexicalBm25Score: number;
}

// ============================================================================
// 2. Internal Constants & Value Types
// ============================================================================

const EXACT_HEADING_PROXIMITY_SCORE = 1.0;
const HIERARCHICAL_HEADING_PROXIMITY_SCORE = 0.5;
const NO_PROXIMITY_SCORE = 0.0;
const SCORE_TIE_EPSILON = 1e-12;
const DEFAULT_CHUNK_LINE_RANGE: [number, number] = [1, 1];

interface NormalizedSectionTarget {
  readonly fileId: string;
  readonly headingSlug: string;
}

interface EligibleLedgerCandidate {
  readonly chunkId: string;
  readonly node: ATMSDecisionNode;
}

interface PreparedAssumptionSignals {
  readonly sections: readonly NormalizedSectionTarget[];
  readonly tags: ReadonlySet<string>;
  readonly bm25Scores: ReadonlyMap<string, number>;
}

// ============================================================================
// 3. Sentinel Filtering & Limit Normalization
// ============================================================================

/*
 * Boundary cases for maxCandidates:
 * - negative, zero, NaN, -Infinity, or positive float < 1 (floored to 0) -> 0
 * - +Infinity -> Number.POSITIVE_INFINITY (capped downstream to candidate count)
 * - positive finite number >= 1 -> Math.floor(maxCandidates)
 */
function normalizeMaxCandidates(maxCandidates: number): number {
  if (
    typeof maxCandidates !== "number" ||
    Number.isNaN(maxCandidates) ||
    maxCandidates <= 0
  ) {
    return 0;
  }
  if (maxCandidates === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(maxCandidates)) {
    return 0;
  }
  return Math.floor(maxCandidates);
}

/**
 * Excludes system-reserved infrastructure sentinels (e.g., `__PROJECT_TAXONOMY__`)
 * and pre-sorts ledger entries by `decisionId` so corpus statistics remain
 * bit-identical regardless of JavaScript object key insertion order.
 */
function collectEligibleLedgerNodes(
  masterLedger: Record<string, ATMSDecisionNode>
): EligibleLedgerCandidate[] {
  const entries = Object.entries(masterLedger)
    .filter(([ledgerKey, node]) => {
      if (
        !node ||
        typeof node.decisionId !== "string" ||
        node.decisionId.trim().length === 0
      ) {
        return false;
      }
      return (
        !isSystemReservedDecisionId(ledgerKey) &&
        !isSystemReservedDecisionId(node.decisionId)
      );
    })
    .sort(([keyA, nodeA], [keyB, nodeB]) => {
      const idOrder = nodeA.decisionId.localeCompare(nodeB.decisionId);
      return idOrder !== 0 ? idOrder : keyA.localeCompare(keyB);
    });

  return entries.map(([, node], index) => ({
    chunkId: `${index}:${node.decisionId}`,
    node,
  }));
}

// ============================================================================
// 4. Signal 1 — AST Section Proximity
// ============================================================================

function normalizeSectionTargets(
  sections: ReadonlyArray<{ fileId: string; headingSlug: string }> | undefined
): NormalizedSectionTarget[] {
  if (!sections || sections.length === 0) {
    return [];
  }

  const normalized: NormalizedSectionTarget[] = [];
  for (const section of sections) {
    if (
      !section ||
      typeof section.fileId !== "string" ||
      typeof section.headingSlug !== "string"
    ) {
      continue;
    }
    const fileId = section.fileId.trim();
    const headingSlug = section.headingSlug.trim();
    if (fileId.length > 0 && headingSlug.length > 0) {
      normalized.push({ fileId, headingSlug });
    }
  }
  return normalized;
}

function hasDelimitedPrefixRelation(
  slugA: string,
  slugB: string,
  delimiter: "-" | "/"
): boolean {
  const edgePattern = delimiter === "-" ? /^-+|-+$/g : /^\/+|\/+$/g;
  const cleanA = slugA.replace(edgePattern, "");
  const cleanB = slugB.replace(edgePattern, "");

  if (cleanA.length === 0 || cleanB.length === 0 || cleanA === cleanB) {
    return false;
  }

  return (
    cleanA.startsWith(`${cleanB}${delimiter}`) ||
    cleanB.startsWith(`${cleanA}${delimiter}`)
  );
}

function isHierarchicalSlugPair(slugA: string, slugB: string): boolean {
  return (
    hasDelimitedPrefixRelation(slugA, slugB, "-") ||
    hasDelimitedPrefixRelation(slugA, slugB, "/")
  );
}

function computeAstSectionProximityScore(
  assumptionSections: readonly NormalizedSectionTarget[],
  decisionSections: readonly NormalizedSectionTarget[]
): number {
  if (assumptionSections.length === 0 || decisionSections.length === 0) {
    return NO_PROXIMITY_SCORE;
  }

  let bestScore = NO_PROXIMITY_SCORE;

  for (const targetA of assumptionSections) {
    for (const targetB of decisionSections) {
      if (targetA.fileId !== targetB.fileId) {
        continue;
      }
      if (targetA.headingSlug === targetB.headingSlug) {
        return EXACT_HEADING_PROXIMITY_SCORE;
      }
      if (isHierarchicalSlugPair(targetA.headingSlug, targetB.headingSlug)) {
        bestScore = HIERARCHICAL_HEADING_PROXIMITY_SCORE;
      }
    }
  }

  return bestScore;
}

// ============================================================================
// 5. Signal 2 — Concept Tags Intersection
// ============================================================================

function normalizeTagSet(tags: readonly string[]): ReadonlySet<string> {
  const normalizedTags = new Set<string>();
  for (const rawTag of tags) {
    if (typeof rawTag !== "string") {
      continue;
    }
    const tag = normalizeConceptTag(rawTag);
    if (tag.length > 0) {
      normalizedTags.add(tag);
    }
  }
  return normalizedTags;
}

/**
 * Computes Jaccard similarity (`|T_A ∩ T_D| / |T_A ∪ T_D|`) in `[0, 1]` so tag
 * relevance increases monotonically with shared tag count while penalizing
 * unmatched or overly broad generalist tag sets (`0` when either set is empty).
 */
function computeConceptTagOverlapScore(
  assumptionTags: ReadonlySet<string>,
  decisionTags: ReadonlySet<string>
): number {
  if (assumptionTags.size === 0 || decisionTags.size === 0) {
    return 0;
  }

  const [smallerSet, largerSet] =
    assumptionTags.size <= decisionTags.size
      ? [assumptionTags, decisionTags]
      : [decisionTags, assumptionTags];

  let intersectionCount = 0;
  for (const tag of smallerSet) {
    if (largerSet.has(tag)) {
      intersectionCount += 1;
    }
  }

  if (intersectionCount === 0) {
    return 0;
  }

  const unionCount =
    assumptionTags.size + decisionTags.size - intersectionCount;
  return intersectionCount / unionCount;
}

// ============================================================================
// 6. Signal 3 — BM25 Lexical Match Over Prompts, Rationales & Alternatives
// ============================================================================

function extractAssumptionQueryText(assumption: CandidateRetrievalInput): string {
  const primaryStatement = assumption.assumptionStatement?.trim();
  if (primaryStatement && primaryStatement.length > 0) {
    return primaryStatement;
  }
  return (assumption.statement ?? "").trim();
}

function buildDecisionDocumentChunk(
  node: ATMSDecisionNode,
  chunkId: string
): DocumentChunk {
  const textSegments: string[] = [
    node.topicSlug,
    node.questionPrompt,
    node.selectedOptionKey,
    node.selectionRationale,
  ];

  for (const alternative of node.evaluatedAlternatives ?? []) {
    textSegments.push(
      alternative.optionKey,
      alternative.neutralSummary,
      alternative.rationaleAndPremises
    );
  }

  const content = textSegments
    .map((segment) => (typeof segment === "string" ? segment.trim() : ""))
    .filter((segment) => segment.length > 0)
    .join("\n");

  return {
    fileId: chunkId,
    fileName: node.decisionId,
    headingSlug: node.topicSlug,
    headingBreadcrumb: "",
    content,
    lineRange: DEFAULT_CHUNK_LINE_RANGE,
    tokens: tokenizeLexicalText(content),
  };
}

function computeLexicalBm25Scores(
  queryText: string,
  candidates: readonly EligibleLedgerCandidate[]
): ReadonlyMap<string, number> {
  const scoresByChunkId = new Map<string, number>();
  if (candidates.length === 0 || tokenizeLexicalText(queryText).length === 0) {
    return scoresByChunkId;
  }

  const chunks = candidates.map((candidate) =>
    buildDecisionDocumentChunk(candidate.node, candidate.chunkId)
  );
  // Request full candidate count so items outside BM25 top-10 still retain
  // their lexical score when combined with AST proximity and tag signals.
  const engine = new LexicalBM25SearchEngine(chunks, {
    maxResults: chunks.length,
  });
  const matches = engine.search(queryText, { maxResults: chunks.length });

  for (const match of matches) {
    if (match.bm25Score > 0 && Number.isFinite(match.bm25Score)) {
      scoresByChunkId.set(
        match.fileId,
        match.bm25Score / (1 + match.bm25Score)
      );
    }
  }

  return scoresByChunkId;
}

// ============================================================================
// 7. Composite Candidate Scoring & Deterministic Tie-Breaking
// ============================================================================

function parseDecisionTimestampMs(updatedAt: Date | string | undefined): number {
  if (updatedAt instanceof Date) {
    const timestamp = updatedAt.getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  if (typeof updatedAt === "string" && updatedAt.trim().length > 0) {
    const timestamp = Date.parse(updatedAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return 0;
}

/**
 * Deterministic comparator treating sub-1e-12 floating-point drift as tied,
 * breaking ties by: (1) load-bearing status, (2) valid `updatedAt` descending,
 * and (3) lexicographical `decisionId` ascending.
 */
function compareScoredCandidates(
  left: ScoredCandidateDecision,
  right: ScoredCandidateDecision
): number {
  const scoreDiff = right.totalScore - left.totalScore;
  if (Math.abs(scoreDiff) >= SCORE_TIE_EPSILON) {
    return scoreDiff;
  }

  if (left.node.isLoadBearing !== right.node.isLoadBearing) {
    return left.node.isLoadBearing ? -1 : 1;
  }

  const leftTimestamp = parseDecisionTimestampMs(left.node.updatedAt);
  const rightTimestamp = parseDecisionTimestampMs(right.node.updatedAt);
  if (rightTimestamp !== leftTimestamp) {
    return rightTimestamp - leftTimestamp;
  }

  return left.node.decisionId.localeCompare(right.node.decisionId);
}

function scoreSingleCandidate(
  candidate: EligibleLedgerCandidate,
  signals: PreparedAssumptionSignals
): ScoredCandidateDecision {
  const decisionSections = normalizeSectionTargets(
    candidate.node.affectedSections
  );
  const decisionTags = normalizeTagSet(candidate.node.conceptTags ?? []);

  const astProximityScore = computeAstSectionProximityScore(
    signals.sections,
    decisionSections
  );
  const conceptTagScore = computeConceptTagOverlapScore(
    signals.tags,
    decisionTags
  );
  const lexicalBm25Score = signals.bm25Scores.get(candidate.chunkId) ?? 0;

  const totalScore =
    CANDIDATE_RETRIEVAL_WEIGHTS.astSectionProximity * astProximityScore +
    CANDIDATE_RETRIEVAL_WEIGHTS.conceptTagOverlap * conceptTagScore +
    CANDIDATE_RETRIEVAL_WEIGHTS.lexicalBm25 * lexicalBm25Score;

  return {
    node: candidate.node,
    totalScore,
    astProximityScore,
    conceptTagScore,
    lexicalBm25Score,
  };
}

/**
 * Computes detailed multi-signal relevance scores for prior decisions in `masterLedger`
 * against a candidate assumption without mutating any input structures.
 *
 * Architectural Invariant (`ELIXENT-ARCH-02` §5.1):
 * Sharing `fileId` and `headingSlug` contributes strictly to candidate retrieval ranking
 * for downstream relational comparison and NEVER implies an automatic dependency link,
 * allowing independent conservative sub-decisions to coexist under the same heading.
 */
export function scoreCandidatePriorDecisions(
  assumption: CandidateRetrievalInput,
  masterLedger: Record<string, ATMSDecisionNode>,
  maxCandidates: number = DEFAULT_MAX_CANDIDATE_DECISIONS
): ScoredCandidateDecision[] {
  if (!assumption || !masterLedger || typeof masterLedger !== "object") {
    return [];
  }

  const normalizedLimit = normalizeMaxCandidates(maxCandidates);
  if (normalizedLimit <= 0) {
    return [];
  }

  const eligibleCandidates = collectEligibleLedgerNodes(masterLedger);
  if (eligibleCandidates.length === 0) {
    return [];
  }

  const signals: PreparedAssumptionSignals = {
    sections: normalizeSectionTargets(assumption.affectedSections),
    tags: normalizeTagSet(assumption.conceptTags ?? []),
    bm25Scores: computeLexicalBm25Scores(
      extractAssumptionQueryText(assumption),
      eligibleCandidates
    ),
  };

  const scoredCandidates = eligibleCandidates
    .map((candidate) => scoreSingleCandidate(candidate, signals))
    .filter((scored) => scored.totalScore > 0);

  scoredCandidates.sort(compareScoredCandidates);

  const effectiveLimit = Math.min(normalizedLimit, scoredCandidates.length);
  return scoredCandidates.slice(0, effectiveLimit);
}

/**
 * Retrieves the top-K (`maxCandidates <= 8` by default) most relevant prior `ATMSDecisionNode`
 * candidates from `masterLedger` for relational classification (`INDEPENDENT`, `DEPENDS_ON`,
 * `REOPENS_OR_OVERRIDES`, `REFINES`) in `atms_relational_linker_node`.
 *
 * Architectural Invariant (`ELIXENT-ARCH-02` §5.1):
 * Sharing `fileId` and `headingSlug` is strictly a retrieval signal for candidate comparison,
 * NEVER an automatic dependency edge — allowing multiple independent conservative sub-decisions
 * to coexist under the same heading.
 */
export function retrieveCandidatePriorDecisions(
  assumption: CandidateRetrievalInput,
  masterLedger: Record<string, ATMSDecisionNode>,
  maxCandidates: number = DEFAULT_MAX_CANDIDATE_DECISIONS
): ATMSDecisionNode[] {
  return scoreCandidatePriorDecisions(
    assumption,
    masterLedger,
    maxCandidates
  ).map((scored) => scored.node);
}
