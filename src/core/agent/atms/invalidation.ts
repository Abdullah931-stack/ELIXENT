/**
 * ATMS Invalidation, Cascading BFS & Differential Section Invalidation
 *
 * Implements deterministic truth maintenance algorithms for the Justification-Driven
 * Assumption-based Truth Maintenance System (`ELIXENT-ARCH-02` §5.2 & §5.3):
 * 1. `resolveATMSCascadeBFS`: Bidirectional BFS propagating upward promotions for
 *    provisional decisions (`APPROVED_CONSERVATIVE`) upon which new requests depend,
 *    and downward invalidation cascades across `dependedBy` edges when a prior decision
 *    is reopened or overridden.
 * 2. `computeMinimalSectionInvalidationMap`: Downward BFS collecting the exact
 *    `(fileId, headingSlug)` section targets impacted by an override, ensuring
 *    differential document editing without touching unrelated document sections.
 *
 * Architectural Invariants:
 * - Deterministic & Side-Effect Free: Never mutates input arguments or shared references.
 * - Sibling Sub-Decision Independence: Independent relations (`INDEPENDENT`) leave prior
 *   decisions completely untouched, allowing sibling decisions under the same section heading
 *   to coexist stably.
 * - Cycle-Safe: Enforces visited sets across both upward and downward graph traversals.
 */

import {
  type ATMSDecisionNode,
  type ChangeWeightBreakdown,
  cloneATMSDecisionNode,
  cloneMasterLedger,
  isSystemReservedDecisionId,
} from "./dag";
export type { ChangeWeightBreakdown };
import type { CandidateRetrievalInput } from "./candidate-retriever";
import type { RelationalLinkType, SectionTarget } from "@/core/agent/schemas/decision-schemas";

// ============================================================================
// 1. Exported Types & Contracts
// ============================================================================

export interface LinkedAssumptionRelationInput {
  targetDecisionId: string;
  relationType: RelationalLinkType;
  confidence?: number;
  justification?: string;
}

export interface LinkedAssumptionInput<
  TAssumption extends CandidateRetrievalInput = CandidateRetrievalInput,
> {
  assumption: TAssumption;
  relations: ReadonlyArray<LinkedAssumptionRelationInput>;
}

export interface ATMSCascadeResult {
  reopenedOrPromotedNodes: ATMSDecisionNode[];
  cascadedDependentNodes: ATMSDecisionNode[];
  updatedLedger: Record<string, ATMSDecisionNode>;
}

// ============================================================================
// 2. Pure Deterministic Helper Functions
// ============================================================================

function deduplicateSectionTargets(
  sections: ReadonlyArray<{ fileId: string; headingSlug: string }>,
): SectionTarget[] {
  if (!Array.isArray(sections) || sections.length === 0) {
    return [];
  }

  const seenKeys = new Set<string>();
  const deduplicated: SectionTarget[] = [];

  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const fileId = typeof section.fileId === "string" ? section.fileId.trim() : "";
    const headingSlug =
      typeof section.headingSlug === "string" ? section.headingSlug.trim() : "";

    if (fileId.length === 0 || headingSlug.length === 0) continue;

    const sectionKey = `${fileId}#${headingSlug}`;
    if (!seenKeys.has(sectionKey)) {
      seenKeys.add(sectionKey);
      deduplicated.push({ fileId, headingSlug });
    }
  }

  return deduplicated;
}

// ============================================================================
// 3. Core Algorithm: resolveATMSCascadeBFS (ELIXENT-ARCH-02 §5.2)
// ============================================================================

/**
 * Resolves bidirectional cascades across the ATMS DAG based on relational links
 * between new assumptions and retrieved prior decisions.
 *
 * 1. Step 1 (Direct Link Evaluation):
 *    - `INDEPENDENT`: No modification. Sibling decisions under the same heading remain intact.
 *    - `DEPENDS_ON` / `REFINES`: Registers dependency and queues target for upward evaluation.
 *    - `REOPENS_OR_OVERRIDES`: Promotes target node to `CORE_ARCHITECTURAL`, evicts it from the
 *      working ledger, and queues all its direct dependents into the downward cascade.
 * 2. Step 2 (Upward Promotion Path):
 *    - Traverses `dependsOn` edges upward via BFS.
 *    - Promotes any reached `APPROVED_CONSERVATIVE` decision to `CORE_ARCHITECTURAL` (`isLoadBearing: true`),
 *      evicting it to `reopenedOrPromotedNodes` for re-evaluation with current evidence.
 * 3. Step 3 (Downward Cascade Path):
 *    - Traverses `dependedBy` edges downward via BFS.
 *    - Evicts all transitively dependent decisions to `cascadedDependentNodes` for parallel re-evaluation.
 * 4. Step 4 (Graph Hygiene):
 *    - Prunes all evicted decision references from surviving nodes' `dependsOn` and `dependedBy` lists.
 */
export function resolveATMSCascadeBFS(
  linkedAssumptions: ReadonlyArray<LinkedAssumptionInput>,
  masterLedger: Record<string, ATMSDecisionNode>,
): ATMSCascadeResult {
  const workingLedger = cloneMasterLedger(masterLedger);
  const reopenedOrPromotedMap = new Map<string, ATMSDecisionNode>();
  const cascadedDependentMap = new Map<string, ATMSDecisionNode>();

  const upwardQueue: string[] = [];
  const upwardVisited = new Set<string>();
  const downwardQueue: string[] = [];
  const downwardVisited = new Set<string>();

  const enqueueUpward = (decisionId: string): void => {
    const trimmed = decisionId.trim();
    if (trimmed.length > 0 && !upwardVisited.has(trimmed)) {
      upwardVisited.add(trimmed);
      upwardQueue.push(trimmed);
    }
  };

  const enqueueDownward = (decisionId: string): void => {
    const trimmed = decisionId.trim();
    if (trimmed.length > 0 && !downwardVisited.has(trimmed)) {
      downwardVisited.add(trimmed);
      downwardQueue.push(trimmed);
    }
  };

  // Step 1: Direct Link Evaluation
  if (Array.isArray(linkedAssumptions)) {
    for (const linked of linkedAssumptions) {
      if (!linked || !Array.isArray(linked.relations)) {
        continue;
      }

      for (const rel of linked.relations) {
        if (!rel || typeof rel.targetDecisionId !== "string") {
          continue;
        }

        const targetId = rel.targetDecisionId.trim();
        if (targetId.length === 0) {
          continue;
        }

        // INDEPENDENT: Explicit zero-op. Sibling sub-decisions remain intact in updatedLedger.
        if (rel.relationType === "INDEPENDENT") {
          continue;
        }

        if (rel.relationType === "DEPENDS_ON" || rel.relationType === "REFINES") {
          if (Array.isArray(linked.assumption?.dependsOn)) {
            const mutableDeps = linked.assumption.dependsOn as string[];
            if (!mutableDeps.includes(targetId)) {
              mutableDeps.push(targetId);
            }
          }
          enqueueUpward(targetId);
        } else if (rel.relationType === "REOPENS_OR_OVERRIDES") {
          const targetNode = workingLedger[targetId] ?? reopenedOrPromotedMap.get(targetId);
          if (targetNode) {
            const clonedTarget = cloneATMSDecisionNode(targetNode);
            clonedTarget.impactTier = "CORE_ARCHITECTURAL";
            clonedTarget.isLoadBearing = true;

            delete workingLedger[targetId];
            cascadedDependentMap.delete(targetId);
            reopenedOrPromotedMap.set(targetId, clonedTarget);

            for (const childId of targetNode.dependedBy ?? []) {
              enqueueDownward(childId);
            }
          }
        }
      }
    }
  }

  // Step 2: Upward Promotion Path (BFS over dependsOn)
  while (upwardQueue.length > 0) {
    const currentId = upwardQueue.shift()!;
    const currentNode = workingLedger[currentId];

    if (!currentNode) {
      // If node was already promoted or evicted, still traverse its parent dependencies
      const alreadyPromoted = reopenedOrPromotedMap.get(currentId);
      if (alreadyPromoted) {
        for (const parentDepId of alreadyPromoted.dependsOn ?? []) {
          enqueueUpward(parentDepId);
        }
      }
      continue;
    }

    if (currentNode.status === "APPROVED_CONSERVATIVE") {
      const promotedNode = cloneATMSDecisionNode(currentNode);
      promotedNode.impactTier = "CORE_ARCHITECTURAL";
      promotedNode.isLoadBearing = true;

      delete workingLedger[currentId];
      cascadedDependentMap.delete(currentId);
      reopenedOrPromotedMap.set(currentId, promotedNode);

      for (const parentDepId of currentNode.dependsOn ?? []) {
        enqueueUpward(parentDepId);
      }
    } else if (currentNode.status === "APPROVED_DIRECT") {
      // Load-bearing core decision: verify its dependency chain upward
      for (const parentDepId of currentNode.dependsOn ?? []) {
        enqueueUpward(parentDepId);
      }
    }
  }

  // Step 3: Downward Cascade Path (BFS over dependedBy)
  while (downwardQueue.length > 0) {
    const depId = downwardQueue.shift()!;
    const depNode = workingLedger[depId];

    if (!depNode) {
      continue;
    }

    const clonedDep = cloneATMSDecisionNode(depNode);
    delete workingLedger[depId];

    // Promotion to CORE_ARCHITECTURAL takes precedence over downward dependent status
    if (!reopenedOrPromotedMap.has(depId)) {
      cascadedDependentMap.set(depId, clonedDep);
    }

    for (const grandChildId of depNode.dependedBy ?? []) {
      enqueueDownward(grandChildId);
    }
  }

  // Step 4: Graph Hygiene on Surviving Nodes
  const allEvictedIds = new Set<string>([
    ...reopenedOrPromotedMap.keys(),
    ...cascadedDependentMap.keys(),
  ]);

  if (allEvictedIds.size > 0) {
    for (const survivingNode of Object.values(workingLedger)) {
      survivingNode.dependsOn = survivingNode.dependsOn.filter(
        (id) => !allEvictedIds.has(id),
      );
      survivingNode.dependedBy = survivingNode.dependedBy.filter(
        (id) => !allEvictedIds.has(id),
      );
    }
  }

  return {
    reopenedOrPromotedNodes: Array.from(reopenedOrPromotedMap.values()),
    cascadedDependentNodes: Array.from(cascadedDependentMap.values()),
    updatedLedger: workingLedger,
  };
}

// ============================================================================
// 4. Differential Section Invalidation: computeMinimalSectionInvalidationMap (ELIXENT-ARCH-02 §5.3)
// ============================================================================

/**
 * Computes a minimal differential section invalidation map for a set of modified
 * or overridden root decision IDs.
 *
 * Traverses downward through `dependedBy` edges via BFS to identify all impacted
 * downstream decisions, extracting deduplicated `(fileId, headingSlug)` section targets
 * for each affected decision node.
 */
export function computeMinimalSectionInvalidationMap(
  rootDecisionIds: readonly string[],
  masterLedger: Record<string, ATMSDecisionNode>,
): Record<string, SectionTarget[]> {
  if (
    !Array.isArray(rootDecisionIds) ||
    rootDecisionIds.length === 0 ||
    !masterLedger ||
    typeof masterLedger !== "object"
  ) {
    return {};
  }

  const invalidationMap: Record<string, SectionTarget[]> = {};
  const queue: string[] = [];
  const visited = new Set<string>();

  for (const rawId of rootDecisionIds) {
    if (typeof rawId !== "string") continue;
    const trimmed = rawId.trim();
    if (trimmed.length > 0 && !visited.has(trimmed)) {
      visited.add(trimmed);
      queue.push(trimmed);
    }
  }

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const node = masterLedger[currentId];

    if (!node) {
      continue;
    }

    if (Array.isArray(node.affectedSections) && node.affectedSections.length > 0) {
      const canonicalSections = deduplicateSectionTargets(node.affectedSections);
      if (canonicalSections.length > 0) {
        invalidationMap[currentId] = canonicalSections;
      }
    }

    for (const rawChildId of node.dependedBy ?? []) {
      if (typeof rawChildId !== "string") continue;
      const childId = rawChildId.trim();
      if (childId.length > 0 && !visited.has(childId)) {
        visited.add(childId);
        queue.push(childId);
      }
    }
  }

  return invalidationMap;
}


// ============================================================================
// 5. 4-Source Decision Change Weight W(d) & Anti-Domino Gate (ADR-014 / SRS-01 §5)
// ============================================================================

export type AntiDominoGateVerdict =
  | "CONSTRAINED_BY_PRIOR"
  | "ESCALATE_TO_HITL"
  | "LOCALIZED_OVERRIDE";

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function collectTransitiveDependents(
  rootDecisionId: string,
  rootNode: ATMSDecisionNode,
  allNodes: Record<string, ATMSDecisionNode>,
): { directCount: number; indirectCount: number; totalCount: number } {
  const normalizedRootId = rootDecisionId.trim();
  const directSet = new Set<string>();
  const indirectSet = new Set<string>();
  const visited = new Set<string>([normalizedRootId]);
  const queue: Array<{ id: string; depth: number }> = [];

  for (const rawChildId of rootNode.dependedBy ?? []) {
    if (typeof rawChildId !== "string") continue;
    const childId = rawChildId.trim();
    if (!childId || isSystemReservedDecisionId(childId) || visited.has(childId)) {
      continue;
    }
    visited.add(childId);
    directSet.add(childId);
    queue.push({ id: childId, depth: 1 });
  }

  while (queue.length > 0) {
    const { id } = queue.shift()!;
    const currentNode = allNodes[id];
    if (!currentNode) continue;

    for (const rawGrandChildId of currentNode.dependedBy ?? []) {
      if (typeof rawGrandChildId !== "string") continue;
      const grandChildId = rawGrandChildId.trim();
      if (
        !grandChildId ||
        isSystemReservedDecisionId(grandChildId) ||
        visited.has(grandChildId)
      ) {
        continue;
      }
      visited.add(grandChildId);
      indirectSet.add(grandChildId);
      queue.push({ id: grandChildId, depth: 2 });
    }
  }

  return {
    directCount: directSet.size,
    indirectCount: indirectSet.size,
    totalCount: directSet.size + indirectSet.size,
  };
}

/**
 * Computes the 4-source Decision Change Weight `W(d) in [10, 100]` (`SRS-01` §5):
 * - `structural` [10, 45]
 * - `provenance` [0, 25]
 * - `topology` [0, 20]
 * - `surface` [0, 10]
 */
export function computeDecisionChangeWeight(
  node: ATMSDecisionNode,
  allNodes: Record<string, ATMSDecisionNode>,
): ChangeWeightBreakdown {
  const defaultCoupling = node.impactTier === "CORE_ARCHITECTURAL" ? 1.5 : 0.5;
  const defaultRollback = node.impactTier === "CORE_ARCHITECTURAL" ? 1.5 : 0.5;

  const coupling = clampNumber(node.couplingLevel ?? defaultCoupling, 0, 2);
  const rollback = clampNumber(node.rollbackCost ?? defaultRollback, 0, 2);
  const structural = Math.round(10 + 17.5 * ((coupling + rollback) / 2.0));

  let provenance = 0;
  if (node.provenance === "USER_EXPLICIT_HITL") {
    provenance = 25;
  } else if (node.provenance === "SYSTEM1_DIRECT_APS") {
    const margin = clampNumber(node.dominanceMargin ?? 0, 0, 1);
    provenance = 10 + Math.round(5 * margin);
  }

  const { directCount, indirectCount } = collectTransitiveDependents(
    node.decisionId,
    node,
    allNodes,
  );
  const topology = Math.min(20, 6 * directCount + 3 * indirectCount);

  const uniqueSections = deduplicateSectionTargets(node.affectedSections ?? []);
  let surface = 0;
  if (uniqueSections.length > 0) {
    const uniqueFiles = new Set(uniqueSections.map((s) => s.fileId));
    surface = Math.min(
      10,
      3 * Math.max(0, uniqueFiles.size - 1) + 2 * uniqueSections.length,
    );
  }

  const total = clampNumber(structural + provenance + topology + surface, 10, 100);

  return {
    total,
    structural,
    provenance,
    topology,
    surface,
  };
}

/**
 * Evaluates the Anti-Domino Gate (`ADR-014` / `SRS-01:505-514`) before allowing a new
 * assumption to override or reopen a prior decision node.
 */
export function evaluateAntiDominoGate(
  assumption: {
    intentType: "DIRECT_USER_INSTRUCTION" | "INFERRED_COLLATERAL_ASSUMPTION";
  },
  priorNode: ATMSDecisionNode,
  allNodes: Record<string, ATMSDecisionNode>,
): AntiDominoGateVerdict {
  const weight = computeDecisionChangeWeight(priorNode, allNodes);
  const { totalCount: transitiveDependents } = collectTransitiveDependents(
    priorNode.decisionId,
    priorNode,
    allNodes,
  );

  if (assumption.intentType === "INFERRED_COLLATERAL_ASSUMPTION") {
    if (
      weight.total >= 40 ||
      priorNode.provenance === "USER_EXPLICIT_HITL" ||
      priorNode.impactTier === "CORE_ARCHITECTURAL"
    ) {
      return "CONSTRAINED_BY_PRIOR";
    }
    if (weight.total >= 25 || transitiveDependents >= 1) {
      return "ESCALATE_TO_HITL";
    }
    return "LOCALIZED_OVERRIDE";
  }

  if (weight.total >= 50 || transitiveDependents >= 1) {
    return "ESCALATE_TO_HITL";
  }
  return "LOCALIZED_OVERRIDE";
}
