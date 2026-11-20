/**
 * Node 1: Intent & Scope Router (`intent_and_scope_router_node`)
 *
 * Native Graph Engine Stage 0 entry node (`ADR-009`, `SRS-01` §2.3 & §3.1).
 *
 * Responsibilities:
 * 1. Loads workspace file tree via `ctx.workspaceProvider.listWorkspaceTree()`.
 * 2. Loads and normalizes `decisions.ledger.json` via `ctx.workspaceProvider.readDecisionLedger()`
 *    and `normalizeProviderLedgerToV2(...)`, populating `master_ledger`, `ledger_edges`, and
 *    `project_taxonomy` while filtering system-reserved decision IDs.
 * 3. Classifies `classified_intent` across the 9-category `InputIntentCategory` taxonomy
 *    using deterministic heuristics + optional `executeStructuredGeneration`.
 * 4. Seeds `local_inspection_state` with `state.user_request.targetFileIds`, resets
 *    `search_loop_count: 0`, and appends the user prompt as an `AgentConversationMessage`.
 */

import { z } from "zod";
import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type {
  AgentConversationMessage,
  AgentGraphState,
  InputIntentCategory,
} from "@/core/agent/state";
import {
  normalizeProviderLedgerToV2,
  type ATMSDecisionNode,
  type DirectedDecisionEdge,
} from "@/core/agent/atms/dag";
import {
  isSystemReservedDecisionId,
  type ProjectTaxonomyState,
} from "@/core/agent/taxonomy/predefined-tags";
import type { WorkspaceTreeEntry } from "@/core/workspace/provider";
import { executeStructuredGeneration } from "@/lib/ai/client";
import { getApiKeys } from "@/lib/ai/key-rotation";
import { resolveVaultRefJustInTime } from "@/lib/vault/ephemeral-memory-map";

const INPUT_INTENT_CATEGORIES: readonly InputIntentCategory[] = [
  "CHAT_ONLY",
  "WORKSPACE_READ_SEARCH",
  "DECISION_LEDGER_QUERY",
  "FAST_LOCAL_EDIT",
  "NEW_DOC_DRAFTING",
  "ARCHITECTURAL_MODIFICATION",
  "CONFLICTING_OVERRIDE",
  "FILE_STRUCTURE_MUTATION",
  "COMPOUND_MULTI_INTENT",
];

const IntentClassificationSchema = z.object({
  intent: z.enum([
    "CHAT_ONLY",
    "WORKSPACE_READ_SEARCH",
    "DECISION_LEDGER_QUERY",
    "FAST_LOCAL_EDIT",
    "NEW_DOC_DRAFTING",
    "ARCHITECTURAL_MODIFICATION",
    "CONFLICTING_OVERRIDE",
    "FILE_STRUCTURE_MUTATION",
    "COMPOUND_MULTI_INTENT",
  ]),
  rationale: z.string().max(300),
});

/**
 * Deterministic fallback intent classifier for offline/hermetic environments
 * or when structured LLM classification is unavailable.
 */
function classifyIntentHeuristically(
  prompt: string,
  targetFileIds: readonly string[],
  ledgerNodeCount: number,
): InputIntentCategory {
  const lower = prompt.toLowerCase();

  const hasFileStructureVerb =
    /\b(create file|new file|delete file|remove file|rename file|move file|create folder)\b/i.test(
      lower,
    );
  const hasOverrideVerb =
    /\b(override|replace|switch from|migrate from|change architecture|supersede|reopen decision)\b/i.test(
      lower,
    );
  const hasLedgerQuery =
    /\b(decision ledger|decisions|why did we|governing|atms|dependencies|depend on|change weight|ledger)\b/i.test(
      lower,
    ) && !/\b(edit|write|update|modify|create|delete|add section|refactor)\b/i.test(lower);
  const hasSearchQuery =
    /\b(find|search|where is|explain|summarize|what does|read|list|show me|inspect)\b/i.test(
      lower,
    ) && !/\b(edit|write|update|modify|create|delete|add|change|implement)\b/i.test(lower);
  const hasNewDocVerb =
    /\b(draft|write a new|create a new doc|scaffold|generate specification|new document)\b/i.test(
      lower,
    );
  const hasArchEditVerb =
    /\b(architecture|design|protocol|database|schema|security|auth|api|system|spec|refactor)\b/i.test(
      lower,
    ) && /\b(edit|update|modify|change|add|implement|fix|revise)\b/i.test(lower);
  const hasLocalEditVerb =
    /\b(typo|fix|edit|update|rewrite|polish|format|clarify|add paragraph|update section)\b/i.test(
      lower,
    );

  if (hasFileStructureVerb && (hasArchEditVerb || hasNewDocVerb)) {
    return "COMPOUND_MULTI_INTENT";
  }
  if (hasFileStructureVerb) {
    return "FILE_STRUCTURE_MUTATION";
  }
  if (hasOverrideVerb && ledgerNodeCount > 0) {
    return "CONFLICTING_OVERRIDE";
  }
  if (hasLedgerQuery) {
    return "DECISION_LEDGER_QUERY";
  }
  if (hasNewDocVerb) {
    return "NEW_DOC_DRAFTING";
  }
  if (hasArchEditVerb) {
    return "ARCHITECTURAL_MODIFICATION";
  }
  if (hasLocalEditVerb && targetFileIds.length > 0) {
    return "FAST_LOCAL_EDIT";
  }
  if (hasSearchQuery || targetFileIds.length > 0) {
    return "WORKSPACE_READ_SEARCH";
  }

  return "CHAT_ONLY";
}

/**
 * Classifies the user request into one of the 9 canonical `InputIntentCategory` values.
 */
async function classifyUserIntent(
  prompt: string,
  targetFileIds: readonly string[],
  workspaceTree: readonly WorkspaceTreeEntry[],
  ledgerNodeCount: number,
  ctx: AgentRuntimeContext,
): Promise<InputIntentCategory> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "CHAT_ONLY";
  }

  const heuristicIntent = classifyIntentHeuristically(
    trimmed,
    targetFileIds,
    ledgerNodeCount,
  );

  const hasApiKeys =
    getApiKeys().length > 0 || Boolean(process.env.GEMINI_API_KEY);
  if (!hasApiKeys) {
    return heuristicIntent;
  }

  try {
    const dereferencedPrompt = resolveVaultRefJustInTime(trimmed);
    const treeSummary = workspaceTree
      .slice(0, 30)
      .map((entry) => `${entry.fileId}:${entry.relativePath}${entry.isFolder ? "/" : ""}`)
      .join(", ");

    const { object } = await executeStructuredGeneration({
      modelId: ctx.selectedSystem2ModelId,
      schema: IntentClassificationSchema,
      abortSignal: ctx.abortSignal,
      system: [
        "You are Stage 0 Intent & Scope Router for an engineering documentation workspace.",
        `Classify the user request into exactly one of: ${INPUT_INTENT_CATEGORIES.join(", ")}.`,
        "Guidelines:",
        "- CHAT_ONLY: greetings, general questions unrelated to workspace files or decision ledger.",
        "- WORKSPACE_READ_SEARCH: read, search, summarize, or explain workspace documents without modifying files.",
        "- DECISION_LEDGER_QUERY: query architectural decisions, rationale, dependencies, or ATMS ledger state.",
        "- FAST_LOCAL_EDIT: small localized prose/formatting/typo edits in targeted files without architectural impact.",
        "- NEW_DOC_DRAFTING: drafting a brand new markdown specification or document.",
        "- ARCHITECTURAL_MODIFICATION: modifying system design, schemas, APIs, security, or cross-cutting specs.",
        "- CONFLICTING_OVERRIDE: explicitly overriding, replacing, or reopening an existing architectural decision.",
        "- FILE_STRUCTURE_MUTATION: creating, deleting, or restructuring workspace files/folders.",
        "- COMPOUND_MULTI_INTENT: combining multiple distinct operations (e.g., file creation + architectural edits).",
      ].join("\n"),
      prompt: [
        `User Request: ${dereferencedPrompt}`,
        `Target File IDs: ${targetFileIds.length > 0 ? targetFileIds.join(", ") : "none"}`,
        `Workspace Tree (${workspaceTree.length} entries): ${treeSummary || "empty"}`,
        `Existing Decision Ledger Nodes: ${ledgerNodeCount}`,
      ].join("\n"),
    });

    return object.intent;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    return heuristicIntent;
  }
}

/**
 * Node 1 (`intent_and_scope_router_node`):
 * Loads workspace tree & normalized ATMS decision ledger, classifies request intent,
 * seeds inspection paths, resets `search_loop_count`, and records the user message.
 */
export const intentAndScopeRouterNode: AgentGraphNodeFn = async (
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> => {
  const targetFileIds = state.user_request?.targetFileIds ?? [];
  const prompt = state.user_request?.prompt?.trim() ?? "";

  let workspaceTree: WorkspaceTreeEntry[] = [];
  try {
    workspaceTree = await ctx.workspaceProvider.listWorkspaceTree();
  } catch {
    workspaceTree = [];
  }

  let normalizedNodes: Record<string, ATMSDecisionNode> = {};
  let normalizedEdges: DirectedDecisionEdge[] = [];
  let loadedTaxonomy: ProjectTaxonomyState | null = null;

  try {
    const rawLedger = await ctx.workspaceProvider.readDecisionLedger();
    const normalized = normalizeProviderLedgerToV2(rawLedger, ctx.workspaceId);
    normalizedNodes = normalized.nodes;
    normalizedEdges = normalized.edges;
    loadedTaxonomy = normalized.taxonomy ?? null;
  } catch {
    normalizedNodes = {};
    normalizedEdges = [];
    loadedTaxonomy = null;
  }

  // Merge loaded ledger with any existing state ledger, filtering system-reserved IDs
  const mergedLedger: Record<string, ATMSDecisionNode> = {};
  for (const [key, node] of Object.entries(normalizedNodes)) {
    if (!isSystemReservedDecisionId(key) && !isSystemReservedDecisionId(node.decisionId)) {
      mergedLedger[key] = node;
    }
  }
  if (state.master_ledger && typeof state.master_ledger === "object") {
    for (const [key, node] of Object.entries(state.master_ledger)) {
      if (!isSystemReservedDecisionId(key) && !isSystemReservedDecisionId(node.decisionId)) {
        mergedLedger[key] = node;
      }
    }
  }

  const mergedEdges: DirectedDecisionEdge[] =
    normalizedEdges.length > 0 ? normalizedEdges : [...(state.ledger_edges ?? [])];

  const classifiedIntent = await classifyUserIntent(
    prompt,
    targetFileIds,
    workspaceTree,
    Object.keys(mergedLedger).length,
    ctx,
  );

  const initialInspectionPaths = Array.from(
    new Set([...(state.local_inspection_state ?? []), ...targetFileIds]),
  );

  const messagesToAppend: AgentConversationMessage[] = [];
  if (prompt.length > 0) {
    const hasPromptMessage = (state.messages ?? []).some(
      (m) => m.role === "user" && m.content.includes(prompt),
    );
    if (!hasPromptMessage) {
      messagesToAppend.push({
        id: `user_${ctx.turnId || Date.now()}`,
        role: "user",
        content: prompt,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return {
    status: "COMPLETED",
    stateDelta: {
      master_ledger: mergedLedger,
      ledger_edges: mergedEdges,
      project_taxonomy: loadedTaxonomy ?? state.project_taxonomy ?? null,
      classified_intent: classifiedIntent,
      local_inspection_state: initialInspectionPaths,
      search_loop_count: 0,
      ...(messagesToAppend.length > 0 ? { messages: messagesToAppend } : {}),
    },
  };
};

/** Transitional alias for backward compatibility during Wave 3.3 wiring. */
export const orchestratorNode = intentAndScopeRouterNode;
