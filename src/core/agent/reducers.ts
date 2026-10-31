/**
 * Pure State Channel Reducers for AgentGraphState
 *
 * Implements the deterministic, side-effect-free reducer functions specified in
 * ELIXENT-ARCH-02 §2 (State Channel Contracts & Pure Reducer Semantics).
 *
 * Architectural Invariants:
 * 1. Pure & Synchronous: Every reducer is `(current, update) => next` with zero I/O,
 *    zero async, and zero mutation of input arguments.
 * 2. JSON-Serializable Output: All returned values use plain objects, arrays, and
 *    strings — never `Map`, `Set`, or `BigInt` at the boundary.
 * 3. Idempotent Deduplication: Composite keys prevent duplicate entries across
 *    search evidence, assumptions, inspection paths, and section targets.
 */

import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import { isSystemReservedDecisionId } from "@/core/agent/taxonomy/predefined-tags";
import type { ProjectTaxonomyState } from "@/core/agent/taxonomy/predefined-tags";
import type { SectionTarget } from "@/core/agent/schemas/decision-schemas";

// ---------------------------------------------------------------------------
// 1. Locally Defined Types (not found elsewhere in the codebase)
// ---------------------------------------------------------------------------

/**
 * Single evidence entry within a search report, keyed by `(fileId, headingSlug)`.
 */
export interface SearchReportEvidence {
  readonly fileId: string;
  readonly headingSlug: string;
  readonly breadcrumb: readonly string[];
  readonly textExcerpt: string;
  readonly vaultRef?: string;
}

/**
 * Aggregated search report produced by `search_synthesizer_node`.
 */
export interface SearchReport {
  readonly evidenceItems: readonly SearchReportEvidence[];
  readonly inspectedPaths: readonly string[];
  readonly summary: string;
}

/**
 * Structured user request input for the agent graph.
 */
export interface UserRequest {
  readonly prompt: string;
  readonly projectId: string;
  readonly targetFileIds: readonly string[];
}

/**
 * Budget tracking state using decimal string representation for JSON-safe BigInt arithmetic.
 */
export interface BudgetTrackingState {
  readonly reservedMicro: string;
  readonly spentMicro: string;
}

/**
 * A decision that failed the conformal prediction criteria and awaits
 * supplementary search or user escalation.
 */
export interface UnresolvedDecision {
  readonly decisionId: string;
  readonly topicSlug: string;
  readonly questionPrompt: string;
  readonly conceptTags: readonly string[];
  readonly reason: string;
}

/**
 * Structured clarifying question batch for human-in-the-loop interrupts.
 */
export interface ClarifyingQuestionBatch {
  readonly questions: ReadonlyArray<{
    readonly questionId: string;
    readonly topicSlug: string;
    readonly questionPrompt: string;
    readonly options: ReadonlyArray<{
      readonly optionKey: string;
      readonly neutralSummary: string;
      readonly rationaleAndPremises: string;
    }>;
    readonly contextExplanation?: string;
  }>;
}

// ---------------------------------------------------------------------------
// 2. Constants
// ---------------------------------------------------------------------------

/** Maximum number of supplementary search loops before escalation to user. */
export const MAX_SEARCH_LOOPS = 3;

// ---------------------------------------------------------------------------
// 3. Pure Reducer Functions
// ---------------------------------------------------------------------------

/**
 * Deep-merges search report evidence entries, deduplicating by composite key
 * `${fileId}:${headingSlug}`. Newer entries overwrite older duplicates.
 * Inspected paths are merged via set union. Summary is replaced by the update.
 *
 * @param current - The existing search report state.
 * @param update - The incoming search report to merge.
 * @returns A new merged SearchReport with deduplicated evidence and paths.
 */
export function reduceSearchReport(
  current: SearchReport,
  update: SearchReport,
): SearchReport {
  const evidenceMap = new Map<string, SearchReportEvidence>();

  for (const entry of current.evidenceItems) {
    const key = `${entry.fileId}:${entry.headingSlug}`;
    evidenceMap.set(key, entry);
  }

  for (const entry of update.evidenceItems) {
    const key = `${entry.fileId}:${entry.headingSlug}`;
    evidenceMap.set(key, entry);
  }

  const mergedPaths = Array.from(
    new Set([...current.inspectedPaths, ...update.inspectedPaths]),
  );

  return {
    evidenceItems: Array.from(evidenceMap.values()),
    inspectedPaths: mergedPaths,
    summary: update.summary || current.summary,
  };
}

/**
 * Produces a deduplicated set union of locally inspected file/heading paths.
 *
 * @param current - The existing set of inspected paths.
 * @param update - New paths to merge into the set.
 * @returns A new array containing the deduplicated union of both sets.
 */
export function reduceLocalInspectionState(
  current: string[],
  update: string[],
): string[] {
  return Array.from(new Set([...current, ...update]));
}

/**
 * Upserts assumption items by `assumptionId`. Newer entries with a matching ID
 * replace existing ones; entries with new IDs are appended.
 *
 * @param current - The existing array of assumption items.
 * @param update - Incoming assumption items to upsert.
 * @returns A new array with assumptions merged by `assumptionId`.
 */
export function reduceAssumptions<
  T extends { readonly assumptionId: string },
>(current: readonly T[], update: readonly T[]): T[] {
  const map = new Map<string, T>();

  for (const item of current) {
    map.set(item.assumptionId, item);
  }

  for (const item of update) {
    map.set(item.assumptionId, item);
  }

  return Array.from(map.values());
}

/**
 * Deep-merges ATMS decision node records, filtering out entries whose
 * `decisionId` key matches system-reserved sentinel IDs (e.g. `__PROJECT_TAXONOMY__`).
 *
 * @param current - The existing master ledger record.
 * @param update - Incoming decision nodes to merge into the ledger.
 * @returns A new record with merged decision nodes, excluding system-reserved IDs.
 */
export function reduceMasterLedger(
  current: Record<string, ATMSDecisionNode>,
  update: Record<string, ATMSDecisionNode>,
): Record<string, ATMSDecisionNode> {
  const merged: Record<string, ATMSDecisionNode> = {};

  for (const [key, node] of Object.entries(current)) {
    if (!isSystemReservedDecisionId(key)) {
      merged[key] = node;
    }
  }

  for (const [key, node] of Object.entries(update)) {
    if (!isSystemReservedDecisionId(key)) {
      merged[key] = node;
    }
  }

  return merged;
}

/**
 * Last-write replacement with null-coalescing fallback: returns the update
 * value if non-null, otherwise preserves the current value.
 *
 * @param current - The existing project taxonomy state.
 * @param update - The incoming project taxonomy state (may be null).
 * @returns The update value if non-null, otherwise the current value.
 */
export function reduceProjectTaxonomy(
  current: ProjectTaxonomyState | null,
  update: ProjectTaxonomyState | null,
): ProjectTaxonomyState | null {
  return update ?? current;
}

/**
 * Aggregates section targets across ATMS DAG invalidation entries,
 * deduplicating within each decision ID by composite key `${fileId}:${headingSlug}`.
 *
 * @param current - The existing invalidation map.
 * @param update - Incoming invalidation entries to aggregate.
 * @returns A new record with merged and deduplicated section targets per decision ID.
 */
export function reduceInvalidationMap(
  current: Record<string, SectionTarget[]>,
  update: Record<string, SectionTarget[]>,
): Record<string, SectionTarget[]> {
  const merged: Record<string, SectionTarget[]> = {};

  // Copy current entries
  for (const [decisionId, sections] of Object.entries(current)) {
    merged[decisionId] = [...sections];
  }

  // Merge update entries with deduplication
  for (const [decisionId, sections] of Object.entries(update)) {
    const existing = merged[decisionId] ?? [];
    const seenKeys = new Set<string>();

    for (const section of existing) {
      seenKeys.add(`${section.fileId}:${section.headingSlug}`);
    }

    const deduped = [...existing];
    for (const section of sections) {
      const key = `${section.fileId}:${section.headingSlug}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        deduped.push(section);
      }
    }

    merged[decisionId] = deduped;
  }

  return merged;
}

/**
 * Adds decimal string micro-credit amounts via BigInt arithmetic,
 * returning the result as decimal strings for JSON serialization.
 *
 * @param current - The existing budget tracking state with decimal string values.
 * @param update - The incoming budget delta with decimal string values.
 * @returns A new BudgetTrackingState with summed values as decimal strings.
 */
export function reduceBudgetTracking(
  current: BudgetTrackingState,
  update: BudgetTrackingState,
): BudgetTrackingState {
  const reserved = BigInt(current.reservedMicro) + BigInt(update.reservedMicro);
  const spent = BigInt(current.spentMicro) + BigInt(update.spentMicro);

  return {
    reservedMicro: reserved.toString(),
    spentMicro: spent.toString(),
  };
}

/**
 * Monotonically increments the search loop counter by the given delta,
 * clamping at `MAX_SEARCH_LOOPS` (3) to prevent unbounded search cycles.
 *
 * @param current - The existing loop count.
 * @param delta - The increment value (typically 1).
 * @returns The new loop count, capped at MAX_SEARCH_LOOPS.
 */
export function reduceSearchLoopCount(
  current: number,
  delta: number,
): number {
  return Math.min(current + delta, MAX_SEARCH_LOOPS);
}
