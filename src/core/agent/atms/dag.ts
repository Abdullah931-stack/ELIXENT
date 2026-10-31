/**
 * Justification-Driven ATMS DAG Structures & Project Decision Ledger Store
 *
 * Defines the canonical JSON-serializable node structures for the Assumption-based
 * Truth Maintenance System (`ELIXENT-ARCH-02` §2 & §5), deep-clone normalization
 * utilities, and multi-tenant persistence synchronization with `project_decision_ledger`.
 *
 * Architectural Invariants:
 * 1. JSON-Serializable State: Uses plain records and arrays (no `Map`, `Set`, or `BigInt`)
 *    for lossless serialization across LangGraph checkpointers.
 * 2. Sentinel Isolation: System-reserved rows (`isSystemReservedDecisionId`, such as
 *    `__PROJECT_TAXONOMY__`) are persisted in `project_decision_ledger` for project-scoped
 *    taxonomy state but are strictly excluded from `masterLedger` DAG operations and
 *    eviction pruning.
 * 3. Multi-Tenant Isolation: Because `project_decision_ledger` uses composite primary key
 *    `(project_id, decision_id)`, all reads, conflict-update clauses (`setWhere`), and
 *    eviction deletes enforce `user_id` ownership so cross-tenant overwrite is impossible.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db, txDb } from "@/server/db";
import {
  projectDecisionLedger,
  type EvaluatedAlternativeRecord,
  type NewProjectDecisionLedgerRow,
  type ProjectDecisionLedgerRow,
} from "@/server/db/schema/project-decision-ledger";
import {
  fromTaxonomyLedgerPayload,
  isSystemReservedDecisionId,
  PROJECT_TAXONOMY_SENTINEL_ID,
  toTaxonomyLedgerPayload,
  type ProjectTaxonomyState,
} from "@/core/agent/taxonomy/predefined-tags";

export type { EvaluatedAlternativeRecord } from "@/server/db/schema/project-decision-ledger";

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

interface LedgerDatabaseClient {
  select: typeof db.select;
  insert: typeof db.insert;
  delete: typeof db.delete;
  transaction?: typeof db.transaction;
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

function mapLedgerRowToDecisionNode(
  row: Partial<ProjectDecisionLedgerRow> & { decisionId: string },
): ATMSDecisionNode {
  const status: ATMSDecisionStatus =
    row.status === "APPROVED_CONSERVATIVE"
      ? "APPROVED_CONSERVATIVE"
      : "APPROVED_DIRECT";
  const impactTier: ATMSImpactTier =
    row.impactTier === "PERIPHERAL" ? "PERIPHERAL" : "CORE_ARCHITECTURAL";

  return cloneATMSDecisionNode({
    decisionId: row.decisionId,
    topicSlug: row.topicSlug ?? "",
    questionPrompt: row.questionPrompt ?? "",
    conceptTags: Array.isArray(row.conceptTags) ? row.conceptTags : [],
    selectedOptionKey: row.selectedOptionKey ?? "",
    selectionRationale: row.selectionRationale ?? "",
    runnerUpOptionKey: row.runnerUpOptionKey ?? null,
    evaluatedAlternatives: Array.isArray(row.evaluatedAlternatives)
      ? row.evaluatedAlternatives
      : [],
    status,
    impactTier,
    isLoadBearing: Boolean(row.isLoadBearing),
    dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn : [],
    dependedBy: Array.isArray(row.dependedBy) ? row.dependedBy : [],
    affectedSections: Array.isArray(row.affectedSections)
      ? row.affectedSections
      : [],
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
  });
}

function isMockSpyFunction(candidate: unknown): boolean {
  return typeof candidate === "function" && "mock" in candidate;
}

function isLiveDrizzleInstance(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const internalMeta = (candidate as { _?: unknown })._;
  return (
    typeof internalMeta === "object" &&
    internalMeta !== null &&
    "session" in internalMeta
  );
}

function resolveReadDatabaseClient(): LedgerDatabaseClient {
  if (db && typeof db.select === "function") {
    return db as unknown as LedgerDatabaseClient;
  }
  return txDb as unknown as LedgerDatabaseClient;
}

async function runInLedgerTransaction<T>(
  operation: (client: LedgerDatabaseClient) => Promise<T>,
): Promise<T> {
  // When `db` is replaced or spied on in hermetic unit tests, avoid accessing the `txDb`
  // Proxy so no real PostgreSQL pool is instantiated against placeholder URLs.
  const dbHasMethodSpies =
    Boolean(db) &&
    (isMockSpyFunction(db.select) ||
      isMockSpyFunction(db.insert) ||
      isMockSpyFunction(db.delete));
  const isHermeticTestDb = !isLiveDrizzleInstance(db) || dbHasMethodSpies;

  if (isHermeticTestDb) {
    const canRunMockTx =
      Boolean(db) &&
      typeof db.transaction === "function" &&
      (!isLiveDrizzleInstance(db) || isMockSpyFunction(db.transaction));
    if (canRunMockTx) {
      return db.transaction(async (tx) =>
        operation(tx as unknown as LedgerDatabaseClient),
      );
    }
    const fallbackClient = (db ?? txDb) as unknown as LedgerDatabaseClient;
    if (fallbackClient && typeof fallbackClient.transaction === "function" && !db) {
      return fallbackClient.transaction!(async (tx) =>
        operation(tx as unknown as LedgerDatabaseClient),
      );
    }
    return operation(fallbackClient);
  }

  const targetDb =
    txDb && typeof txDb.transaction === "function" ? txDb : db;
  if (targetDb && typeof targetDb.transaction === "function") {
    return targetDb.transaction(async (tx) =>
      operation(tx as unknown as LedgerDatabaseClient),
    );
  }

  return operation(targetDb as unknown as LedgerDatabaseClient);
}

/**
 * Loads the persisted decision ledger and project-scoped concept taxonomy state
 * for `(projectId, userId)` from `project_decision_ledger`.
 */
export async function loadProjectDecisionLedger(
  projectId: string,
  userId: string,
): Promise<LoadedProjectLedgerState> {
  const normalizedProjectId = assertNonEmptyIdentifier(projectId, "projectId");
  const normalizedUserId = assertNonEmptyIdentifier(userId, "userId");
  const client = resolveReadDatabaseClient();

  const queriedRows = await client
    .select()
    .from(projectDecisionLedger)
    .where(
      and(
        eq(projectDecisionLedger.projectId, normalizedProjectId),
        eq(projectDecisionLedger.userId, normalizedUserId),
      ),
    );

  const ledgerRows: Array<Partial<ProjectDecisionLedgerRow>> = Array.isArray(queriedRows)
    ? queriedRows
    : [];

  const masterLedger: Record<string, ATMSDecisionNode> = {};
  let projectTaxonomy: ProjectTaxonomyState | null = null;

  for (const row of ledgerRows) {
    if (typeof row.projectId === "string" && row.projectId !== normalizedProjectId) {
      continue;
    }
    if (typeof row.userId === "string" && row.userId !== normalizedUserId) {
      continue;
    }

    const decisionId =
      typeof row.decisionId === "string" ? row.decisionId.trim() : "";
    if (decisionId.length === 0) continue;

    if (decisionId === PROJECT_TAXONOMY_SENTINEL_ID) {
      projectTaxonomy = fromTaxonomyLedgerPayload(normalizedProjectId, row);
      continue;
    }

    if (isSystemReservedDecisionId(decisionId)) {
      continue;
    }

    masterLedger[decisionId] = mapLedgerRowToDecisionNode({
      ...row,
      decisionId,
    });
  }

  return { masterLedger, projectTaxonomy };
}

function buildTaxonomyLedgerRow(
  projectId: string,
  userId: string,
  taxonomy: ProjectTaxonomyState,
  timestamp: Date,
): NewProjectDecisionLedgerRow {
  const payload = toTaxonomyLedgerPayload({
    ...taxonomy,
    projectId,
  });

  return {
    projectId,
    decisionId: PROJECT_TAXONOMY_SENTINEL_ID,
    userId,
    topicSlug: payload.topicSlug,
    questionPrompt: payload.questionPrompt,
    conceptTags: payload.conceptTags,
    selectedOptionKey: payload.selectedOptionKey,
    selectionRationale: payload.selectionRationale,
    runnerUpOptionKey: null,
    evaluatedAlternatives: payload.evaluatedAlternatives,
    status: payload.status,
    impactTier: payload.impactTier,
    isLoadBearing: payload.isLoadBearing,
    dependsOn: [],
    dependedBy: [],
    affectedSections: [],
    updatedAt: timestamp,
  };
}

function buildDecisionLedgerRow(
  projectId: string,
  userId: string,
  node: ATMSDecisionNode,
  timestamp: Date,
): NewProjectDecisionLedgerRow {
  return {
    projectId,
    decisionId: node.decisionId,
    userId,
    topicSlug: node.topicSlug,
    questionPrompt: node.questionPrompt,
    conceptTags: node.conceptTags,
    selectedOptionKey: node.selectedOptionKey,
    selectionRationale: node.selectionRationale,
    runnerUpOptionKey: node.runnerUpOptionKey,
    evaluatedAlternatives: node.evaluatedAlternatives,
    status: node.status,
    impactTier: node.impactTier,
    isLoadBearing: node.isLoadBearing,
    dependsOn: node.dependsOn,
    dependedBy: node.dependedBy,
    affectedSections: node.affectedSections,
    updatedAt: timestamp,
  };
}

async function upsertLedgerRow(
  client: LedgerDatabaseClient,
  row: NewProjectDecisionLedgerRow,
): Promise<void> {
  // `setWhere` binds conflict updates strictly to the owning `userId` so a collision on
  // primary key `(project_id, decision_id)` can never overwrite another tenant's row.
  await client
    .insert(projectDecisionLedger)
    .values(row)
    .onConflictDoUpdate({
      target: [
        projectDecisionLedger.projectId,
        projectDecisionLedger.decisionId,
      ],
      set: {
        topicSlug: row.topicSlug,
        questionPrompt: row.questionPrompt,
        conceptTags: row.conceptTags,
        selectedOptionKey: row.selectedOptionKey,
        selectionRationale: row.selectionRationale,
        runnerUpOptionKey: row.runnerUpOptionKey,
        evaluatedAlternatives: row.evaluatedAlternatives,
        status: row.status,
        impactTier: row.impactTier,
        isLoadBearing: row.isLoadBearing,
        dependsOn: row.dependsOn,
        dependedBy: row.dependedBy,
        affectedSections: row.affectedSections,
        updatedAt: row.updatedAt,
      },
      setWhere: eq(projectDecisionLedger.userId, row.userId),
    });
}

interface LedgerSyncTransactionContext {
  projectId: string;
  userId: string;
  activeDecisionIds: ReadonlySet<string>;
  rowsToUpsert: readonly NewProjectDecisionLedgerRow[];
  shouldPruneEvicted: boolean;
}

function buildRowsToUpsert(
  projectId: string,
  userId: string,
  activeNodes: readonly ATMSDecisionNode[],
  projectTaxonomy?: ProjectTaxonomyState | null,
): NewProjectDecisionLedgerRow[] {
  const syncTimestamp = new Date();
  const rows: NewProjectDecisionLedgerRow[] = [];

  if (projectTaxonomy !== undefined && projectTaxonomy !== null) {
    rows.push(
      buildTaxonomyLedgerRow(projectId, userId, projectTaxonomy, syncTimestamp),
    );
  }

  for (const node of activeNodes) {
    rows.push(buildDecisionLedgerRow(projectId, userId, node, syncTimestamp));
  }

  return rows;
}

async function inspectProjectOwnershipAndEvictions(
  client: LedgerDatabaseClient,
  context: LedgerSyncTransactionContext,
): Promise<string[]> {
  if (typeof client.select !== "function") {
    if (context.shouldPruneEvicted) {
      throw new Error(
        "ATMS Decision Ledger: database client must implement select() when eviction pruning is enabled.",
      );
    }
    return [];
  }

  // Query by `projectId` alone (without filtering by `userId` in SQL) so rows owned by
  // another tenant on the same `projectId` are surfaced and rejected before any mutation.
  const existingRows = await client
    .select()
    .from(projectDecisionLedger)
    .where(eq(projectDecisionLedger.projectId, context.projectId));

  const persistedRows: Array<Partial<ProjectDecisionLedgerRow>> = Array.isArray(existingRows)
    ? existingRows
    : [];
  const evictedSet = new Set<string>();

  for (const row of persistedRows) {
    if (typeof row.projectId === "string" && row.projectId !== context.projectId) {
      continue;
    }
    if (typeof row.userId === "string" && row.userId !== context.userId) {
      throw new Error(
        `ATMS Decision Ledger: cross-tenant ownership conflict on project "${context.projectId}" decision "${String(row.decisionId ?? "unknown")}".`,
      );
    }
    if (!context.shouldPruneEvicted) {
      continue;
    }

    const persistedId =
      typeof row.decisionId === "string" ? row.decisionId.trim() : "";
    if (
      persistedId.length > 0 &&
      !isSystemReservedDecisionId(persistedId) &&
      !context.activeDecisionIds.has(persistedId)
    ) {
      evictedSet.add(persistedId);
    }
  }

  return Array.from(evictedSet);
}

async function deleteEvictedLedgerRows(
  client: LedgerDatabaseClient,
  projectId: string,
  userId: string,
  evictedDecisionIds: readonly string[],
): Promise<void> {
  await client
    .delete(projectDecisionLedger)
    .where(
      and(
        eq(projectDecisionLedger.projectId, projectId),
        eq(projectDecisionLedger.userId, userId),
        inArray(projectDecisionLedger.decisionId, [...evictedDecisionIds]),
      ),
    );
}

async function executeLedgerSyncTransaction(
  context: LedgerSyncTransactionContext,
): Promise<void> {
  await runInLedgerTransaction(async (client) => {
    const evictedDecisionIds = await inspectProjectOwnershipAndEvictions(
      client,
      context,
    );

    for (const row of context.rowsToUpsert) {
      await upsertLedgerRow(client, row);
    }

    if (evictedDecisionIds.length > 0) {
      await deleteEvictedLedgerRows(
        client,
        context.projectId,
        context.userId,
        evictedDecisionIds,
      );
    }
  });
}

/**
 * Synchronizes the in-memory `masterLedger` and optional `projectTaxonomy` state
 * into `project_decision_ledger`, pruning evicted decisions by default while
 * preserving system-reserved sentinels (`__PROJECT_TAXONOMY__`).
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
  const normalizedProjectId = assertNonEmptyIdentifier(projectId, "projectId");
  const normalizedUserId = assertNonEmptyIdentifier(userId, "userId");
  if (!masterLedger || typeof masterLedger !== "object" || Array.isArray(masterLedger)) {
    throw new Error("ATMS Decision Ledger: masterLedger must be a valid record object.");
  }

  const activeNodes = Object.values(cloneMasterLedger(masterLedger));
  const shouldPruneEvicted = options?.pruneEvicted !== false;
  const rowsToUpsert = buildRowsToUpsert(
    normalizedProjectId,
    normalizedUserId,
    activeNodes,
    projectTaxonomy,
  );

  if (rowsToUpsert.length === 0 && !shouldPruneEvicted) {
    return;
  }

  await executeLedgerSyncTransaction({
    projectId: normalizedProjectId,
    userId: normalizedUserId,
    activeDecisionIds: new Set(activeNodes.map((node) => node.decisionId)),
    rowsToUpsert,
    shouldPruneEvicted,
  });
}
