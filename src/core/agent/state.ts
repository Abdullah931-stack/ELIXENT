/**
 * Native 18-Channel AgentGraphState & State Transition Helpers
 *
 * Defines the canonical 18-channel state contract for the Elixent Native
 * Graph Engine (`ADR-009` & `SRS-01` §2.3), replacing LangGraph's
 * `Annotation.Root` with pure TypeScript interfaces and deterministic reducers.
 *
 * All channel updates are applied synchronously via `applyStateDelta` using the
 * pure reducer functions in `./reducers`.
 */

import type {
  ATMSDecisionNode,
  DirectedDecisionEdge,
} from "@/core/agent/atms/dag";
import type { ProjectTaxonomyState } from "@/core/agent/taxonomy/predefined-tags";
import type { SectionTarget } from "@/core/agent/schemas/decision-schemas";
import {
  reduceMessages,
  reduceSearchReport,
  reduceLocalInspectionState,
  reduceAssumptions,
  reduceMasterLedger,
  reduceProjectTaxonomy,
  reduceInvalidationMap,
  reduceBudgetTracking,
  reduceSearchLoopCount,
  type AgentConversationMessage,
  type SearchReport,
  type UserRequest,
  type BudgetTrackingState,
  type UnresolvedDecision,
  type ClarifyingQuestionBatch,
} from "./reducers";

// Re-export reducer types for consumers that import state.ts as the main entry point.
export type {
  AgentPermissionMode,
  AgentConversationMessage,
  SearchReport,
  SearchReportEvidence,
  UserRequest,
  BudgetTrackingState,
  UnresolvedDecision,
  ClarifyingQuestionBatch,
} from "./reducers";

// ---------------------------------------------------------------------------
// Intent Classification & File Lifecycle Action Contracts
// ---------------------------------------------------------------------------

/**
 * 9-category input intent taxonomy classified by the Stage 0 Orchestrator.
 */
export type InputIntentCategory =
  | "CHAT_ONLY"
  | "WORKSPACE_READ_SEARCH"
  | "DECISION_LEDGER_QUERY"
  | "FAST_LOCAL_EDIT"
  | "NEW_DOC_DRAFTING"
  | "ARCHITECTURAL_MODIFICATION"
  | "CONFLICTING_OVERRIDE"
  | "FILE_STRUCTURE_MUTATION"
  | "COMPOUND_MULTI_INTENT";

/**
 * Pending workspace file creation or deletion action awaiting execution or HITL approval.
 */
export interface PendingFileLifecycleAction {
  readonly actionId: string;
  readonly type: "CREATE_FILE" | "DELETE_FILE";
  readonly relativePath: string;
  readonly fileId?: string;
  readonly initialContent?: string;
  readonly rationale: string;
  readonly approved?: boolean;
}

/**
 * Concrete assumption item shape used in the graph state `assumptions` channel.
 */
export interface AssumptionItem {
  readonly assumptionId: string;
  readonly statement: string;
  readonly intentType?: "DIRECT_USER_INSTRUCTION" | "INFERRED_COLLATERAL_ASSUMPTION";
  readonly conceptTags: readonly string[];
  readonly affectedSections: ReadonlyArray<{
    readonly fileId: string;
    readonly headingSlug: string;
  }>;
  readonly dependsOn: readonly string[];
}

// ---------------------------------------------------------------------------
// Canonical 18-Channel AgentGraphState
// ---------------------------------------------------------------------------

/**
 * Canonical 18-channel state interface for the Elixent Native Graph Engine.
 *
 * @see SRS-01 §2.3 for channel semantics and reducer contracts.
 */
export interface AgentGraphState {
  /** Conversation message history merged deterministically by `id`. */
  readonly messages: AgentConversationMessage[];

  /** Structured user request input. Last-write replacement semantics. */
  readonly user_request: UserRequest;

  /** Stage 0 classified input intent category. */
  readonly classified_intent: InputIntentCategory | null;

  /** Aggregated search evidence report deduplicated by `(fileId, headingSlug)`. */
  readonly search_report: SearchReport;

  /** Deduplicated set of locally inspected file/heading paths. */
  readonly local_inspection_state: string[];

  /** Active assumptions in the current cycle, upserted by `assumptionId`. */
  readonly assumptions: AssumptionItem[];

  /** Prior ATMS decisions governing the current architectural scope. */
  readonly governing_constraints: ATMSDecisionNode[];

  /** Conformal-scored decision outputs from Stage 3 JEV evaluation. */
  readonly scored_decisions: Array<Record<string, unknown>>;

  /** Justification-Driven ATMS DAG nodes, excluding system-reserved IDs. */
  readonly master_ledger: Record<string, ATMSDecisionNode>;

  /** Directed dependency edges (`fromDecisionId -> toDecisionId`) in the ATMS DAG. */
  readonly ledger_edges: DirectedDecisionEdge[];

  /** Project-scoped concept taxonomy state (null-coalescing last-write). */
  readonly project_taxonomy: ProjectTaxonomyState | null;

  /** Decisions that failed conformal prediction criteria in the current cycle. */
  readonly unresolved_ledger: UnresolvedDecision[];

  /** Section targets affected by ATMS DAG invalidation or override cascades. */
  readonly invalidation_map: Record<string, SectionTarget[]>;

  /** Queued file creation or soft-deletion actions. */
  readonly pending_file_actions: PendingFileLifecycleAction[];

  /** Structured question batch for human-in-the-loop interrupts. */
  readonly question_queue: ClarifyingQuestionBatch | null;

  /** User responses collected upon HITL resumption. */
  readonly clarification_answers: Record<string, unknown> | null;

  /** Credit budget tracking using decimal string micro-units. */
  readonly budget_tracking: BudgetTrackingState;

  /** Monotonic search loop counter, bounded by `MAX_SEARCH_LOOPS` (3). */
  readonly search_loop_count: number;
}

/**
 * State delta emitted by graph nodes and applied via `applyStateDelta`.
 */
export type AgentGraphStateDelta = Partial<AgentGraphState> & {
  readonly clearInvalidationMap?: boolean;
  readonly replaceMasterLedger?: boolean;
};

// ---------------------------------------------------------------------------
// State Factory & Pure Transition Application
// ---------------------------------------------------------------------------

const DEFAULT_USER_REQUEST: UserRequest = {
  prompt: "",
  workspaceId: "",
  turnId: "",
  targetFileIds: [],
  permissionMode: "safe",
  selectedSystem2ModelId: "google/gemini-3.8-flash",
};

/**
 * Constructs a complete, JSON-serializable 18-channel `AgentGraphState`
 * with deterministic defaults and optional overrides.
 */
export function createInitialAgentGraphState(
  overrides?: Partial<AgentGraphState>,
): AgentGraphState {
  return {
    messages: overrides?.messages ? [...overrides.messages] : [],
    user_request: overrides?.user_request ?? { ...DEFAULT_USER_REQUEST },
    classified_intent: overrides?.classified_intent ?? null,
    search_report: overrides?.search_report ?? {
      evidenceItems: [],
      inspectedPaths: [],
      summary: "",
    },
    local_inspection_state: overrides?.local_inspection_state
      ? [...overrides.local_inspection_state]
      : [],
    assumptions: overrides?.assumptions ? [...overrides.assumptions] : [],
    governing_constraints: overrides?.governing_constraints
      ? [...overrides.governing_constraints]
      : [],
    scored_decisions: overrides?.scored_decisions
      ? [...overrides.scored_decisions]
      : [],
    master_ledger: overrides?.master_ledger ? { ...overrides.master_ledger } : {},
    ledger_edges: overrides?.ledger_edges ? [...overrides.ledger_edges] : [],
    project_taxonomy: overrides?.project_taxonomy ?? null,
    unresolved_ledger: overrides?.unresolved_ledger
      ? [...overrides.unresolved_ledger]
      : [],
    invalidation_map: overrides?.invalidation_map
      ? { ...overrides.invalidation_map }
      : {},
    pending_file_actions: overrides?.pending_file_actions
      ? [...overrides.pending_file_actions]
      : [],
    question_queue: overrides?.question_queue ?? null,
    clarification_answers: overrides?.clarification_answers ?? null,
    budget_tracking: overrides?.budget_tracking ?? {
      reservedMicro: "0",
      spentMicro: "0",
    },
    search_loop_count: overrides?.search_loop_count ?? 0,
  };
}

/**
 * Applies a partial node state delta to the current `AgentGraphState` using
 * deterministic, side-effect-free channel reducers.
 */
export function applyStateDelta(
  current: AgentGraphState,
  delta: AgentGraphStateDelta,
): AgentGraphState {
  const nextInvalidationMap =
    delta.clearInvalidationMap === true
      ? delta.invalidation_map
        ? reduceInvalidationMap({}, delta.invalidation_map)
        : {}
      : delta.invalidation_map
        ? reduceInvalidationMap(current.invalidation_map, delta.invalidation_map)
        : current.invalidation_map;

  return {
    messages:
      delta.messages !== undefined
        ? reduceMessages(current.messages, delta.messages)
        : current.messages,
    user_request:
      delta.user_request !== undefined ? delta.user_request : current.user_request,
    classified_intent:
      delta.classified_intent !== undefined
        ? delta.classified_intent
        : current.classified_intent,
    search_report:
      delta.search_report !== undefined
        ? reduceSearchReport(current.search_report, delta.search_report)
        : current.search_report,
    local_inspection_state:
      delta.local_inspection_state !== undefined
        ? reduceLocalInspectionState(
            current.local_inspection_state,
            delta.local_inspection_state,
          )
        : current.local_inspection_state,
    assumptions:
      delta.assumptions !== undefined
        ? reduceAssumptions(current.assumptions, delta.assumptions)
        : current.assumptions,
    governing_constraints:
      delta.governing_constraints !== undefined
        ? delta.governing_constraints
        : current.governing_constraints,
    scored_decisions:
      delta.scored_decisions !== undefined
        ? delta.scored_decisions
        : current.scored_decisions,
    master_ledger:
      delta.replaceMasterLedger === true
        ? reduceMasterLedger({}, delta.master_ledger ?? {})
        : delta.master_ledger !== undefined
          ? reduceMasterLedger(current.master_ledger, delta.master_ledger)
          : current.master_ledger,
    ledger_edges:
      delta.ledger_edges !== undefined ? delta.ledger_edges : current.ledger_edges,
    project_taxonomy:
      delta.project_taxonomy !== undefined
        ? reduceProjectTaxonomy(current.project_taxonomy, delta.project_taxonomy)
        : current.project_taxonomy,
    unresolved_ledger:
      delta.unresolved_ledger !== undefined
        ? delta.unresolved_ledger
        : current.unresolved_ledger,
    invalidation_map: nextInvalidationMap,
    pending_file_actions:
      delta.pending_file_actions !== undefined
        ? delta.pending_file_actions
        : current.pending_file_actions,
    question_queue:
      delta.question_queue !== undefined
        ? delta.question_queue
        : current.question_queue,
    clarification_answers:
      delta.clarification_answers !== undefined
        ? delta.clarification_answers
        : current.clarification_answers,
    budget_tracking:
      delta.budget_tracking !== undefined
        ? reduceBudgetTracking(current.budget_tracking, delta.budget_tracking)
        : current.budget_tracking,
    search_loop_count:
      delta.search_loop_count !== undefined
        ? reduceSearchLoopCount(current.search_loop_count, delta.search_loop_count)
        : current.search_loop_count,
  };
}
