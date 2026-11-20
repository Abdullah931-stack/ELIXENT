/**
 * Stage 4 ATMS Ledger Commit Node (Node 7: `ledger_commit_node`)
 *
 * Implements deterministic ATMS DAG commitment for the Elixent Native Graph Engine:
 * - Converts approved decisions (`APPROVED_DIRECT` | `APPROVED_CONSERVATIVE`) from
 *   `state.scored_decisions` into formal `ATMSDecisionNode` entries in `master_ledger`.
 * - Updates `ledger_edges` (`DirectedDecisionEdge[]`), runs `assertAcyclicDecisionGraph`
 *   and `normalizeLedgerGraphIntegrity`.
 * - Recomputes 4-source `changeWeight` via `computeDecisionChangeWeight` across modified
 *   and connected nodes, and computes `invalidation_map` via `computeMinimalSectionInvalidationMap`.
 * - Persists `decisions.ledger.json` via `ctx.workspaceProvider.writeDecisionLedger` and emits
 *   `vault_file_commit_required` when the ledger artifact is encrypted.
 */

import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type { AgentGraphState } from "@/core/agent/state";
import {
  assertAcyclicDecisionGraph,
  normalizeLedgerGraphIntegrity,
  toProviderLedgerDocument,
  type ATMSDecisionNode,
  type DecisionLedgerDocument,
  type DecisionProvenance,
  type DirectedDecisionEdge,
} from "@/core/agent/atms/dag";
import {
  computeDecisionChangeWeight,
  computeMinimalSectionInvalidationMap,
} from "@/core/agent/atms/invalidation";
import type { EvaluatedAlternativeRecord } from "@/lib/jev/conformal-classifier";
import type { SectionTarget } from "@/core/agent/schemas/decision-schemas";
import type { DecisionLedgerDocument as ProviderDecisionLedgerDocument } from "@/core/workspace/provider";

/**
 * Normalized intermediate representation of a scored decision item.
 */
export interface ScoredDecisionCandidate {
  readonly decisionId: string;
  readonly topicSlug?: string;
  readonly questionPrompt?: string;
  readonly conceptTags?: readonly string[];
  readonly status?: "APPROVED_DIRECT" | "APPROVED_CONSERVATIVE" | "UNRESOLVED";
  readonly provenance?: DecisionProvenance | string;
  readonly impactTier?: "CORE_ARCHITECTURAL" | "PERIPHERAL";
  readonly isLoadBearing?: boolean;
  readonly selectedOptionKey?: string | null;
  readonly selectionRationale?: string;
  readonly runnerUpOptionKey?: string | null;
  readonly evaluatedAlternatives?: readonly EvaluatedAlternativeRecord[];
  readonly predictionSetCore?: readonly string[];
  readonly predictionSetPeriph?: readonly string[];
  readonly dominanceMargin?: number;
  readonly evidenceGrounding?: number;
  readonly probabilities?: Record<string, number>;
  readonly options?: ReadonlyArray<{
    readonly optionKey: string;
    readonly neutralSummary: string;
    readonly rationaleAndPremises: string;
  }>;
  readonly couplingLevel?: number;
  readonly rollbackCost?: number;
  readonly dependsOnDecisionIds?: readonly string[];
  readonly affectedSections?: ReadonlyArray<{
    readonly fileId: string;
    readonly headingSlug: string;
  }>;
  readonly reason?: string;
}

function resolveDecisionProvenance(
  rawProvenance: unknown,
  status: "APPROVED_DIRECT" | "APPROVED_CONSERVATIVE",
): DecisionProvenance {
  if (rawProvenance === "USER_EXPLICIT_HITL") {
    return "USER_EXPLICIT_HITL";
  }
  if (rawProvenance === "SYSTEM1_DIRECT_APS") {
    return "SYSTEM1_DIRECT_APS";
  }
  if (
    rawProvenance === "SYSTEM2_ESCALATED_APS" ||
    rawProvenance === "SYSTEM1_CONSERVATIVE_APS"
  ) {
    return "SYSTEM2_ESCALATED_APS";
  }
  return status === "APPROVED_CONSERVATIVE"
    ? "SYSTEM2_ESCALATED_APS"
    : "SYSTEM1_DIRECT_APS";
}

function extractAffectedSections(
  rawAffected: unknown,
  fallbackSections: ReadonlyArray<{ fileId: string; headingSlug: string }>,
): Array<{ fileId: string; headingSlug: string }> {
  const source = Array.isArray(rawAffected) ? rawAffected : fallbackSections;
  const sections: Array<{ fileId: string; headingSlug: string }> = [];

  for (const sec of source) {
    if (
      sec &&
      typeof sec === "object" &&
      typeof (sec as { fileId?: unknown }).fileId === "string" &&
      typeof (sec as { headingSlug?: unknown }).headingSlug === "string"
    ) {
      const fileId = (sec as { fileId: string }).fileId.trim();
      const headingSlug = (sec as { headingSlug: string }).headingSlug.trim();
      if (fileId.length > 0 && headingSlug.length > 0) {
        sections.push({ fileId, headingSlug });
      }
    }
  }

  return sections;
}

function extractDependsOn(
  item: Record<string, unknown>,
  fallbackDependsOn: readonly string[],
): string[] {
  const rawDependsOn =
    (Array.isArray(item.dependsOn) ? item.dependsOn : null) ??
    (Array.isArray(item.dependsOnDecisionIds)
      ? item.dependsOnDecisionIds
      : null) ??
    fallbackDependsOn;

  return Array.from(
    new Set(
      rawDependsOn.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      ),
    ),
  );
}

/**
 * Canonical Node 7 (`ledger_commit_node`).
 *
 * Commits approved decisions into the ATMS DAG, validates acyclicity, recomputes
 * 4-source `changeWeight` and `invalidation_map`, and persists `decisions.ledger.json`
 * via `ctx.workspaceProvider.writeDecisionLedger`.
 */
export const ledgerCommitNode: AgentGraphNodeFn = async (
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> => {
  const updatedMasterLedger: Record<string, ATMSDecisionNode> = {
    ...(state.master_ledger ?? {}),
  };
  const updatedEdges: DirectedDecisionEdge[] = [
    ...(state.ledger_edges ?? []),
  ];

  const unresolvedIds = new Set(
    (state.unresolved_ledger ?? []).map((u) => u.decisionId),
  );

  const committedIds: string[] = [];
  const nowIso = new Date().toISOString();

  for (const rawItem of state.scored_decisions ?? []) {
    if (!rawItem || typeof rawItem !== "object" || !("decisionId" in rawItem)) {
      continue;
    }

    const decId = String(rawItem.decisionId).trim();
    if (!decId || unresolvedIds.has(decId)) {
      continue;
    }

    const rawStatus = rawItem.status;
    if (
      rawStatus !== "APPROVED_DIRECT" &&
      rawStatus !== "APPROVED_CONSERVATIVE"
    ) {
      continue;
    }

    const status: "APPROVED_DIRECT" | "APPROVED_CONSERVATIVE" = rawStatus;
    const impactTier: "CORE_ARCHITECTURAL" | "PERIPHERAL" =
      rawItem.impactTier === "PERIPHERAL"
        ? "PERIPHERAL"
        : "CORE_ARCHITECTURAL";
    const isLoadBearing =
      typeof rawItem.isLoadBearing === "boolean"
        ? rawItem.isLoadBearing
        : impactTier === "CORE_ARCHITECTURAL";

    const matchingAssumption = state.assumptions?.find(
      (a) => a.assumptionId === decId,
    );

    const affectedSections = extractAffectedSections(
      rawItem.affectedSections,
      matchingAssumption?.affectedSections ?? [],
    );
    const dependsOn = extractDependsOn(
      rawItem,
      matchingAssumption?.dependsOn ?? [],
    );

    const existingNode = updatedMasterLedger[decId];
    const dependedBy = existingNode ? [...existingNode.dependedBy] : [];
    const provenance = resolveDecisionProvenance(rawItem.provenance, status);

    const evaluatedAlternatives: EvaluatedAlternativeRecord[] = Array.isArray(
      rawItem.evaluatedAlternatives,
    )
      ? rawItem.evaluatedAlternatives.map((alt) => {
          const record = alt as Record<string, unknown>;
          return {
            optionKey: String(record.optionKey ?? ""),
            neutralSummary: String(record.neutralSummary ?? ""),
            rationaleAndPremises: String(record.rationaleAndPremises ?? ""),
            normalizedProbability:
              typeof record.normalizedProbability === "number"
                ? record.normalizedProbability
                : undefined,
          };
        })
      : [];

    const committedNode: ATMSDecisionNode = {
      decisionId: decId,
      topicSlug: String(rawItem.topicSlug ?? decId),
      questionPrompt: String(rawItem.questionPrompt ?? decId),
      conceptTags: Array.isArray(rawItem.conceptTags)
        ? rawItem.conceptTags.map(String)
        : [],
      selectedOptionKey: String(
        rawItem.selectedOptionKey ??
          rawItem.runnerUpOptionKey ??
          "default_choice",
      ),
      selectionRationale: String(
        rawItem.selectionRationale ?? "Adopted during resolution commit.",
      ),
      runnerUpOptionKey: rawItem.runnerUpOptionKey
        ? String(rawItem.runnerUpOptionKey)
        : null,
      evaluatedAlternatives,
      status,
      impactTier,
      isLoadBearing,
      dependsOn,
      dependedBy,
      affectedSections,
      provenance,
      couplingLevel:
        typeof rawItem.couplingLevel === "number"
          ? rawItem.couplingLevel
          : existingNode?.couplingLevel,
      rollbackCost:
        typeof rawItem.rollbackCost === "number"
          ? rawItem.rollbackCost
          : existingNode?.rollbackCost,
      dominanceMargin:
        typeof rawItem.dominanceMargin === "number"
          ? rawItem.dominanceMargin
          : existingNode?.dominanceMargin,
      evidenceGrounding:
        typeof rawItem.evidenceGrounding === "number"
          ? rawItem.evidenceGrounding
          : existingNode?.evidenceGrounding,
      createdAt: existingNode?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    updatedMasterLedger[decId] = committedNode;
    committedIds.push(decId);

    for (const parentId of dependsOn) {
      const parentNode = updatedMasterLedger[parentId];
      if (parentNode && !parentNode.dependedBy.includes(decId)) {
        updatedMasterLedger[parentId] = {
          ...parentNode,
          dependedBy: [...parentNode.dependedBy, decId],
        };
      }

      const hasEdge = updatedEdges.some(
        (edge) =>
          edge.sourceDecisionId === decId &&
          edge.targetDecisionId === parentId &&
          edge.relation === "DEPENDS_ON",
      );
      if (!hasEdge) {
        updatedEdges.push({
          edgeId: `${decId}--DEPENDS_ON--${parentId}`,
          sourceDecisionId: decId,
          targetDecisionId: parentId,
          relation: "DEPENDS_ON",
          createdAt: nowIso,
        });
      }
    }
  }

  // Validate acyclicity and normalize bidirectional graph integrity
  assertAcyclicDecisionGraph(updatedMasterLedger, updatedEdges);

  const normalizedDoc = normalizeLedgerGraphIntegrity({
    schemaVersion: "2.0.0",
    workspaceId: ctx.workspaceId,
    updatedAt: nowIso,
    taxonomy: state.project_taxonomy ?? null,
    nodes: updatedMasterLedger,
    edges: updatedEdges,
  });

  // Recompute 4-source changeWeight W(d) across modified and connected nodes
  const nodesToReweight = new Set<string>(committedIds);
  for (const id of committedIds) {
    const node = normalizedDoc.nodes[id];
    if (!node) continue;
    for (const parentId of node.dependsOn) {
      nodesToReweight.add(parentId);
    }
    for (const childId of node.dependedBy) {
      nodesToReweight.add(childId);
    }
  }

  const finalNodes: Record<string, ATMSDecisionNode> = {
    ...normalizedDoc.nodes,
  };
  for (const nodeId of nodesToReweight) {
    const node = finalNodes[nodeId];
    if (!node) continue;
    finalNodes[nodeId] = {
      ...node,
      changeWeight: computeDecisionChangeWeight(node, finalNodes),
    };
  }

  const computedInvalidationMap: Record<string, SectionTarget[]> =
    computeMinimalSectionInvalidationMap(committedIds, finalNodes);

  const finalLedgerDoc: DecisionLedgerDocument = {
    schemaVersion: "2.0.0",
    workspaceId: ctx.workspaceId,
    updatedAt: nowIso,
    taxonomy: state.project_taxonomy ?? null,
    nodes: finalNodes,
    edges: normalizedDoc.edges,
  };

  const providerLedgerDoc = toProviderLedgerDocument(finalLedgerDoc);
  await ctx.workspaceProvider.writeDecisionLedger(
    providerLedgerDoc as unknown as ProviderDecisionLedgerDocument,
  );

  // If the ledger artifact is encrypted, emit vault_file_commit_required for client E2EE sync
  const workspaceTree = await ctx.workspaceProvider.listWorkspaceTree();
  const ledgerEntry = workspaceTree.find(
    (entry) => entry.artifactRole === "decision_ledger",
  );
  if (ledgerEntry?.isEncrypted) {
    ctx.emitSseEvent({
      type: "vault_file_commit_required",
      fileId: ledgerEntry.fileId,
      relativePath: ledgerEntry.relativePath,
      mergedContent: JSON.stringify(providerLedgerDoc, null, 2),
    });
  }

  return {
    status: "COMPLETED",
    stateDelta: {
      master_ledger: finalNodes,
      ledger_edges: normalizedDoc.edges,
      ...(Object.keys(computedInvalidationMap).length > 0
        ? { invalidation_map: computedInvalidationMap }
        : {}),
    },
  };
};
