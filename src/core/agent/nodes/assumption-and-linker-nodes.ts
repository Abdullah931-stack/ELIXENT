/**
 * Assumption Analysis, ATMS Candidate Retrieval & Relational Linker (Stage 2)
 *
 * Implements Stage 2 nodes and conditional routing for the Elixent agent state graph
 * according to ELIXENT-ARCH-02 §1 & §3.3.
 *
 * Exported Symbols:
 * 1. `assumptionAnalyzerNode`: Metered node extracting assumptions and bounding tags via project taxonomy.
 * 2. `atmsRelationalLinkerNode`: Adjudicates relational links and executes ATMS cascade BFS.
 * 3. `routeAfterAssumptions`: Conditional routing gate (G-5) to jev_structuring, doc_writer, or search_agent.
 * 4. `rawAssumptionAnalyzerNode`: Unwrapped pure implementation for testing.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import type { AgentGraphState, AssumptionItem } from "@/core/agent/state";
import { reduceInvalidationMap } from "@/core/agent/reducers";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import { resolveVaultRefJustInTime } from "@/lib/vault/ephemeral-memory-map";
import { resolveProjectConceptTags } from "@/core/agent/taxonomy/predefined-tags";
import {
  createAssumptionExtractionBatchSchema,
  type SectionTarget,
} from "@/core/agent/schemas/decision-schemas";
import { retrieveCandidatePriorDecisions } from "@/core/agent/atms/candidate-retriever";
import { linkAssumptionsToPriorDecisions } from "@/core/agent/atms/relational-linker";
import {
  resolveATMSCascadeBFS,
  computeMinimalSectionInvalidationMap,
} from "@/core/agent/atms/invalidation";
import { executeStructuredGeneration } from "@/lib/ai/client";
import { getApiKeys } from "@/lib/ai/key-rotation";

/** Model identifier used for metered assumption analyzer execution */
export const ASSUMPTION_ANALYZER_MODEL_ID = "google/gemini-3.8-flash";

/**
 * Extended assumption shape that optionally tracks retrieved candidate decision IDs.
 */
export interface AnalyzedAssumptionItem extends AssumptionItem {
  readonly candidateDecisionIds?: readonly string[];
}

/**
 * Unwrapped implementation of `assumptionAnalyzerNode`.
 *
 * Extracts architectural assumptions from the search report and user prompt,
 * bounds concept tags to the project taxonomy, and retrieves top-K candidate prior
 * decisions from `master_ledger` for each assumption.
 *
 * @param state - The current agent graph state.
 * @param config - LangGraph execution config.
 * @returns Partial state update containing the extracted assumptions.
 */
export async function rawAssumptionAnalyzerNode(
  state: AgentGraphState,
  config?: RunnableConfig,
): Promise<Partial<AgentGraphState>> {
  const activeTags = resolveProjectConceptTags(state.project_taxonomy);
  const extractionSchema = createAssumptionExtractionBatchSchema(activeTags);

  const dereferencedPrompt = resolveVaultRefJustInTime(state.user_request?.prompt ?? "");
  const evidenceSummaries = (state.search_report?.evidenceItems ?? []).map(
    (e) => `[${e.fileId}#${e.headingSlug}]: ${resolveVaultRefJustInTime(e.textExcerpt)}`,
  );

  const hasApiKeys = getApiKeys().length > 0 || Boolean(process.env.GEMINI_API_KEY);
  let extractedAssumptions: AssumptionItem[] = [];

  if (hasApiKeys) {
    try {
      const promptText = [
        "Analyze the user request and gathered workspace evidence to extract distinct architectural assumptions.",
        `User Request: ${dereferencedPrompt}`,
        evidenceSummaries.length > 0
          ? `Workspace Evidence:\n${evidenceSummaries.join("\n")}`
          : "No workspace evidence available.",
      ].join("\n\n");

      const result = await executeStructuredGeneration({
        modelId: ASSUMPTION_ANALYZER_MODEL_ID,
        schema: extractionSchema,
        prompt: promptText,
        system:
          "You are an architectural assumption analyzer. Extract concise technical assumptions and map each to 1-6 authorized concept tags from the active project taxonomy.",
        abortSignal: config?.signal,
      });

      if (result.object && Array.isArray(result.object.assumptions)) {
        extractedAssumptions = result.object.assumptions.map((a, index) => ({
          assumptionId: a.assumptionId || `asmp_${Date.now()}_${index + 1}`,
          statement: a.statement || a.assumptionStatement || "",
          conceptTags: (a.conceptTags as string[]) ?? [activeTags[0]],
          affectedSections: (a.affectedSections as SectionTarget[]) ?? [],
          dependsOn: a.dependsOn ?? [],
        }));
      }
    } catch {
      // Fallback to deterministic extraction on model failure
      extractedAssumptions = [];
    }
  }

  // Deterministic fallback if model was unconfigured or failed
  if (extractedAssumptions.length === 0) {
    const prompt = dereferencedPrompt.trim();
    if (prompt.length > 0) {
      const affectedSections: SectionTarget[] = (state.search_report?.evidenceItems ?? []).map(
        (e) => ({
          fileId: e.fileId,
          headingSlug: e.headingSlug,
        }),
      );

      extractedAssumptions.push({
        assumptionId: `asmp_${Date.now()}_1`,
        statement: prompt,
        conceptTags: [activeTags[0]],
        affectedSections,
        dependsOn: [],
      });
    }
  }

  // Deterministic Top-K Candidate Retrieval (ELIXENT-ARCH-02 §5.1 Step 1)
  const masterLedger = state.master_ledger ?? {};
  const enrichedAssumptions: AssumptionItem[] = extractedAssumptions.map((assumption) => {
    // Run candidate retriever to rank prior decisions from masterLedger
    const candidateNodes = retrieveCandidatePriorDecisions(assumption, masterLedger);
    const candidateIds = candidateNodes.map((n) => n.decisionId);

    return {
      ...assumption,
      candidateDecisionIds: candidateIds,
    } as AssumptionItem;
  });

  return {
    assumptions: enrichedAssumptions,
  };
}

/**
 * Metered assumption analyzer node wrapped with `withMeteredNodeGate`.
 */
export const assumptionAnalyzerNode = withMeteredNodeGate(
  "assumption_analyzer_node",
  ASSUMPTION_ANALYZER_MODEL_ID,
  rawAssumptionAnalyzerNode,
);

/**
 * Justification-Driven ATMS Relational Linker Node (Stage 2 — Step 2).
 *
 * Adjudicates logical relationships (`INDEPENDENT`, `DEPENDS_ON`, `REOPENS_OR_OVERRIDES`, `REFINES`)
 * between newly extracted assumptions and candidate prior decisions, executes Contagious Promotion &
 * Override Cascade BFS across the ATMS DAG, and aggregates impacted section targets.
 *
 * @param state - The current agent graph state.
 * @param config - LangGraph execution config containing optional abortSignal.
 * @returns Partial state update with updated master ledger, invalidation map, and reopened assumptions.
 */
export async function atmsRelationalLinkerNode(
  state: AgentGraphState,
  config?: RunnableConfig,
): Promise<Partial<AgentGraphState>> {
  const assumptions = state.assumptions ?? [];
  const masterLedger = state.master_ledger ?? {};

  if (assumptions.length === 0) {
    return {
      master_ledger: masterLedger,
      invalidation_map: state.invalidation_map ?? {},
    };
  }

  // 1. Relational Adjudication via POST /v1/decisions client
  const linkedGroups = await linkAssumptionsToPriorDecisions(assumptions, masterLedger, {
    abortSignal: config?.signal,
  });

  // 2. Bidirectional Contagious Promotion & Override Cascade BFS (ELIXENT-ARCH-02 §5.2)
  const cascadeResult = resolveATMSCascadeBFS(linkedGroups, masterLedger);

  // 3. Differential Section Invalidation Map (ELIXENT-ARCH-02 §5.3)
  const rootDecisionIds = cascadeResult.reopenedOrPromotedNodes.map((node) => node.decisionId);
  const minimalInvalidations = computeMinimalSectionInvalidationMap(rootDecisionIds, masterLedger);
  const mergedInvalidations = reduceInvalidationMap(
    state.invalidation_map ?? {},
    minimalInvalidations,
  );

  // 4. Staged assumptions: merge current assumptions with reopened / promoted nodes for Stage 3
  const existingAssumptionIds = new Set(assumptions.map((a) => a.assumptionId));
  const reopenedAssumptions: AssumptionItem[] = cascadeResult.reopenedOrPromotedNodes
    .filter((node) => !existingAssumptionIds.has(node.decisionId))
    .map((node) => ({
      assumptionId: node.decisionId,
      statement: node.questionPrompt,
      conceptTags: node.conceptTags,
      affectedSections: node.affectedSections,
      dependsOn: node.dependsOn,
    }));

  return {
    master_ledger: cascadeResult.updatedLedger,
    invalidation_map: mergedInvalidations,
    assumptions: [...assumptions, ...reopenedAssumptions],
  };
}

/**
 * Conditional edge router after Stage 2 Assumption Analysis (G-5 Gate).
 *
 * Routing Rules:
 * 1. If no assumptions were generated and invalidation_map is empty, route to "document_writer_node".
 * 2. If contextual gaps are flagged and search_loop_count < MAX_SEARCH_LOOPS (3), route to "search_agent_node".
 * 3. Otherwise, route to "jev_structuring_node".
 *
 * @param state - The current agent graph state.
 * @returns Target node key: "jev_structuring_node" | "document_writer_node" | "search_agent_node".
 */
export function routeAfterAssumptions(
  state: AgentGraphState,
): "jev_structuring_node" | "document_writer_node" | "search_agent_node" {
  const assumptions = state.assumptions ?? [];
  const invalidationMap = state.invalidation_map ?? {};
  const hasInvalidations = Object.keys(invalidationMap).length > 0;

  // Rule 1: No assumptions generated and no invalidations -> direct doc writer execution
  if (assumptions.length === 0 && !hasInvalidations) {
    return "document_writer_node";
  }

  // Rule 2: Contextual gaps flagged while search loops remain
  const searchLoopCount = state.search_loop_count ?? 0;
  const hasTargetFiles = (state.user_request?.targetFileIds ?? []).length > 0;
  const hasNoEvidence = (state.search_report?.evidenceItems ?? []).length === 0;

  const hasContextualGapFlag = assumptions.some((a) => {
    const text = a.statement.toLowerCase();
    return (
      text.includes("contextual gap") ||
      text.includes("needs inspection") ||
      text.includes("insufficient evidence") ||
      text.includes("unresolved gap")
    );
  });

  const isGapFlagged = hasContextualGapFlag || (hasTargetFiles && hasNoEvidence);

  if (isGapFlagged && searchLoopCount < 3) {
    return "search_agent_node";
  }

  // Rule 3: Normal progression to Stage 3
  return "jev_structuring_node";
}
