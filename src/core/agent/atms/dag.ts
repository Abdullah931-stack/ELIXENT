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

export interface EvaluatedAlternativeRecord {
  optionKey: string;
  neutralSummary: string;
  rationaleAndPremises: string;
  normalizedProbability?: number;
}

export type ATMSDecisionStatus = "APPROVED_DIRECT" | "APPROVED_CONSERVATIVE";

export type ATMSImpactTier = "CORE_ARCHITECTURAL" | "PERIPHERAL";

export type ATMSSectionTarget = {
  fileId: string;
  headingSlug: string;
};

export interface ATMSDecisionNode {
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
    rationaleAndPremises: alternative.rationaleAndPremises,
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

/**
 * Deep-clones an `ATMSDecisionNode` and normalizes/deduplicates its array fields
 * so callers never share mutable array or nested record references.
 */
export function cloneATMSDecisionNode(node: ATMSDecisionNode): ATMSDecisionNode {
  const clonedTimestamp = cloneOptionalTimestamp(node.updatedAt);

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
