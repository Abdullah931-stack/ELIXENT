/**
 * AgentGraphState Annotation & Derived State Type
 *
 * Defines the canonical 12-channel LangGraph state annotation for the Elixent
 * agent orchestration graph, as specified in ELIXENT-ARCH-02 §2 (State Channel
 * Contracts & Pure Reducer Semantics).
 *
 * Each channel declares its value type, reducer strategy, and default factory.
 * All reducers are pure, synchronous functions imported from `./reducers`.
 */

import type { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import type { ProjectTaxonomyState } from "@/core/agent/taxonomy/predefined-tags";
import type { SectionTarget } from "@/core/agent/schemas/decision-schemas";
import {
  reduceSearchReport,
  reduceLocalInspectionState,
  reduceAssumptions,
  reduceMasterLedger,
  reduceProjectTaxonomy,
  reduceInvalidationMap,
  reduceBudgetTracking,
  reduceSearchLoopCount,
  type SearchReport,
  type UserRequest,
  type BudgetTrackingState,
  type UnresolvedDecision,
  type ClarifyingQuestionBatch,
} from "./reducers";

// Re-export reducer types for consumers that import state.ts as the main entry point.
export type {
  SearchReport,
  SearchReportEvidence,
  UserRequest,
  BudgetTrackingState,
  UnresolvedDecision,
  ClarifyingQuestionBatch,
} from "./reducers";

// ---------------------------------------------------------------------------
// AssumptionItem type alias for the generic assumption reducer
// ---------------------------------------------------------------------------

/**
 * Concrete assumption item shape used in the graph state `assumptions` channel.
 */
export interface AssumptionItem {
  readonly assumptionId: string;
  readonly statement: string;
  readonly conceptTags: readonly string[];
  readonly affectedSections: ReadonlyArray<{
    readonly fileId: string;
    readonly headingSlug: string;
  }>;
  readonly dependsOn: readonly string[];
}

// ---------------------------------------------------------------------------
// AgentGraphAnnotation: 12-Channel LangGraph State Definition
// ---------------------------------------------------------------------------

/**
 * Root annotation defining all 12 state channels of the Elixent agent graph.
 * Each channel specifies its value type, reducer function, and initial default.
 *
 * @see ELIXENT-ARCH-02 §2 for the authoritative channel contract table.
 */
export const AgentGraphAnnotation = Annotation.Root({
  /**
   * Conversation message history. Uses LangGraph's built-in message reducer
   * that merges messages while preserving deterministic message IDs.
   */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /**
   * Structured user request input. Last-write replacement semantics.
   */
  user_request: Annotation<UserRequest>({
    reducer: (_prev, next) => next,
    default: () => ({ prompt: "", projectId: "", targetFileIds: [] }),
  }),

  /**
   * Aggregated search evidence report. Deep-merges evidence entries
   * deduplicated by composite key `(fileId, headingSlug)`.
   */
  search_report: Annotation<SearchReport>({
    reducer: reduceSearchReport,
    default: () => ({ evidenceItems: [], inspectedPaths: [], summary: "" }),
  }),

  /**
   * Deduplicated set of locally inspected file/heading paths,
   * preventing re-inspection during supplementary search loops.
   */
  local_inspection_state: Annotation<string[]>({
    reducer: reduceLocalInspectionState,
    default: () => [],
  }),

  /**
   * Active assumptions in the current cycle, keyed by `assumptionId`.
   * Upserts by ID on each reducer invocation.
   */
  assumptions: Annotation<AssumptionItem[]>({
    reducer: reduceAssumptions,
    default: () => [],
  }),

  /**
   * Justification-Driven ATMS DAG. Deep-merges decision node records,
   * filtering system-reserved sentinel IDs from DAG execution.
   */
  master_ledger: Annotation<Record<string, ATMSDecisionNode>>({
    reducer: reduceMasterLedger,
    default: () => ({}),
  }),

  /**
   * Project-scoped concept taxonomy state. Null-coalescing last-write:
   * preserves current value when update is null.
   */
  project_taxonomy: Annotation<ProjectTaxonomyState | null>({
    reducer: reduceProjectTaxonomy,
    default: () => null,
  }),

  /**
   * Decisions that failed conformal prediction criteria in the current cycle.
   * Last-write replacement.
   */
  unresolved_ledger: Annotation<UnresolvedDecision[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /**
   * Section targets affected by ATMS DAG invalidation or override cascades.
   * Aggregated and deduplicated by `(fileId, headingSlug)` per decision ID.
   */
  invalidation_map: Annotation<Record<string, SectionTarget[]>>({
    reducer: reduceInvalidationMap,
    default: () => ({}),
  }),

  /**
   * Structured question batch for human-in-the-loop interrupts.
   * Last-write replacement; resets to null on session resumption.
   */
  question_queue: Annotation<ClarifyingQuestionBatch | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Credit budget tracking using decimal string micro-units.
   * Reducer performs BigInt addition then serializes back to strings.
   */
  budget_tracking: Annotation<BudgetTrackingState>({
    reducer: reduceBudgetTracking,
    default: () => ({ reservedMicro: "0", spentMicro: "0" }),
  }),

  /**
   * Monotonic search loop counter, bounded by MAX_SEARCH_LOOPS (3).
   * Reducer adds the delta and clamps at the ceiling.
   */
  search_loop_count: Annotation<number>({
    reducer: reduceSearchLoopCount,
    default: () => 0,
  }),
});

/**
 * Inferred state type derived from `AgentGraphAnnotation`.
 * Provides full type-safety for all graph node functions.
 */
export type AgentGraphState = typeof AgentGraphAnnotation.State;
