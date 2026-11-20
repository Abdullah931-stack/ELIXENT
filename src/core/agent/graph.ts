/**
 * Elixent Native Graph Engine Assembly (ADR-009, ADR-010 & SRS-01 §3.1–§3.2)
 *
 * Assembles the 9 replay-safe canonical nodes and 6 deterministic
 * state-predicate routing gates (`G-01..G-06`) on `ElixentNativeGraphRunner`.
 *
 * Topology:
 * - Entry: `intent_and_scope_router_node` (Node 1)
 * - Gates: `G-01..G-06` + `gateAfterHitlClarification`
 * - Terminal (`null` / END): `workspace_mutator_node` (Node 8) & `direct_response_node` (Node 9)
 * - Max super-steps: 25
 */

import {
  ElixentNativeGraphRunner,
  type AgentGraphGateFn,
  type AgentGraphNodeFn,
} from "@/core/agent/engine/runner";
import type { AgentGraphState } from "@/core/agent/state";

// 9 Replay-Safe Canonical Nodes (Wave 3.2)
import { intentAndScopeRouterNode } from "./nodes/orchestrator-node";
import { searchDiscoveryNode } from "./nodes/search-nodes";
import {
  assumptionExtractorNode,
  conflictAndWeightGateNode,
} from "./nodes/assumption-and-linker-nodes";
import { jevConformalScorerNode } from "./nodes/jev-scoring-nodes";
import { hitlClarificationNode } from "./nodes/hitl-nodes";
import { ledgerCommitNode } from "./nodes/resolution-and-ledger-nodes";
import { workspaceMutatorNode } from "./nodes/document-writer-node";
import { directResponseNode } from "./nodes/direct-response-node";

// ---------------------------------------------------------------------------
// Canonical 9-Node Identifiers (SRS-01 §3.1)
// ---------------------------------------------------------------------------

/** Node 1: Stage 0 Intent & Scope Router */
export const INTENT_AND_SCOPE_ROUTER_NODE = "intent_and_scope_router_node";

/** Node 2: Stage 1 Search Discovery */
export const SEARCH_DISCOVERY_NODE = "search_discovery_node";

/** Node 3: Stage 2 Assumption Extractor */
export const ASSUMPTION_EXTRACTOR_NODE = "assumption_extractor_node";

/** Node 4: Stage 2 Conflict & Weight Gate (ATMS + Anti-Domino) */
export const CONFLICT_AND_WEIGHT_GATE_NODE = "conflict_and_weight_gate_node";

/** Node 5: Stage 3–4 JEV Conformal Scorer */
export const JEV_CONFORMAL_SCORER_NODE = "jev_conformal_scorer_node";

/** Node 6: Stage 6 HITL Clarification & Deletion Approval */
export const HITL_CLARIFICATION_NODE = "hitl_clarification_node";

/** Node 7: Stage 5 ATMS Ledger Commit */
export const LEDGER_COMMIT_NODE = "ledger_commit_node";

/** Node 8: Stage 7 Workspace Mutator (Diff3 / Ghost / File Lifecycle) */
export const WORKSPACE_MUTATOR_NODE = "workspace_mutator_node";

/** Node 9: Stage 7 Direct Conversational / Query Response */
export const DIRECT_RESPONSE_NODE = "direct_response_node";

// ---------------------------------------------------------------------------
// 6 Deterministic State-Predicate Routing Gates (SRS-01 §3.2)
// ---------------------------------------------------------------------------

/**
 * Gate G-01 (from Node 1 `intent_and_scope_router_node`):
 * - `CHAT_ONLY` -> `direct_response_node` (Node 9)
 * - All other intents -> `search_discovery_node` (Node 2)
 */
export const gateG01: AgentGraphGateFn = (
  state: Readonly<AgentGraphState>,
): string => {
  if (state.classified_intent === "CHAT_ONLY") {
    return DIRECT_RESPONSE_NODE;
  }
  return SEARCH_DISCOVERY_NODE;
};

/**
 * Gate G-02 (from Node 2 `search_discovery_node`):
 * - `WORKSPACE_READ_SEARCH` | `DECISION_LEDGER_QUERY` -> `direct_response_node` (Node 9)
 * - `FAST_LOCAL_EDIT` -> `workspace_mutator_node` (Node 8)
 * - Architectural / multi-file / structure mutation intents -> `assumption_extractor_node` (Node 3)
 */
export const gateG02: AgentGraphGateFn = (
  state: Readonly<AgentGraphState>,
): string => {
  if (
    state.classified_intent === "WORKSPACE_READ_SEARCH" ||
    state.classified_intent === "DECISION_LEDGER_QUERY"
  ) {
    return DIRECT_RESPONSE_NODE;
  }
  if (state.classified_intent === "FAST_LOCAL_EDIT") {
    return WORKSPACE_MUTATOR_NODE;
  }
  return ASSUMPTION_EXTRACTOR_NODE;
};

/**
 * Gate G-03 (from Node 3 `assumption_extractor_node`):
 * - Zero assumptions AND empty invalidation map -> `workspace_mutator_node` (Node 8)
 * - Otherwise -> `conflict_and_weight_gate_node` (Node 4)
 */
export const gateG03: AgentGraphGateFn = (
  state: Readonly<AgentGraphState>,
): string => {
  if (
    state.assumptions.length === 0 &&
    Object.keys(state.invalidation_map).length === 0
  ) {
    return WORKSPACE_MUTATOR_NODE;
  }
  return CONFLICT_AND_WEIGHT_GATE_NODE;
};

/**
 * Gate G-04 (from Node 4 `conflict_and_weight_gate_node`):
 * - Anti-Domino `ESCALATE_TO_HITL` triggered (`state.question_queue !== null`) -> `hitl_clarification_node` (Node 6)
 * - Contextual evidence gap flagged AND `state.search_loop_count < 3` -> `search_discovery_node` (Node 2)
 * - Otherwise -> `jev_conformal_scorer_node` (Node 5)
 */
export const gateG04: AgentGraphGateFn = (
  state: Readonly<AgentGraphState>,
): string => {
  if (state.question_queue !== null) {
    return HITL_CLARIFICATION_NODE;
  }

  const hasEvidenceGap =
    state.search_loop_count < 3 &&
    state.search_report.inspectedPaths.length > 0 &&
    state.assumptions.some((assumption) =>
      assumption.affectedSections.some(
        (sec) =>
          !state.search_report.evidenceItems.some(
            (ev) => ev.fileId === sec.fileId,
          ),
      ),
    );

  if (hasEvidenceGap) {
    return SEARCH_DISCOVERY_NODE;
  }

  return JEV_CONFORMAL_SCORER_NODE;
};

/**
 * Gate G-05 (from Node 5 `jev_conformal_scorer_node`):
 * - `unresolved_ledger.length > 0` OR unapproved `DELETE_FILE` in `safe`/`semi_auto` -> `hitl_clarification_node` (Node 6)
 * - Otherwise -> `ledger_commit_node` (Node 7)
 */
export const gateG05: AgentGraphGateFn = (
  state: Readonly<AgentGraphState>,
): string => {
  const hasUnapprovedDeletion = state.pending_file_actions.some(
    (action) =>
      action.type === "DELETE_FILE" &&
      action.approved !== true &&
      state.user_request.permissionMode !== "full_auto",
  );

  if (state.unresolved_ledger.length > 0 || hasUnapprovedDeletion) {
    return HITL_CLARIFICATION_NODE;
  }

  return LEDGER_COMMIT_NODE;
};

/**
 * Outgoing gate from Node 6 (`hitl_clarification_node`) upon HITL resumption:
 * - If Node 4 escalated Anti-Domino directly to Node 6 (`G-04 -> Node 6`, skipping Node 5)
 *   and resumption still leaves unconstrained assumptions with `scored_decisions.length === 0`,
 *   route to `jev_conformal_scorer_node` (Node 5) to score them before committing.
 * - Otherwise route directly to `ledger_commit_node` (Node 7).
 */
export const gateAfterHitlClarification: AgentGraphGateFn = (
  state: Readonly<AgentGraphState>,
): string => {
  const hasUnconstrainedAssumptions = state.assumptions.some(
    (assumption) =>
      !(assumption as { constrainedByPrior?: boolean }).constrainedByPrior,
  );

  if (hasUnconstrainedAssumptions && state.scored_decisions.length === 0) {
    return JEV_CONFORMAL_SCORER_NODE;
  }

  return LEDGER_COMMIT_NODE;
};

/**
 * Gate G-06 (from Node 7 `ledger_commit_node`):
 * - No `.md` target sections or file lifecycle mutations pending -> `direct_response_node` (Node 9)
 * - `.md` mutations or file creation/deletion pending -> `workspace_mutator_node` (Node 8)
 */
export const gateG06: AgentGraphGateFn = (
  state: Readonly<AgentGraphState>,
): string => {
  if (
    Object.keys(state.invalidation_map).length === 0 &&
    state.pending_file_actions.length === 0 &&
    state.user_request.targetFileIds.length === 0
  ) {
    return DIRECT_RESPONSE_NODE;
  }
  return WORKSPACE_MUTATOR_NODE;
};

// ---------------------------------------------------------------------------
// Native Graph Runner Factory & Production Singleton
// ---------------------------------------------------------------------------

/**
 * Options for constructing an `ElixentNativeGraphRunner` instance.
 */
export interface ElixentAgentGraphOptions {
  readonly maxSuperSteps?: number;
}

/**
 * Factory function assembling all 9 canonical nodes and 6 deterministic
 * routing gates (`G-01..G-06`) onto `ElixentNativeGraphRunner`.
 */
export function createElixentAgentGraph(
  options?: ElixentAgentGraphOptions,
): ElixentNativeGraphRunner {
  const nodes: Record<string, AgentGraphNodeFn> = {
    [INTENT_AND_SCOPE_ROUTER_NODE]: intentAndScopeRouterNode,
    [SEARCH_DISCOVERY_NODE]: searchDiscoveryNode,
    [ASSUMPTION_EXTRACTOR_NODE]: assumptionExtractorNode,
    [CONFLICT_AND_WEIGHT_GATE_NODE]: conflictAndWeightGateNode,
    [JEV_CONFORMAL_SCORER_NODE]: jevConformalScorerNode,
    [HITL_CLARIFICATION_NODE]: hitlClarificationNode,
    [LEDGER_COMMIT_NODE]: ledgerCommitNode,
    [WORKSPACE_MUTATOR_NODE]: workspaceMutatorNode,
    [DIRECT_RESPONSE_NODE]: directResponseNode,
  };

  const edges: Record<string, string | AgentGraphGateFn | null> = {
    [INTENT_AND_SCOPE_ROUTER_NODE]: gateG01,
    [SEARCH_DISCOVERY_NODE]: gateG02,
    [ASSUMPTION_EXTRACTOR_NODE]: gateG03,
    [CONFLICT_AND_WEIGHT_GATE_NODE]: gateG04,
    [JEV_CONFORMAL_SCORER_NODE]: gateG05,
    [HITL_CLARIFICATION_NODE]: gateAfterHitlClarification,
    [LEDGER_COMMIT_NODE]: gateG06,
    [WORKSPACE_MUTATOR_NODE]: null,
    [DIRECT_RESPONSE_NODE]: null,
  };

  return new ElixentNativeGraphRunner({
    entryNodeId: INTENT_AND_SCOPE_ROUTER_NODE,
    nodes,
    edges,
    maxSuperSteps: options?.maxSuperSteps ?? 25,
  });
}

/**
 * Type alias for the Elixent Native Graph Engine runner.
 */
export type ElixentAgentGraph = ElixentNativeGraphRunner;

/**
 * Production singleton instance of the Elixent Native Graph Engine.
 */
export const elixentAgentGraph: ElixentNativeGraphRunner =
  createElixentAgentGraph();
