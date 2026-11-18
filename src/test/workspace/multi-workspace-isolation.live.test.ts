/**
 * Multi-Workspace Isolation, Schema Constraints & Atomic Transaction Live Suite
 *
 * REAL DATABASE TEST: isolated Neon PostgreSQL branch (`TEST_DATABASE_URL`).
 * Registered in `LIVE_TEST_FILES` (`vitest.constants.mts`); runs ONLY via `npm run test:live`.
 *
 * Verifies real PostgreSQL behavior that cannot be proven in memory:
 * 1. `workspaces` unique index `(user_id, name)` and `agent_checkpoints` composite PK
 *    with `ON DELETE CASCADE` from `workspaces`.
 * 2. Partial unique index `idx_files_workspace_parent_title_live`: allows identical titles
 *    across distinct workspaces of the same user while enforcing uniqueness within a workspace.
 * 3. `user_vault_profiles.allow_ai_on_encrypted_files` DB-level default `true`.
 * 4. `resolveOrEnsureWorkspaceId` and `ensureTestDefaultWorkspace` persistence.
 * 5. `decryptEntireWorkspace` real SQL transaction rollback on 409 OCC conflict and atomic commit.
 * 6. `CloudPostgresWorkspaceProvider`, `moveFile` (403 cross-workspace), `createFile` &
 *    `PUT /api/files/:id` (`400 WORKSPACE_ENCRYPTION_REQUIRED`) against real PostgreSQL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import {
  testDb,
  cleanupTestUsers,
  ensureTestDefaultWorkspace,
} from "@/test/test-db";
import {
  createWorkspace,
  deleteWorkspace,
  decryptEntireWorkspace,
  resolveOrEnsureWorkspaceId,
} from "@/server/actions/workspaces";
import { createFile } from "@/server/actions/files";
import { moveFile } from "@/server/actions/folders";
import { handleFileByIdPut } from "@/server/routes/files-api.routes";
import { CloudPostgresWorkspaceProvider } from "@/core/workspace/cloud-provider";
import {
  CrossWorkspaceAccessForbiddenError,
  DecisionLedgerConflictError,
} from "@/core/workspace/provider";

const USER_A_ID = "24242424-2424-2424-2424-242424242424";
const USER_B_ID = "25252525-2525-2525-2525-252525252525";

let dbAvailable = false;
let currentSessionUser: { id: string; email: string } | null = {
  id: USER_A_ID,
  email: "multi-ws-a@example.test",
};

vi.mock("@/lib/supabase/server", () => ({
  getUser: vi.fn(async () => currentSessionUser),
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: currentSessionUser },
        error: null,
      })),
    },
  })),
}));

vi.mock("@/server/db", async () => {
  const original = await vi.importActual<typeof import("@/server/db")>(
    "@/server/db"
  );
  return {
    ...original,
    db: testDb,
  };
});

vi.mock("@/lib/rate-limit", async () => {
  const original = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit"
  );
  return {
    ...original,
    fileApiRateLimiter: {
      limit: vi.fn().mockResolvedValue({
        success: true,
        remaining: 100,
        reset: Math.ceil(Date.now() / 1000) + 60,
        limit: 100,
      }),
    },
  };
});

const ENC_META = {
  version: 1,
  algorithm: "AES-GCM-256",
  keyId: "master-v1",
  salt: "c2FsdA==",
  iv: "aXYxMjM0NTY3ODkw",
  kdfIterations: 600000,
};

describe("Multi-Workspace Isolation & Governance — Real PostgreSQL Live Suite", () => {
  beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
    await ensureTestDb();
    await runMigrations();

    await testDb
      .insert(schema.users)
      .values([
        { id: USER_A_ID, email: "multi-ws-a@example.test", tier: "free" },
        { id: USER_B_ID, email: "multi-ws-b@example.test", tier: "free" },
      ])
      .onConflictDoNothing();
  });

  beforeEach(async (ctx) => {
    if (!dbAvailable) {
      ctx.skip();
      return;
    }
    currentSessionUser = { id: USER_A_ID, email: "multi-ws-a@example.test" };
    await testDb
      .delete(schema.agentCheckpoints)
      .where(eq(schema.agentCheckpoints.userId, USER_A_ID));
    await testDb
      .delete(schema.files)
      .where(eq(schema.files.userId, USER_A_ID));
    await testDb
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.userId, USER_A_ID));
    await testDb
      .delete(schema.userVaultProfiles)
      .where(eq(schema.userVaultProfiles.userId, USER_A_ID));
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    try {
      await cleanupTestUsers([USER_A_ID, USER_B_ID]);
    } catch {
      /* ignore cleanup errors */
    }
  });

  it("[DB] scopes partial unique title index per workspace and cascades agent_checkpoints on workspace delete", async () => {
    const ws1 = (await createWorkspace({ name: "Workspace One" })).data!;
    const ws2 = (await createWorkspace({ name: "Workspace Two" })).data!;

    // Same user can have identical live root title in two distinct workspaces
    const f1 = await createFile("README.md", null, false, ws1.id);
    const f2 = await createFile("README.md", null, false, ws2.id);
    expect(f1.success).toBe(true);
    expect(f2.success).toBe(true);

    // Duplicate live title inside the same workspace violates partial unique index
    await expect(
      testDb.insert(schema.files).values({
        id: randomUUID(),
        userId: USER_A_ID,
        workspaceId: ws1.id,
        title: "README.md",
        content: "dup",
        isFolder: false,
      })
    ).rejects.toThrow(/unique|duplicate|violates|Failed query/i);

    // Seed agent_checkpoints bound to ws2 and verify CASCADE deletion
    const threadId = `thread_${randomUUID()}`;
    await testDb.insert(schema.agentCheckpoints).values({
      threadId,
      stepIndex: 0,
      workspaceId: ws2.id,
      userId: USER_A_ID,
      nodeId: "search_agent_node",
      status: "RUNNING",
      encryptedStateBlob: Buffer.from("encrypted-state"),
    });

    const delWs = await deleteWorkspace(ws2.id);
    expect(delWs.success).toBe(true);

    const remainingCheckpoints = await testDb.query.agentCheckpoints.findMany({
      where: eq(schema.agentCheckpoints.threadId, threadId),
    });
    expect(remainingCheckpoints).toHaveLength(0);
  });

  it("[DB] defaults user_vault_profiles.allow_ai_on_encrypted_files to true and resolves Default Workspace", async () => {
    await testDb.insert(schema.userVaultProfiles).values({
      userId: USER_A_ID,
      encryptedMasterKey: "emk",
      recoveryEncryptedMasterKey: "remk",
      keySalt: "ks",
      recoverySalt: "rs",
    });

    const profile = await testDb.query.userVaultProfiles.findFirst({
      where: eq(schema.userVaultProfiles.userId, USER_A_ID),
    });
    expect(profile?.allowAIOnEncryptedFiles).toBe(true);

    const resolvedId = await resolveOrEnsureWorkspaceId(USER_A_ID);
    const ensuredId = await ensureTestDefaultWorkspace(USER_A_ID);
    expect(resolvedId).toBe(schema.deriveDefaultWorkspaceId(USER_A_ID));
    expect(ensuredId).toBe(resolvedId);
  });

  it("[DB] decryptEntireWorkspace rolls back on 409 version conflict and commits atomically on match", async () => {
    const ws = (
      await createWorkspace({ name: "Encrypted Vault WS", isEncrypted: true })
    ).data!;

    const doc1 = (
      await createFile("Doc1.md", null, false, ws.id, {
        content: "cipher-1",
        isEncrypted: true,
        encryptionMetadata: ENC_META,
      })
    ).data!;
    const doc2 = (
      await createFile("Doc2.md", null, false, ws.id, {
        content: "cipher-2",
        isEncrypted: true,
        encryptionMetadata: ENC_META,
      })
    ).data!;

    // Stale expectedVersion on doc2 must roll back doc1 and keep workspace encrypted
    const conflict = await decryptEntireWorkspace(ws.id, [
      { fileId: doc1.id, content: "# Plain 1", expectedVersion: 1 },
      { fileId: doc2.id, content: "# Plain 2", expectedVersion: 99 },
    ]);
    expect(conflict.success).toBe(false);
    expect(conflict.statusCode).toBe(409);

    const doc1AfterFail = await testDb.query.files.findFirst({
      where: eq(schema.files.id, doc1.id),
    });
    const wsAfterFail = await testDb.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, ws.id),
    });
    expect(doc1AfterFail?.isEncrypted).toBe(true);
    expect(wsAfterFail?.isEncrypted).toBe(true);

    // Matching preconditions commit atomically
    const ok = await decryptEntireWorkspace(ws.id, [
      { fileId: doc1.id, content: "# Plain 1", expectedVersion: 1 },
      { fileId: doc2.id, content: "# Plain 2", expectedVersion: 1 },
    ]);
    expect(ok.success).toBe(true);
    expect(ok.data?.isEncrypted).toBe(false);

    const decryptedFiles = await testDb.query.files.findMany({
      where: and(
        eq(schema.files.workspaceId, ws.id),
        eq(schema.files.isEncrypted, false)
      ),
    });
    expect(decryptedFiles).toHaveLength(2);
  });

  it("[DB] enforces cross-workspace 403 and WORKSPACE_ENCRYPTION_REQUIRED 400 across actions, REST PUT, and CloudPostgresWorkspaceProvider", async () => {
    const wsPlain = (await createWorkspace({ name: "Plain WS" })).data!;
    const wsEnc = (
      await createWorkspace({ name: "Enc WS", isEncrypted: true })
    ).data!;

    const plainFolder = (
      await createFile("FolderA", null, true, wsPlain.id)
    ).data!;
    const encFolder = (
      await createFile("FolderB", null, true, wsEnc.id)
    ).data!;
    const plainDoc = (
      await createFile("Note.md", plainFolder.id, false, wsPlain.id, {
        content: "# Title\nOriginal text.",
      })
    ).data!;

    // moveFile across workspaces -> 403
    const moveRes = await moveFile(plainDoc.id, encFolder.id);
    expect(moveRes).toMatchObject({
      success: false,
      status: "forbidden",
      statusCode: 403,
      error: "CROSS_WORKSPACE_ACCESS_FORBIDDEN",
    });

    // Unencrypted createFile in encrypted workspace -> 400 WORKSPACE_ENCRYPTION_REQUIRED
    const unencCreate = await createFile("Leak.md", null, false, wsEnc.id);
    expect(unencCreate).toMatchObject({
      success: false,
      statusCode: 400,
      error: "WORKSPACE_ENCRYPTION_REQUIRED",
    });

    // PUT /api/files/:id stripping encryption inside encrypted workspace -> 400
    const encDoc = (
      await createFile("Locked.md", null, false, wsEnc.id, {
        content: "ciphertext",
        isEncrypted: true,
        encryptionMetadata: ENC_META,
      })
    ).data!;
    const putRes = await handleFileByIdPut(
      new Request(`http://localhost/api/files/${encDoc.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "plaintext downgrade",
          isEncrypted: false,
          expectedVersion: 1,
        }),
      }),
      { id: encDoc.id }
    );
    expect(putRes.status).toBe(400);
    expect(await putRes.json()).toMatchObject({
      code: "WORKSPACE_ENCRYPTION_REQUIRED",
    });

    // CloudPostgresWorkspaceProvider cross-workspace 403, decision ledger OCC, and merge persistence
    const providerA = new CloudPostgresWorkspaceProvider({
      userId: USER_A_ID,
      workspaceId: wsPlain.id,
      db: testDb,
    });

    await expect(providerA.listHeadingsTree([encDoc.id])).rejects.toThrow(
      CrossWorkspaceAccessForbiddenError
    );

    const createdViaProvider = await providerA.createWorkspaceFile({
      relativePath: "docs/guide.md",
      initialContent: "# Guide\nInitial body.",
    });
    expect(createdViaProvider.relativePath).toBe("docs/guide.md");

    const w1 = await providerA.writeDecisionLedger({
      schemaVersion: "2.0",
      workspaceId: wsPlain.id,
      updatedAt: new Date().toISOString(),
      decisions: { "ADR-1": { decision: "Keep isolated" } },
    });
    expect(w1.version).toBe(1);

    await expect(
      providerA.writeDecisionLedger(
        {
          schemaVersion: "2.0",
          workspaceId: wsPlain.id,
          updatedAt: new Date().toISOString(),
          decisions: {},
        },
        { expectedVersion: 99 }
      )
    ).rejects.toThrow(DecisionLedgerConflictError);

    const ledgerRow = await testDb.query.files.findFirst({
      where: and(
        eq(schema.files.workspaceId, wsPlain.id),
        eq(schema.files.artifactRole, "decision_ledger")
      ),
    });
    await expect(
      providerA.deleteWorkspaceFile({ fileId: ledgerRow!.id })
    ).rejects.toMatchObject({
      status: 403,
      code: "DECISION_LEDGER_DELETE_FORBIDDEN",
    });
  });
});
