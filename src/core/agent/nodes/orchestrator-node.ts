/**
 * Master Orchestrator Node (Stage 0)
 *
 * Implements `orchestratorNode` for the Elixent agent state graph
 * according to ELIXENT-ARCH-02 §1 & §3.1.
 *
 * Responsibilities:
 * 1. Inspects `state.user_request` for project identity, prompt, and target file IDs.
 * 2. Loads persistent project decision ledger records and project-scoped taxonomy sentinel
 *    (`__PROJECT_TAXONOMY__`) from `project_decision_ledger`.
 * 3. Merges loaded decisions with existing `master_ledger` (filtering out system sentinels).
 * 4. Deduplicates and initializes `local_inspection_state` with `targetFileIds`.
 * 5. Guarantees monotonic `search_loop_count` initialization at 0.
 * 6. Appends the initial user prompt as a `HumanMessage` to `messages` if not already present.
 */

import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { AgentGraphState } from "@/core/agent/state";
import { loadProjectDecisionLedger, type ATMSDecisionNode } from "@/core/agent/atms/dag";
import {
  isSystemReservedDecisionId,
  type ProjectTaxonomyState,
} from "@/core/agent/taxonomy/predefined-tags";

/**
 * Initializes the orchestration state for the agent state graph.
 *
 * Deterministically loads the project ledger and concept taxonomy from persistent storage,
 * sets initial workspace inspection targets, resets/initializes search loop tracking,
 * and ensures the user request is seeded into the message history.
 *
 * @param state - The current agent graph state.
 * @param config - Optional LangGraph runnable execution config containing user/thread parameters.
 * @returns Partial state update with merged master ledger, taxonomy, inspection paths, and messages.
 */
export async function orchestratorNode(
  state: AgentGraphState,
  config?: RunnableConfig,
): Promise<Partial<AgentGraphState>> {
  const userId =
    (config?.configurable?.userId as string | undefined) ??
    (config?.configurable?.user_id as string | undefined) ??
    "default_user";

  const projectId = state.user_request?.projectId?.trim() ?? "";
  const targetFileIds = state.user_request?.targetFileIds ?? [];

  let loadedMasterLedger: Record<string, ATMSDecisionNode> = {};
  let loadedProjectTaxonomy: ProjectTaxonomyState | null = null;

  if (projectId.length > 0 && userId.length > 0) {
    try {
      const loaded = await loadProjectDecisionLedger(projectId, userId);
      loadedMasterLedger = loaded.masterLedger ?? {};
      loadedProjectTaxonomy = loaded.projectTaxonomy ?? null;
    } catch {
      // Fallback gracefully for offline tests or unconfigured databases
      loadedMasterLedger = {};
      loadedProjectTaxonomy = null;
    }
  }

  // Merge loaded master ledger with any existing state ledger, filtering system-reserved sentinels
  const mergedLedger: Record<string, ATMSDecisionNode> = { ...loadedMasterLedger };
  if (state.master_ledger && typeof state.master_ledger === "object") {
    for (const [key, node] of Object.entries(state.master_ledger)) {
      if (!isSystemReservedDecisionId(key)) {
        mergedLedger[key] = node;
      }
    }
  }

  // Deduplicate and initialize local inspection state with target file IDs
  const initialInspectionPaths = Array.from(
    new Set([...(state.local_inspection_state ?? []), ...targetFileIds]),
  );

  // Initialize search loop count if not present
  const searchLoopCount = state.search_loop_count ?? 0;

  // Append initial prompt as HumanMessage if not already present
  const messages = [...(state.messages ?? [])];
  const prompt = state.user_request?.prompt?.trim();
  if (prompt && prompt.length > 0) {
    const hasPromptMessage = messages.some(
      (m) =>
        m._getType() === "human" &&
        (typeof m.content === "string" ? m.content : "").includes(prompt),
    );
    if (!hasPromptMessage) {
      messages.push(new HumanMessage({ content: prompt }));
    }
  }

  return {
    master_ledger: mergedLedger,
    project_taxonomy: loadedProjectTaxonomy ?? state.project_taxonomy ?? null,
    local_inspection_state: initialInspectionPaths,
    search_loop_count: searchLoopCount,
    messages,
  };
}
