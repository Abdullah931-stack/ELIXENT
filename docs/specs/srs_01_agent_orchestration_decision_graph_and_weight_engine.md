# Software Requirements Specification (SRS-01): Agent Orchestration Engine, Canonical Decision Graph (`decisions.ledger.json`), and Deterministic Change Weight Gate

| Standard Field              | Approved Value                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document ID**             | `ELIXENT-SRS-01-ORCHESTRATION-v1.1`                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Classification**          | `SOFTWARE REQUIREMENTS SPECIFICATION (SUBSYSTEM 1 OF 4)`                                                                                                                                                                                                                                                                                                                                                                                         |
| **Governing ADRs**          | [`ADR-009`](../architecture/adrs/adr_009_native_graph_orchestration_engine.md), [`ADR-010`](../architecture/adrs/adr_010_replay_safe_node_boundary_topology.md), [`ADR-012`](../architecture/adrs/adr_012_json_decision_ledger_and_graph_traversal.md), [`ADR-013`](../architecture/adrs/adr_013_epistemic_framing_decoupling_system2_system1.md), [`ADR-014`](../architecture/adrs/adr_014_deterministic_change_weight_and_anti_domino_gate.md) |
| **Reference Baseline**      | `Elixent v0.26.0` (`Vite 6 SPA + TanStack Router + Hono RPC`)                                                                                                                                                                                                                                                                                                                                                                                    |
| **Target Repository Scope** | `../../src/core/agent/engine/**`, `../../src/core/agent/state.ts`, `../../src/core/agent/reducers.ts`, `../../src/core/agent/nodes/**`, `../../src/core/agent/atms/**`, `../../src/core/agent/tools/decision-graph-tools.ts`, `../../src/core/agent/schemas/decision-schemas.ts`, `../../src/lib/jev/**`, `../../src/server/routes/agent.routes.ts`, `../../src/server/db/schema/agent-checkpoints.ts`                                           |
| **Status**                  | `IMPLEMENTED & VERIFIED — Phases 3 & 6 Release Gate Closed (v0.29.0)`                                                                                                                                                                                                                                                                                                                                                                                                    |

## 1. Purpose, Scope & Architectural Traceability

This Software Requirements Specification (**SRS-01**) defines the exact functional contracts, TypeScript/Zod interfaces, state-machine execution rules, mathematical formulas, and node-level algorithms for the **Elixent Agent Orchestration & Decision Engine**.

| Requirement Group         | Governing ADR                                                                                 | Target Source Modules                                                                                                                                | Core Engineering Objective                                                                                                                                                                                                           |
| :------------------------ | :-------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`REQ-ORCH-01 .. 05`**   | [`ADR-009`](../architecture/adrs/adr_009_native_graph_orchestration_engine.md)                | `../../src/core/agent/engine/**`, `../../src/core/agent/state.ts`, `../../src/server/db/schema/agent-checkpoints.ts`                                 | Replace `@langchain/langgraph` and `PostgresSaver` with `Elixent Native Graph Engine`, separating `AgentRuntimeContext` from `AgentGraphState` and persisting single-table encrypted checkpoints (`agent_checkpoints`).              |
| **`REQ-TOPO-01 .. 06`**   | [`ADR-010`](../architecture/adrs/adr_010_replay_safe_node_boundary_topology.md)               | `../../src/core/agent/nodes/**`, `../../src/core/agent/graph.ts`                                                                                     | Implement the 9 Replay-Safe Canonical Nodes, 6 deterministic State-Predicate routing gates (`G-01..G-06`), 9+ input pattern routing, and full generative editing in `workspace_mutator_node` without silent HTML alignment comments. |
| **`REQ-LEDGER-01 .. 04`** | [`ADR-012`](../architecture/adrs/adr_012_json_decision_ledger_and_graph_traversal.md)         | `../../src/core/agent/atms/dag.ts`, `../../src/core/agent/tools/decision-graph-tools.ts`, `../../src/core/agent/nodes/search-nodes.ts`, `../../src/core/agent/nodes/resolution-and-ledger-nodes.ts` | Replace the SQL `project_decision_ledger` table with `decisions.ledger.json` (`DecisionLedgerDocument v2.0`) and provide 4 deterministic graph-exploration tools inside `search_discovery_node`.                                     |
| **`REQ-EPIST-01 .. 03`**  | [`ADR-013`](../architecture/adrs/adr_013_epistemic_framing_decoupling_system2_system1.md)     | `../../src/core/agent/schemas/decision-schemas.ts`, `../../src/lib/jev/client.ts`, `../../src/core/agent/nodes/jev-scoring-nodes.ts`                 | Eliminate `System 2` pre-scoring `rationaleAndPremises`, ground `POST /v1/decisions` in verbatim `search_report.evidenceItems` and governing prior decisions, and synthesize rationales post-adjudication.                           |
| **`REQ-WEIGHT-01 .. 04`** | [`ADR-014`](../architecture/adrs/adr_014_deterministic_change_weight_and_anti_domino_gate.md) | `../../src/core/agent/atms/invalidation.ts`, `../../src/core/agent/nodes/assumption-and-linker-nodes.ts`                                             | Compute the deterministic 4-source Change Weight $W(d) \in [10, 100]$ and enforce the Intent-Aware Anti-Domino Override Gate (`CONSTRAINED_BY_PRIOR`, `ESCALATE_TO_HITL`, `LOCALIZED_OVERRIDE`).                                     |

## 2. Native Graph Runtime & Checkpoint Specification (`ADR-009`)

### 2.1. Removal of `@langchain/*` Dependencies (`REQ-ORCH-01`)

1. `../../package.json` MUST remove `@langchain/langgraph`, `@langchain/core`, and `@langchain/langgraph-checkpoint-postgres`.
2. `../../src/server/db/schema/langgraph-checkpoints.ts` (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`) MUST be retired and replaced by `../../src/server/db/schema/agent-checkpoints.ts`.

### 2.2. Consolidated Encrypted Checkpoint Schema (`REQ-ORCH-02`)

File: `../../src/server/db/schema/agent-checkpoints.ts`

```typescript
import {
  pgTable,
  text,
  integer,
  uuid,
  timestamp,
  customType,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { workspaces } from "./workspaces";

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const agentCheckpoints = pgTable(
  "agent_checkpoints",
  {
    threadId: text("thread_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    status: text("status")
      .$type<"RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED">()
      .notNull(),
    nextNodeId: text("next_node_id"),
    interruptReason: text("interrupt_reason").$type<
      | "HITL_CLARIFICATION_REQUIRED"
      | "FILE_DELETION_APPROVAL_REQUIRED"
      | "ANTI_DOMINO_CONFIRMATION_REQUIRED"
      | "INSUFFICIENT_CREDITS"
      | null
    >(),
    encryptedStateBlob: bytea("encrypted_state_blob").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.stepIndex] }),
    index("idx_agent_checkpoints_workspace_thread").on(
      table.workspaceId,
      table.threadId,
    ),
  ],
);
```

- **Zero-Knowledge Leak Guard:** Before encrypting `AgentGraphState` into `encryptedStateBlob`, `encryptAgentGraphState` (`../../src/core/agent/checkpoint-serializer.ts`) MUST invoke `getActiveEphemeralVaultPlaintexts()` (`../../src/lib/vault/ephemeral-memory-map.ts`) and assert that zero active decrypted vault strings appear anywhere inside the serialized state JSON.

### 2.3. Separation of `AgentRuntimeContext` and `AgentGraphState` (`REQ-ORCH-03`)

Files: `../../src/core/agent/engine/runner.ts` & `../../src/core/agent/state.ts`

```typescript
export interface AgentRuntimeContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly permissionMode: AgentPermissionMode;
  readonly selectedSystem2ModelId: string;
  readonly workspaceProvider: IWorkspaceProvider;
  readonly streamGovernor: StreamGovernor;
  readonly ephemeralVaultPayloads: ReadonlyMap<string, string>;
  readonly liveDocumentSnapshots: ReadonlyMap<string, string>;
  readonly emitSseEvent: (event: AgentStreamEvent) => void;
  readonly abortSignal: AbortSignal;
}

export type NodeExecutionResult =
  | {
      readonly status: "COMPLETED";
      readonly stateDelta: Partial<AgentGraphState>;
    }
  | {
      readonly status: "INTERRUPTED";
      readonly interruptReason:
        | "HITL_CLARIFICATION_REQUIRED"
        | "FILE_DELETION_APPROVAL_REQUIRED"
        | "ANTI_DOMINO_CONFIRMATION_REQUIRED"
        | "INSUFFICIENT_CREDITS";
      readonly stateDelta: Partial<AgentGraphState>;
      readonly interruptPayload: Record<string, unknown>;
    };

export type AgentGraphNodeFn<TNodeId extends string = string> = (
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
) => Promise<NodeExecutionResult>;
```

```typescript
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

export type AgentPermissionMode = "safe" | "semi_auto" | "full_auto";

export interface AgentConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: string;
  readonly createdAt: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface PendingFileLifecycleAction {
  readonly actionId: string;
  readonly type: "CREATE_FILE" | "DELETE_FILE";
  readonly relativePath: string;
  readonly fileId?: string;
  readonly initialContent?: string;
  readonly rationale: string;
  readonly approved?: boolean;
}

export interface AgentGraphState {
  readonly messages: readonly AgentConversationMessage[];
  readonly user_request: {
    readonly prompt: string;
    readonly workspaceId: string;
    readonly turnId: string;
    readonly targetFileIds: readonly string[];
    readonly permissionMode: AgentPermissionMode;
    readonly selectedSystem2ModelId: string;
  };
  readonly classified_intent: InputIntentCategory | null;
  readonly search_report: SearchReport;
  readonly local_inspection_state: readonly string[];
  readonly assumptions: readonly AssumptionItem[];
  readonly governing_constraints: readonly DecisionGraphNode[];
  readonly scored_decisions: readonly ScoredDecisionCandidate[];
  readonly master_ledger: Record<string, DecisionGraphNode>;
  readonly ledger_edges: readonly DirectedDecisionEdge[];
  readonly project_taxonomy: ProjectTaxonomyState | null;
  readonly unresolved_ledger: readonly UnresolvedDecision[];
  readonly invalidation_map: Record<string, SectionTarget[]>;
  readonly pending_file_actions: readonly PendingFileLifecycleAction[];
  readonly question_queue: ClarifyingQuestionBatch | null;
  readonly clarification_answers: ClarificationResponse["answers"];
  readonly budget_tracking: BudgetTrackingState;
  readonly search_loop_count: number;
}
```

- **Reducer Semantics (`../../src/core/agent/reducers.ts`):**
  - `invalidation_map` MUST support an explicit clear operation (`clearInvalidationMap: boolean` or empty-reset on post-mutation completion) so completed section invalidations do not re-trigger in subsequent turns.
  - `scored_decisions` and `clarification_answers` are first-class typed channels in `AgentGraphState`, eliminating silent channel drops between scoring, classification, and HITL resumption.

## 3. 9 Replay-Safe Canonical Nodes & 6 Routing Gates (`ADR-010`)

### 3.1. Canonical Node Specifications (`REQ-TOPO-01 .. 05`)

1. **Node 1: `intent_and_scope_router_node` (`../../src/core/agent/nodes/orchestrator-node.ts`)**
   - Loads the workspace file tree index via `ctx.workspaceProvider.listWorkspaceTree()` and loads `decisions.ledger.json` into `state.master_ledger`, `state.ledger_edges`, and `state.project_taxonomy`.
   - Classifies the request into `InputIntentCategory` (`state.classified_intent`).
2. **Node 2: `search_discovery_node` (`../../src/core/agent/nodes/search-nodes.ts`)**
   - Invokes `executeToolAgentGeneration` (`../../src/lib/ai/client.ts`) with `maxSteps = 6` and the **8-tool Dual Toolset**:
     - **4 Workspace Document Tools:** `listWorkspaceTree`, `listHeadingsTree`, `searchLexicalWithASTBreadcrumb`, `readSectionByHeading`.
     - **4 Decision Graph Tools (`ADR-012`):** `searchDecisionLedger`, `getDecisionNodeDetails`, `traverseDecisionDependencies`, `getSectionGoverningDecisions`.
   - **Deterministic `SearchReport` Synthesis (`0` Extra LLM Calls):** Iterates over `result.steps` returned by `executeToolAgentGeneration`, matching each `toolCall` (`toolCallId`, `toolName`, `args`) with its corresponding `toolResult` so every `readSectionByHeading` call is attributed to its exact `(args.fileId, args.headingSlug)` pair (`SectionReadResult` in `../../src/core/workspace/provider.ts` is extended to include `fileId: string` and `headingSlug: string`).
3. **Node 3: `assumption_extractor_node` (`../../src/core/agent/nodes/assumption-and-linker-nodes.ts`)**
   - Invokes `executeStructuredGeneration` using `ctx.selectedSystem2ModelId` to extract architectural assumptions bounded by `createAssumptionExtractionBatchSchema(activeTags)`.
   - Each extracted `AssumptionItem` includes:
     - `intentType: "DIRECT_USER_INSTRUCTION" | "INFERRED_COLLATERAL_ASSUMPTION"`
     - `options: NeutralDecisionOptionInput[]` (3 to 4 neutral options containing `optionKey`, `neutralSummary`, `technicalConstraints`—with **zero** `rationaleAndPremises`).
   - Merges decision nodes discovered by the agent's tool calls in Node 2 with the deterministic fallback retriever `retrieveCandidatePriorDecisions(assumption, state.master_ledger)`.
4. **Node 4: `conflict_and_weight_gate_node` (`../../src/core/agent/nodes/assumption-and-linker-nodes.ts`)**
   - Calls `linkAssumptionsToPriorDecisions` (`../../src/core/agent/atms/relational-linker.ts`) to classify pairs into `INDEPENDENT`, `DEPENDS_ON`, `REOPENS_OR_OVERRIDES`, or `REFINES`.
   - For every `REOPENS_OR_OVERRIDES` link, executes `evaluateAntiDominoGate(assumption, targetDecision, state.master_ledger)` (Section 5.2):
     - If `CONSTRAINED_BY_PRIOR`: removes the overriding assumption from `state.assumptions` and appends `targetDecision` to `state.governing_constraints`.
     - If `ESCALATE_TO_HITL`: populates `state.question_queue` with the conflict blast-radius descriptor and routes via `G-04` to `hitl_clarification_node`.
     - If `LOCALIZED_OVERRIDE`: permits `resolveATMSCascadeBFS` and `computeMinimalSectionInvalidationMap` to reopen the decision and collect impacted `(fileId, headingSlug)` targets.
5. **Node 5: `jev_conformal_scorer_node` (`../../src/core/agent/nodes/jev-scoring-nodes.ts`)**
   - Evaluates all open decisions in a single batched `POST /v1/decisions` request (`evaluateDecisionBatch` in `../../src/lib/jev/client.ts:346`), passing verbatim `workspaceEvidence` from `state.search_report.evidenceItems` (with `vault_ref://` pointers resolved just-in-time in RAM) and `state.governing_constraints`.
   - Executes `classifyDecisionConformalAPS` (`../../src/lib/jev/conformal-classifier.ts`) inline and synthesizes post-adjudication `selectionRationale` and `evaluatedAlternatives` (Section 4.2).
   - Writes results to `state.scored_decisions` and populates `state.unresolved_ledger` for any decision classified as `UNRESOLVED`.
6. **Node 6: `hitl_clarification_node` (`../../src/core/agent/nodes/hitl-nodes.ts`)**
   - On entry without `state.clarification_answers`: builds `ClarifyingQuestionBatch` (from `unresolved_ledger`, Anti-Domino escalations, or unapproved `DELETE_FILE` actions in `safe`/`semi_auto` modes) and returns `{ status: "INTERRUPTED", interruptReason, stateDelta: { question_queue }, interruptPayload }`.
   - On resumption with validated `ClarificationResponse`:
     - Maps each user answer to its corresponding decision in `scored_decisions` with `status: "APPROVED_DIRECT"` and `provenance: "USER_EXPLICIT_HITL"`.
     - Computes the empirical nonconformity score $s(x, a_{\text{user}}) = 1 - \tilde{p}(a_{\text{user}})$ and calls `calibrationStore.recordFeedbackScore(modelId, nonconformityScore)` (`../../src/lib/jev/calibration-store.ts`).
7. **Node 7: `ledger_commit_node` (`../../src/core/agent/nodes/resolution-and-ledger-nodes.ts`)**
   - Merges approved decisions from `state.scored_decisions` into `state.master_ledger` and updates `state.ledger_edges`.
   - Runs topological cycle detection (`assertAcyclicDecisionGraph`) and recomputes the 4-source Change Weight $W(d)$ across all modified and upstream nodes (Section 5.1).
   - Persists the updated `DecisionLedgerDocument` (`decisions.ledger.json`) via `ctx.workspaceProvider.writeDecisionLedger(ledgerDoc)`.
8. **Node 8: `workspace_mutator_node` (`../../src/core/agent/nodes/document-writer-node.ts`)**
   - Executes approved file creation (`createWorkspaceFile`) and deletion (`deleteWorkspaceFile`) operations.
   - For every target `(fileId, headingSlug)` in `state.invalidation_map` or `state.user_request`:
     - Invokes `executeStreamingGeneration` (`../../src/lib/ai/client.ts`) using `ctx.selectedSystem2ModelId` to author, replace, or delete the target Markdown section or full file, governed by `state.master_ledger` and `state.governing_constraints`.
     - **Purge of Silent HTML Comments (`REQ-TOPO-06`):** `synthesizeAgentSectionContent` and `<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->` markers are permanently removed.
     - Executes `ctx.workspaceProvider.mergeSectionThreeWay` (`../../src/core/workspace/provider.ts`).
     - In `safe` mode: emits `ghost_hunk_proposed` SSE frames without mutating the persistent file record.
     - In `semi_auto` and `full_auto` modes: commits unencrypted files directly to PostgreSQL (and emits `file_mutated` SSE frames so open client tabs update via single `CodeMirror` undo transactions) or emits `vault_file_commit_required` SSE frames for encrypted files ([`ADR-016`](../architecture/adrs/adr_016_zk_encryption_granularity_and_ephemeral_ai_bridge.md)).
9. **Node 9: `direct_response_node` (`../../src/core/agent/nodes/direct-response-node.ts`)**
   - Streams conversational responses, workspace search findings, or `decisions.ledger.json` dependency explanations via `executeStreamingGeneration` when no `.md` document mutation is required.

### 3.2. Deterministic State-Predicate Routing Gates (`G-01 .. G-06`)

| Gate ID    | Source Node | Deterministic Routing Predicate Function                                               | Target Node |
| :--------- | :---------- | :------------------------------------------------------------------------------------- | :---------- |
| **`G-01`** | `Node 1`    | `state.classified_intent === "CHAT_ONLY"`                                              | `Node 9`    |
| **`G-01`** | `Node 1`    | All other `InputIntentCategory` values                                                 | `Node 2`    |
| **`G-02`** | `Node 2`    | `state.classified_intent in ["WORKSPACE_READ_SEARCH", "DECISION_LEDGER_QUERY"]`        | `Node 9`    |
| **`G-02`** | `Node 2`    | `state.classified_intent === "FAST_LOCAL_EDIT"` (0 architectural assumptions)          | `Node 8`    |
| **`G-02`** | `Node 2`    | Architectural / multi-file / structure mutation intents                                | `Node 3`    |
| **`G-03`** | `Node 3`    | `state.assumptions.length === 0 && Object.keys(state.invalidation_map).length === 0`   | `Node 8`    |
| **`G-03`** | `Node 3`    | `state.assumptions.length > 0`                                                         | `Node 4`    |
| **`G-04`** | `Node 4`    | Contextual evidence gap flagged AND `state.search_loop_count < 3`                      | `Node 2`    |
| **`G-04`** | `Node 4`    | Anti-Domino `ESCALATE_TO_HITL` triggered (`state.question_queue !== null`)             | `Node 6`    |
| **`G-04`** | `Node 4`    | Otherwise                                                                              | `Node 5`    |
| **`G-05`** | `Node 5`    | `state.unresolved_ledger.length > 0` OR unapproved `DELETE_FILE` in `safe`/`semi_auto` | `Node 6`    |
| **`G-05`** | `Node 5`    | All decisions resolved and file actions permitted                                      | `Node 7`    |
| **`G-06`** | `Node 7`    | No `.md` target sections or file lifecycle mutations pending                           | `Node 9`    |
| **`G-06`** | `Node 7`    | `.md` mutations or file creation/deletion pending                                      | `Node 8`    |

## 4. `decisions.ledger.json` Schema, Graph Tools & Epistemic Decoupling (`ADR-012` & `ADR-013`)

### 4.1. Canonical `decisions.ledger.json` Schema (`DecisionLedgerDocument v2.0`) (`REQ-LEDGER-01`)

File: `../../src/core/agent/atms/dag.ts` (Pure isomorphic TypeScript; zero `@/server/db` imports)

```typescript
export interface DirectedDecisionEdge {
  readonly edgeId: string;
  readonly fromDecisionId: string;
  readonly toDecisionId: string;
  readonly relationType: "DEPENDS_ON" | "REFINES";
  readonly justification: string;
  readonly createdAt: string;
}

export interface DecisionGraphNode {
  readonly decisionId: string;
  readonly topicSlug: string;
  readonly questionPrompt: string;
  readonly conceptTags: string[];
  readonly selectedOptionKey: string;
  readonly selectionRationale: string;
  readonly runnerUpOptionKey: string | null;
  readonly evaluatedAlternatives: EvaluatedAlternativeRecord[];
  readonly status: "APPROVED_DIRECT" | "APPROVED_CONSERVATIVE";
  readonly provenance:
    | "USER_EXPLICIT_HITL"
    | "SYSTEM1_DIRECT_APS"
    | "SYSTEM1_CONSERVATIVE_APS";
  readonly impactTier: "CORE_ARCHITECTURAL" | "PERIPHERAL";
  readonly isLoadBearing: boolean;
  readonly metrics: {
    readonly couplingLevel: number;
    readonly rollbackCost: number;
    readonly evidenceGrounding: number;
    readonly dominanceMargin: number;
  };
  readonly changeWeight: {
    readonly total: number; // Clamped in [10, 100] per ADR-014
    readonly structural: number;
    readonly provenance: number;
    readonly topology: number;
    readonly surface: number;
  };
  readonly dependsOn: string[];
  readonly dependedBy: string[];
  readonly affectedSections: Array<{
    readonly fileId: string;
    readonly relativePath: string;
    readonly headingSlug: string;
  }>;
  readonly updatedAt: string;
}

export interface DecisionLedgerDocument {
  readonly schemaVersion: "2.0.0";
  readonly workspaceId: string;
  readonly updatedAt: string;
  readonly taxonomy: ProjectTaxonomyState;
  readonly nodes: Record<string, DecisionGraphNode>;
  readonly edges: DirectedDecisionEdge[];
}
```

### 4.2. Four Deterministic Decision Graph Tools (`REQ-LEDGER-02`)

Implemented in `../../src/core/agent/tools/decision-graph-tools.ts` (re-exported via `../../src/core/agent/atms/dag.ts`) and exposed to `executeToolAgentGeneration` inside `search_discovery_node`:

1. **`searchDecisionLedger`:**
   - **Input Schema:** `z.object({ query: z.string().optional(), conceptTags: z.array(z.string()).optional(), fileId: z.string().optional() })`
   - **Behavior:** Performs deterministic filtering over `DecisionLedgerDocument.nodes`, returning matching nodes sorted by `changeWeight.total` descending.
2. **`getDecisionNodeDetails`:**
   - **Input Schema:** `z.object({ decisionId: z.string().min(1) })`
   - **Behavior:** Returns the complete `DecisionGraphNode` and all incident `DirectedDecisionEdge` records (`fromDecisionId === decisionId || toDecisionId === decisionId`).
3. **`traverseDecisionDependencies`:**
   - **Input Schema:**
     ```typescript
     z.object({
       decisionId: z.string().min(1),
       direction: z.enum(["upstream", "downstream", "both"]),
       maxDepth: z.union([z.literal(1), z.literal(2), z.literal("all")]),
     });
     ```
   - **Algorithm:** Runs cycle-safe Breadth-First Search (`BFS`) starting from `decisionId`:
     - `"upstream"` follows `dependsOn` (`fromDecisionId -> toDecisionId` where `fromDecisionId` depends on `toDecisionId`).
     - `"downstream"` follows `dependedBy` (`toDecisionId <- fromDecisionId`).
     - Stops at hop depth `1`, `2`, or full transitive closure (`"all"`), returning `{ rootDecisionId, visitedNodes, traversedEdges, topologicalOrder }`.
4. **`getSectionGoverningDecisions`:**
   - **Input Schema:** `z.object({ fileId: z.string().min(1), headingSlug: z.string().optional() })`
   - **Behavior:** Finds all nodes whose `affectedSections` match `fileId` (and `headingSlug` if provided), plus their upstream load-bearing ancestors (`isLoadBearing === true`).

### 4.3. Neutral Option Schema & Post-Adjudication Rationale Synthesis (`REQ-EPIST-01 .. 03`)

File: `../../src/core/agent/schemas/decision-schemas.ts` & `../../src/lib/jev/client.ts`

1. **`NeutralOptionSchema` & `NeutralDecisionOptionInput` (Used Prior to `POST /v1/decisions`):**
   ```typescript
   export const NeutralOptionSchema = z.object({
     optionKey: z.string().regex(/^[a-z0-9_]+$/),
     neutralSummary: z.string().min(5).max(220),
     technicalConstraints: z.array(z.string().max(160)).min(1).max(4),
   });
   export type NeutralDecisionOptionInput = z.infer<typeof NeutralOptionSchema>;
   ```
2. **Evidence-Grounded `POST /v1/decisions` Payload (`../../src/lib/jev/client.ts` & `../../src/core/agent/nodes/jev-scoring-nodes.ts`):**
   - Replaces the current behavior in `../../src/core/agent/nodes/jev-scoring-nodes.ts` (lines `136–143`), where `priorDecisionContext` is populated only for reopened decisions and `undefined` for new decisions without live workspace evidence:
   ```typescript
   export interface GroundedDecisionEvaluationRequestItem {
     readonly decisionId: string;
     readonly topicSlug: string;
     readonly questionPrompt: string;
     readonly conceptTags: readonly string[];
     readonly options: readonly NeutralDecisionOptionInput[];
     readonly workspaceEvidence: ReadonlyArray<{
       readonly fileId: string;
       readonly headingSlug: string;
       readonly excerpt: string;
     }>;
     readonly governingPriorDecisions: ReadonlyArray<{
       readonly decisionId: string;
       readonly topicSlug: string;
       readonly selectedOptionKey: string;
       readonly changeWeightTotal: number;
     }>;
     readonly priorDecisionContext?: {
       readonly reopenedFromDecisionId?: string;
       readonly previousSelectedOptionKey?: string;
       readonly triggerForReevaluation?: string;
     };
   }
   ```
3. **Post-Adjudication Rationale Builder (`synthesizePostAdjudicationRationales`):**
   - Executed in `jev_conformal_scorer_node` _after_ `classifyDecisionConformalAPS` returns `selectedOptionKey`, `dominanceMargin` $m(x)$, and `evidenceGrounding`:
     - Constructs `selectionRationale` citing the winning option's `neutralSummary`, `technicalConstraints`, supporting `(fileId, headingSlug)` evidence keys, and conformal metrics ($\tilde{p}_{(1)}$, $m(x)$, `evidenceGrounding`).
     - Constructs `evaluatedAlternatives` for each rejected option with its normalized probability $\tilde{p}(a_k)$ and nonconformity exclusion reason.

## 5. Deterministic Change Weight ($W(d)$) & Anti-Domino Gate (`ADR-014`)

### 5.1. Pure Mathematical Implementation of $W(d)$ (`REQ-WEIGHT-01`)

File: `../../src/core/agent/atms/invalidation.ts`

```typescript
export interface ChangeWeightBreakdown {
  readonly total: number; // integer in [10, 100]
  readonly structural: number; // integer in [10, 45]
  readonly provenance: number; // integer in [0, 25]
  readonly topology: number; // integer in [0, 20]
  readonly surface: number; // integer in [0, 10]
}

export function computeDecisionChangeWeight(
  node: Pick<
    DecisionGraphNode,
    "decisionId" | "provenance" | "metrics" | "affectedSections"
  >,
  allNodes: Readonly<
    Record<string, Pick<DecisionGraphNode, "decisionId" | "dependedBy">>
  >,
): ChangeWeightBreakdown {
  const clampedCoupling = Math.max(0, Math.min(2, node.metrics.couplingLevel));
  const clampedRollback = Math.max(0, Math.min(2, node.metrics.rollbackCost));
  const structural = Math.round(
    10 + 17.5 * ((clampedCoupling + clampedRollback) / 2.0),
  );

  let provenance = 0;
  if (node.provenance === "USER_EXPLICIT_HITL") {
    provenance = 25;
  } else if (node.provenance === "SYSTEM1_DIRECT_APS") {
    const clampedMargin = Math.max(
      0,
      Math.min(1, node.metrics.dominanceMargin),
    );
    provenance = 10 + Math.round(5 * clampedMargin);
  }

  // BFS over dependedBy to count direct (depth = 1) and indirect (depth >= 2) dependents
  const directDependedBy = new Set<string>();
  const indirectDependedBy = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [];
  const visited = new Set<string>([node.decisionId]);

  const rootRecord = allNodes[node.decisionId];
  for (const depId of rootRecord?.dependedBy ?? []) {
    if (!visited.has(depId) && allNodes[depId]) {
      visited.add(depId);
      directDependedBy.add(depId);
      queue.push({ id: depId, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentNode = allNodes[current.id];
    for (const nextDepId of currentNode?.dependedBy ?? []) {
      if (!visited.has(nextDepId) && allNodes[nextDepId]) {
        visited.add(nextDepId);
        indirectDependedBy.add(nextDepId);
        queue.push({ id: nextDepId, depth: current.depth + 1 });
      }
    }
  }

  const topology = Math.min(
    20,
    6 * directDependedBy.size + 3 * indirectDependedBy.size,
  );

  const uniqueFiles = new Set<string>();
  const uniqueSections = new Set<string>();
  for (const sec of node.affectedSections) {
    if (sec.fileId && sec.headingSlug) {
      uniqueFiles.add(sec.fileId);
      uniqueSections.add(`${sec.fileId}#${sec.headingSlug}`);
    }
  }

  const fileCount = uniqueFiles.size;
  const sectionCount = uniqueSections.size;
  const surface =
    sectionCount === 0
      ? 0
      : Math.min(10, 3 * Math.max(0, fileCount - 1) + 2 * sectionCount);

  const total = Math.max(
    10,
    Math.min(100, structural + provenance + topology + surface),
  );

  return { total, structural, provenance, topology, surface };
}
```

### 5.2. Anti-Domino Gate Evaluation (`REQ-WEIGHT-02`)

When `relationType === "REOPENS_OR_OVERRIDES"` between `assumption` ($a_{\text{new}}$) and `priorNode` ($d_{\text{old}}$):

1. Compute `weight = computeDecisionChangeWeight(priorNode, masterLedger)` and transitive dependent count $D^+(d_{\text{old}})$.
2. If `assumption.intentType === "INFERRED_COLLATERAL_ASSUMPTION"`:
   - If `weight.total >= 40 || priorNode.provenance === "USER_EXPLICIT_HITL" || priorNode.impactTier === "CORE_ARCHITECTURAL"` $\rightarrow$ return `"CONSTRAINED_BY_PRIOR"`.
   - Else if `weight.total >= 25 || D^+(d_{\text{old}}) >= 1` $\rightarrow$ return `"ESCALATE_TO_HITL"`.
   - Else $\rightarrow$ return `"LOCALIZED_OVERRIDE"`.
3. If `assumption.intentType === "DIRECT_USER_INSTRUCTION"`:
   - If `weight.total >= 50 || D^+(d_{\text{old}}) >= 1` $\rightarrow$ return `"ESCALATE_TO_HITL"`.
   - Else $\rightarrow$ return `"LOCALIZED_OVERRIDE"`.

## 6. Verification & Acceptance Criteria

1. **Unit Verification (`../../src/test/agent/`):**
   - Verify `Elixent Native Graph Engine` executes all 9 input patterns through Gates `G-01..G-06` and persists encrypted state blobs to `agent_checkpoints` with zero `@langchain/*` imports.
   - Verify `search_discovery_node` accurately pairs multiple `readSectionByHeading` calls to their distinct `(fileId, headingSlug)` targets and traverses 1-hop, 2-hop, and full-chain dependencies in `decisions.ledger.json`.
   - Verify `computeDecisionChangeWeight` and `evaluateAntiDominoGate` deterministically shield high-weight decisions against `INFERRED_COLLATERAL_ASSUMPTION` overrides while escalating `DIRECT_USER_INSTRUCTION` conflicts with dependent blast-radius previews.
