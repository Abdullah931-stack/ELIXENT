/**
 * Elixent LangGraph StateGraph Assembly
 *
 * Assembles the full autonomous decision-making and architectural adjudication
 * state machine according to ELIXENT-ARCH-02 §1, §2, & §3.
 *
 * Topology:
 * - 14 Nodes across Stages 0 to 7
 * - 3 Conditional Edge Routers:
 *   1. `toolsCondition`: Stage 1 inspection loop
 *   2. `routeAfterAssumptions`: Stage 2 assumption gate
 *   3. `resolutionGateRouter`: Stage 5 four-way resolution gate
 * - Entry from START to `orchestrator_node`
 * - Terminal transition from `document_writer_node` to END
 * - Production checkpointer: `PostgresSaver` with `EncryptedCheckpointSerializer` (AES-256-GCM)
 */

import {
  StateGraph,
  START,
  END,
  MemorySaver,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getPgPool } from "@/server/db";
import { EncryptedCheckpointSerializer } from "@/core/agent/checkpoint-serializer";
import {
  AgentGraphAnnotation,
  type AgentGraphState,
} from "@/core/agent/state";

// Stage 0 Orchestrator Node
import { orchestratorNode } from "./nodes/orchestrator-node";

// Stage 1 Search Nodes & Router
import {
  searchAgentNode,
  workspaceToolNode,
  searchSynthesizerNode,
  toolsCondition,
} from "./nodes/search-nodes";

// Stage 2 Assumption & Linker Nodes & Router
import {
  assumptionAnalyzerNode,
  atmsRelationalLinkerNode,
  routeAfterAssumptions,
} from "./nodes/assumption-and-linker-nodes";

// Stage 3 JEV Scoring Nodes
import {
  jevStructuringNode,
  decisionScorerNode,
} from "./nodes/jev-scoring-nodes";

// Stages 4 & 5 Resolution & Ledger Commit Nodes & Router
import {
  confidenceClassifierNode,
  ledgerCommitNode,
  internalGapPlannerNode,
  resolutionGateRouter,
} from "./nodes/resolution-and-ledger-nodes";

// Stage 6 HITL Nodes
import {
  questionOrganizerNode,
  pureInterruptNode,
} from "./nodes/hitl-nodes";

// Stage 7 Document Writer Node
import { documentWriterNode } from "./nodes/document-writer-node";

// ---------------------------------------------------------------------------
// Canonical Node Name Constants
// ---------------------------------------------------------------------------

/** Stage 0 Master Orchestrator Node identifier */
export const ORCHESTRATOR_NODE = "orchestrator_node";

/** Stage 1 Local Inspection Agent Node identifier */
export const SEARCH_AGENT_NODE = "search_agent_node";

/** Stage 1 Deterministic Workspace Tool Execution Node identifier */
export const WORKSPACE_TOOL_NODE = "workspace_tool_node";

/** Stage 1 Evidence Report Synthesizer Node identifier */
export const SEARCH_SYNTHESIZER_NODE = "search_synthesizer_node";

/** Stage 2 Assumption Analyzer & Tag Classifier Node identifier */
export const ASSUMPTION_ANALYZER_NODE = "assumption_analyzer_node";

/** Stage 2 Relational Adjudication & Rationale Audit Node identifier */
export const ATMS_RELATIONAL_LINKER_NODE = "atms_relational_linker_node";

/** Stage 3 Option & Rationale Neutralization Node identifier */
export const JEV_STRUCTURING_NODE = "jev_structuring_node";

/** Stage 3 Parallel Decision Scorer Node identifier */
export const DECISION_SCORER_NODE = "decision_scorer_node";

/** Stage 4 Deterministic Mathematical Classifier Node identifier */
export const CONFIDENCE_CLASSIFIER_NODE = "confidence_classifier_node";

/** Stage 5 ATMS DAG Commit & Dependency Invalidation Node identifier */
export const LEDGER_COMMIT_NODE = "ledger_commit_node";

/** Stage 5 Supplementary Search Planner Node identifier */
export const INTERNAL_GAP_PLANNER_NODE = "internal_gap_planner_node";

/** Stage 6 Diagnostic Question Batch Organizer Node identifier */
export const QUESTION_ORGANIZER_NODE = "question_organizer_node";

/** Stage 6 Replay-Safe Pure Interrupt Node identifier */
export const PURE_INTERRUPT_NODE = "pure_interrupt_node";

/** Stage 7 Document Writer & Structural Merge Node identifier */
export const DOCUMENT_WRITER_NODE = "document_writer_node";

// ---------------------------------------------------------------------------
// StateGraph Workflow Construction
// ---------------------------------------------------------------------------

/**
 * Builds and configures the uncompiled StateGraph workflow connecting all
 * 14 canonical nodes and 3 conditional edge routers.
 *
 * @returns Configured StateGraph builder instance.
 */
export function buildAgentWorkflow(): StateGraph<
  typeof AgentGraphAnnotation,
  AgentGraphState
> {
  const workflow = new StateGraph(AgentGraphAnnotation)
    // 14 Nodes
    .addNode(ORCHESTRATOR_NODE, orchestratorNode)
    .addNode(SEARCH_AGENT_NODE, searchAgentNode)
    .addNode(WORKSPACE_TOOL_NODE, workspaceToolNode)
    .addNode(SEARCH_SYNTHESIZER_NODE, searchSynthesizerNode)
    .addNode(ASSUMPTION_ANALYZER_NODE, assumptionAnalyzerNode)
    .addNode(ATMS_RELATIONAL_LINKER_NODE, atmsRelationalLinkerNode)
    .addNode(JEV_STRUCTURING_NODE, jevStructuringNode)
    .addNode(DECISION_SCORER_NODE, decisionScorerNode)
    .addNode(CONFIDENCE_CLASSIFIER_NODE, confidenceClassifierNode)
    .addNode(LEDGER_COMMIT_NODE, ledgerCommitNode)
    .addNode(INTERNAL_GAP_PLANNER_NODE, internalGapPlannerNode)
    .addNode(QUESTION_ORGANIZER_NODE, questionOrganizerNode)
    .addNode(PURE_INTERRUPT_NODE, pureInterruptNode)
    .addNode(DOCUMENT_WRITER_NODE, documentWriterNode);

  // 1. Entry Transition: START -> orchestrator_node -> search_agent_node
  workflow.addEdge(START, ORCHESTRATOR_NODE);
  workflow.addEdge(ORCHESTRATOR_NODE, SEARCH_AGENT_NODE);

  // 2. Stage 1 Conditional Inspection Loop
  workflow.addConditionalEdges(SEARCH_AGENT_NODE, toolsCondition, {
    [WORKSPACE_TOOL_NODE]: WORKSPACE_TOOL_NODE,
    [SEARCH_SYNTHESIZER_NODE]: SEARCH_SYNTHESIZER_NODE,
  });
  workflow.addEdge(WORKSPACE_TOOL_NODE, SEARCH_AGENT_NODE);
  workflow.addEdge(SEARCH_SYNTHESIZER_NODE, ASSUMPTION_ANALYZER_NODE);

  // 3. Stage 2 Assumption Analysis -> ATMS Linker -> Conditional Edge Gate
  workflow.addEdge(ASSUMPTION_ANALYZER_NODE, ATMS_RELATIONAL_LINKER_NODE);
  workflow.addConditionalEdges(ATMS_RELATIONAL_LINKER_NODE, routeAfterAssumptions, {
    [JEV_STRUCTURING_NODE]: JEV_STRUCTURING_NODE,
    [DOCUMENT_WRITER_NODE]: DOCUMENT_WRITER_NODE,
    [SEARCH_AGENT_NODE]: SEARCH_AGENT_NODE,
  });

  // 4. Stage 3 Auditing -> Scoring -> Stage 4 Confidence Classifier
  workflow.addEdge(JEV_STRUCTURING_NODE, DECISION_SCORER_NODE);
  workflow.addEdge(DECISION_SCORER_NODE, CONFIDENCE_CLASSIFIER_NODE);

  // 5. Stage 4 & 5 Deterministic Triage -> Ledger Commit -> Four-Way Gate
  workflow.addEdge(CONFIDENCE_CLASSIFIER_NODE, LEDGER_COMMIT_NODE);
  workflow.addConditionalEdges(LEDGER_COMMIT_NODE, resolutionGateRouter, {
    [DOCUMENT_WRITER_NODE]: DOCUMENT_WRITER_NODE,
    [INTERNAL_GAP_PLANNER_NODE]: INTERNAL_GAP_PLANNER_NODE,
    [QUESTION_ORGANIZER_NODE]: QUESTION_ORGANIZER_NODE,
    [PURE_INTERRUPT_NODE]: PURE_INTERRUPT_NODE,
  });

  // 6. Resolution Gate Edge Continuations
  workflow.addEdge(INTERNAL_GAP_PLANNER_NODE, SEARCH_AGENT_NODE);
  workflow.addEdge(QUESTION_ORGANIZER_NODE, PURE_INTERRUPT_NODE);
  workflow.addEdge(PURE_INTERRUPT_NODE, ASSUMPTION_ANALYZER_NODE);

  // 7. Stage 7 Terminal Transition: document_writer_node -> END
  workflow.addEdge(DOCUMENT_WRITER_NODE, END);

  return workflow as unknown as StateGraph<
    typeof AgentGraphAnnotation,
    AgentGraphState
  >;
}

/** Pre-configured StateGraph builder instance */
export const workflow = buildAgentWorkflow();

// ---------------------------------------------------------------------------
// Checkpointer & Factory (G-1 & G-2)
// ---------------------------------------------------------------------------

/**
 * Instantiates and returns the production PostgreSQL checkpointer.
 *
 * Configures `PostgresSaver` with the global PostgreSQL pool and
 * `EncryptedCheckpointSerializer` (AES-256-GCM) per G-1.
 *
 * @returns Configured PostgresSaver checkpointer instance.
 */
export function getProductionCheckpointer(): PostgresSaver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PostgresSaver(getPgPool() as any, new EncryptedCheckpointSerializer());
}

/**
 * Options for configuring and compiling the Elixent agent graph.
 */
export interface ElixentAgentGraphOptions {
  /**
   * Optional custom checkpoint saver (e.g. MemorySaver for testing).
   * Defaults to production PostgresSaver via `getProductionCheckpointer()`.
   */
  checkpointer?: BaseCheckpointSaver;
}

/**
 * Factory function that compiles the Elixent agent state graph with the specified
 * or default production checkpointer.
 *
 * @param options - Optional compilation settings including custom checkpointer.
 * @returns Compiled StateGraph instance ready for invocation or streaming.
 */
export function createElixentAgentGraph(options?: ElixentAgentGraphOptions) {
  const checkpointer = options?.checkpointer ?? getProductionCheckpointer();
  return workflow.compile({ checkpointer });
}

/**
 * Type alias for the compiled Elixent Agent StateGraph.
 */
export type ElixentAgentGraph = ReturnType<typeof createElixentAgentGraph>;

// ---------------------------------------------------------------------------
// Lazy Singleton Production Instance
// ---------------------------------------------------------------------------

let singletonGraph: ElixentAgentGraph | null = null;

/**
 * Lazily initializes and returns the singleton compiled agent graph for production.
 *
 * @returns Compiled agent graph instance configured with PostgresSaver.
 */
export function getElixentAgentGraph(): ElixentAgentGraph {
  if (!singletonGraph) {
    singletonGraph = createElixentAgentGraph();
  }
  return singletonGraph;
}

/**
 * Compiled Elixent Agent StateGraph configured with the production checkpointer.
 * Lazily evaluated via Proxy on first access to prevent eager database initialization
 * during unit test execution or offline runs.
 */
export const elixentAgentGraph: ElixentAgentGraph = new Proxy(
  {} as ElixentAgentGraph,
  {
    get(_target, prop, receiver) {
      const graph = getElixentAgentGraph();
      const value = Reflect.get(graph, prop, receiver);
      return typeof value === "function" ? value.bind(graph) : value;
    },
  },
);

export { START, END, MemorySaver };
