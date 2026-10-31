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
  cloneATMSDecisionNode,
  cloneMasterLedger,
} from "./dag";
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
