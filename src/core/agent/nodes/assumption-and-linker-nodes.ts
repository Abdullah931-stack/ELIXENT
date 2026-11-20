/**
 * Assumption Extraction, ATMS Relational Linker & Anti-Domino Gate (Nodes 3 & 4)
 *
 * Implements Stage 2 canonical nodes for the Elixent Native Graph Engine (`ADR-009` & `SRS-01`):
 * 1. `assumptionExtractorNode` / `rawAssumptionExtractorNode`: Extracts architectural assumptions
 *    with `intentType` (`DIRECT_USER_INSTRUCTION` | `INFERRED_COLLATERAL_ASSUMPTION`) and 3-4
 *    neutral options (`NeutralOptionSchema`), merging tool-discovered decisions with
 *    `retrieveCandidatePriorDecisions`.
 * 2. `conflictAndWeightGateNode`: Adjudicates relational links via `linkAssumptionsToPriorDecisions`,
 *    enforces `evaluateAntiDominoGate`, executes `resolveATMSCascadeBFS`, and computes
 *    `computeMinimalSectionInvalidationMap`.
 */

import { z } from "zod";
import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import { retrieveCandidatePriorDecisions } from "@/core/agent/atms/candidate-retriever";
import {
  computeMinimalSectionInvalidationMap,
  evaluateAntiDominoGate,
  resolveATMSCascadeBFS,
  type LinkedAssumptionInput,
} from "@/core/agent/atms/invalidation";
import { linkAssumptionsToPriorDecisions } from "@/core/agent/atms/relational-linker";
import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import {
  reduceInvalidationMap,
  type ClarifyingQuestionBatch,
  type SearchReport,
} from "@/core/agent/reducers";
import {
  createAssumptionItemSchema,
  NeutralOptionSchema,
  type AssumptionIntentType,
  type NeutralDecisionOptionInput,
  type SectionTarget,
} from "@/core/agent/schemas/decision-schemas";
import type { AgentGraphState, AssumptionItem } from "@/core/agent/state";
import { resolveProjectConceptTags } from "@/core/agent/taxonomy/predefined-tags";
import { executeStructuredGeneration } from "@/lib/ai/client";
import { getApiKeys } from "@/lib/ai/key-rotation";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import { resolveVaultRefJustInTime } from "@/lib/vault/ephemeral-memory-map";

/**
 * Extended assumption shape carrying retrieved candidate prior decision IDs
 * and neutral pre-scoring options (`NeutralOptionSchema`).
 */
export interface AnalyzedAssumptionItem extends AssumptionItem {
  readonly candidateDecisionIds?: readonly string[];
  readonly neutralOptions?: readonly NeutralDecisionOptionInput[];
  readonly constrainedByPrior?: boolean;
}

function slugifyOptionPrefix(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.slice(0, 28) || "option";
}

function buildFallbackNeutralOptions(statement: string): NeutralDecisionOptionInput[] {
  const prefix = slugifyOptionPrefix(statement);
  return [
    {
      optionKey: `${prefix}_standard`,
      neutralSummary: "Adopt standard modular implementation aligned with existing workspace boundaries.",
      technicalConstraints: ["Preserves existing module interfaces", "Minimal structural coupling"],
    },
    {
      optionKey: `${prefix}_conservative`,
      neutralSummary: "Apply conservative incremental change with strict fallback isolation.",
      technicalConstraints: ["Limits blast radius to local section", "Easy rollback via isolated boundary"],
    },
    {
      optionKey: `${prefix}_decoupled`,
      neutralSummary: "Introduce decoupled abstraction layer separating core policy from implementation.",
      technicalConstraints: ["Higher initial indirection", "Isolates downstream dependents"],
    },
  ];
}

function normalizeNeutralOptions(
  rawOptions: readonly NeutralDecisionOptionInput[] | undefined,
  statement: string,
): NeutralDecisionOptionInput[] {
  if (!Array.isArray(rawOptions) || rawOptions.length < 3) {
    return buildFallbackNeutralOptions(statement);
  }

  return rawOptions.slice(0, 4).map((opt, idx) => ({
    optionKey: opt.optionKey.toLowerCase().replace(/[^a-z0-9_]/g, "_") || `option_${idx + 1}`,
    neutralSummary: opt.neutralSummary.slice(0, 220),
    technicalConstraints:
      opt.technicalConstraints.length > 0
        ? opt.technicalConstraints.slice(0, 4).map((c: string) => c.slice(0, 160))
        : ["Standard architectural constraint"],
  }));
}

function mergeCandidateDecisionIds(
  assumption: AssumptionItem,
  masterLedger: Record<string, ATMSDecisionNode>,
  searchReport: SearchReport | undefined,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  const pushId = (id: string): void => {
    if (id && masterLedger[id] && !seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  };

  if (searchReport) {
    const ledgerIds = Object.keys(masterLedger);
    const searchableText = [
      searchReport.summary ?? "",
      ...(searchReport.inspectedPaths ?? []),
      ...(searchReport.evidenceItems ?? []).map(
        (ev) => `${ev.fileId} ${ev.headingSlug} ${ev.textExcerpt}`,
      ),
    ].join("\n");

    for (const id of ledgerIds) {
      if (searchableText.includes(id)) {
        pushId(id);
      }
    }
  }

  const retrieved = retrieveCandidatePriorDecisions(assumption, masterLedger);
  for (const node of retrieved) {
    pushId(node.decisionId);
  }

  return merged;
}

/**
 * Unwrapped implementation of Node 3 (`assumption_extractor_node`).
 *
 * Extracts architectural assumptions with `intentType` classification and 3-4
 * neutral options (`NeutralOptionSchema`, zero `rationaleAndPremises`), then merges
 * tool-discovered prior decisions with `retrieveCandidatePriorDecisions`.
 */
export async function rawAssumptionExtractorNode(
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> {
  const activeTags = resolveProjectConceptTags(state.project_taxonomy);
  const itemSchema = createAssumptionItemSchema(activeTags).extend({
    options: z.array(NeutralOptionSchema).min(3).max(4).optional(),
  });
  const extractionSchema = z.object({
    assumptions: z.array(itemSchema),
  });

  const dereferencedPrompt = resolveVaultRefJustInTime(state.user_request?.prompt ?? "");
  const evidenceSummaries = (state.search_report?.evidenceItems ?? []).map(
    (e) => `[${e.fileId}#${e.headingSlug}]: ${resolveVaultRefJustInTime(e.textExcerpt)}`,
  );

  const hasApiKeys = getApiKeys().length > 0 || Boolean(process.env.GEMINI_API_KEY);
  let extractedAssumptions: AnalyzedAssumptionItem[] = [];

  if (hasApiKeys) {
    try {
      const promptText = [
        "Analyze the user request and gathered workspace evidence to extract distinct architectural assumptions.",
        "For each assumption, classify intentType as DIRECT_USER_INSTRUCTION (explicitly requested by user) or INFERRED_COLLATERAL_ASSUMPTION (implied side-effect), and provide 3-4 mutually exclusive neutral options (optionKey, neutralSummary, technicalConstraints only — no rationaleAndPremises).",
        `User Request: ${dereferencedPrompt}`,
        evidenceSummaries.length > 0
          ? `Workspace Evidence:\n${evidenceSummaries.join("\n")}`
          : "No workspace evidence available.",
      ].join("\n\n");

      const result = await executeStructuredGeneration({
        modelId: ctx.selectedSystem2ModelId,
        schema: extractionSchema,
        prompt: promptText,
        system:
          "You are an architectural assumption extractor. Extract concise technical assumptions with intentType, 1-6 authorized conceptTags from the active project taxonomy, and 3-4 neutral options.",
        abortSignal: ctx.abortSignal,
      });

      if (result.object && Array.isArray(result.object.assumptions)) {
        extractedAssumptions = result.object.assumptions.map((a, index) => {
          const statement = a.statement || a.assumptionStatement || "";
          const intentType: AssumptionIntentType =
            a.intentType ?? "INFERRED_COLLATERAL_ASSUMPTION";
          return {
            assumptionId: a.assumptionId || `asmp_${Date.now()}_${index + 1}`,
            statement,
            intentType,
            conceptTags: (a.conceptTags as string[]) ?? [activeTags[0]],
            affectedSections: (a.affectedSections as SectionTarget[]) ?? [],
            dependsOn: a.dependsOn ?? [],
            neutralOptions: normalizeNeutralOptions(a.options, statement),
          };
        });
      }
    } catch {
      extractedAssumptions = [];
    }
  }

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
        intentType: "DIRECT_USER_INSTRUCTION",
        conceptTags: [activeTags[0]],
        affectedSections,
        dependsOn: [],
        neutralOptions: buildFallbackNeutralOptions(prompt),
      });
    }
  }

  const masterLedger = state.master_ledger ?? {};
  const enrichedAssumptions: AnalyzedAssumptionItem[] = extractedAssumptions.map((assumption) => ({
    ...assumption,
    candidateDecisionIds: mergeCandidateDecisionIds(
      assumption,
      masterLedger,
      state.search_report,
    ),
  }));

  return {
    status: "COMPLETED",
    stateDelta: {
      assumptions: enrichedAssumptions,
    },
  };
}

/**
 * Metered Node 3 (`assumption_extractor_node`) wrapped with `withMeteredNodeGate`.
 */
export const assumptionExtractorNode: AgentGraphNodeFn = withMeteredNodeGate(
  "assumption_extractor_node",
  "system2",
  rawAssumptionExtractorNode,
  { isSystem2Node: true },
);

function buildAntiDominoEscalationQuestion(
  assumption: AssumptionItem,
  priorNode: ATMSDecisionNode,
  masterLedger: Record<string, ATMSDecisionNode>,
): ClarifyingQuestionBatch["questions"][number] {
  const dependentCount = countTransitiveDependents(priorNode.decisionId, priorNode, masterLedger);
  const affectedSectionsList = (priorNode.affectedSections ?? [])
    .map((s) => `${s.fileId}#${s.headingSlug}`)
    .join(", ");

  return {
    questionId: `antidomino_${priorNode.decisionId}`,
    topicSlug: priorNode.topicSlug,
    questionPrompt: `Assumption "${assumption.statement}" conflicts with prior decision "${priorNode.questionPrompt}" (${priorNode.selectedOptionKey}). Confirm override or preserve prior decision?`,
    options: [
      {
        optionKey: "preserve_prior",
        neutralSummary: `Preserve prior decision (${priorNode.selectedOptionKey}) and constrain the new assumption.`,
      },
      {
        optionKey: "confirm_override",
        neutralSummary: `Override prior decision (${priorNode.decisionId}) and cascade updates to ${dependentCount} dependent(s).`,
      },
    ],
    contextExplanation: `Anti-Domino Blast Radius: ${dependentCount} dependent decision(s); affected sections: [${affectedSectionsList || "none"}].`,
  };
}

function countTransitiveDependents(
  rootId: string,
  rootNode: ATMSDecisionNode,
  masterLedger: Record<string, ATMSDecisionNode>,
): number {
  const visited = new Set<string>([rootId]);
  const queue: string[] = [...(rootNode.dependedBy ?? [])];
  let count = 0;

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    count += 1;

    const child = masterLedger[currentId];
    if (child?.dependedBy) {
      for (const grandChildId of child.dependedBy) {
        if (!visited.has(grandChildId)) {
          queue.push(grandChildId);
        }
      }
    }
  }

  return count;
}

/**
 * Node 4 (`conflict_and_weight_gate_node`): Pure deterministic + relational-linker node.
 *
 * Adjudicates links via `linkAssumptionsToPriorDecisions`, enforces `evaluateAntiDominoGate`
 * for `REOPENS_OR_OVERRIDES` links, executes `resolveATMSCascadeBFS`, and computes
 * `computeMinimalSectionInvalidationMap`.
 */
export async function conflictAndWeightGateNode(
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> {
  const assumptions = state.assumptions ?? [];
  const masterLedger = state.master_ledger ?? {};

  if (assumptions.length === 0) {
    return {
      status: "COMPLETED",
      stateDelta: {
        master_ledger: masterLedger,
        invalidation_map: state.invalidation_map ?? {},
      },
    };
  }

  const linkedGroups = await linkAssumptionsToPriorDecisions(assumptions, masterLedger, {
    abortSignal: ctx.abortSignal,
  });

  const constrainedAssumptionIds = new Set<string>();
  const governingMap = new Map<string, ATMSDecisionNode>();
  for (const existing of state.governing_constraints ?? []) {
    governingMap.set(existing.decisionId, existing);
  }

  const escalatedQuestions: Array<ClarifyingQuestionBatch["questions"][number]> = [];
  const permittedGroups: Array<LinkedAssumptionInput<AssumptionItem>> = [];
  const localizedOverrideRootIds: string[] = [];

  for (const group of linkedGroups) {
    const intentType: AssumptionIntentType =
      group.assumption.intentType ?? "INFERRED_COLLATERAL_ASSUMPTION";
    const permittedRelations = [];
    let isConstrainedByPrior = false;

    for (const rel of group.relations) {
      if (rel.relationType !== "REOPENS_OR_OVERRIDES") {
        permittedRelations.push(rel);
        continue;
      }

      const priorNode = masterLedger[rel.targetDecisionId];
      if (!priorNode) {
        continue;
      }

      const verdict = evaluateAntiDominoGate(
        { intentType },
        priorNode,
        masterLedger,
      );

      if (verdict === "CONSTRAINED_BY_PRIOR") {
        isConstrainedByPrior = true;
        governingMap.set(priorNode.decisionId, priorNode);
      } else if (verdict === "ESCALATE_TO_HITL") {
        escalatedQuestions.push(
          buildAntiDominoEscalationQuestion(group.assumption, priorNode, masterLedger),
        );
      } else {
        // LOCALIZED_OVERRIDE
        localizedOverrideRootIds.push(priorNode.decisionId);
        permittedRelations.push(rel);
      }
    }

    if (isConstrainedByPrior) {
      constrainedAssumptionIds.add(group.assumption.assumptionId);
    } else {
      permittedGroups.push({
        assumption: group.assumption,
        relations: permittedRelations,
      });
    }
  }

  const cascadeResult = resolveATMSCascadeBFS(permittedGroups, masterLedger);

  const rootDecisionIds = Array.from(
    new Set([
      ...cascadeResult.reopenedOrPromotedNodes.map((node) => node.decisionId),
      ...localizedOverrideRootIds,
    ]),
  );

  const minimalInvalidations = computeMinimalSectionInvalidationMap(
    rootDecisionIds,
    masterLedger,
  );
  const mergedInvalidations = reduceInvalidationMap(
    state.invalidation_map ?? {},
    minimalInvalidations,
  );

  const taggedAssumptions: AnalyzedAssumptionItem[] = assumptions.map((a) =>
    constrainedAssumptionIds.has(a.assumptionId)
      ? { ...a, constrainedByPrior: true }
      : a,
  );
  const existingAssumptionIds = new Set(taggedAssumptions.map((a) => a.assumptionId));

  const reopenedAssumptions: AssumptionItem[] = cascadeResult.reopenedOrPromotedNodes
    .filter((node) => !existingAssumptionIds.has(node.decisionId))
    .map((node) => ({
      assumptionId: node.decisionId,
      statement: node.questionPrompt,
      intentType: "INFERRED_COLLATERAL_ASSUMPTION",
      conceptTags: node.conceptTags,
      affectedSections: node.affectedSections,
      dependsOn: node.dependsOn,
    }));

  const questionQueue: ClarifyingQuestionBatch | null =
    escalatedQuestions.length > 0
      ? { questions: escalatedQuestions }
      : (state.question_queue ?? null);

  const hasEvictions =
    cascadeResult.reopenedOrPromotedNodes.length > 0 ||
    cascadeResult.cascadedDependentNodes.length > 0;

  return {
    status: "COMPLETED",
    stateDelta: {
      assumptions: [...taggedAssumptions, ...reopenedAssumptions],
      governing_constraints: Array.from(governingMap.values()),
      master_ledger: cascadeResult.updatedLedger,
      ...(hasEvictions ? { replaceMasterLedger: true } : {}),
      invalidation_map: mergedInvalidations,
      question_queue: questionQueue,
    },
  };
}
