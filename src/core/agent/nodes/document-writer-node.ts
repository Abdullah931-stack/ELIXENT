/**
 * Stage 7 Document Writer Node
 *
 * Implements section-targeted three-way document editing for the Elixent agent
 * orchestration engine (ELIXENT-ARCH-02 §3 & ELIXENT-ARCH-03 §4).
 *
 * Execution Steps:
 * 1. Collects targeted document sections from `state.invalidation_map` (or active decisions in `state.master_ledger`).
 * 2. Retrieves base section content via `IWorkspaceProvider.readSectionByHeading`.
 * 3. Synthesizes agent-proposed updated section content aligning with resolved decisions in `master_ledger`.
 * 4. Executes isolated three-way merge via `IWorkspaceProvider.mergeSectionThreeWay` or `diff3MergeSection`,
 *    preserving non-conflicting concurrent edits and quarantining true overlaps.
 * 5. Returns updated conversation messages summarizing merge outcomes.
 */

import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { AgentGraphState } from "@/core/agent/state";
import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import type { SectionTarget } from "@/core/agent/schemas/decision-schemas";
import {
  diff3MergeSection,
  type SectionMergeOutcome,
} from "@/lib/sync/diff3";
import {
  type IWorkspaceProvider,
} from "@/core/workspace/provider";
import { CloudPostgresWorkspaceProvider } from "@/core/workspace/cloud-provider";

/**
 * Result record tracking merge status for a single heading section.
 */
export interface SectionMergeRecord {
  readonly fileId: string;
  readonly headingSlug: string;
  readonly status: SectionMergeOutcome["status"];
  readonly diagnostics?: readonly string[];
}

/**
 * Deterministically synthesizes updated section content reflecting committed ATMS decisions.
 *
 * @param baseContent - Current base plaintext of the heading section.
 * @param headingSlug - Target heading slug being edited.
 * @param relevantDecisions - Array of committed ATMS decisions affecting this section.
 * @returns Verbatim updated section content ready for 3-way merge.
 */
export function synthesizeAgentSectionContent(
  baseContent: string,
  headingSlug: string,
  relevantDecisions: readonly ATMSDecisionNode[],
): string {
  const trimmedBase = baseContent.trim();
  const humanReadableHeading = headingSlug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  // Build decision implementation bullet entries
  const decisionLines: string[] = [];
  for (const decision of relevantDecisions) {
    decisionLines.push(
      `- **${decision.topicSlug}** [${decision.selectedOptionKey}]: ${decision.selectionRationale}`,
    );
  }

  const decisionBlock = decisionLines.length > 0
    ? `\n\n<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->\n${decisionLines.join("\n")}\n<!-- END:AGENT_DECISION_ALIGNMENT -->`
    : "";

  if (trimmedBase.length === 0) {
    return `## ${humanReadableHeading}\n${decisionBlock.trimStart()}`;
  }

  // If section already has a decision block, update it cleanly
  const startMarker = "<!-- BEGIN:AGENT_DECISION_ALIGNMENT -->";
  const endMarker = "<!-- END:AGENT_DECISION_ALIGNMENT -->";
  const startIndex = trimmedBase.indexOf(startMarker);
  const endIndex = trimmedBase.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const beforeBlock = trimmedBase.slice(0, startIndex).trimEnd();
    const afterBlock = trimmedBase.slice(endIndex + endMarker.length).trimStart();
    const joined = `${beforeBlock}${decisionBlock}\n\n${afterBlock}`.trim();
    return joined;
  }

  // Otherwise, append the decision block to the base section
  return `${trimmedBase}${decisionBlock}`;
}

/**
 * Stage 7 Document Writer Node.
 *
 * Merges modifications across document sections registered in `state.invalidation_map`
 * using the Hunt-McIlroy Diff3 3-way merge engine.
 *
 * Architectural Invariants:
 * 1. Minimal Section Invalidation: Only sections listed in `state.invalidation_map`
 *    are inspected and patched; untouched document sections remain bit-for-bit identical.
 * 2. Zero Unresolved Conflicts in Memory: Merge conflicts (if any) are quarantined per-section
 *    without crashing the agent graph execution.
 * 3. Zero Knowledge Isolation: When operating on encrypted vault files, plaintexts are
 *    accessed strictly through `IWorkspaceProvider` using ephemeral references.
 *
 * @param state - Current agent graph state.
 * @param config - Optional runnable configuration containing workspaceProvider or snapshots.
 * @returns State delta containing summary messages and cleared invalidation map.
 */
export async function documentWriterNode(
  state: AgentGraphState,
  config?: RunnableConfig,
): Promise<Partial<AgentGraphState>> {
  const stateRecord = state as unknown as Record<string, unknown>;
  const configurable = config?.configurable as Record<string, unknown> | undefined;

  // 1. Collect target sections to modify from invalidation_map or master_ledger
  const targetsToMerge: SectionTarget[] = [];
  const seenTargetKeys = new Set<string>();

  for (const sections of Object.values(state.invalidation_map ?? {})) {
    for (const sec of sections) {
      const key = `${sec.fileId}#${sec.headingSlug}`;
      if (!seenTargetKeys.has(key)) {
        seenTargetKeys.add(key);
        targetsToMerge.push(sec);
      }
    }
  }

  // Fallback: If invalidation_map is empty, check master_ledger affectedSections
  if (targetsToMerge.length === 0) {
    for (const node of Object.values(state.master_ledger ?? {})) {
      for (const sec of node.affectedSections ?? []) {
        const key = `${sec.fileId}#${sec.headingSlug}`;
        if (!seenTargetKeys.has(key)) {
          seenTargetKeys.add(key);
          targetsToMerge.push(sec);
        }
      }
    }
  }

  // 2. Resolve Workspace Provider
  let provider = configurable?.workspaceProvider as IWorkspaceProvider | undefined;
  const userId = (
    configurable?.userId ??
    configurable?.user_id ??
    stateRecord.userId ??
    stateRecord.user_id ??
    "default-user"
  ) as string;

  const liveSnapshots: Record<string, string> = {
    ...((configurable?.liveDocumentSnapshots as Record<string, string> | undefined) ?? {}),
    ...((stateRecord.liveDocumentSnapshots as Record<string, string> | undefined) ?? {}),
  };

  if (!provider && typeof CloudPostgresWorkspaceProvider === "function") {
    try {
      provider = new CloudPostgresWorkspaceProvider({
        userId,
        liveDocumentSnapshots: liveSnapshots,
        ephemeralVaultPayloads: configurable?.ephemeralVaultPayloads as
          | Record<string, string>
          | undefined,
      });
    } catch {
      // In-memory or fallback mode if database cannot be initialized
      provider = undefined;
    }
  }

  const mergeRecords: SectionMergeRecord[] = [];

  // 3. Merge each targeted section individually
  for (const target of targetsToMerge) {
    const relevantDecisions = Object.values(state.master_ledger ?? {}).filter(
      (node) =>
        node.affectedSections?.some(
          (sec) =>
            sec.fileId === target.fileId &&
            sec.headingSlug === target.headingSlug,
        ),
    );

    let baseContent = "";
    if (provider) {
      try {
        const readResult = await provider.readSectionByHeading(
          target.fileId,
          target.headingSlug,
        );
        baseContent = readResult.contentOrVaultRef;
      } catch {
        baseContent = "";
      }
    }

    // Synthesize agent proposed content
    const agentContent = synthesizeAgentSectionContent(
      baseContent,
      target.headingSlug,
      relevantDecisions,
    );

    const liveDoc = liveSnapshots[target.fileId] ?? baseContent;
    let outcome: SectionMergeOutcome;

    if (provider) {
      try {
        outcome = await provider.mergeSectionThreeWay({
          fileId: target.fileId,
          headingSlug: target.headingSlug,
          baseSectionContent: baseContent,
          agentProposedSectionContent: agentContent,
          liveDocumentContent: liveDoc,
        });
      } catch {
        outcome = diff3MergeSection({
          headingSlug: target.headingSlug,
          liveDocumentContent: liveDoc,
          baseSectionContent: baseContent,
          agentProposedSectionContent: agentContent,
        });
      }
    } else {
      outcome = diff3MergeSection({
        headingSlug: target.headingSlug,
        liveDocumentContent: liveDoc,
        baseSectionContent: baseContent,
        agentProposedSectionContent: agentContent,
      });
    }

    // Update accumulated live document snapshot
    liveSnapshots[target.fileId] = outcome.mergedDocumentContent;

    mergeRecords.push({
      fileId: target.fileId,
      headingSlug: target.headingSlug,
      status: outcome.status,
      diagnostics: outcome.diagnostics,
    });
  }

  // 4. Synthesize final execution summary message
  const cleanCount = mergeRecords.filter((r) => r.status === "clean").length;
  const conflictCount = mergeRecords.filter(
    (r) => r.status === "conflict_quarantined",
  ).length;

  let summaryText = `Document Writer Node completed: ${cleanCount} section(s) cleanly merged.`;
  if (conflictCount > 0) {
    summaryText += ` ${conflictCount} section(s) had concurrent conflicts safely quarantined.`;
  }
  if (mergeRecords.length === 0) {
    summaryText = "Document Writer Node completed: no section modifications required.";
  }

  const summaryMessage = new AIMessage({
    content: summaryText,
  });

  return {
    messages: [summaryMessage],
    invalidation_map: {},
  };
}
