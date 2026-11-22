/**
 * Phase 5 (Wave 5.1) — IndexedDB v2 Migration, Persistent Ghost Hunks & Turn-Linked Rollback
 *
 * Cross-Contract Verification:
 * - `src/lib/sync/idb-types.ts` (IDB v2 schema constants & extended `IDBOperation` contract)
 * - `src/lib/sync/indexeddb.ts` (v1 -> v2 upgrade adding `idx_operations_workspace_turn`,
 *   composite index turn lookup, encrypted-at-rest `pending_ghost_hunks_${workspaceId}` CRUD)
 * - `src/lib/sync/rollback.ts` (`SyncRollback.rollbackAgentTurn` reverse-chronological rollback
 *   across `update`, `create`, and `delete` operations against real IndexedDB)
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDB_CONFIG,
  getDatabaseName,
  type IDBFile,
  type IDBOperation,
} from "@/lib/sync/idb-types";
import {
  IndexedDBManager,
  createIndexedDBManager,
} from "@/lib/sync/indexeddb";
import type { GhostHunk } from "@/components/editor/markdown/types";

const {
  mockDeleteFile,
  mockRestoreWorkspaceFileRpc,
  mockUpdateFileContent,
  mockToggleFileEncryption,
} = vi.hoisted(() => ({
  mockDeleteFile: vi.fn(),
  mockRestoreWorkspaceFileRpc: vi.fn(),
  mockUpdateFileContent: vi.fn(),
  mockToggleFileEncryption: vi.fn(),
}));

// Mock only the external HTTP/RPC boundary; persistence (IndexedDB + AES-GCM) is 100% real.
vi.mock("@/client/rpc-client", () => ({
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  restoreWorkspaceFileRpc: (...args: unknown[]) =>
    mockRestoreWorkspaceFileRpc(...args),
  updateFileContent: (...args: unknown[]) => mockUpdateFileContent(...args),
  toggleFileEncryption: (...args: unknown[]) => mockToggleFileEncryption(...args),
}));

import { createSyncRollback, type SyncRollback } from "@/lib/sync/rollback";

function buildFile(overrides: Partial<IDBFile> = {}): IDBFile {
  return {
    id: overrides.id ?? "file-md-1",
    title: overrides.title ?? "architecture.md",
    content: overrides.content ?? "# Initial Architecture\n",
    etag: overrides.etag ?? "etag-v1",
    version: overrides.version ?? 1,
    parentFolderId: overrides.parentFolderId ?? null,
    isFolder: overrides.isFolder ?? false,
    lastModified: overrides.lastModified ?? 1_700_000_000_000,
    lastSyncedAt: overrides.lastSyncedAt ?? 1_700_000_000_000,
    isDirty: overrides.isDirty ?? false,
    ...overrides,
  };
}

function buildOperation(overrides: Partial<IDBOperation> = {}): IDBOperation {
  const id = overrides.id ?? `op-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    operationId: overrides.operationId ?? id,
    userId: overrides.userId ?? "user-wave5",
    workspaceId: overrides.workspaceId ?? "ws-alpha",
    threadId: overrides.threadId ?? "thread-1",
    turnId: overrides.turnId ?? "turn-1",
    postTurnEtag: overrides.postTurnEtag ?? "etag-post-turn",
    fileId: overrides.fileId ?? "file-md-1",
    baseVersion: overrides.baseVersion ?? 1,
    localRevision: overrides.localRevision ?? 2,
    sentRevision: overrides.sentRevision ?? 1,
    status: overrides.status ?? "synced",
    attempts: overrides.attempts ?? 1,
    nextRetryAt: overrides.nextRetryAt ?? 0,
    lastError: overrides.lastError,
    operationType: overrides.operationType ?? "update",
    position: overrides.position ?? 0,
    content: overrides.content ?? "# Updated Content\n",
    timestamp: overrides.timestamp ?? 1_700_000_001_000,
    synced: overrides.synced ?? true,
    ...overrides,
  };
}

function buildGhostHunk(overrides: Partial<GhostHunk> = {}): GhostHunk {
  return {
    hunkId: overrides.hunkId ?? "hunk-1",
    decisionIds: overrides.decisionIds ?? ["dec-1"],
    headingSlug: overrides.headingSlug ?? "system-overview",
    from: overrides.from ?? 0,
    to: overrides.to ?? 10,
    originalSlice: overrides.originalSlice ?? "Old secret",
    replacementText: overrides.replacementText ?? "New confidential text",
    status: overrides.status ?? "preview_ready",
    operation: overrides.operation ?? "replace",
  };
}

async function readRawRecord<T>(
  dbName: string,
  storeName: string,
  key: string,
): Promise<T | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, IDB_CONFIG.DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

describe("IndexedDB v2 Migration, Turn Index & Persistent Ghost Hunks (Wave 5.1)", () => {
  let userId: string;
  let idb: IndexedDBManager;

  beforeEach(() => {
    vi.clearAllMocks();
    userId = `user-idb-v2-${Math.random().toString(36).slice(2, 10)}`;
    idb = createIndexedDBManager(userId);
  });

  afterEach(async () => {
    await idb.deleteDatabase();
  });

  it("upgrades an existing v1 database to v2, creates idx_operations_workspace_turn, and preserves pre-existing v1 operations", async () => {
    const dbName = getDatabaseName(userId);

    // Seed a legacy v1 IndexedDB database without idx_operations_workspace_turn
    await new Promise<void>((resolve, reject) => {
      const openReq = indexedDB.open(dbName, 1);
      openReq.onupgradeneeded = () => {
        const legacyDb = openReq.result;
        const filesStore = legacyDb.createObjectStore(IDB_CONFIG.STORES.FILES, {
          keyPath: "id",
        });
        filesStore.createIndex("isDirty", "isDirty", { unique: false });
        const opsStore = legacyDb.createObjectStore(
          IDB_CONFIG.STORES.OPERATIONS,
          { keyPath: "id" },
        );
        opsStore.createIndex("fileId", "fileId", { unique: false });
        opsStore.createIndex("synced", "synced", { unique: false });
        legacyDb.createObjectStore(IDB_CONFIG.STORES.SYNC_METADATA, {
          keyPath: "id",
        });
      };
      openReq.onsuccess = () => {
        const legacyDb = openReq.result;
        const tx = legacyDb.transaction(
          IDB_CONFIG.STORES.OPERATIONS,
          "readwrite",
        );
        tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).put({
          id: "legacy-op-1",
          fileId: "legacy-file-1",
          workspaceId: "ws-legacy",
          turnId: "turn-legacy",
          operationType: "update",
          position: 0,
          content: "Legacy plaintext operation content",
          timestamp: 1000,
          synced: true,
        });
        tx.oncomplete = () => {
          legacyDb.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      openReq.onerror = () => reject(openReq.error);
    });

    // Open with v2 IndexedDBManager
    const upgradedDb = await idb.init(userId);
    expect(upgradedDb.version).toBe(2);

    const tx = upgradedDb.transaction(IDB_CONFIG.STORES.OPERATIONS, "readonly");
    const opsStore = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS);
    expect(
      opsStore.indexNames.contains(IDB_CONFIG.INDEXES.OPERATIONS_WORKSPACE_TURN),
    ).toBe(true);
    const idx = opsStore.index(IDB_CONFIG.INDEXES.OPERATIONS_WORKSPACE_TURN);
    expect(idx.keyPath).toEqual(["workspaceId", "turnId"]);

    // Legacy v1 record is still queryable through the newly built composite index
    const migratedOps = await idb.getOperationsByWorkspaceTurn(
      "ws-legacy",
      "turn-legacy",
    );
    expect(migratedOps).toHaveLength(1);
    expect(migratedOps[0].id).toBe("legacy-op-1");
    expect(migratedOps[0].content).toBe("Legacy plaintext operation content");
  });

  it("queries operations scoped strictly by (workspaceId, turnId) while preserving all concurrency/retry and turn metadata encrypted at rest", async () => {
    await idb.init(userId);

    const targetOp = buildOperation({
      id: "op-target",
      userId,
      workspaceId: "ws-1",
      threadId: "thread-abc",
      turnId: "turn-42",
      postTurnEtag: "etag-after-42",
      fileId: "doc-1",
      baseVersion: 3,
      localRevision: 7,
      sentRevision: 6,
      status: "failed",
      attempts: 2,
      nextRetryAt: 1_800_000_000_000,
      lastError: "transient timeout",
      content: "Confidential turn delta payload",
      snapshot: {
        content: "Confidential pre-turn snapshot",
        etag: "etag-before-42",
        version: 3,
      },
    });
    const otherTurnOp = buildOperation({
      id: "op-other-turn",
      userId,
      workspaceId: "ws-1",
      turnId: "turn-99",
      fileId: "doc-1",
    });
    const otherWorkspaceOp = buildOperation({
      id: "op-other-ws",
      userId,
      workspaceId: "ws-2",
      turnId: "turn-42",
      fileId: "doc-1",
    });

    await idb.addOperation(targetOp);
    await idb.addOperation(otherTurnOp);
    await idb.addOperation(otherWorkspaceOp);

    const fetched = await idb.getOperationsByWorkspaceTurn("ws-1", "turn-42");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({
      id: "op-target",
      workspaceId: "ws-1",
      threadId: "thread-abc",
      turnId: "turn-42",
      postTurnEtag: "etag-after-42",
      baseVersion: 3,
      localRevision: 7,
      sentRevision: 6,
      status: "failed",
      attempts: 2,
      nextRetryAt: 1_800_000_000_000,
      lastError: "transient timeout",
      content: "Confidential turn delta payload",
      snapshot: {
        content: "Confidential pre-turn snapshot",
        etag: "etag-before-42",
        version: 3,
      },
    });

    // Verify zero plaintext at rest in raw IndexedDB storage
    const rawOp = await readRawRecord<IDBOperation>(
      getDatabaseName(userId),
      IDB_CONFIG.STORES.OPERATIONS,
      "op-target",
    );
    expect(rawOp?.content).toContain('"_enc":1');
    expect(rawOp?.content).not.toContain("Confidential turn delta payload");
    expect(rawOp?.snapshot?.content).toContain('"_enc":1');
    expect(rawOp?.snapshot?.content).not.toContain(
      "Confidential pre-turn snapshot",
    );
  });

  it("persists, isolates, encrypts at rest, and clears pending_ghost_hunks_${workspaceId} across reconnects", async () => {
    await idb.init(userId);

    const hunkA = buildGhostHunk({
      hunkId: "hunk-ws1-a",
      replacementText: "Top secret workspace-1 edit",
    });
    const hunkB = buildGhostHunk({
      hunkId: "hunk-ws2-b",
      replacementText: "Top secret workspace-2 edit",
    });

    await idb.savePendingGhostHunks("ws-1", {
      ghostHunksByFileId: { "file-1": [hunkA] },
      turnIdByHunkId: { "hunk-ws1-a": "turn-1" },
    });
    await idb.savePendingGhostHunks("ws-2", {
      ghostHunksByFileId: { "file-2": [hunkB] },
      turnIdByHunkId: { "hunk-ws2-b": "turn-2" },
    });

    // Verify raw stored record is encrypted under key `pending_ghost_hunks_ws-1`
    const rawMeta = await readRawRecord<{
      id: string;
      payload: string;
      updatedAt: number;
    }>(
      getDatabaseName(userId),
      IDB_CONFIG.STORES.SYNC_METADATA,
      "pending_ghost_hunks_ws-1",
    );
    expect(rawMeta?.id).toBe("pending_ghost_hunks_ws-1");
    expect(typeof rawMeta?.payload).toBe("string");
    expect(rawMeta?.payload).toContain('"_enc":1');
    expect(rawMeta?.payload).not.toContain("Top secret workspace-1 edit");

    // Simulate page reload with a fresh IndexedDBManager instance
    idb.close();
    const reloadedIdb = createIndexedDBManager(userId);
    await reloadedIdb.init(userId);

    const loadedWs1 = await reloadedIdb.loadPendingGhostHunks("ws-1");
    const loadedWs2 = await reloadedIdb.loadPendingGhostHunks("ws-2");

    expect(loadedWs1?.ghostHunksByFileId["file-1"]).toEqual([hunkA]);
    expect(loadedWs1?.turnIdByHunkId).toEqual({ "hunk-ws1-a": "turn-1" });
    expect(loadedWs1?.updatedAt).toBeGreaterThan(0);

    expect(loadedWs2?.ghostHunksByFileId["file-2"]).toEqual([hunkB]);

    // Clearing ws-1 must not affect ws-2
    await reloadedIdb.clearPendingGhostHunks("ws-1");
    expect(await reloadedIdb.loadPendingGhostHunks("ws-1")).toBeNull();
    expect(
      (await reloadedIdb.loadPendingGhostHunks("ws-2"))?.ghostHunksByFileId[
        "file-2"
      ],
    ).toEqual([hunkB]);

    reloadedIdb.close();
    // Re-init original manager so afterEach cleanly deletes DB
    await idb.init(userId);
  });
});

describe("SyncRollback.rollbackAgentTurn (Wave 5.1)", () => {
  let userId: string;
  let idb: IndexedDBManager;
  let rollback: SyncRollback;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDeleteFile.mockResolvedValue({ success: true });
    mockRestoreWorkspaceFileRpc.mockResolvedValue({ success: true });
    mockUpdateFileContent.mockResolvedValue({ success: true });
    mockToggleFileEncryption.mockResolvedValue({ success: true });

    userId = `user-rb-${Math.random().toString(36).slice(2, 10)}`;
    idb = createIndexedDBManager(userId);
    await idb.init(userId);
    rollback = createSyncRollback(idb);
  });

  afterEach(async () => {
    await idb.deleteDatabase();
  });

  it("reverts update (.md & decisions.ledger.json), create, and delete operations in reverse chronological order while leaving other turns untouched", async () => {
    const executionOrder: string[] = [];
    mockDeleteFile.mockImplementation(async (fileId: string) => {
      executionOrder.push(`delete:${fileId}`);
      return { success: true };
    });
    mockRestoreWorkspaceFileRpc.mockImplementation(async (fileId: string) => {
      executionOrder.push(`restore:${fileId}`);
      return { success: true };
    });

    // Seed post-turn file state in real IndexedDB
    await idb.saveFile(
      buildFile({
        id: "file-spec",
        title: "spec.md",
        content: "# Spec v3 (post-turn)",
        etag: "etag-spec-v3",
        version: 3,
      }),
    );
    await idb.saveFile(
      buildFile({
        id: "file-ledger",
        title: "decisions.ledger.json",
        content: JSON.stringify({ schemaVersion: "2.0.0", nodes: { d1: {} } }),
        etag: "etag-ledger-v2",
        version: 2,
      }),
    );
    await idb.saveFile(
      buildFile({
        id: "file-created",
        title: "agent-generated.md",
        content: "# Created by agent",
        etag: "etag-created-v1",
        version: 1,
      }),
    );
    await idb.saveFile(
      buildFile({
        id: "file-other-turn",
        title: "other.md",
        content: "# Untouched other turn",
        etag: "etag-other-v2",
        version: 2,
      }),
    );

    // Two sequential updates on the SAME file in turn-7:
    // t=1000 (v1 -> v2) and t=3000 (v2 -> v3). Reverse order MUST leave file-spec at v1!
    await idb.addOperation(
      buildOperation({
        id: "op-1-spec-first",
        workspaceId: "ws-main",
        turnId: "turn-7",
        fileId: "file-spec",
        operationType: "update",
        timestamp: 1000,
        content: "# Spec v2",
        snapshot: {
          content: "# Spec v1 (pre-turn)",
          etag: "etag-spec-v1",
          version: 1,
        },
      }),
    );
    await idb.addOperation(
      buildOperation({
        id: "op-2-delete-old",
        workspaceId: "ws-main",
        turnId: "turn-7",
        fileId: "file-deleted-by-agent",
        operationType: "delete",
        timestamp: 2000,
        content: "",
      }),
    );
    await idb.addOperation(
      buildOperation({
        id: "op-3-spec-second",
        workspaceId: "ws-main",
        turnId: "turn-7",
        fileId: "file-spec",
        operationType: "update",
        timestamp: 3000,
        content: "# Spec v3 (post-turn)",
        snapshot: {
          content: "# Spec v2",
          etag: "etag-spec-v2",
          version: 2,
        },
      }),
    );
    await idb.addOperation(
      buildOperation({
        id: "op-4-create-new",
        workspaceId: "ws-main",
        turnId: "turn-7",
        fileId: "file-created",
        operationType: "create",
        timestamp: 4000,
        content: "# Created by agent",
      }),
    );
    await idb.addOperation(
      buildOperation({
        id: "op-5-ledger-update",
        workspaceId: "ws-main",
        turnId: "turn-7",
        fileId: "file-ledger",
        operationType: "update",
        timestamp: 5000,
        content: JSON.stringify({ schemaVersion: "2.0.0", nodes: { d1: {} } }),
        snapshot: {
          content: JSON.stringify({ schemaVersion: "2.0.0", nodes: {} }),
          etag: "etag-ledger-v1",
          version: 1,
        },
      }),
    );

    // Unrelated turn & unrelated workspace operations (must remain untouched)
    await idb.addOperation(
      buildOperation({
        id: "op-unrelated-turn",
        workspaceId: "ws-main",
        turnId: "turn-8",
        fileId: "file-other-turn",
        operationType: "update",
        timestamp: 6000,
        snapshot: {
          content: "# Should NOT be restored",
          etag: "etag-other-v1",
          version: 1,
        },
      }),
    );
    await idb.addOperation(
      buildOperation({
        id: "op-unrelated-ws",
        workspaceId: "ws-other",
        turnId: "turn-7",
        fileId: "file-other-turn",
        operationType: "delete",
        timestamp: 6000,
      }),
    );

    const summary = await rollback.rollbackAgentTurn("ws-main", "turn-7");

    // Reverse chronological order:
    // t=5000 (update file-ledger) -> t=4000 (create file-created) ->
    // t=3000 (update file-spec) -> t=2000 (delete file-deleted-by-agent) -> t=1000 (update file-spec)
    expect(summary).toEqual({
      rolledBackFiles: ["file-ledger", "file-spec", "file-spec"],
      deletedCreatedFiles: ["file-created"],
      restoredFiles: ["file-deleted-by-agent"],
    });
    expect(executionOrder).toEqual([
      "delete:file-created",
      "restore:file-deleted-by-agent",
    ]);

    // file-spec must end up at the earliest pre-turn snapshot (v1), proving reverse-order replay
    const restoredSpec = await idb.getFile("file-spec");
    expect(restoredSpec).toMatchObject({
      content: "# Spec v1 (pre-turn)",
      etag: "etag-spec-v1",
      version: 1,
      isDirty: true,
    });

    // decisions.ledger.json restored to pre-turn snapshot
    const restoredLedger = await idb.getFile("file-ledger");
    expect(restoredLedger).toMatchObject({
      content: JSON.stringify({ schemaVersion: "2.0.0", nodes: {} }),
      etag: "etag-ledger-v1",
      version: 1,
      isDirty: true,
    });

    // Created file soft-deleted on server and purged from local IDB
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith("file-created");
    expect(await idb.getFile("file-created")).toBeUndefined();

    // Soft-deleted file restored via RPC & reverted update snapshots persisted back to PostgreSQL
    expect(mockRestoreWorkspaceFileRpc).toHaveBeenCalledTimes(1);
    expect(mockRestoreWorkspaceFileRpc).toHaveBeenCalledWith(
      "file-deleted-by-agent",
    );
    expect(mockUpdateFileContent).toHaveBeenCalledWith(
      "file-ledger",
      JSON.stringify({ schemaVersion: "2.0.0", nodes: {} }),
    );
    expect(mockUpdateFileContent).toHaveBeenLastCalledWith(
      "file-spec",
      "# Spec v1 (pre-turn)",
    );

    // Other turn's file untouched
    const otherFile = await idb.getFile("file-other-turn");
    expect(otherFile?.content).toBe("# Untouched other turn");
    expect(otherFile?.version).toBe(2);
  });

  it("isolates a failed update snapshot without aborting sibling create/delete rollbacks in the same turn", async () => {
    await idb.addOperation(
      buildOperation({
        id: "op-missing-snap",
        workspaceId: "ws-main",
        turnId: "turn-partial",
        fileId: "file-no-snap",
        operationType: "update",
        timestamp: 2000,
        snapshot: undefined,
      }),
    );
    await idb.addOperation(
      buildOperation({
        id: "op-create-no-local-idb",
        workspaceId: "ws-main",
        turnId: "turn-partial",
        fileId: "file-cloud-only-created",
        operationType: "create",
        timestamp: 1500,
      }),
    );
    await idb.addOperation(
      buildOperation({
        id: "op-restore-deleted",
        workspaceId: "ws-main",
        turnId: "turn-partial",
        fileId: "file-deleted-2",
        operationType: "delete",
        timestamp: 1000,
      }),
    );

    const summary = await rollback.rollbackAgentTurn("ws-main", "turn-partial");

    expect(summary).toEqual({
      rolledBackFiles: [],
      deletedCreatedFiles: ["file-cloud-only-created"],
      restoredFiles: ["file-deleted-2"],
    });

    const failedOp = await idb.getOperation("op-missing-snap");
    expect(failedOp?.status).toBe("rollback_failed");
    expect(failedOp?.lastError).toMatch(/no snapshot/i);
  });

  it("returns empty arrays and triggers zero RPC calls when the turn has no recorded operations", async () => {
    const summary = await rollback.rollbackAgentTurn("ws-empty", "turn-none");

    expect(summary).toEqual({
      rolledBackFiles: [],
      restoredFiles: [],
      deletedCreatedFiles: [],
    });
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockRestoreWorkspaceFileRpc).not.toHaveBeenCalled();
  });
});
