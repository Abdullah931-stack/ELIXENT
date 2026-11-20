/**
 * Justification-Driven ATMS DAG Structures & Project Decision Ledger Store
 *
 * Defines the canonical JSON-serializable node structures for the Assumption-based
 * Truth Maintenance System (`ELIXENT-ARCH-02` §2 & §5), deep-clone normalization
 * utilities, and pure in-memory ledger adapter stubs.
 *
 * Architectural Invariants:
 * 1. JSON-Serializable State: Uses plain records and arrays (no `Map`, `Set`, or `BigInt`)
 *    for lossless serialization across LangGraph checkpointers.
 * 2. Sentinel Isolation: System-reserved rows (`isSystemReservedDecisionId`, such as
 *    `__PROJECT_TAXONOMY__`) are strictly excluded from `masterLedger` DAG operations.
 * 3. Client/Server Boundary Isolation: Contains zero `@/server/*` or `drizzle-orm` imports
 *    so ATMS DAG structures remain safe across client and shared runtimes.
 */

import {
  isSystemReservedDecisionId,
  type ProjectTaxonomyState,
} from "@/core/agent/taxonomy/predefined-tags";

export { isSystemReservedDecisionId, type ProjectTaxonomyState };

export interface EvaluatedAlternativeRecord {
  optionKey: string;
  neutralSummary: string;
  rationaleAndPremises: string;
  technicalConstraints?: string[];
  normalizedProbability?: number;
}

export type ATMSDecisionStatus = "APPROVED_DIRECT" | "APPROVED_CONSERVATIVE";

export type ATMSImpactTier = "CORE_ARCHITECTURAL" | "PERIPHERAL";

export type ATMSSectionTarget = {
  fileId: string;
  headingSlug: string;
};

export type DecisionProvenance =
  | "USER_EXPLICIT_HITL"
  | "SYSTEM1_DIRECT_APS"
  | "SYSTEM2_ESCALATED_APS";

export interface ChangeWeightBreakdown {
  total: number;
  structural: number;
  provenance: number;
  topology: number;
  surface: number;
}

export type DecisionEdgeRelation = "DEPENDS_ON" | "REFINES" | "OVERRIDES";

export interface DirectedDecisionEdge {
  edgeId: string;
  sourceDecisionId: string;
  targetDecisionId: string;
  relation: DecisionEdgeRelation;
  confidence?: number;
  justification?: string;
  createdAt?: string;
}

export interface DecisionGraphNode {
  decisionId: string;
  topicSlug: string;
  questionPrompt: string;
  conceptTags: string[];
  selectedOptionKey: string;
  selectionRationale: string;
  runnerUpOptionKey: string | null;
  evaluatedAlternatives: EvaluatedAlternativeRecord[];
  status: "APPROVED_DIRECT" | "APPROVED_CONSERVATIVE";
  impactTier: "CORE_ARCHITECTURAL" | "PERIPHERAL";
  isLoadBearing: boolean;
  dependsOn: string[];
  dependedBy: string[];
  affectedSections: Array<{ fileId: string; headingSlug: string }>;
  updatedAt?: Date | string;
  provenance?: DecisionProvenance;
  couplingLevel?: number;
  rollbackCost?: number;
  dominanceMargin?: number;
  evidenceGrounding?: number;
  changeWeight?: ChangeWeightBreakdown;
  evidenceRefs?: Array<{ fileId: string; headingSlug: string; excerpt?: string }>;
  createdAt?: string;
  supersededByDecisionId?: string | null;
}

export type ATMSDecisionNode = DecisionGraphNode;

export interface DecisionLedgerDocument {
  schemaVersion: "2.0.0";
  workspaceId: string;
  updatedAt: string;
  taxonomy: ProjectTaxonomyState | null;
  nodes: Record<string, DecisionGraphNode>;
  edges: DirectedDecisionEdge[];
  decisions?: Record<string, DecisionGraphNode>;
}

export interface LoadedProjectLedgerState {
  masterLedger: Record<string, ATMSDecisionNode>;
  projectTaxonomy: ProjectTaxonomyState | null;
}

export interface SyncMasterLedgerOptions {
  pruneEvicted?: boolean;
}

function assertNonEmptyIdentifier(rawIdentifier: string, fieldName: string): string {
  if (typeof rawIdentifier !== "string" || rawIdentifier.trim().length === 0) {
    throw new Error(`ATMS Decision Ledger: ${fieldName} must be a non-empty string.`);
  }
  return rawIdentifier.trim();
}

function normalizeUniqueStrings(entries: readonly string[]): string[] {
  // Cases: empty array / whitespace-only strings / duplicate values / valid entries
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  return normalized;
}

function normalizeDecisionReferences(decisionIds: readonly string[]): string[] {
  // Filters out system-reserved sentinels so infrastructure metadata never enters DAG edges.
  return normalizeUniqueStrings(decisionIds).filter(
    (id) => !isSystemReservedDecisionId(id),
  );
}

function normalizeSectionTargets(
  sections: ReadonlyArray<{ fileId: string; headingSlug: string }>,
): ATMSSectionTarget[] {
  // Cases: empty array / blank fileId or headingSlug / duplicate (fileId, headingSlug) pairs
  if (!Array.isArray(sections) || sections.length === 0) {
    return [];
  }

  const seenPairs = new Set<string>();
  const normalized: ATMSSectionTarget[] = [];

  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const fileId = typeof section.fileId === "string" ? section.fileId.trim() : "";
    const headingSlug =
      typeof section.headingSlug === "string" ? section.headingSlug.trim() : "";
    if (fileId.length === 0 || headingSlug.length === 0) continue;

    // NUL delimiter prevents ambiguity when fileId or headingSlug contains '#' or ':'.
    const compositeKey = `${fileId}\u0000${headingSlug}`;
    if (!seenPairs.has(compositeKey)) {
      seenPairs.add(compositeKey);
      normalized.push({ fileId, headingSlug });
    }
  }

  return normalized;
}

function cloneEvaluatedAlternatives(
  alternatives: readonly EvaluatedAlternativeRecord[],
): EvaluatedAlternativeRecord[] {
  if (!Array.isArray(alternatives) || alternatives.length === 0) {
    return [];
  }

  return alternatives.map((alternative) => ({
    optionKey: alternative.optionKey,
    neutralSummary: alternative.neutralSummary,
    rationaleAndPremises:
      typeof alternative.rationaleAndPremises === "string"
        ? alternative.rationaleAndPremises
        : "",
    ...(Array.isArray(alternative.technicalConstraints)
      ? { technicalConstraints: normalizeUniqueStrings(alternative.technicalConstraints) }
      : {}),
    ...(typeof alternative.normalizedProbability === "number"
      ? { normalizedProbability: alternative.normalizedProbability }
      : {}),
  }));
}

function cloneOptionalTimestamp(
  timestamp: Date | string | undefined,
): Date | string | undefined {
  if (timestamp instanceof Date) {
    return new Date(timestamp.getTime());
  }
  return typeof timestamp === "string" ? timestamp : undefined;
}

function normalizeRunnerUpKey(runnerUpOptionKey: string | null | undefined): string | null {
  if (typeof runnerUpOptionKey !== "string") {
    return null;
  }
  const trimmed = runnerUpOptionKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneChangeWeight(
  weight: ChangeWeightBreakdown | undefined,
): ChangeWeightBreakdown | undefined {
  if (!weight || typeof weight !== "object") return undefined;
  return {
    total: weight.total,
    structural: weight.structural,
    provenance: weight.provenance,
    topology: weight.topology,
    surface: weight.surface,
  };
}

function cloneEvidenceRefs(
  refs: ReadonlyArray<{ fileId: string; headingSlug: string; excerpt?: string }> | undefined,
): Array<{ fileId: string; headingSlug: string; excerpt?: string }> | undefined {
  if (!Array.isArray(refs)) return undefined;
  return refs
    .filter((ref) => ref && typeof ref.fileId === "string" && typeof ref.headingSlug === "string")
    .map((ref) => ({
      fileId: ref.fileId.trim(),
      headingSlug: ref.headingSlug.trim(),
      ...(typeof ref.excerpt === "string" ? { excerpt: ref.excerpt } : {}),
    }))
    .filter((ref) => ref.fileId.length > 0 && ref.headingSlug.length > 0);
}

/**
 * Deep-clones an `ATMSDecisionNode` and normalizes/deduplicates its array fields
 * so callers never share mutable array or nested record references.
 */
export function cloneATMSDecisionNode(node: ATMSDecisionNode): ATMSDecisionNode {
  const clonedTimestamp = cloneOptionalTimestamp(node.updatedAt);
  const clonedWeight = cloneChangeWeight(node.changeWeight);
  const clonedEvidenceRefs = cloneEvidenceRefs(node.evidenceRefs);

  return {
    decisionId: node.decisionId.trim(),
    topicSlug: node.topicSlug.trim(),
    questionPrompt: node.questionPrompt,
    conceptTags: normalizeUniqueStrings(node.conceptTags),
    selectedOptionKey: node.selectedOptionKey.trim(),
    selectionRationale: node.selectionRationale,
    runnerUpOptionKey: normalizeRunnerUpKey(node.runnerUpOptionKey),
    evaluatedAlternatives: cloneEvaluatedAlternatives(node.evaluatedAlternatives),
    status: node.status,
    impactTier: node.impactTier,
    isLoadBearing: Boolean(node.isLoadBearing),
    dependsOn: normalizeDecisionReferences(node.dependsOn),
    dependedBy: normalizeDecisionReferences(node.dependedBy),
    affectedSections: normalizeSectionTargets(node.affectedSections),
    ...(clonedTimestamp !== undefined ? { updatedAt: clonedTimestamp } : {}),
    ...(node.provenance !== undefined ? { provenance: node.provenance } : {}),
    ...(typeof node.couplingLevel === "number" ? { couplingLevel: node.couplingLevel } : {}),
    ...(typeof node.rollbackCost === "number" ? { rollbackCost: node.rollbackCost } : {}),
    ...(typeof node.dominanceMargin === "number" ? { dominanceMargin: node.dominanceMargin } : {}),
    ...(typeof node.evidenceGrounding === "number"
      ? { evidenceGrounding: node.evidenceGrounding }
      : {}),
    ...(clonedWeight !== undefined ? { changeWeight: clonedWeight } : {}),
    ...(clonedEvidenceRefs !== undefined ? { evidenceRefs: clonedEvidenceRefs } : {}),
    ...(typeof node.createdAt === "string" ? { createdAt: node.createdAt } : {}),
    ...(node.supersededByDecisionId !== undefined
      ? { supersededByDecisionId: node.supersededByDecisionId }
      : {}),
  };
}

/**
 * Deep-clones all active decision nodes in `masterLedger` while strictly excluding
 * any key or `node.decisionId` matching `isSystemReservedDecisionId`.
 */
export function cloneMasterLedger(
  masterLedger: Record<string, ATMSDecisionNode>,
): Record<string, ATMSDecisionNode> {
  if (!masterLedger || typeof masterLedger !== "object" || Array.isArray(masterLedger)) {
    return {};
  }

  const clonedLedger: Record<string, ATMSDecisionNode> = {};

  for (const [rawKey, node] of Object.entries(masterLedger)) {
    if (!node || typeof node !== "object") continue;

    const trimmedKey = rawKey.trim();
    const trimmedNodeId =
      typeof node.decisionId === "string" ? node.decisionId.trim() : "";

    if (
      isSystemReservedDecisionId(trimmedKey) ||
      isSystemReservedDecisionId(trimmedNodeId)
    ) {
      continue;
    }

    const effectiveDecisionId = trimmedNodeId || trimmedKey;
    if (effectiveDecisionId.length === 0) continue;

    clonedLedger[effectiveDecisionId] = cloneATMSDecisionNode({
      ...node,
      decisionId: effectiveDecisionId,
    });
  }

  return clonedLedger;
}

/**
 * Pure in-memory adapter stub for loading the project decision ledger.
 * Validates `(projectId, userId)` identifiers and returns an empty ledger state.
 */
export async function loadProjectDecisionLedger(
  projectId: string,
  userId: string,
): Promise<LoadedProjectLedgerState> {
  assertNonEmptyIdentifier(projectId, "projectId");
  assertNonEmptyIdentifier(userId, "userId");

  return {
    masterLedger: {},
    projectTaxonomy: null,
  };
}

/**
 * Pure in-memory adapter stub for synchronizing `masterLedger` and optional
 * `projectTaxonomy` state. Validates `(projectId, userId)` and `masterLedger`,
 * and normalizes nodes via `cloneMasterLedger`.
 *
 * Parameter-count exception (`clean-code-guard` Rule 3): Retains the 5-parameter
 * signature mandated by the Phase 8 / Phase 9 `ELIXENT-ARCH-02` public contract
 * (`ledgerCommitNode`). Revisit if internal callers migrate to a unified options DTO.
 */
export async function syncMasterLedgerToProjectStore(
  projectId: string,
  userId: string,
  masterLedger: Record<string, ATMSDecisionNode>,
  projectTaxonomy?: ProjectTaxonomyState | null,
  options?: SyncMasterLedgerOptions,
): Promise<void> {
  assertNonEmptyIdentifier(projectId, "projectId");
  assertNonEmptyIdentifier(userId, "userId");
  if (!masterLedger || typeof masterLedger !== "object" || Array.isArray(masterLedger)) {
    throw new Error("ATMS Decision Ledger: masterLedger must be a valid record object.");
  }

  void projectTaxonomy;
  void options;
  cloneMasterLedger(masterLedger);
}


// ============================================================================
// DecisionLedgerDocument v2.0 Integrity, Provider Bridge & Graph Queries
// ============================================================================

function cloneDirectedEdge(edge: DirectedDecisionEdge): DirectedDecisionEdge {
  return {
    edgeId: edge.edgeId.trim(),
    sourceDecisionId: edge.sourceDecisionId.trim(),
    targetDecisionId: edge.targetDecisionId.trim(),
    relation: edge.relation,
    ...(typeof edge.confidence === "number" ? { confidence: edge.confidence } : {}),
    ...(typeof edge.justification === "string" ? { justification: edge.justification } : {}),
    ...(typeof edge.createdAt === "string" ? { createdAt: edge.createdAt } : {}),
  };
}

function buildEdgeKey(sourceId: string, targetId: string, relation: DecisionEdgeRelation): string {
  return `${sourceId}\u0000${targetId}\u0000${relation}`;
}

/**
 * Verifies that the directed dependency graph defined by `nodes` and `edges`
 * contains no cycles using 3-color DFS (`0 = unvisited`, `1 = visiting`, `2 = visited`).
 * Throws an Error naming the cycle path if a cycle is detected.
 */
export function assertAcyclicDecisionGraph(
  nodes: Record<string, DecisionGraphNode>,
  edges: ReadonlyArray<DirectedDecisionEdge> = [],
): void {
  const adjacency = new Map<string, Set<string>>();

  const addNeighbor = (from: string, to: string): void => {
    if (!from || !to || isSystemReservedDecisionId(from) || isSystemReservedDecisionId(to)) {
      return;
    }
    let neighbors = adjacency.get(from);
    if (!neighbors) {
      neighbors = new Set<string>();
      adjacency.set(from, neighbors);
    }
    neighbors.add(to);
  };

  for (const [rawId, node] of Object.entries(nodes)) {
    if (!node || isSystemReservedDecisionId(rawId)) continue;
    const nodeId = node.decisionId.trim() || rawId.trim();
    if (isSystemReservedDecisionId(nodeId)) continue;
    if (!adjacency.has(nodeId)) {
      adjacency.set(nodeId, new Set<string>());
    }
    for (const depId of node.dependsOn ?? []) {
      addNeighbor(nodeId, depId.trim());
    }
  }

  for (const edge of edges) {
    if (!edge) continue;
    addNeighbor(edge.sourceDecisionId.trim(), edge.targetDecisionId.trim());
  }

  // 0 = unvisited, 1 = visiting, 2 = visited
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const dfs = (current: string): void => {
    color.set(current, 1);
    stack.push(current);

    const neighbors = adjacency.get(current);
    if (neighbors) {
      for (const next of neighbors) {
        const nextColor = color.get(next) ?? 0;
        if (nextColor === 1) {
          const cycleStart = stack.indexOf(next);
          const cyclePath = [...stack.slice(cycleStart), next].join(" -> ");
          throw new Error(`ATMS Decision Graph cycle detected: ${cyclePath}`);
        }
        if (nextColor === 0) {
          dfs(next);
        }
      }
    }

    stack.pop();
    color.set(current, 2);
  };

  for (const nodeId of adjacency.keys()) {
    if ((color.get(nodeId) ?? 0) === 0) {
      dfs(nodeId);
    }
  }
}

/**
 * Synchronizes `nodes`, `edges`, `dependsOn`, and `dependedBy`, excludes system-reserved
 * sentinels, asserts acyclicity, and keeps `decisions` mirrored to `nodes`.
 */
export function normalizeLedgerGraphIntegrity(
  doc: DecisionLedgerDocument,
): DecisionLedgerDocument {
  const normalizedNodes = cloneMasterLedger(doc.nodes ?? {});
  const edgeMap = new Map<string, DirectedDecisionEdge>();

  const registerEdge = (edge: DirectedDecisionEdge): void => {
    const source = edge.sourceDecisionId.trim();
    const target = edge.targetDecisionId.trim();
    if (
      !source ||
      !target ||
      source === target ||
      isSystemReservedDecisionId(source) ||
      isSystemReservedDecisionId(target)
    ) {
      return;
    }

    const key = buildEdgeKey(source, target, edge.relation);
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        ...cloneDirectedEdge(edge),
        edgeId: edge.edgeId.trim() || `${source}->${target}:${edge.relation}`,
        sourceDecisionId: source,
        targetDecisionId: target,
      });
    }
  };

  for (const rawEdge of doc.edges ?? []) {
    if (!rawEdge || typeof rawEdge !== "object") continue;
    registerEdge(rawEdge);
  }

  for (const node of Object.values(normalizedNodes)) {
    for (const depId of node.dependsOn) {
      if (depId === node.decisionId) continue;
      const hasExplicitEdge =
        edgeMap.has(buildEdgeKey(node.decisionId, depId, "DEPENDS_ON")) ||
        edgeMap.has(buildEdgeKey(node.decisionId, depId, "REFINES")) ||
        edgeMap.has(buildEdgeKey(node.decisionId, depId, "OVERRIDES"));

      if (!hasExplicitEdge) {
        registerEdge({
          edgeId: `${node.decisionId}->${depId}:DEPENDS_ON`,
          sourceDecisionId: node.decisionId,
          targetDecisionId: depId,
          relation: "DEPENDS_ON",
        });
      }
    }

    for (const childId of node.dependedBy) {
      if (childId === node.decisionId) continue;
      const childNode = normalizedNodes[childId];
      if (childNode && !childNode.dependsOn.includes(node.decisionId)) {
        childNode.dependsOn.push(node.decisionId);
      }
      const hasExplicitEdge =
        edgeMap.has(buildEdgeKey(childId, node.decisionId, "DEPENDS_ON")) ||
        edgeMap.has(buildEdgeKey(childId, node.decisionId, "REFINES")) ||
        edgeMap.has(buildEdgeKey(childId, node.decisionId, "OVERRIDES"));

      if (!hasExplicitEdge) {
        registerEdge({
          edgeId: `${childId}->${node.decisionId}:DEPENDS_ON`,
          sourceDecisionId: childId,
          targetDecisionId: node.decisionId,
          relation: "DEPENDS_ON",
        });
      }
    }
  }

  const normalizedEdges = Array.from(edgeMap.values());

  // Re-derive dependsOn / dependedBy consistently from edges + existing dependsOn
  for (const edge of normalizedEdges) {
    const sourceNode = normalizedNodes[edge.sourceDecisionId];
    if (sourceNode && !sourceNode.dependsOn.includes(edge.targetDecisionId)) {
      sourceNode.dependsOn.push(edge.targetDecisionId);
    }
    const targetNode = normalizedNodes[edge.targetDecisionId];
    if (targetNode && !targetNode.dependedBy.includes(edge.sourceDecisionId)) {
      targetNode.dependedBy.push(edge.sourceDecisionId);
    }
  }

  for (const node of Object.values(normalizedNodes)) {
    node.dependsOn = normalizeDecisionReferences(node.dependsOn).filter(
      (id) => id !== node.decisionId,
    );
    node.dependedBy = normalizeDecisionReferences(node.dependedBy).filter(
      (id) => id !== node.decisionId,
    );
  }

  assertAcyclicDecisionGraph(normalizedNodes, normalizedEdges);

  return {
    schemaVersion: "2.0.0",
    workspaceId: doc.workspaceId,
    updatedAt: doc.updatedAt || new Date().toISOString(),
    taxonomy: doc.taxonomy ?? null,
    nodes: normalizedNodes,
    edges: normalizedEdges,
    decisions: normalizedNodes,
  };
}

/**
 * Normalizes either a v2.0 `DecisionLedgerDocument` (`nodes`, `edges`) or a legacy
 * Phase 2 `IWorkspaceProvider` ledger (`decisions: Record<string, unknown>`) into
 * a validated v2.0 `DecisionLedgerDocument`.
 */
export function normalizeProviderLedgerToV2(
  raw: unknown,
  workspaceId: string,
): DecisionLedgerDocument {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const rawNodesCandidate =
    record.nodes && typeof record.nodes === "object" && !Array.isArray(record.nodes)
      ? record.nodes
      : record.decisions && typeof record.decisions === "object" && !Array.isArray(record.decisions)
      ? record.decisions
      : {};

  const rawEdges = Array.isArray(record.edges)
    ? (record.edges as DirectedDecisionEdge[])
    : [];

  const rawTaxonomy =
    record.taxonomy && typeof record.taxonomy === "object" && !Array.isArray(record.taxonomy)
      ? (record.taxonomy as ProjectTaxonomyState)
      : null;

  const updatedAt =
    typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0
      ? record.updatedAt
      : new Date().toISOString();

  const resolvedWorkspaceId =
    typeof record.workspaceId === "string" && record.workspaceId.trim().length > 0
      ? record.workspaceId.trim()
      : workspaceId;

  return normalizeLedgerGraphIntegrity({
    schemaVersion: "2.0.0",
    workspaceId: resolvedWorkspaceId,
    updatedAt,
    taxonomy: rawTaxonomy,
    nodes: rawNodesCandidate as Record<string, DecisionGraphNode>,
    edges: rawEdges,
  });
}

/**
 * Serializes a v2.0 `DecisionLedgerDocument` for `IWorkspaceProvider.writeDecisionLedger`,
 * guaranteeing `decisions` is populated and synchronized with `nodes`.
 */
export function toProviderLedgerDocument(
  doc: DecisionLedgerDocument,
): DecisionLedgerDocument & { decisions: Record<string, DecisionGraphNode> } {
  const normalized = normalizeLedgerGraphIntegrity(doc);
  return {
    ...normalized,
    decisions: normalized.nodes,
  };
}

// ============================================================================
// Pure Graph Exploration Functions (ADR-012 / SRS-01 §4.2)
// ============================================================================

export function searchDecisionLedger(
  doc: DecisionLedgerDocument,
  params: { query?: string; conceptTags?: string[]; fileId?: string },
): DecisionGraphNode[] {
  const queryLower =
    typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
  const filterTags = new Set(
    (params.conceptTags ?? [])
      .filter((t) => typeof t === "string" && t.trim().length > 0)
      .map((t) => t.trim().toLowerCase()),
  );
  const filterFileId =
    typeof params.fileId === "string" ? params.fileId.trim() : "";

  const matches: DecisionGraphNode[] = [];

  for (const node of Object.values(doc.nodes ?? {})) {
    if (!node || isSystemReservedDecisionId(node.decisionId)) continue;

    if (filterFileId.length > 0) {
      const touchesFile = (node.affectedSections ?? []).some(
        (s) => s.fileId === filterFileId,
      );
      if (!touchesFile) continue;
    }

    if (filterTags.size > 0) {
      const sharesTag = (node.conceptTags ?? []).some((t) =>
        filterTags.has(t.trim().toLowerCase()),
      );
      if (!sharesTag) continue;
    }

    if (queryLower.length > 0) {
      const haystack = [
        node.decisionId,
        node.topicSlug,
        node.questionPrompt,
        node.selectedOptionKey,
        node.selectionRationale,
        ...(node.conceptTags ?? []),
      ]
        .join(" ")
        .toLowerCase();

      if (!haystack.includes(queryLower)) continue;
    }

    matches.push(cloneATMSDecisionNode(node));
  }

  return matches.sort((a, b) => {
    const weightDiff = (b.changeWeight?.total ?? 0) - (a.changeWeight?.total ?? 0);
    if (weightDiff !== 0) return weightDiff;
    return a.decisionId.localeCompare(b.decisionId);
  });
}

export function getDecisionNodeDetails(
  doc: DecisionLedgerDocument,
  params: { decisionId: string },
): { node: DecisionGraphNode | null; incidentEdges: DirectedDecisionEdge[] } {
  const targetId = params.decisionId.trim();
  if (!targetId || isSystemReservedDecisionId(targetId)) {
    return { node: null, incidentEdges: [] };
  }

  const rawNode = doc.nodes?.[targetId];
  const node = rawNode ? cloneATMSDecisionNode(rawNode) : null;
  const incidentEdges = (doc.edges ?? [])
    .filter(
      (edge) =>
        edge.sourceDecisionId === targetId || edge.targetDecisionId === targetId,
    )
    .map(cloneDirectedEdge);

  return { node, incidentEdges };
}

export function traverseDecisionDependencies(
  doc: DecisionLedgerDocument,
  params: {
    decisionId: string;
    direction: "upstream" | "downstream" | "both";
    maxDepth: 1 | 2 | "all";
  },
): {
  rootDecisionId: string;
  visitedNodes: DecisionGraphNode[];
  traversedEdges: DirectedDecisionEdge[];
  topologicalOrder: string[];
} {
  const rootId = params.decisionId.trim();
  const maxDepthNumeric = params.maxDepth === "all" ? Infinity : params.maxDepth;
  const nodesMap = doc.nodes ?? {};

  if (!rootId || isSystemReservedDecisionId(rootId) || !nodesMap[rootId]) {
    return {
      rootDecisionId: rootId,
      visitedNodes: [],
      traversedEdges: [],
      topologicalOrder: [],
    };
  }

  const visitedIds = new Set<string>([rootId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const traversedEdgeMap = new Map<string, DirectedDecisionEdge>();

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepthNumeric) continue;

    const currentNode = nodesMap[id];
    if (!currentNode) continue;

    if (params.direction === "upstream" || params.direction === "both") {
      for (const parentId of currentNode.dependsOn ?? []) {
        if (!parentId || isSystemReservedDecisionId(parentId)) continue;
        const matchingEdge = (doc.edges ?? []).find(
          (e) => e.sourceDecisionId === id && e.targetDecisionId === parentId,
        );
        const edge: DirectedDecisionEdge = matchingEdge
          ? cloneDirectedEdge(matchingEdge)
          : {
              edgeId: `${id}->${parentId}:DEPENDS_ON`,
              sourceDecisionId: id,
              targetDecisionId: parentId,
              relation: "DEPENDS_ON",
            };
        traversedEdgeMap.set(
          buildEdgeKey(edge.sourceDecisionId, edge.targetDecisionId, edge.relation),
          edge,
        );

        if (nodesMap[parentId] && !visitedIds.has(parentId)) {
          visitedIds.add(parentId);
          queue.push({ id: parentId, depth: depth + 1 });
        }
      }
    }

    if (params.direction === "downstream" || params.direction === "both") {
      for (const childId of currentNode.dependedBy ?? []) {
        if (!childId || isSystemReservedDecisionId(childId)) continue;
        const matchingEdge = (doc.edges ?? []).find(
          (e) => e.sourceDecisionId === childId && e.targetDecisionId === id,
        );
        const edge: DirectedDecisionEdge = matchingEdge
          ? cloneDirectedEdge(matchingEdge)
          : {
              edgeId: `${childId}->${id}:DEPENDS_ON`,
              sourceDecisionId: childId,
              targetDecisionId: id,
              relation: "DEPENDS_ON",
            };
        traversedEdgeMap.set(
          buildEdgeKey(edge.sourceDecisionId, edge.targetDecisionId, edge.relation),
          edge,
        );

        if (nodesMap[childId] && !visitedIds.has(childId)) {
          visitedIds.add(childId);
          queue.push({ id: childId, depth: depth + 1 });
        }
      }
    }
  }

  const visitedNodes = Array.from(visitedIds)
    .map((id) => nodesMap[id])
    .filter((n): n is DecisionGraphNode => Boolean(n))
    .map(cloneATMSDecisionNode);

  const traversedEdges = Array.from(traversedEdgeMap.values());

  // Cycle-safe topological sort over the visited subgraph (dependencies first)
  const inDegree = new Map<string, number>();
  const dependentsAdj = new Map<string, string[]>();
  for (const id of visitedIds) {
    inDegree.set(id, 0);
    dependentsAdj.set(id, []);
  }
  for (const edge of traversedEdges) {
    if (visitedIds.has(edge.sourceDecisionId) && visitedIds.has(edge.targetDecisionId)) {
      // edge: source depends on target => target comes before source
      dependentsAdj.get(edge.targetDecisionId)!.push(edge.sourceDecisionId);
      inDegree.set(edge.sourceDecisionId, (inDegree.get(edge.sourceDecisionId) ?? 0) + 1);
    }
  }

  const topoQueue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) topoQueue.push(id);
  }

  const topologicalOrder: string[] = [];
  while (topoQueue.length > 0) {
    const id = topoQueue.shift()!;
    topologicalOrder.push(id);
    for (const dependentId of dependentsAdj.get(id) ?? []) {
      const nextDeg = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, nextDeg);
      if (nextDeg === 0) {
        topoQueue.push(dependentId);
      }
    }
  }

  return {
    rootDecisionId: rootId,
    visitedNodes,
    traversedEdges,
    topologicalOrder,
  };
}

export function getSectionGoverningDecisions(
  doc: DecisionLedgerDocument,
  params: { fileId: string; headingSlug?: string },
): {
  directNodes: DecisionGraphNode[];
  loadBearingAncestors: DecisionGraphNode[];
  allGoverningNodes: DecisionGraphNode[];
} {
  const targetFileId = params.fileId.trim();
  const targetHeadingSlug =
    typeof params.headingSlug === "string" ? params.headingSlug.trim() : "";

  const nodesMap = doc.nodes ?? {};
  const directNodes: DecisionGraphNode[] = [];
  const directIds = new Set<string>();

  for (const node of Object.values(nodesMap)) {
    if (!node || isSystemReservedDecisionId(node.decisionId)) continue;
    const matchesSection = (node.affectedSections ?? []).some((section) => {
      if (section.fileId !== targetFileId) return false;
      if (targetHeadingSlug.length > 0) {
        return section.headingSlug === targetHeadingSlug;
      }
      return true;
    });

    if (matchesSection) {
      directIds.add(node.decisionId);
      directNodes.push(cloneATMSDecisionNode(node));
    }
  }

  // Upstream BFS from directNodes to gather load-bearing ancestors
  const visited = new Set<string>(directIds);
  const queue: string[] = Array.from(directIds);
  const loadBearingAncestors: DecisionGraphNode[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentNode = nodesMap[currentId];
    if (!currentNode) continue;

    for (const parentId of currentNode.dependsOn ?? []) {
      if (!parentId || isSystemReservedDecisionId(parentId) || visited.has(parentId)) {
        continue;
      }
      visited.add(parentId);
      queue.push(parentId);
      const parentNode = nodesMap[parentId];
      if (parentNode && parentNode.isLoadBearing) {
        loadBearingAncestors.push(cloneATMSDecisionNode(parentNode));
      }
    }
  }

  const sortByWeight = (a: DecisionGraphNode, b: DecisionGraphNode): number => {
    const diff = (b.changeWeight?.total ?? 0) - (a.changeWeight?.total ?? 0);
    return diff !== 0 ? diff : a.decisionId.localeCompare(b.decisionId);
  };

  directNodes.sort(sortByWeight);
  loadBearingAncestors.sort(sortByWeight);
  const allGoverningNodes = [...directNodes, ...loadBearingAncestors].sort(sortByWeight);

  return {
    directNodes,
    loadBearingAncestors,
    allGoverningNodes,
  };
}
