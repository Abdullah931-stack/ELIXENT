/**
 * Stage 7 Workspace Mutator Node (Node 8: `workspace_mutator_node`)
 *
 * Implements metered, LLM-streamed three-way section editing and file lifecycle
 * execution for the Elixent Native Graph Engine (`ADR-009` & `SRS-01` §2.3):
 * 1. Executes approved `pending_file_actions` (`CREATE_FILE` / `DELETE_FILE`).
 * 2. Collects target `(fileId, headingSlug)` sections from `state.invalidation_map`
 *    (and `state.user_request.targetFileIds` for `FAST_LOCAL_EDIT` / `NEW_DOC_DRAFTING`).
 * 3. Reads base sections via `ctx.workspaceProvider.readSectionByHeading`, dereferencing
 *    any `vault_ref://` pointers in RAM via `resolveVaultRefJustInTime` for the LLM prompt.
 * 4. Streams full generative markdown edits via `executeStreamingGeneration` using
 *    `ctx.selectedSystem2ModelId`, governed by `state.master_ledger` and `state.governing_constraints`.
 * 5. Merges via `ctx.workspaceProvider.mergeSectionThreeWay` and branches SSE output by
 *    `ctx.permissionMode` (`safe` -> `ghost_hunk_proposed`; `semi_auto`/`full_auto` ->
 *    `vault_file_commit_required` for encrypted files or `file_mutated` otherwise).
 */

import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type {
  AgentConversationMessage,
  AgentGraphState,
  PendingFileLifecycleAction,
} from "@/core/agent/state";
import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import type { SectionTarget } from "@/core/agent/schemas/decision-schemas";
import type { WorkspaceTreeEntry } from "@/core/workspace/provider";
import type { SectionMergeOutcome } from "@/lib/sync/diff3";
import { executeStreamingGeneration } from "@/lib/ai/client";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import { resolveVaultRefJustInTime } from "@/lib/vault/ephemeral-memory-map";

/**
 * Result record tracking merge status for a single heading section.
 */
export interface SectionMergeRecord {
  readonly fileId: string;
  readonly headingSlug: string;
  readonly status: SectionMergeOutcome["status"];
  readonly diagnostics?: readonly string[];
}

function buildGovernanceContextText(
  target: SectionTarget,
  masterLedger: Record<string, ATMSDecisionNode>,
  governingConstraints: readonly ATMSDecisionNode[],
): string {
  const relevantById = new Map<string, ATMSDecisionNode>();

  for (const node of governingConstraints) {
    relevantById.set(node.decisionId, node);
  }

  for (const node of Object.values(masterLedger)) {
    const touchesTarget = node.affectedSections?.some(
      (sec) =>
        sec.fileId === target.fileId && sec.headingSlug === target.headingSlug,
    );
    if (touchesTarget) {
      relevantById.set(node.decisionId, node);
    }
  }

  if (relevantById.size === 0) {
    return "No specific prior ATMS decision constraints bound to this section.";
  }

  return Array.from(relevantById.values())
    .map(
      (node) =>
        `- [${node.decisionId}] ${node.topicSlug} (${node.selectedOptionKey}): ${node.selectionRationale}`,
    )
    .join("\n");
}

function dereferenceIfVaultPointer(text: string): string {
  if (!text || !text.includes("vault_ref://")) {
    return text;
  }
  return resolveVaultRefJustInTime(text);
}

async function collectTargetSections(
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<SectionTarget[]> {
  const targets: SectionTarget[] = [];
  const seenKeys = new Set<string>();

  for (const sections of Object.values(state.invalidation_map ?? {})) {
    for (const sec of sections) {
      const key = `${sec.fileId}#${sec.headingSlug}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        targets.push(sec);
      }
    }
  }

  const isLocalOrDraftIntent =
    state.classified_intent === "FAST_LOCAL_EDIT" ||
    state.classified_intent === "NEW_DOC_DRAFTING";

  if (
    targets.length === 0 &&
    isLocalOrDraftIntent &&
    state.user_request.targetFileIds.length > 0
  ) {
    const headingsByFile = await ctx.workspaceProvider.listHeadingsTree([
      ...state.user_request.targetFileIds,
    ]);
    for (const fileId of state.user_request.targetFileIds) {
      const headings = headingsByFile[fileId] ?? [];
      if (headings.length > 0) {
        const firstSlug = headings[0].headingSlug;
        const key = `${fileId}#${firstSlug}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          targets.push({ fileId, headingSlug: firstSlug });
        }
      }
    }
  }

  return targets;
}

/**
 * Unwrapped implementation of Node 8 (`workspace_mutator_node`).
 */
export const rawWorkspaceMutatorNode: AgentGraphNodeFn = async (
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> => {
  // 1. Execute approved file lifecycle actions
  const remainingFileActions: PendingFileLifecycleAction[] = [];
  let executedFileActionCount = 0;

  for (const action of state.pending_file_actions ?? []) {
    if (action.type === "CREATE_FILE") {
      const canCreate =
        action.approved === true ||
        (action.approved !== false && ctx.permissionMode !== "safe");
      if (canCreate) {
        const created = await ctx.workspaceProvider.createWorkspaceFile({
          relativePath: action.relativePath,
          initialContent: action.initialContent ?? "",
        });
        executedFileActionCount++;
        ctx.emitSseEvent({
          type: "file_mutated",
          fileId: created.fileId,
          relativePath: created.relativePath,
          action: "created",
        });
        continue;
      }
    } else if (action.type === "DELETE_FILE") {
      const canDelete =
        (action.approved === true || ctx.permissionMode === "full_auto") &&
        Boolean(action.fileId);
      if (canDelete && action.fileId) {
        await ctx.workspaceProvider.deleteWorkspaceFile({
          fileId: action.fileId,
        });
        executedFileActionCount++;
        ctx.emitSseEvent({
          type: "file_mutated",
          fileId: action.fileId,
          relativePath: action.relativePath,
          action: "deleted",
        });
        continue;
      }
    }

    remainingFileActions.push(action);
  }

  // 2. Load workspace tree metadata for encryption & relativePath lookup
  const workspaceTree = await ctx.workspaceProvider.listWorkspaceTree();
  const treeByFileId = new Map<string, WorkspaceTreeEntry>(
    workspaceTree.map((entry) => [entry.fileId, entry]),
  );

  // 3. Collect target sections from invalidation_map (or targetFileIds for fast/draft intents)
  const targetsToMerge = await collectTargetSections(state, ctx);
  const liveSnapshots = new Map<string, string>(ctx.liveDocumentSnapshots);
  const mergeRecords: SectionMergeRecord[] = [];
  const resolvedUserPrompt = dereferenceIfVaultPointer(
    state.user_request.prompt,
  );

  // 4. Stream generative markdown edits and execute 3-way section merge
  for (const target of targetsToMerge) {
    const readResult = await ctx.workspaceProvider.readSectionByHeading(
      target.fileId,
      target.headingSlug,
    );
    const basePlaintext = dereferenceIfVaultPointer(
      readResult.contentOrVaultRef,
    );
    const governanceContext = buildGovernanceContextText(
      target,
      state.master_ledger ?? {},
      state.governing_constraints ?? [],
    );

    const systemPrompt = [
      "You are Elixent's architectural document editor.",
      "Rewrite only the requested Markdown heading section cleanly and completely.",
      "Preserve the heading line itself and adhere strictly to all governing ATMS decisions.",
      "Do not emit HTML decision-alignment comment blocks or placeholder stubs.",
    ].join(" ");

    const userPrompt = [
      `Target File ID: ${target.fileId}`,
      `Heading Breadcrumb: ${readResult.breadcrumb || target.headingSlug}`,
      `User Request:\n${resolvedUserPrompt}`,
      `Governing Decisions & Constraints:\n${governanceContext}`,
      `Current Base Section Markdown:\n\`\`\`markdown\n${basePlaintext}\n\`\`\``,
      "Return only the updated Markdown for this section.",
    ].join("\n\n");

    const streamResult = await executeStreamingGeneration({
      modelId: ctx.selectedSystem2ModelId,
      system: systemPrompt,
      prompt: userPrompt,
      abortSignal: ctx.abortSignal,
    });
    const agentProposedSectionContent = (await streamResult.text).trim();

    const liveDocumentContent =
      liveSnapshots.get(target.fileId) ?? basePlaintext;

    const outcome = await ctx.workspaceProvider.mergeSectionThreeWay({
      fileId: target.fileId,
      headingSlug: target.headingSlug,
      baseSectionContent: readResult.contentOrVaultRef,
      agentProposedSectionContent,
      liveDocumentContent,
    });

    liveSnapshots.set(target.fileId, outcome.mergedDocumentContent);
    mergeRecords.push({
      fileId: target.fileId,
      headingSlug: target.headingSlug,
      status: outcome.status,
      diagnostics: outcome.diagnostics,
    });

    const treeEntry = treeByFileId.get(target.fileId);
    const relativePath = treeEntry?.relativePath ?? target.fileId;

    if (ctx.permissionMode === "safe") {
      ctx.emitSseEvent({
        type: "ghost_hunk_proposed",
        fileId: target.fileId,
        headingSlug: target.headingSlug,
        hunks: [outcome.hunkRange as unknown as Record<string, unknown>],
      });
    } else if (treeEntry?.isEncrypted) {
      ctx.emitSseEvent({
        type: "vault_file_commit_required",
        fileId: target.fileId,
        relativePath,
        mergedContent: outcome.mergedDocumentContent,
      });
    } else {
      ctx.emitSseEvent({
        type: "file_mutated",
        fileId: target.fileId,
        relativePath,
        action: "updated",
      });
    }
  }

  // 5. Build summary assistant message and clear invalidation_map
  const cleanCount = mergeRecords.filter((r) => r.status === "clean").length;
  const conflictCount = mergeRecords.filter(
    (r) => r.status === "conflict_quarantined",
  ).length;

  let summaryText: string;
  if (mergeRecords.length === 0 && executedFileActionCount === 0) {
    summaryText =
      "Workspace Mutator Node completed: no section modifications or file actions required.";
  } else {
    summaryText = `Workspace Mutator Node completed: ${cleanCount} section(s) cleanly merged, ${executedFileActionCount} file action(s) executed.`;
    if (conflictCount > 0) {
      summaryText += ` ${conflictCount} section(s) had concurrent conflicts quarantined.`;
    }
  }

  const summaryMessage: AgentConversationMessage = {
    id: `mutator-summary-${ctx.turnId}-${Date.now()}`,
    role: "assistant",
    content: summaryText,
    createdAt: new Date().toISOString(),
  };

  return {
    status: "COMPLETED",
    stateDelta: {
      messages: [summaryMessage],
      pending_file_actions: remainingFileActions,
      clearInvalidationMap: true,
    },
  };
};

/**
 * Metered Canonical Node 8 (`workspace_mutator_node`).
 */
export const workspaceMutatorNode: AgentGraphNodeFn = withMeteredNodeGate(
  "workspace_mutator_node",
  "system2",
  rawWorkspaceMutatorNode,
  { isSystem2Node: true },
);
