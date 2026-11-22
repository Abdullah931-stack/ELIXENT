/**
 * Multi-Workspace Isolation, ZK Governance & ZIP Export Verification Suite (Unit & Cross-Contract)
 *
 * Pure hermetic suite (zero DB / network dependency) running under `npm run test`.
 * Real PostgreSQL schema, index, FK cascade, and transaction rollback tests live in
 * `src/test/workspace/multi-workspace-isolation.live.test.ts` (registered in `LIVE_TEST_FILES`).
 *
 * Verifies Phase 2 SRS-01 / SRS-02 invariants across real production modules:
 * 1. Schema contracts & deterministic `deriveDefaultWorkspaceId`.
 * 2. `resolveOrEnsureWorkspaceId`, `deleteWorkspace`, `decryptEntireWorkspace` atomicity & OCC.
 * 3. `CloudPostgresWorkspaceProvider`: `CrossWorkspaceAccessForbiddenError` (403), `isAiExcluded`,
 *    `SectionReadResult` fields, `listWorkspaceTree()`, `createWorkspaceFile()`, `deleteWorkspaceFile()`
 *    (403 on `decision_ledger`), `readDecisionLedger()` / `writeDecisionLedger()` (409 OCC),
 *    and closed unencrypted file persistence in `mergeSectionThreeWay`.
 * 4. Cross-Contract ZK & Cross-Workspace Guards across Server Actions, REST `PUT /api/files/:id`,
 *    and Hono RPC routes (`400 WORKSPACE_ENCRYPTION_REQUIRED`, `403 CROSS_WORKSPACE_ACCESS_FORBIDDEN`).
 * 5. `exportWorkspaceAsZip`: folder hierarchy reconstruction, fail-closed `VAULT_LOCKED` /
 *    `ENCRYPTED_EXPORT_UNCONFIRMED`, local decryption, `decisions.ledger.json` `affectedSections`
 *    path enrichment, and binary ZIP structure (STORE method 0 + IEEE 802.3 CRC-32).
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// In-Memory Relational Store & Drizzle AST Evaluator (Hoisted System Boundary)
// ============================================================================

interface InMemoryStore {
  workspaces: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  userVaultProfiles: Array<Record<string, unknown>>;
}

const { sharedStore, mockSessionUser, mockTxDbOverride, createInMemoryDrizzleDb } = vi.hoisted(() => {
  const snakeToCamel = (colName: string): string =>
    colName.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

  const evalDrizzleCondition = (
    condition: unknown,
    row: Record<string, unknown>
  ): boolean => {
    if (!condition || typeof condition !== "object") return true;
    const node = condition as { queryChunks?: unknown[] };
    const chunks = node.queryChunks;
    if (!Array.isArray(chunks)) return true;

    if (
      chunks.length === 3 &&
      Array.isArray((chunks[0] as { value?: string[] })?.value) &&
      (chunks[0] as { value: string[] }).value[0] === "(" &&
      Array.isArray((chunks[2] as { value?: string[] })?.value) &&
      (chunks[2] as { value: string[] }).value[0] === ")"
    ) {
      return evalDrizzleCondition(chunks[1], row);
    }

    const hasAnd = chunks.some(
      (c) =>
        c &&
        typeof c === "object" &&
        Array.isArray((c as { value?: unknown[] }).value) &&
        (c as { value: string[] }).value[0] === " and "
    );
    if (hasAnd) {
      return chunks
        .filter((c) => c && typeof c === "object" && "queryChunks" in (c as object))
        .every((c) => evalDrizzleCondition(c, row));
    }

    const hasOr = chunks.some(
      (c) =>
        c &&
        typeof c === "object" &&
        Array.isArray((c as { value?: unknown[] }).value) &&
        (c as { value: string[] }).value[0] === " or "
    );
    if (hasOr) {
      return chunks
        .filter((c) => c && typeof c === "object" && "queryChunks" in (c as object))
        .some((c) => evalDrizzleCondition(c, row));
    }

    let colKey: string | null = null;
    const textParts: string[] = [];
    const params: unknown[] = [];

    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== "object") continue;
      if (
        "name" in chunk &&
        typeof (chunk as { name?: unknown }).name === "string" &&
        !("queryChunks" in chunk)
      ) {
        colKey = snakeToCamel((chunk as { name: string }).name);
      } else if (
        "value" in chunk &&
        Array.isArray((chunk as { value?: unknown }).value)
      ) {
        textParts.push(((chunk as { value: string[] }).value).join(""));
      } else if (
        "value" in chunk &&
        !Array.isArray((chunk as { value?: unknown }).value)
      ) {
        params.push((chunk as { value: unknown }).value);
      } else if (Array.isArray(chunk)) {
        for (const item of chunk) {
          if (item && typeof item === "object" && "value" in item) {
            params.push((item as { value: unknown }).value);
          }
        }
      }
    }

    if (!colKey) return true;
    const rowVal = row[colKey];
    const op = textParts.join("").trim();

    if (op === "is null") return rowVal === null || rowVal === undefined;
    if (op === "is not null") return rowVal !== null && rowVal !== undefined;
    if (op === "=") {
      const target = params[0];
      if (rowVal instanceof Date && target instanceof Date) {
        return rowVal.getTime() === target.getTime();
      }
      return rowVal === target;
    }
    if (op === "in") {
      const allowed = params.flat();
      return allowed.includes(rowVal);
    }
    return true;
  };

  const buildDb = (
    store: InMemoryStore,
    schemaRef: typeof import("@/server/db/schema")
  ) => {
    const resolveTableRows = (
      table: unknown
    ): Array<Record<string, unknown>> => {
      if (table === schemaRef.workspaces) return store.workspaces;
      if (table === schemaRef.files) return store.files;
      if (table === schemaRef.userVaultProfiles) return store.userVaultProfiles;
      return [];
    };

    const applyInsertDefaults = (
      table: unknown,
      raw: Record<string, unknown>
    ): Record<string, unknown> => {
      const now = new Date();
      if (table === schemaRef.workspaces) {
        return {
          id: raw.id ?? globalThis.crypto.randomUUID(),
          userId: raw.userId,
          name: raw.name,
          description: raw.description ?? null,
          isEncrypted: raw.isEncrypted ?? false,
          defaultPermissionMode: raw.defaultPermissionMode ?? "safe",
          createdAt: raw.createdAt ?? now,
          updatedAt: raw.updatedAt ?? now,
        };
      }
      if (table === schemaRef.files) {
        return {
          id: raw.id ?? globalThis.crypto.randomUUID(),
          userId: raw.userId,
          workspaceId: raw.workspaceId,
          title: raw.title,
          content: raw.content ?? null,
          parentFolderId: raw.parentFolderId ?? null,
          isFolder: raw.isFolder ?? false,
          isAiExcluded: raw.isAiExcluded ?? false,
          artifactRole: raw.artifactRole ?? "document",
          isEncrypted: raw.isEncrypted ?? false,
          encryptionMetadata: raw.encryptionMetadata ?? null,
          etag: raw.etag ?? null,
          version: raw.version ?? 1,
          deletedAt: raw.deletedAt ?? null,
          createdAt: raw.createdAt ?? now,
          updatedAt: raw.updatedAt ?? now,
        };
      }
      return { ...raw };
    };

    const dbApi = {
      query: {
        workspaces: {
          findFirst: async (opts?: { where?: unknown }) =>
            store.workspaces.find((r) => evalDrizzleCondition(opts?.where, r)),
          findMany: async (opts?: { where?: unknown }) =>
            store.workspaces.filter((r) => evalDrizzleCondition(opts?.where, r)),
        },
        files: {
          findFirst: async (opts?: { where?: unknown }) =>
            store.files.find((r) => evalDrizzleCondition(opts?.where, r)),
          findMany: async (opts?: { where?: unknown; limit?: number }) => {
            const matched = store.files.filter((r) =>
              evalDrizzleCondition(opts?.where, r)
            );
            return typeof opts?.limit === "number"
              ? matched.slice(0, opts.limit)
              : matched;
          },
        },
        userVaultProfiles: {
          findFirst: async (opts?: { where?: unknown }) =>
            store.userVaultProfiles.find((r) =>
              evalDrizzleCondition(opts?.where, r)
            ),
        },
      },
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            const rows = resolveTableRows(table).filter((r) =>
              evalDrizzleCondition(condition, r)
            );
            return Object.assign(Promise.resolve(rows), {
              limit: async (n: number) => rows.slice(0, n),
            });
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (
          vals: Record<string, unknown> | Array<Record<string, unknown>>
        ) => {
          const list = (Array.isArray(vals) ? vals : [vals]).map((v) =>
            applyInsertDefaults(table, v)
          );
          const rows = resolveTableRows(table);
          const executeInsert = (ignoreConflict: boolean) => {
            const inserted: Array<Record<string, unknown>> = [];
            for (const item of list) {
              const exists = rows.some((r) => r.id && r.id === item.id);
              if (exists) {
                if (ignoreConflict) continue;
                throw new Error(`Duplicate primary key: ${String(item.id)}`);
              }
              rows.push(item);
              inserted.push(item);
            }
            return inserted;
          };

          let committed = false;
          let insertedRows: Array<Record<string, unknown>> = [];
          const ensureCommitted = (ignoreConflict: boolean) => {
            if (!committed) {
              insertedRows = executeInsert(ignoreConflict);
              committed = true;
            }
            return insertedRows;
          };

          return {
            onConflictDoNothing: () => ({
              returning: async () => ensureCommitted(true),
              then: (
                onFulfilled?: (v: Array<Record<string, unknown>>) => unknown,
                onRejected?: (e: unknown) => unknown
              ) => Promise.resolve(ensureCommitted(true)).then(onFulfilled, onRejected),
            }),
            returning: async () => ensureCommitted(false),
            then: (
              onFulfilled?: (v: Array<Record<string, unknown>>) => unknown,
              onRejected?: (e: unknown) => unknown
            ) => Promise.resolve(ensureCommitted(false)).then(onFulfilled, onRejected),
          };
        },
      }),
      update: (table: unknown) => ({
        set: (updates: Record<string, unknown>) => ({
          where: (condition: unknown) => {
            const rows = resolveTableRows(table);
            const updated: Array<Record<string, unknown>> = [];
            for (const r of rows) {
              if (evalDrizzleCondition(condition, r)) {
                Object.assign(r, updates);
                updated.push(r);
              }
            }
            return Object.assign(
              Promise.resolve({ rowCount: updated.length }),
              {
                returning: async () => updated,
              }
            );
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: (condition: unknown) => {
          const rows = resolveTableRows(table);
          const deleted: Array<Record<string, unknown>> = [];
          for (let i = rows.length - 1; i >= 0; i--) {
            if (evalDrizzleCondition(condition, rows[i])) {
              deleted.unshift(rows[i]);
              rows.splice(i, 1);
            }
          }
          return Object.assign(Promise.resolve({ rowCount: deleted.length }), {
            returning: async () => deleted,
          });
        },
      }),
      transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
        const snapshot: InMemoryStore = {
          workspaces: store.workspaces.map((r) => ({ ...r })),
          files: store.files.map((r) => ({ ...r })),
          userVaultProfiles: store.userVaultProfiles.map((r) => ({ ...r })),
        };
        try {
          return await callback(dbApi);
        } catch (err) {
          store.workspaces = snapshot.workspaces;
          store.files = snapshot.files;
          store.userVaultProfiles = snapshot.userVaultProfiles;
          throw err;
        }
      },
    };

    return dbApi;
  };

  const store: InMemoryStore = {
    workspaces: [],
    files: [],
    userVaultProfiles: [],
  };
  return {
    sharedStore: store,
    mockSessionUser: {
      current: {
        id: "11111111-1111-4111-a111-111111111111",
        email: "multi-ws@elixent.test",
      } as { id: string; email: string } | null,
    },
    mockTxDbOverride: {
      mode: "omitted" as "omitted" | "present" | "throws",
      client: null as ReturnType<typeof buildDb> | null,
    },
    createInMemoryDrizzleDb: buildDb,
  };
});

vi.mock("@/server/db", async () => {
  const actualSchema = await vi.importActual<typeof import("@/server/db/schema")>(
    "@/server/db/schema"
  );
  const dbInstance = createInMemoryDrizzleDb(sharedStore, actualSchema);
  mockTxDbOverride.client = createInMemoryDrizzleDb(sharedStore, actualSchema);
  const mockExports = {
    db: dbInstance,
    schema: actualSchema,
    files: actualSchema.files,
    workspaces: actualSchema.workspaces,
    userVaultProfiles: actualSchema.userVaultProfiles,
    agentCheckpoints: actualSchema.agentCheckpoints,
  };
  Object.defineProperty(mockExports, "txDb", {
    enumerable: true,
    configurable: true,
    get() {
      if (mockTxDbOverride.mode === "throws") {
        throw new Error('No "txDb" export is defined on the "@/server/db" mock.');
      }
      return mockTxDbOverride.mode === "present" ? mockTxDbOverride.client : undefined;
    },
  });
  return mockExports;
});

import { db as inMemoryDb } from "@/server/db";

vi.mock("@/server/auth/session", () => ({
  requireAuthenticatedUser: async () => {
    if (!mockSessionUser.current) {
      throw new Error("Authentication required");
    }
    return mockSessionUser.current;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => mockSessionUser.current,
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    fileApiRateLimiter: {
      limit: async () => ({
        success: true,
        limit: 120,
        remaining: 119,
        reset: Math.ceil(Date.now() / 1000) + 60,
      }),
    },
    syncApiRateLimiter: {
      limit: async () => ({
        success: true,
        limit: 60,
        remaining: 59,
        reset: Math.ceil(Date.now() / 1000) + 60,
      }),
    },
  };
});

// ============================================================================
// Imports under test (Real Production Modules)
// ============================================================================

import {
  deriveDefaultWorkspaceId,
  workspaces as workspacesTable,
  agentCheckpoints as agentCheckpointsTable,
  userVaultProfiles as vaultProfilesTable,
} from "@/server/db/schema";
import {
  resolveOrEnsureWorkspaceId,
  createWorkspace,
  deleteWorkspace,
  decryptEntireWorkspace,
  WorkspaceNotFoundError,
} from "@/server/actions/workspaces";
import {
  createFile,
  copyFile,
  toggleFileEncryption,
} from "@/server/actions/files";
import { moveFile } from "@/server/actions/folders";
import { importFile } from "@/server/actions/import-file";
import { handleFileByIdPut } from "@/server/routes/files-api.routes";
import { rpcRoutes } from "@/server/routes/rpc.routes";
import { CloudPostgresWorkspaceProvider } from "@/core/workspace/cloud-provider";
import {
  CrossWorkspaceAccessForbiddenError,
  DecisionLedgerConflictError,
  EncryptedPayloadMissingError,
  WorkspaceFileAccessDeniedError,
} from "@/core/workspace/provider";
import { runWithEphemeralVaultScope } from "@/lib/vault/ephemeral-memory-map";
import {
  computeCrc32,
  exportWorkspaceAsZip,
  WorkspaceZipExportError,
} from "@/lib/export/workspace-zip-exporter";
import { generateETagSync } from "@/lib/sync/etag-generator.server";
import type { InboundPayloadInput } from "@/lib/sync/sync-crypto-gateway";

// ============================================================================
// Helpers
// ============================================================================

const USER_A = "11111111-1111-4111-a111-111111111111";
const USER_B = "22222222-2222-4222-a222-222222222222";
const WS_ALPHA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_BETA = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WS_ENCRYPTED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const VALID_ENC_META = {
  version: 1,
  algorithm: "AES-GCM-256",
  keyId: "master-v1",
  salt: "c2FsdA==",
  iv: "aXYxMjM0NTY3ODkw",
  kdfIterations: 600000,
};

interface ParsedZipEntry {
  path: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  data: Uint8Array;
}

function parseZipArchive(bytes: Uint8Array): ParsedZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // Locate End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP: EOCD signature missing");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries: ParsedZipEntry[] = [];

  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    // Verify corresponding Local File Header (0x04034b50)
    expect(view.getUint32(localHeaderOffset, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + uncompressedSize);

    entries.push({
      path,
      method,
      flags,
      crc32,
      compressedSize,
      uncompressedSize,
      data,
    });
  }

  return entries;
}

describe("Multi-Workspace Isolation, ZK Governance & ZIP Export", () => {
  beforeEach(() => {
    mockTxDbOverride.mode = "omitted";
    sharedStore.workspaces = [
      {
        id: WS_ALPHA,
        userId: USER_A,
        name: "Alpha Workspace",
        description: null,
        isEncrypted: false,
        defaultPermissionMode: "safe",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: WS_BETA,
        userId: USER_A,
        name: "Beta Workspace",
        description: null,
        isEncrypted: false,
        defaultPermissionMode: "semi_auto",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: WS_ENCRYPTED,
        userId: USER_A,
        name: "Vault Workspace",
        description: "Strict ZK",
        isEncrypted: true,
        defaultPermissionMode: "safe",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    sharedStore.files = [];
    sharedStore.userVaultProfiles = [
      {
        userId: USER_A,
        allowAIOnEncryptedFiles: true,
      },
    ];
    mockSessionUser.current = {
      id: USER_A,
      email: "multi-ws@elixent.test",
    };
  });

  // =========================================================================
  // 1. Schema Contracts & Deterministic Workspace Resolution
  // =========================================================================
  describe("Schema & Workspace Resolution", () => {
    it("deriveDefaultWorkspaceId produces deterministic RFC 4122 UUIDv5 per user", () => {
      const a1 = deriveDefaultWorkspaceId(USER_A);
      const a2 = deriveDefaultWorkspaceId(USER_A);
      const b1 = deriveDefaultWorkspaceId(USER_B);

      expect(a1).toBe(a2);
      expect(a1).not.toBe(b1);
      expect(a1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    });

    it("defines required multi-workspace columns and vault allowAIOnEncryptedFiles default=true", () => {
      expect(workspacesTable.userId.notNull).toBe(true);
      expect(workspacesTable.isEncrypted.default).toBe(false);
      expect(agentCheckpointsTable.workspaceId.notNull).toBe(true);
      expect(agentCheckpointsTable.encryptedStateBlob.notNull).toBe(true);
      expect(vaultProfilesTable.allowAIOnEncryptedFiles.default).toBe(true);
    });

    it("resolveOrEnsureWorkspaceId verifies ownership, inherits from parentFolderId, and initializes Default Workspace", async () => {
      // 1. Explicit owned workspaceId
      expect(await resolveOrEnsureWorkspaceId(USER_A, WS_BETA)).toBe(WS_BETA);

      // 2. Foreign or missing workspaceId throws WorkspaceNotFoundError (404)
      await expect(
        resolveOrEnsureWorkspaceId(USER_B, WS_ALPHA)
      ).rejects.toThrow(WorkspaceNotFoundError);

      // 3. Parent folder inheritance when workspaceId is omitted
      const folderId = randomUUID();
      sharedStore.files.push({
        id: folderId,
        userId: USER_A,
        workspaceId: WS_BETA,
        title: "Specs",
        isFolder: true,
        parentFolderId: null,
        deletedAt: null,
      });
      expect(await resolveOrEnsureWorkspaceId(USER_A, null, folderId)).toBe(
        WS_BETA
      );

      // 4. Fallback initializes deterministic Default Workspace
      const defaultId = await resolveOrEnsureWorkspaceId(USER_B);
      expect(defaultId).toBe(deriveDefaultWorkspaceId(USER_B));
      expect(
        sharedStore.workspaces.some(
          (w) => w.id === defaultId && w.userId === USER_B && w.name === "Default Workspace"
        )
      ).toBe(true);
    });

    it("deleteWorkspace forbids deleting Default Workspace (403) and deletes secondary workspaces", async () => {
      const defaultId = await resolveOrEnsureWorkspaceId(USER_A);

      const forbidRes = await deleteWorkspace(defaultId);
      expect(forbidRes.success).toBe(false);
      expect(forbidRes.statusCode).toBe(403);

      const createRes = await createWorkspace({ name: "Ephemeral WS" });
      expect(createRes.success).toBe(true);

      const delRes = await deleteWorkspace(createRes.data!.id);
      expect(delRes.success).toBe(true);
      expect(
        sharedStore.workspaces.some((w) => w.id === createRes.data!.id)
      ).toBe(false);
    });

    it("deleteWorkspace forbids deleting a 0014-migrated Default Workspace whose ID differs from deriveDefaultWorkspaceId (403)", async () => {
      const migratedDefaultId = randomUUID();
      expect(migratedDefaultId).not.toBe(deriveDefaultWorkspaceId(USER_B));

      sharedStore.workspaces.push({
        id: migratedDefaultId,
        userId: USER_B,
        name: "Default Workspace",
        description: "Backfilled by migration 0014",
        isEncrypted: false,
        defaultPermissionMode: "safe",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockSessionUser.current = {
        id: USER_B,
        email: "migrated-user@elixent.test",
      };

      const forbidRes = await deleteWorkspace(migratedDefaultId);
      expect(forbidRes.success).toBe(false);
      expect(forbidRes.status).toBe("forbidden");
      expect(forbidRes.statusCode).toBe(403);
      expect(
        sharedStore.workspaces.some((w) => w.id === migratedDefaultId)
      ).toBe(true);
    });

    it("decryptEntireWorkspace rejects partial payloads (400), rolls back on version conflict (409), and commits atomically", async () => {
      const f1 = randomUUID();
      const f2 = randomUUID();
      sharedStore.files.push(
        {
          id: f1,
          userId: USER_A,
          workspaceId: WS_ENCRYPTED,
          title: "Secret1.md",
          content: "ciphertext-1",
          isFolder: false,
          isEncrypted: true,
          encryptionMetadata: VALID_ENC_META,
          etag: "etag-1",
          version: 2,
          deletedAt: null,
        },
        {
          id: f2,
          userId: USER_A,
          workspaceId: WS_ENCRYPTED,
          title: "Secret2.md",
          content: "ciphertext-2",
          isFolder: false,
          isEncrypted: true,
          encryptionMetadata: VALID_ENC_META,
          etag: "etag-2",
          version: 4,
          deletedAt: null,
        }
      );

      // Partial payload -> 400
      const partialRes = await decryptEntireWorkspace(WS_ENCRYPTED, [
        { fileId: f1, content: "# Plain 1", expectedVersion: 2 },
      ]);
      expect(partialRes.success).toBe(false);
      expect(partialRes.statusCode).toBe(400);

      // Stale version on f2 -> 409 and f1 MUST remain encrypted (atomic rollback)
      const conflictRes = await decryptEntireWorkspace(WS_ENCRYPTED, [
        { fileId: f1, content: "# Plain 1", expectedVersion: 2 },
        { fileId: f2, content: "# Plain 2", expectedVersion: 3 },
      ]);
      expect(conflictRes.success).toBe(false);
      expect(conflictRes.statusCode).toBe(409);
      expect(sharedStore.files.find((f) => f.id === f1)?.isEncrypted).toBe(true);
      expect(
        sharedStore.workspaces.find((w) => w.id === WS_ENCRYPTED)?.isEncrypted
      ).toBe(true);

      // Matching versions -> atomic decrypt succeeds
      const okRes = await decryptEntireWorkspace(WS_ENCRYPTED, [
        { fileId: f1, content: "# Plain 1\r\n", expectedVersion: 2, expectedETag: "etag-1" },
        { fileId: f2, content: "# Plain 2", expectedVersion: 4, expectedETag: "etag-2" },
      ]);
      expect(okRes.success).toBe(true);
      expect(okRes.data?.isEncrypted).toBe(false);

      const updatedF1 = sharedStore.files.find((f) => f.id === f1)!;
      expect(updatedF1.isEncrypted).toBe(false);
      expect(updatedF1.encryptionMetadata).toBeNull();
      expect(updatedF1.content).toBe("# Plain 1\n");
      expect(updatedF1.version).toBe(3);
    });

    it("Phase 6 regression: decryptEntireWorkspace executes atomically via txDb.transaction on Neon HTTP runtime (where db.transaction throws) and rolls back on 409 ETag conflict", async () => {
      mockTxDbOverride.mode = "present";
      const dbTxSpy = vi
        .spyOn(inMemoryDb, "transaction")
        .mockRejectedValue(new Error("No transactions support in neon-http driver"));

      try {
        const f1 = randomUUID();
        const f2 = randomUUID();
        sharedStore.files.push(
          {
            id: f1,
            userId: USER_A,
            workspaceId: WS_ENCRYPTED,
            title: "NeonSecret1.md",
            content: "ciphertext-neon-1",
            isFolder: false,
            isEncrypted: true,
            encryptionMetadata: VALID_ENC_META,
            etag: "etag-neon-1",
            version: 1,
            deletedAt: null,
          },
          {
            id: f2,
            userId: USER_A,
            workspaceId: WS_ENCRYPTED,
            title: "NeonSecret2.md",
            content: "ciphertext-neon-2",
            isFolder: false,
            isEncrypted: true,
            encryptionMetadata: VALID_ENC_META,
            etag: "etag-neon-2",
            version: 1,
            deletedAt: null,
          }
        );

        // 1. ETag conflict on f2 must roll back f1 atomically via txDb without touching db.transaction
        const etagConflict = await decryptEntireWorkspace(WS_ENCRYPTED, [
          { fileId: f1, content: "# Plain Neon 1", expectedVersion: 1, expectedETag: "etag-neon-1" },
          { fileId: f2, content: "# Plain Neon 2", expectedVersion: 1, expectedETag: "etag-stale" },
        ]);
        expect(etagConflict.success).toBe(false);
        expect(etagConflict.status).toBe("conflict");
        expect(etagConflict.statusCode).toBe(409);
        expect(dbTxSpy).not.toHaveBeenCalled();
        expect(sharedStore.files.find((f) => f.id === f1)?.isEncrypted).toBe(true);
        expect(sharedStore.files.find((f) => f.id === f1)?.content).toBe("ciphertext-neon-1");
        expect(sharedStore.workspaces.find((w) => w.id === WS_ENCRYPTED)?.isEncrypted).toBe(true);

        // 2. Matching preconditions commit atomically via txDb even though db.transaction is unsupported
        const okRes = await decryptEntireWorkspace(WS_ENCRYPTED, [
          { fileId: f1, content: "# Plain Neon 1\r\n", expectedVersion: 1, expectedETag: "etag-neon-1" },
          { fileId: f2, content: "# Plain Neon 2", expectedVersion: 1, expectedETag: "etag-neon-2" },
        ]);
        expect(okRes.success).toBe(true);
        expect(okRes.data?.isEncrypted).toBe(false);
        expect(dbTxSpy).not.toHaveBeenCalled();

        const decryptedF1 = sharedStore.files.find((f) => f.id === f1)!;
        const decryptedF2 = sharedStore.files.find((f) => f.id === f2)!;
        expect(decryptedF1.isEncrypted).toBe(false);
        expect(decryptedF1.encryptionMetadata).toBeNull();
        expect(decryptedF1.content).toBe("# Plain Neon 1\n");
        expect(decryptedF1.version).toBe(2);
        expect(decryptedF2.isEncrypted).toBe(false);
        expect(decryptedF2.encryptionMetadata).toBeNull();
        expect(decryptedF2.version).toBe(2);
      } finally {
        dbTxSpy.mockRestore();
      }
    });

    it("Phase 6 regression: decryptEntireWorkspace falls back to db.transaction when txDb export access throws on partial mocks", async () => {
      mockTxDbOverride.mode = "throws";

      const f1 = randomUUID();
      sharedStore.files.push({
        id: f1,
        userId: USER_A,
        workspaceId: WS_ENCRYPTED,
        title: "PartialMockSecret.md",
        content: "ciphertext-partial",
        isFolder: false,
        isEncrypted: true,
        encryptionMetadata: VALID_ENC_META,
        etag: "etag-partial-1",
        version: 1,
        deletedAt: null,
      });

      const okRes = await decryptEntireWorkspace(WS_ENCRYPTED, [
        { fileId: f1, content: "# Decrypted via fallback", expectedVersion: 1, expectedETag: "etag-partial-1" },
      ]);

      expect(okRes.success).toBe(true);
      expect(okRes.data?.isEncrypted).toBe(false);
      expect(sharedStore.files.find((f) => f.id === f1)?.isEncrypted).toBe(false);
    });
  });

  // =========================================================================
  // 2. CloudPostgresWorkspaceProvider Multi-Workspace & Ledger Contracts
  // =========================================================================
  describe("CloudPostgresWorkspaceProvider Phase 2 Contracts", () => {
    const FILE_ALPHA = "f1111111-1111-4111-a111-111111111111";
    const FILE_BETA = "f2222222-2222-4222-a222-222222222222";
    const FILE_EXCLUDED = "f3333333-3333-4333-a333-333333333333";

    beforeEach(() => {
      sharedStore.files.push(
        {
          id: FILE_ALPHA,
          userId: USER_A,
          workspaceId: WS_ALPHA,
          parentFolderId: null,
          title: "alpha.md",
          content: "# Overview\nAlpha body content.",
          isFolder: false,
          isAiExcluded: false,
          artifactRole: "document",
          isEncrypted: false,
          etag: "etag-alpha-1",
          version: 3,
          deletedAt: null,
          updatedAt: new Date("2026-11-18T10:00:00Z"),
        },
        {
          id: FILE_BETA,
          userId: USER_A,
          workspaceId: WS_BETA,
          parentFolderId: null,
          title: "beta.md",
          content: "# Beta\nBeta body content.",
          isFolder: false,
          isAiExcluded: false,
          artifactRole: "document",
          isEncrypted: false,
          etag: "etag-beta-1",
          version: 1,
          deletedAt: null,
          updatedAt: new Date("2026-11-18T10:00:00Z"),
        },
        {
          id: FILE_EXCLUDED,
          userId: USER_A,
          workspaceId: WS_ALPHA,
          parentFolderId: null,
          title: "private-notes.md",
          content: "# Overview\nSecret excluded note.",
          isFolder: false,
          isAiExcluded: true,
          artifactRole: "document",
          isEncrypted: false,
          etag: "etag-excl-1",
          version: 1,
          deletedAt: null,
          updatedAt: new Date("2026-11-18T10:00:00Z"),
        }
      );
    });

    it.each([
      [
        "listHeadingsTree",
        (p: CloudPostgresWorkspaceProvider) => p.listHeadingsTree([FILE_BETA]),
      ],
      [
        "readSectionByHeading",
        (p: CloudPostgresWorkspaceProvider) =>
          p.readSectionByHeading(FILE_BETA, "beta"),
      ],
      [
        "searchLexicalWithASTBreadcrumb",
        (p: CloudPostgresWorkspaceProvider) =>
          p.searchLexicalWithASTBreadcrumb({ fileIds: [FILE_BETA], query: "Beta" }),
      ],
      [
        "mergeSectionThreeWay",
        (p: CloudPostgresWorkspaceProvider) =>
          p.mergeSectionThreeWay({
            fileId: FILE_BETA,
            headingSlug: "beta",
            baseSectionContent: "## Beta\nOld",
            agentProposedSectionContent: "## Beta\nNew",
            liveDocumentContent: "## Beta\nOld",
          }),
      ],
      [
        "deleteWorkspaceFile",
        (p: CloudPostgresWorkspaceProvider) =>
          p.deleteWorkspaceFile({ fileId: FILE_BETA }),
      ],
    ])(
      "%s throws CrossWorkspaceAccessForbiddenError (403) on cross-workspace file",
      async (_methodName, invoke) => {
        const provider = new CloudPostgresWorkspaceProvider({
          userId: USER_A,
          workspaceId: WS_ALPHA,
          db: inMemoryDb,
        });

        let caught: unknown;
        try {
          await invoke(provider);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(CrossWorkspaceAccessForbiddenError);
        expect(caught).toMatchObject({
          status: 403,
          code: "CROSS_WORKSPACE_ACCESS_FORBIDDEN",
        });
      }
    );

    it("filters isAiExcluded files from listWorkspaceTree and auto-search, and rejects explicit access with 404", async () => {
      const provider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ALPHA,
        db: inMemoryDb,
      });

      const tree = await provider.listWorkspaceTree();
      expect(tree.map((e) => e.fileId)).toEqual([FILE_ALPHA]);

      const headings = await provider.listHeadingsTree();
      expect(Object.keys(headings)).toEqual([FILE_ALPHA]);

      await expect(provider.listHeadingsTree([FILE_EXCLUDED])).rejects.toThrow(
        WorkspaceFileAccessDeniedError
      );
    });

    it("returns SectionReadResult with fileId, headingSlug, SHA-256 sectionHash, fileEtag, and fileVersion", async () => {
      const provider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ALPHA,
        db: inMemoryDb,
      });

      const res = await provider.readSectionByHeading(FILE_ALPHA, "overview");
      const expectedHash = createHash("sha256")
        .update(res.contentOrVaultRef)
        .digest("hex");

      expect(res.fileId).toBe(FILE_ALPHA);
      expect(res.headingSlug).toBe("overview");
      expect(res.sectionHash).toBe(expectedHash);
      expect(res.fileEtag).toBe("etag-alpha-1");
      expect(res.fileVersion).toBe(3);

      // Encrypted document keeps sectionHash over plaintext while redacting contentOrVaultRef
      const encId = randomUUID();
      const plainBody = "# Secret\nTop secret body.";
      sharedStore.files.push({
        id: encId,
        userId: USER_A,
        workspaceId: WS_ALPHA,
        parentFolderId: null,
        title: "secret.md",
        content: "CIPHERTEXT",
        isFolder: false,
        isAiExcluded: false,
        artifactRole: "document",
        isEncrypted: true,
        etag: "etag-enc-9",
        version: 9,
        deletedAt: null,
      });
      const encProvider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ALPHA,
        ephemeralVaultPayloads: { [encId]: plainBody },
        db: inMemoryDb,
      });
      await runWithEphemeralVaultScope(async () => {
        const encRes = await encProvider.readSectionByHeading(encId, "secret");
        expect(encRes.isVaultRef).toBe(true);
        expect(encRes.fileId).toBe(encId);
        expect(encRes.headingSlug).toBe("secret");
        expect(encRes.fileEtag).toBe("etag-enc-9");
        expect(encRes.fileVersion).toBe(9);
        expect(encRes.sectionHash).toBe(
          createHash("sha256").update(plainBody).digest("hex")
        );
      });
    });

    it("createWorkspaceFile creates missing nested folders and listWorkspaceTree reconstructs relativePath", async () => {
      const provider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ENCRYPTED,
        db: inMemoryDb,
      });

      const created = await provider.createWorkspaceFile({
        relativePath: "architecture/specs/design.md",
        initialContent: "# Design Spec",
      });

      expect(created.title).toBe("design.md");
      expect(created.relativePath).toBe("architecture/specs/design.md");
      expect(created.isEncrypted).toBe(true);
      expect(created.version).toBe(1);

      // Creating sibling in same nested folder reuses existing folders
      const sibling = await provider.createWorkspaceFile({
        relativePath: "architecture/specs/api.md",
        initialContent: "# API Spec",
      });
      expect(sibling.parentFolderId).toBe(created.parentFolderId);

      const tree = await provider.listWorkspaceTree();
      const paths = tree.map((e) => e.relativePath).sort();
      expect(paths).toEqual([
        "architecture",
        "architecture/specs",
        "architecture/specs/api.md",
        "architecture/specs/design.md",
      ]);
    });

    it("readDecisionLedger, writeDecisionLedger (409 OCC), and deleteWorkspaceFile (403 on decision_ledger)", async () => {
      const provider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ALPHA,
        db: inMemoryDb,
      });

      // Default initialization when absent
      const initial = await provider.readDecisionLedger();
      expect(initial.schemaVersion).toBe("2.0");
      expect(initial.workspaceId).toBe(WS_ALPHA);
      expect(initial.decisions).toEqual({});

      // Rejects expectedVersion > 0 when ledger does not yet exist
      await expect(
        provider.writeDecisionLedger(initial, { expectedVersion: 1 })
      ).rejects.toThrow(DecisionLedgerConflictError);

      // Initial write succeeds at version 1
      const w1 = await provider.writeDecisionLedger({
        schemaVersion: "2.0",
        workspaceId: WS_ALPHA,
        updatedAt: new Date().toISOString(),
        decisions: { "ADR-01": { status: "accepted" } },
      });
      expect(w1.version).toBe(1);

      const readBack = await provider.readDecisionLedger();
      expect(readBack.decisions["ADR-01"]).toEqual({ status: "accepted" });

      // Stale version or stale etag triggers 409 DecisionLedgerConflictError
      await expect(
        provider.writeDecisionLedger(readBack, { expectedVersion: 99 })
      ).rejects.toThrow(DecisionLedgerConflictError);

      await expect(
        provider.writeDecisionLedger(readBack, { expectedEtag: "wrong-etag" })
      ).rejects.toThrow(DecisionLedgerConflictError);

      // Matching OCC succeeds and increments version
      const w2 = await provider.writeDecisionLedger(
        { ...readBack, decisions: { "ADR-01": { status: "superseded" } } },
        { expectedVersion: 1, expectedEtag: w1.etag }
      );
      expect(w2.version).toBe(2);

      // Deleting canonical decision_ledger is forbidden with 403
      const ledgerRow = sharedStore.files.find(
        (f) => f.workspaceId === WS_ALPHA && f.artifactRole === "decision_ledger"
      )!;
      await expect(
        provider.deleteWorkspaceFile({ fileId: String(ledgerRow.id) })
      ).rejects.toMatchObject({
        status: 403,
        code: "DECISION_LEDGER_DELETE_FORBIDDEN",
      });

      // Normal document soft-deletion succeeds
      const delRes = await provider.deleteWorkspaceFile({ fileId: FILE_ALPHA });
      expect(delRes.fileId).toBe(FILE_ALPHA);
      expect(
        sharedStore.files.find((f) => f.id === FILE_ALPHA)?.deletedAt
      ).not.toBeNull();
    });

    it("readDecisionLedger fails closed with EncryptedPayloadMissingError when encrypted ledger lacks plaintext", async () => {
      sharedStore.files.push({
        id: randomUUID(),
        userId: USER_A,
        workspaceId: WS_ENCRYPTED,
        parentFolderId: null,
        title: "decisions.ledger.json",
        content: "ENCRYPTED_LEDGER_BLOB",
        isFolder: false,
        isEncrypted: true,
        isAiExcluded: false,
        artifactRole: "decision_ledger",
        version: 1,
        deletedAt: null,
      });

      const provider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ENCRYPTED,
        db: inMemoryDb,
      });

      await expect(provider.readDecisionLedger()).rejects.toThrow(
        EncryptedPayloadMissingError
      );
    });

    it("mergeSectionThreeWay persists clean unencrypted merges and skips DB write when liveDocumentSnapshots or encrypted", async () => {
      const mergeDocId = randomUUID();
      const baseDoc = [
        "# Spec",
        "",
        "## Overview",
        "Line 1: Original",
        "Line 2: Common",
      ].join("\n");
      sharedStore.files.push({
        id: mergeDocId,
        userId: USER_A,
        workspaceId: WS_ALPHA,
        parentFolderId: null,
        title: "spec.md",
        content: baseDoc,
        isFolder: false,
        isAiExcluded: false,
        artifactRole: "document",
        isEncrypted: false,
        etag: "etag-before",
        version: 2,
        deletedAt: null,
      });

      // 1. Live snapshot mode must NOT persist to DB
      const snapshotProvider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ALPHA,
        liveDocumentSnapshots: { [mergeDocId]: baseDoc },
        db: inMemoryDb,
      });
      const snapOutcome = await snapshotProvider.mergeSectionThreeWay({
        fileId: mergeDocId,
        headingSlug: "overview",
        baseSectionContent: "## Overview\nLine 1: Original\nLine 2: Common",
        agentProposedSectionContent: "## Overview\nLine 1: Original\nLine 2: Proposed",
        liveDocumentContent: baseDoc,
      });
      expect(snapOutcome.status).toBe("clean");
      expect(sharedStore.files.find((f) => f.id === mergeDocId)?.version).toBe(2);

      // 2. Headless DB mode persists clean merge and advances version + etag
      const headlessProvider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ALPHA,
        db: inMemoryDb,
      });
      const dbOutcome = await headlessProvider.mergeSectionThreeWay({
        fileId: mergeDocId,
        headingSlug: "overview",
        baseSectionContent: "## Overview\nLine 1: Original\nLine 2: Common",
        agentProposedSectionContent: "## Overview\nLine 1: Original\nLine 2: Proposed",
        liveDocumentContent: baseDoc,
      });
      expect(dbOutcome.status).toBe("clean");
      const persisted = sharedStore.files.find((f) => f.id === mergeDocId)!;
      expect(persisted.version).toBe(3);
      expect(persisted.content).toContain("Line 2: Proposed");
      expect(persisted.etag).not.toBe("etag-before");
    });

    it("mergeSectionThreeWay treats empty-string liveDocumentSnapshots[fileId] as an open tab and throws 409 FILE_VERSION_CONFLICT on concurrent version mismatch", async () => {
      const mergeDocId = randomUUID();
      const baseDoc = [
        "# Spec",
        "",
        "## Overview",
        "Line 1: Original",
        "Line 2: Common",
      ].join("\n");
      sharedStore.files.push({
        id: mergeDocId,
        userId: USER_A,
        workspaceId: WS_ALPHA,
        parentFolderId: null,
        title: "open-empty.md",
        content: baseDoc,
        isFolder: false,
        isAiExcluded: false,
        artifactRole: "document",
        isEncrypted: false,
        etag: "etag-v2",
        version: 2,
        deletedAt: null,
      });

      // (a) Empty-string snapshot (`""`) is an open tab -> must NOT overwrite DB
      const emptySnapshotProvider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ALPHA,
        liveDocumentSnapshots: { [mergeDocId]: "" },
        db: inMemoryDb,
      });
      const openOutcome = await emptySnapshotProvider.mergeSectionThreeWay({
        fileId: mergeDocId,
        headingSlug: "overview",
        baseSectionContent: "## Overview\nLine 1: Original\nLine 2: Common",
        agentProposedSectionContent: "## Overview\nLine 1: Original\nLine 2: Proposed",
        liveDocumentContent: baseDoc,
      });
      expect(openOutcome.status).toBe("clean");
      expect(sharedStore.files.find((f) => f.id === mergeDocId)?.version).toBe(2);
      expect(sharedStore.files.find((f) => f.id === mergeDocId)?.content).toBe(baseDoc);

      // (b) Closed file with concurrent version bump between read and CAS update -> 409 FILE_VERSION_CONFLICT
      const racedDb = {
        select: () => inMemoryDb.select(),
        update: (table: Parameters<typeof inMemoryDb.update>[0]) => {
          const target = sharedStore.files.find((f) => f.id === mergeDocId);
          if (target) {
            target.version = 3; // Concurrent writer committed version 3
          }
          return inMemoryDb.update(table);
        },
      };
      const racedProvider = new CloudPostgresWorkspaceProvider({
        userId: USER_A,
        workspaceId: WS_ALPHA,
        db: racedDb,
      });

      let caught: unknown;
      try {
        await racedProvider.mergeSectionThreeWay({
          fileId: mergeDocId,
          headingSlug: "overview",
          baseSectionContent: "## Overview\nLine 1: Original\nLine 2: Common",
          agentProposedSectionContent: "## Overview\nLine 1: Original\nLine 2: Proposed",
          liveDocumentContent: baseDoc,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({
        status: 409,
        code: "FILE_VERSION_CONFLICT",
      });
    });
  });

  // =========================================================================
  // 3. Cross-Contract ZK Governance & Cross-Workspace Action/Route Guards
  // =========================================================================
  describe("ZK Governance & Cross-Workspace Guards (Actions, REST & RPC)", () => {
    it("enforces 400 WORKSPACE_ENCRYPTION_REQUIRED across createFile, copyFile, toggleFileEncryption, importFile, PUT /api/files/:id, and RPC routes", async () => {
      const encDocId = randomUUID();
      const plainSrcId = randomUUID();
      sharedStore.files.push(
        {
          id: encDocId,
          userId: USER_A,
          workspaceId: WS_ENCRYPTED,
          title: "LockedNote.md",
          content: "ciphertext",
          isFolder: false,
          isEncrypted: true,
          encryptionMetadata: VALID_ENC_META,
          etag: "etag-enc-1",
          version: 1,
          deletedAt: null,
          updatedAt: new Date(),
          createdAt: new Date(),
        },
        {
          id: plainSrcId,
          userId: USER_A,
          workspaceId: WS_ALPHA,
          title: "PlainSource.md",
          content: "# Plain",
          isFolder: false,
          isEncrypted: false,
          encryptionMetadata: null,
          etag: "etag-plain-1",
          version: 1,
          deletedAt: null,
          updatedAt: new Date(),
          createdAt: new Date(),
        }
      );

      // 1. Folders are exempt in encrypted workspaces; plaintext documents are blocked (400)
      const folderOk = await createFile("EncryptedFolder", null, true, WS_ENCRYPTED);
      expect(folderOk.success).toBe(true);

      const createFail = await createFile("Plain.md", null, false, WS_ENCRYPTED);
      expect(createFail).toMatchObject({
        success: false,
        statusCode: 400,
        error: "WORKSPACE_ENCRYPTION_REQUIRED",
      });

      // 2. copyFile into encrypted workspace without encryptedOverride -> 400
      const copyFail = await copyFile(plainSrcId, null, 0, undefined, WS_ENCRYPTED);
      expect(copyFail).toMatchObject({
        success: false,
        statusCode: 400,
        error: "WORKSPACE_ENCRYPTION_REQUIRED",
      });

      // 3. toggleFileEncryption(false) inside encrypted workspace -> 400
      const toggleFail = await toggleFileEncryption(
        encDocId,
        false,
        "decrypted plaintext",
        null,
        { expectedVersion: 1 }
      );
      expect(toggleFail).toMatchObject({
        success: false,
        statusCode: 400,
        error: "WORKSPACE_ENCRYPTION_REQUIRED",
      });

      // 4. importFile plaintext into encrypted workspace -> 400
      const importFail = await importFile(
        "note.md",
        "# Unencrypted",
        "md",
        null,
        undefined,
        WS_ENCRYPTED
      );
      expect(importFail).toMatchObject({
        success: false,
        statusCode: 400,
        error: "WORKSPACE_ENCRYPTION_REQUIRED",
      });

      // 5. PUT /api/files/:id attempting to strip encryption in encrypted workspace -> 400
      const putRes = await handleFileByIdPut(
        new Request(`http://localhost/api/files/${encDocId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "Attempted plaintext downgrade",
            isEncrypted: false,
            expectedVersion: 1,
          }),
        }),
        { id: encDocId }
      );
      expect(putRes.status).toBe(400);
      expect(await putRes.json()).toMatchObject({
        code: "WORKSPACE_ENCRYPTION_REQUIRED",
      });

      // 6. Hono RPC routes propagate HTTP 400 for WORKSPACE_ENCRYPTION_REQUIRED
      const rpcCases = [
        await rpcRoutes.request("/files/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "PlainViaRpc.md",
            workspaceId: WS_ENCRYPTED,
          }),
        }),
        await rpcRoutes.request("/files/copy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileId: plainSrcId,
            workspaceId: WS_ENCRYPTED,
          }),
        }),
        await rpcRoutes.request("/files/toggle-encryption", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileId: encDocId,
            isEncrypted: false,
            content: "plaintext",
            encryptionMetadata: null,
          }),
        }),
        await rpcRoutes.request("/files/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: "plain.md",
            textContent: "# Plain",
            fileType: "md",
            workspaceId: WS_ENCRYPTED,
          }),
        }),
      ];

      for (const res of rpcCases) {
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("WORKSPACE_ENCRYPTION_REQUIRED");
      }
    });

    it("blocks cross-workspace moveFile and parentFolderId mismatches with 403 CROSS_WORKSPACE_ACCESS_FORBIDDEN", async () => {
      const alphaDocId = randomUUID();
      const betaFolderId = randomUUID();
      sharedStore.files.push(
        {
          id: alphaDocId,
          userId: USER_A,
          workspaceId: WS_ALPHA,
          title: "AlphaDoc.md",
          content: "alpha",
          isFolder: false,
          parentFolderId: null,
          deletedAt: null,
        },
        {
          id: betaFolderId,
          userId: USER_A,
          workspaceId: WS_BETA,
          title: "BetaFolder",
          content: null,
          isFolder: true,
          parentFolderId: null,
          deletedAt: null,
        }
      );

      // moveFile across workspaces -> 403
      const moveActionRes = await moveFile(alphaDocId, betaFolderId);
      expect(moveActionRes).toMatchObject({
        success: false,
        status: "forbidden",
        statusCode: 403,
        error: "CROSS_WORKSPACE_ACCESS_FORBIDDEN",
      });

      const moveRpcRes = await rpcRoutes.request("/files/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: alphaDocId,
          newParentFolderId: betaFolderId,
        }),
      });
      expect(moveRpcRes.status).toBe(403);
      expect(await moveRpcRes.json()).toMatchObject({
        success: false,
        error: "CROSS_WORKSPACE_ACCESS_FORBIDDEN",
      });

      // createFile / copyFile / importFile with mismatched workspaceId vs parentFolderId -> 403
      expect(
        await createFile("Cross.md", betaFolderId, false, WS_ALPHA)
      ).toMatchObject({
        success: false,
        statusCode: 403,
        error: "CROSS_WORKSPACE_ACCESS_FORBIDDEN",
      });

      expect(
        await copyFile(alphaDocId, betaFolderId, 0, undefined, WS_ALPHA)
      ).toMatchObject({
        success: false,
        statusCode: 403,
        error: "CROSS_WORKSPACE_ACCESS_FORBIDDEN",
      });

      expect(
        await importFile("cross.md", "# Cross", "md", betaFolderId, undefined, WS_ALPHA)
      ).toMatchObject({
        success: false,
        statusCode: 403,
        error: "CROSS_WORKSPACE_ACCESS_FORBIDDEN",
      });
    });

    it("scopes /files/list and /files/list-root RPC routes by workspaceId and rejects invalid UUIDs with 400", async () => {
      sharedStore.files.push(
        {
          id: randomUUID(),
          userId: USER_A,
          workspaceId: WS_ALPHA,
          title: "AlphaOnly.md",
          isFolder: false,
          parentFolderId: null,
          deletedAt: null,
          updatedAt: new Date(),
        },
        {
          id: randomUUID(),
          userId: USER_A,
          workspaceId: WS_BETA,
          title: "BetaOnly.md",
          isFolder: false,
          parentFolderId: null,
          deletedAt: null,
          updatedAt: new Date(),
        }
      );

      const listAlpha = await rpcRoutes.request(
        `/files/list?workspaceId=${WS_ALPHA}`,
        { method: "GET" }
      );
      expect(listAlpha.status).toBe(200);
      const alphaJson = await listAlpha.json();
      expect(alphaJson.data.map((f: { title: string }) => f.title)).toEqual([
        "AlphaOnly.md",
      ]);

      const badList = await rpcRoutes.request("/files/list?workspaceId=not-a-uuid", {
        method: "GET",
      });
      expect(badList.status).toBe(400);
    });
  });

  // =========================================================================
  // 4. Full-Workspace ZIP Archive Exporter (`exportWorkspaceAsZip`)
  // =========================================================================
  describe("exportWorkspaceAsZip Binary & Governance Contracts", () => {
    it("reconstructs folder hierarchy, decrypts files, enriches decision ledger affectedSections, and emits valid STORE+CRC32 ZIP", async () => {
      const folderSpecsId = "fld-specs";
      const folderSubId = "fld-sub";
      const plainDocId = "doc-plain-1";
      const encDocId = "doc-enc-1";
      const deletedDocId = "doc-deleted";

      const decryptCalls: InboundPayloadInput[] = [];
      const blob = await exportWorkspaceAsZip(WS_ALPHA, {
        timestamp: new Date("2026-11-18T12:00:00Z"),
        confirmedPlaintextExport: true,
        files: [
          {
            id: folderSpecsId,
            workspaceId: WS_ALPHA,
            title: "Specs",
            content: null,
            parentFolderId: null,
            isFolder: true,
          },
          {
            id: folderSubId,
            workspaceId: WS_ALPHA,
            title: "Sub",
            content: null,
            parentFolderId: folderSpecsId,
            isFolder: true,
          },
          {
            id: plainDocId,
            workspaceId: WS_ALPHA,
            title: "overview.md",
            content: "# Overview\nPlaintext body.",
            parentFolderId: folderSpecsId,
            isFolder: false,
            isEncrypted: false,
          },
          {
            id: encDocId,
            workspaceId: WS_ALPHA,
            title: "secrets.md",
            content: "AES_GCM_CIPHERTEXT",
            parentFolderId: folderSubId,
            isFolder: false,
            isEncrypted: true,
            encryptionMetadata: VALID_ENC_META,
          },
          {
            id: deletedDocId,
            workspaceId: WS_ALPHA,
            title: "trash.md",
            content: "deleted",
            parentFolderId: null,
            isFolder: false,
            deletedAt: "2026-11-17T00:00:00Z",
          },
          {
            id: "ledger-id",
            workspaceId: WS_ALPHA,
            title: "decisions.ledger.json",
            content: JSON.stringify({
              schemaVersion: "2.0",
              workspaceId: WS_ALPHA,
              decisions: {
                "ADR-10": {
                  title: "Zero-Knowledge Export",
                  affectedSections: [
                    { fileId: encDocId, headingSlug: "keys" },
                    { fileId: plainDocId, headingSlug: "intro" },
                  ],
                },
              },
            }),
            parentFolderId: null,
            isFolder: false,
            artifactRole: "decision_ledger",
          },
        ],
        decryptFile: async (payload) => {
          decryptCalls.push(payload);
          return {
            fileId: payload.fileId,
            content: "# Secrets\nDecrypted secret body.",
            isEncrypted: true,
            isVaultLocked: false,
            status: "decrypted",
            encryptionMetadata: null,
          };
        },
      });

      expect(decryptCalls).toHaveLength(1);
      expect(blob.type).toBe("application/zip");

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const entries = parseZipArchive(bytes);
      const decoder = new TextDecoder();

      expect(entries.map((e) => e.path)).toEqual([
        "decisions.ledger.json",
        "Specs/",
        "Specs/overview.md",
        "Specs/Sub/",
        "Specs/Sub/secrets.md",
      ]);

      for (const entry of entries) {
        expect(entry.method).toBe(0); // STORE
        expect(entry.flags & 0x0800).toBe(0x0800); // UTF-8
        expect(entry.compressedSize).toBe(entry.uncompressedSize);
        expect(entry.crc32).toBe(computeCrc32(entry.data));
      }

      const secretText = decoder.decode(
        entries.find((e) => e.path === "Specs/Sub/secrets.md")!.data
      );
      expect(secretText).toBe("# Secrets\nDecrypted secret body.");

      const ledgerJson = JSON.parse(
        decoder.decode(
          entries.find((e) => e.path === "decisions.ledger.json")!.data
        )
      );
      expect(ledgerJson.decisions["ADR-10"].affectedSections).toEqual([
        {
          fileId: encDocId,
          relativePath: "Specs/Sub/secrets.md",
          headingSlug: "keys",
        },
        {
          fileId: plainDocId,
          relativePath: "Specs/overview.md",
          headingSlug: "intro",
        },
      ]);
    });

    it.each([
      {
        label: "fails closed with VAULT_LOCKED when encrypted file cannot decrypt because vault is locked",
        options: {
          files: [
            {
              id: "enc-1",
              workspaceId: WS_ALPHA,
              title: "secret.md",
              content: "cipher",
              parentFolderId: null,
              isFolder: false,
              isEncrypted: true,
            },
          ],
          confirmedPlaintextExport: true,
          decryptFile: async (payload: InboundPayloadInput) => ({
            fileId: payload.fileId,
            content: "",
            isEncrypted: true,
            isVaultLocked: true,
            status: "locked" as const,
            encryptionMetadata: null,
          }),
        },
        expectedCode: "VAULT_LOCKED",
      },
      {
        label: "fails closed with ENCRYPTED_EXPORT_UNCONFIRMED when confirmedPlaintextExport is omitted",
        options: {
          files: [
            {
              id: "enc-omitted",
              workspaceId: WS_ALPHA,
              title: "secret.md",
              content: "cipher",
              parentFolderId: null,
              isFolder: false,
              isEncrypted: true,
            },
          ],
        },
        expectedCode: "ENCRYPTED_EXPORT_UNCONFIRMED",
      },
      {
        label: "fails closed with ENCRYPTED_EXPORT_UNCONFIRMED when confirmedPlaintextExport is false",
        options: {
          files: [
            {
              id: "enc-2",
              workspaceId: WS_ALPHA,
              title: "secret.md",
              content: "cipher",
              parentFolderId: null,
              isFolder: false,
              isEncrypted: true,
            },
          ],
          confirmedPlaintextExport: false,
        },
        expectedCode: "ENCRYPTED_EXPORT_UNCONFIRMED",
      },
      {
        label: "rejects cross-workspace files with CROSS_WORKSPACE_FILE_FORBIDDEN",
        options: {
          files: [
            {
              id: "foreign-1",
              workspaceId: WS_BETA,
              title: "foreign.md",
              content: "foreign",
              parentFolderId: null,
              isFolder: false,
            },
          ],
        },
        expectedCode: "CROSS_WORKSPACE_FILE_FORBIDDEN",
      },
    ])("$label", async ({ options, expectedCode }) => {
      let caught: unknown;
      try {
        await exportWorkspaceAsZip(WS_ALPHA, options);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkspaceZipExportError);
      expect((caught as WorkspaceZipExportError).code).toBe(expectedCode);
    });

    it("produces valid ETag-compatible archive bytes for empty unencrypted workspace", async () => {
      const blob = await exportWorkspaceAsZip(WS_ALPHA, { files: [] });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      expect(parseZipArchive(bytes)).toEqual([]);
      expect(generateETagSync({ id: "zip", content: "empty", updatedAt: new Date(0) })).toMatch(
        /^[a-f0-9]{32}$/
      );
    });
  });
});
