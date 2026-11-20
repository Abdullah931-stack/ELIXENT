/**
 * Node 9: Direct Conversational & Query Response (`direct_response_node`)
 *
 * Native Graph Engine terminal streaming node (`ADR-009`, `SRS-01` §2.3).
 *
 * Invoked when `classified_intent` is `CHAT_ONLY`, `WORKSPACE_READ_SEARCH`,
 * `DECISION_LEDGER_QUERY`, or when `G-06` finds no pending Markdown mutations.
 *
 * Responsibilities:
 * 1. Builds grounded context from `state.search_report.evidenceItems` (resolving
 *    `vault_ref://` pointers just-in-time in RAM), `state.master_ledger`, and `state.messages`.
 * 2. Streams the response via `executeStreamingGeneration` (`ctx.selectedSystem2ModelId`),
 *    emitting incremental SSE `update` events via `ctx.emitSseEvent(...)`.
 * 3. Appends the finalized assistant `AgentConversationMessage` to `stateDelta.messages`.
 */

import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type {
  AgentConversationMessage,
  AgentGraphState,
} from "@/core/agent/state";
import { executeStreamingGeneration } from "@/lib/ai/client";
import { getApiKeys } from "@/lib/ai/key-rotation";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import { resolveVaultRefJustInTime } from "@/lib/vault/ephemeral-memory-map";

/**
 * Resolves `vault_ref://` pointers safely in RAM without throwing if an offline
 * fallback test lacks an active ephemeral vault scope.
 */
function safeResolveVaultText(text: string): string {
  if (!text) return "";
  try {
    return resolveVaultRefJustInTime(text);
  } catch {
    return text;
  }
}

/**
 * Formats grounded workspace evidence, ATMS decision ledger state, and recent
 * conversation history into the LLM prompt for `direct_response_node`.
 */
function buildGroundedPrompt(state: Readonly<AgentGraphState>): string {
  const userPrompt = safeResolveVaultText(state.user_request?.prompt ?? "");

  const evidenceBlocks = (state.search_report?.evidenceItems ?? [])
    .slice(0, 15)
    .map((item, idx) => {
      const resolvedExcerpt = safeResolveVaultText(
        item.vaultRef ?? item.textExcerpt,
      );
      const breadcrumb = item.breadcrumb.join(" > ");
      return `[Evidence ${idx + 1}] ${item.fileId}#${item.headingSlug} (${breadcrumb})\n${resolvedExcerpt}`;
    });

  const ledgerEntries = Object.values(state.master_ledger ?? {})
    .slice(0, 20)
    .map(
      (node) =>
        `- ${node.decisionId} [${node.impactTier}/${node.status}]: ${node.topicSlug} -> ${node.selectedOptionKey} (${node.selectionRationale})`,
    );

  const recentMessages = (state.messages ?? [])
    .slice(-8)
    .map((m) => `${m.role.toUpperCase()}: ${safeResolveVaultText(m.content)}`);

  return [
    `Classified Intent: ${state.classified_intent ?? "CHAT_ONLY"}`,
    `User Prompt: ${userPrompt}`,
    "",
    recentMessages.length > 0
      ? `Recent Conversation:\n${recentMessages.join("\n")}`
      : "Recent Conversation: none",
    "",
    evidenceBlocks.length > 0
      ? `Workspace Evidence:\n${evidenceBlocks.join("\n\n")}`
      : "Workspace Evidence: none",
    "",
    ledgerEntries.length > 0
      ? `ATMS Decision Ledger (${Object.keys(state.master_ledger ?? {}).length} total):\n${ledgerEntries.join("\n")}`
      : "ATMS Decision Ledger: empty",
  ].join("\n");
}

/**
 * Builds a deterministic fallback response when API keys are absent or offline.
 */
function buildOfflineFallbackResponse(state: Readonly<AgentGraphState>): string {
  const evidenceCount = state.search_report?.evidenceItems?.length ?? 0;
  const ledgerCount = Object.keys(state.master_ledger ?? {}).length;
  const summary = state.search_report?.summary?.trim();

  if (summary && evidenceCount > 0) {
    return `${summary} (Active ATMS decisions: ${ledgerCount}.)`;
  }

  if (ledgerCount > 0) {
    return `Reviewed ${ledgerCount} architectural decision(s) in the ATMS Decision Ledger.`;
  }

  return "Ready to assist with your workspace documentation and architectural decisions.";
}

/**
 * Unwrapped implementation of `directResponseNode` (Node 9: `direct_response_node`).
 */
export const rawDirectResponseNode: AgentGraphNodeFn = async (
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> => {
  const assistantMessageId = `assistant_${ctx.turnId || Date.now()}`;
  const createdAt = new Date().toISOString();
  const hasApiKeys =
    getApiKeys().length > 0 || Boolean(process.env.GEMINI_API_KEY);

  let finalContent = "";

  if (hasApiKeys) {
    try {
      const prompt = buildGroundedPrompt(state);
      const streamResult = await executeStreamingGeneration({
        modelId: ctx.selectedSystem2ModelId,
        abortSignal: ctx.abortSignal,
        system: [
          "You are Elixent, an expert engineering documentation and architecture assistant.",
          "Answer the user's question accurately using only the provided workspace evidence and ATMS Decision Ledger.",
          "Cite exact file IDs, heading slugs, and decision IDs when referencing workspace facts.",
          "Be concise, direct, and technically precise.",
        ].join("\n"),
        prompt,
      });

      for await (const chunk of streamResult.textStream) {
        if (!chunk) continue;
        finalContent += chunk;

        const streamingMessage: AgentConversationMessage = {
          id: assistantMessageId,
          role: "assistant",
          content: finalContent,
          createdAt,
        };

        ctx.emitSseEvent({
          type: "update",
          nodeId: "direct_response_node",
          stepIndex: (ctx as { currentStepIndex?: number }).currentStepIndex ?? 0,
          stateDelta: {
            messages: [streamingMessage],
          },
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (!finalContent.trim()) {
        finalContent = buildOfflineFallbackResponse(state);
      }
    }
  }

  if (!finalContent.trim()) {
    finalContent = buildOfflineFallbackResponse(state);
  }

  const finalMessage: AgentConversationMessage = {
    id: assistantMessageId,
    role: "assistant",
    content: finalContent,
    createdAt,
  };

  return {
    status: "COMPLETED",
    stateDelta: {
      messages: [finalMessage],
    },
  };
};

/**
 * Metered Node 9 (`direct_response_node`) wrapped with `withMeteredNodeGate`.
 */
export const directResponseNode: AgentGraphNodeFn = withMeteredNodeGate(
  "direct_response_node",
  "system2",
  rawDirectResponseNode,
  { isSystem2Node: true },
);
