// @vitest-environment jsdom
/**
 * Phase 5 (Wave 5.2) — useAIStream Pre-Stream ZK Vault Bridge, Turn-Linked Mutations,
 * `vault_file_commit_required` (LUGX-004), Persistent Ghost Hunks & Wire `workspaceId` Contract
 *
 * Cross-Contract Verification:
 * - Real `useAIStream` + Real `IndexedDBManager` (`fake-indexeddb/auto`)
 * - Real `SyncCryptoGateway` (WebCrypto AES-GCM) + Real `sessionKeyStore`
 * - Real `WorkspaceTabsProvider`
 * - External boundaries only (`consumeAgentStream`, `@/client/rpc-client`, `@/client/navigation`) mocked.
 *
 * Specifications: SRS-02 §4.3 (`REQ-ZK-04`), SRS-03 §3.1 & §5.2 (`IDBOperation` turn tracking).
 */

import "fake-indexeddb/auto";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { StreamHandlerOptions } from "@/lib/ai/stream-handler";
import type { EditorAdapter, GhostHunk } from "@/components/editor/markdown/types";
import type { FileRecord, WorkspaceRecord } from "@/types/rpc-contracts";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";

const {
  mockConsumeAgentStream,
  mockGetUserFiles,
  mockGetFile,
  mockToggleFileEncryption,
  mockListWorkspacesRpc,
  mockResolveInitialClientUserIdSync,
} = vi.hoisted(() => ({
  mockConsumeAgentStream: vi.fn(),
  mockGetUserFiles: vi.fn(),
  mockGetFile: vi.fn(),
  mockToggleFileEncryption: vi.fn(),
  mockListWorkspacesRpc: vi.fn(),
  mockResolveInitialClientUserIdSync: vi.fn(),
}));

vi.mock("@/lib/ai/stream-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/stream-handler")>();
  return {
    ...actual,
    consumeAgentStream: (opts: StreamHandlerOptions) => mockConsumeAgentStream(opts),
  };
});

vi.mock("@/client/rpc-client", () => ({
  getUserFiles: (...args: unknown[]) => mockGetUserFiles(...args),
  getFile: (...args: unknown[]) => mockGetFile(...args),
  toggleFileEncryption: (...args: unknown[]) => mockToggleFileEncryption(...args),
  listWorkspacesRpc: (...args: unknown[]) => mockListWorkspacesRpc(...args),
  updateFileContent: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/client/navigation", () => ({
  navigateTo: vi.fn(),
}));

vi.mock("@/lib/auth/client-identity", () => ({
  resolveInitialClientUserIdSync: () => mockResolveInitialClientUserIdSync(),
}));

import { useAIStream } from "@/hooks/use-ai-stream";
import { WorkspaceTabsProvider } from "@/components/editor/workspace-tab-bar";

const VALID_WS_UUID = "11111111-2222-4333-8444-555555555555";
const OTHER_WS_UUID = "99999999-8888-4777-8666-555555555555";

function createInMemoryEditor(initialContent: string) {
  let content = initialContent;
  let ghostHunks: GhostHunk[] = [];
  const setValueCalls: Array<{ content: string; origin?: string }> = [];

  const editor = {
    getValue: () => content,
    setValue: (next: string, origin?: string) => {
      content = next;
      setValueCalls.push({ content: next, origin });
    },
    startGhostSession: vi.fn((_sid: string, hunks?: GhostHunk[]) => {
      ghostHunks = hunks ? [...hunks] : [];
    }),
    upsertGhostHunk: vi.fn((hunk: GhostHunk) => {
      const idx = ghostHunks.findIndex((h) => h.hunkId === hunk.hunkId);
      if (idx >= 0) ghostHunks[idx] = hunk;
      else ghostHunks.push(hunk);
    }),
    getGhostHunks: () => [...ghostHunks],
    clearGhostSession: vi.fn(() => {
      ghostHunks = [];
    }),
    clearStreamingGhost: vi.fn(() => {
      ghostHunks = [];
    }),
    acceptGhostHunk: vi.fn(),
    rejectGhostHunk: vi.fn(),
    acceptAllGhostHunks: vi.fn(),
  } as unknown as EditorAdapter;

  return { editor, getContent: () => content, setValueCalls };
}

function buildRemoteFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: overrides.id ?? "file-remote-1",
    userId: overrides.userId ?? "user-stream-1",
    workspaceId: overrides.workspaceId ?? VALID_WS_UUID,
    title: overrides.title ?? "remote.md",
    content: overrides.content ?? null,
    parentFolderId: overrides.parentFolderId ?? null,
    isFolder: overrides.isFolder ?? false,
    isAiExcluded: overrides.isAiExcluded ?? false,
    artifactRole: overrides.artifactRole ?? "document",
    isEncrypted: overrides.isEncrypted ?? false,
    encryptionMetadata: overrides.encryptionMetadata ?? null,
    etag: overrides.etag ?? "etag-r1",
    version: overrides.version ?? 1,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function buildWorkspace(id: string, userId: string): WorkspaceRecord {
  return {
    id,
    userId,
    name: "Wave 5.2 Workspace",
    description: null,
    isEncrypted: true,
    defaultPermissionMode: "semi_auto",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("useAIStream — Pre-Stream ZK Vault Bridge, Turn Mutations & Persistent Hunks (Wave 5.2)", () => {
  let userId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    sessionKeyStore.purgeKeys(false);

    userId = `user-w52-${Math.random().toString(36).slice(2, 10)}`;
    mockResolveInitialClientUserIdSync.mockReturnValue(userId);
    mockGetUserFiles.mockResolvedValue({ success: true, data: [] });
    mockGetFile.mockResolvedValue({ success: false, data: null });
    mockToggleFileEncryption.mockResolvedValue({
      success: true,
      version: 2,
      etag: "etag-encrypted-v2",
    });
    mockListWorkspacesRpc.mockResolvedValue({
      success: true,
      data: [buildWorkspace(VALID_WS_UUID, userId)],
    });

    await indexedDBManager.init(userId);
  });

  afterEach(async () => {
    cleanup();
    sessionKeyStore.purgeKeys(false);
    await indexedDBManager.deleteDatabase();
  });

  it("transmits valid UUID workspaceId on wire when explicitly configured and omits workspaceId when only legacy projectId is supplied", async () => {
    const capturedPayloads: Array<Record<string, unknown>> = [];
    mockConsumeAgentStream.mockImplementation(async (opts: StreamHandlerOptions) => {
      capturedPayloads.push((opts.payload ?? {}) as Record<string, unknown>);
      opts.onStart?.({
        type: "start",
        sessionId: "s-ws-uuid",
        threadId: opts.payload?.threadId ?? "t-1",
        operationId: "op-1",
      });
      opts.onDone?.({
        type: "done",
        threadId: opts.payload?.threadId ?? "t-1",
        operationId: "op-1",
      });
    });

    const { editor } = createInMemoryEditor("# Doc");

    // 1. Valid UUID workspaceId -> included on wire
    const uuidHook = renderHook(() =>
      useAIStream({
        fileId: "file-1",
        workspaceId: VALID_WS_UUID,
        userId,
        editor,
      }),
    );
    await act(async () => {
      await uuidHook.result.current.startAgentSession("Audit schema");
    });
    expect(capturedPayloads[0].workspaceId).toBe(VALID_WS_UUID);
    expect(typeof capturedPayloads[0].turnId).toBe("string");
    uuidHook.unmount();

    // 2. Non-UUID legacy projectId -> workspaceId MUST be omitted from wire
    const legacyHook = renderHook(() =>
      useAIStream({
        fileId: "file-1",
        projectId: "legacy-non-uuid-project",
        userId,
        editor,
      }),
    );
    await act(async () => {
      await legacyHook.result.current.startAgentSession("Audit legacy");
    });
    expect("workspaceId" in capturedPayloads[1]).toBe(false);
    expect(capturedPayloads[1].projectId).toBe("legacy-non-uuid-project");
  });

  it("decrypts open, closed IDB, remote closed, and decisions.ledger.json encrypted files into ephemeralVaultPayloads while excluding isAiExcluded/deleted/cross-workspace files, and shows zkAiNotice only once", async () => {
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    sessionKeyStore.setMasterKey(masterKey);

    const encClosedIdb = await SyncCryptoGateway.encryptOutbound(
      "file-closed-idb",
      "# Closed Local Doc",
      userId,
    );
    const encClosedRemote = await SyncCryptoGateway.encryptOutbound(
      "file-closed-remote",
      "# Closed Remote Doc",
      userId,
    );
    const encLedger = await SyncCryptoGateway.encryptOutbound(
      "file-ledger",
      '{"schemaVersion":"2.0.0","nodes":{"d1":{}}}',
      userId,
    );
    const encExcluded = await SyncCryptoGateway.encryptOutbound(
      "file-excluded",
      "# Secret Excluded From AI",
      userId,
    );
    const encOtherWs = await SyncCryptoGateway.encryptOutbound(
      "file-other-ws",
      "# Other Workspace Doc",
      userId,
    );
    const encLocalExcluded = await SyncCryptoGateway.encryptOutbound(
      "file-local-excluded",
      "# Local IDB Excluded Doc",
      userId,
    );
    const encLocalOtherWs = await SyncCryptoGateway.encryptOutbound(
      "file-local-other-ws",
      "# Local IDB Other Workspace Doc",
      userId,
    );

    // Seed closed encrypted files in real IndexedDB (including local-only excluded & cross-workspace isolation checks)
    await indexedDBManager.saveFile(
      {
        id: "file-closed-idb",
        title: "closed-local.md",
        content: encClosedIdb.ciphertextBase64,
        etag: "etag-c1",
        version: 1,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: true,
        encryptionMetadata: encClosedIdb.encryptionMetadata,
        workspaceId: VALID_WS_UUID,
        isAiExcluded: false,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );
    await indexedDBManager.saveFile(
      {
        id: "file-local-excluded",
        title: "local-excluded.md",
        content: encLocalExcluded.ciphertextBase64,
        etag: "etag-le1",
        version: 1,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: true,
        encryptionMetadata: encLocalExcluded.encryptionMetadata,
        workspaceId: VALID_WS_UUID,
        isAiExcluded: true,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );
    await indexedDBManager.saveFile(
      {
        id: "file-local-other-ws",
        title: "local-other-ws.md",
        content: encLocalOtherWs.ciphertextBase64,
        etag: "etag-lo1",
        version: 1,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: true,
        encryptionMetadata: encLocalOtherWs.encryptionMetadata,
        workspaceId: OTHER_WS_UUID,
        isAiExcluded: false,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    mockGetUserFiles.mockResolvedValue({
      success: true,
      data: [
        buildRemoteFile({
          id: "file-closed-remote",
          workspaceId: VALID_WS_UUID,
          userId,
          isEncrypted: true,
          content: null, // forces lazy getFile hydration
        }),
        buildRemoteFile({
          id: "file-ledger",
          workspaceId: VALID_WS_UUID,
          userId,
          title: "decisions.ledger.json",
          artifactRole: "decision_ledger",
          isEncrypted: true,
          content: encLedger.ciphertextBase64,
          encryptionMetadata: encLedger.encryptionMetadata,
        }),
        buildRemoteFile({
          id: "file-excluded",
          workspaceId: VALID_WS_UUID,
          userId,
          isEncrypted: true,
          isAiExcluded: true,
          content: encExcluded.ciphertextBase64,
          encryptionMetadata: encExcluded.encryptionMetadata,
        }),
        buildRemoteFile({
          id: "file-deleted",
          workspaceId: VALID_WS_UUID,
          userId,
          isEncrypted: true,
          deletedAt: "2026-01-02T00:00:00.000Z",
          content: encExcluded.ciphertextBase64,
          encryptionMetadata: encExcluded.encryptionMetadata,
        }),
        buildRemoteFile({
          id: "file-other-ws",
          workspaceId: OTHER_WS_UUID,
          userId,
          isEncrypted: true,
          content: encOtherWs.ciphertextBase64,
          encryptionMetadata: encOtherWs.encryptionMetadata,
        }),
      ],
    });

    mockGetFile.mockResolvedValue({
      success: true,
      data: buildRemoteFile({
        id: "file-closed-remote",
        workspaceId: VALID_WS_UUID,
        userId,
        isEncrypted: true,
        content: encClosedRemote.ciphertextBase64,
        encryptionMetadata: encClosedRemote.encryptionMetadata,
      }),
    });

    const capturedVaultPayloads: Array<Record<string, string> | undefined> = [];
    mockConsumeAgentStream.mockImplementation(async (opts: StreamHandlerOptions) => {
      capturedVaultPayloads.push(opts.payload?.ephemeralVaultPayloads);
      opts.onStart?.({
        type: "start",
        sessionId: `s-zk-${capturedVaultPayloads.length}`,
        threadId: "t-zk",
        operationId: `op-zk-${capturedVaultPayloads.length}`,
      });
      opts.onDone?.({
        type: "done",
        threadId: "t-zk",
        operationId: `op-zk-${capturedVaultPayloads.length}`,
      });
    });

    const onVaultAiNotice = vi.fn();
    const { editor } = createInMemoryEditor("# Active Open Encrypted Doc");

    const { result } = renderHook(() =>
      useAIStream({
        fileId: "file-active-open",
        workspaceId: VALID_WS_UUID,
        userId,
        editor,
        isEncrypted: true,
        allowAIOnEncryptedFiles: true,
        onVaultAiNotice,
      }),
    );

    await act(async () => {
      await result.current.startAgentSession("Analyze encrypted workspace");
    });

    expect(capturedVaultPayloads[0]).toEqual({
      "file-active-open": "# Active Open Encrypted Doc",
      "file-closed-idb": "# Closed Local Doc",
      "file-closed-remote": "# Closed Remote Doc",
      "file-ledger": '{"schemaVersion":"2.0.0","nodes":{"d1":{}}}',
    });
    expect(result.current.zkAiNotice).toMatch(/decrypted transiently in memory/i);
    expect(onVaultAiNotice).toHaveBeenCalledTimes(1);

    // Second invocation MUST NOT re-trigger the one-time notice
    await act(async () => {
      await result.current.startAgentSession("Second analysis");
    });
    expect(onVaultAiNotice).toHaveBeenCalledTimes(1);
  });

  it("handles vault_file_commit_required by recording turn-linked IDBOperation, encrypting via SyncCryptoGateway, storing ciphertext-only in IDB (LUGX-004), and syncing active editor", async () => {
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    sessionKeyStore.setMasterKey(masterKey);

    const initialEnc = await SyncCryptoGateway.encryptOutbound(
      "file-zk-active",
      "# Old Secret Draft",
      userId,
    );
    await indexedDBManager.saveFile(
      {
        id: "file-zk-active",
        title: "secret.md",
        content: initialEnc.ciphertextBase64,
        etag: "etag-zk-v1",
        version: 3,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: true,
        encryptionMetadata: initialEnc.encryptionMetadata,
        localRevision: 4,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    mockToggleFileEncryption.mockResolvedValue({
      success: true,
      version: 4,
      etag: "etag-zk-v4",
    });

    let capturedOpts: StreamHandlerOptions | null = null;
    let capturedTurnId = "";
    mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
      capturedOpts = opts;
      capturedTurnId = opts.payload?.turnId ?? "";
      opts.onStart?.({
        type: "start",
        sessionId: "s-vault-commit",
        threadId: opts.payload?.threadId ?? "t-vc",
        operationId: "op-vc",
      });
    });

    const { editor, getContent, setValueCalls } = createInMemoryEditor("# Old Secret Draft");
    const programmaticWraps = vi.fn((fn: () => void) => fn());

    const { result } = renderHook(() =>
      useAIStream({
        fileId: "file-zk-active",
        workspaceId: VALID_WS_UUID,
        userId,
        editor,
        isEncrypted: true,
        allowAIOnEncryptedFiles: true,
        onProgrammaticTransaction: programmaticWraps,
      }),
    );

    await act(async () => {
      await result.current.startAgentSession("Rewrite secret architecture");
    });

    await act(async () => {
      await capturedOpts?.onVaultFileCommitRequired?.({
        type: "vault_file_commit_required",
        fileId: "file-zk-active",
        relativePath: "secret.md",
        mergedContent: "# Merged Confidential Architecture v4",
      });
    });

    // 1. Outbound RPC received genuine AES-GCM ciphertext that decrypts to mergedContent
    expect(mockToggleFileEncryption).toHaveBeenCalledTimes(1);
    const [fid, isEncFlag, cipherB64, encMeta, optsArg] =
      mockToggleFileEncryption.mock.calls[0];
    expect(fid).toBe("file-zk-active");
    expect(isEncFlag).toBe(true);
    expect(optsArg).toEqual({ expectedVersion: 3 });
    expect(cipherB64).not.toContain("Merged Confidential Architecture v4");

    const decryptedVerify = await SyncCryptoGateway.decryptInbound({
      fileId: "file-zk-active",
      content: cipherB64,
      isEncrypted: true,
      encryptionMetadata: encMeta,
      userId,
    });
    expect(decryptedVerify.status).toBe("decrypted");
    expect(decryptedVerify.content).toBe("# Merged Confidential Architecture v4");

    // 2. LUGX-004: IDBFile stores ONLY ciphertext (NEVER plaintext)
    const savedIdbFile = await indexedDBManager.getFile("file-zk-active", userId);
    expect(savedIdbFile?.isEncrypted).toBe(true);
    expect(savedIdbFile?.content).toBe(cipherB64);
    expect(savedIdbFile?.content).not.toContain("Merged Confidential Architecture v4");
    expect(savedIdbFile?.etag).toBe("etag-zk-v4");
    expect(savedIdbFile?.version).toBe(4);
    expect(savedIdbFile?.isDirty).toBe(false);

    // 3. Turn-linked IDBOperation stored under (workspaceId, turnId) with pre-turn snapshot & all 7 concurrency/retry fields
    const turnOps = await indexedDBManager.getOperationsByWorkspaceTurn(
      VALID_WS_UUID,
      capturedTurnId,
    );
    expect(turnOps).toHaveLength(1);
    expect(turnOps[0]).toMatchObject({
      workspaceId: VALID_WS_UUID,
      turnId: capturedTurnId,
      fileId: "file-zk-active",
      operationType: "update",
      postTurnEtag: "etag-zk-v4",
      baseVersion: 3,
      localRevision: 5,
      sentRevision: 4,
      status: "synced",
      attempts: 0,
      nextRetryAt: 0,
      synced: true,
      isEncrypted: true,
      snapshot: {
        content: initialEnc.ciphertextBase64,
        etag: "etag-zk-v1",
        version: 3,
      },
    });

    // 4. Active editor view updated programmatically with plaintext & turn recorded
    expect(programmaticWraps).toHaveBeenCalled();
    expect(getContent()).toBe("# Merged Confidential Architecture v4");
    expect(setValueCalls[setValueCalls.length - 1]).toEqual({
      content: "# Merged Confidential Architecture v4",
      origin: "agent.mutation",
    });
    expect(result.current.mutatedTurns).toHaveLength(1);
    expect(result.current.mutatedTurns[0].mutatedFiles[0]).toMatchObject({
      fileId: "file-zk-active",
      action: "updated",
      postTurnEtag: "etag-zk-v4",
    });
  });

  it("handles file_mutated (updated, created, deleted) by recording turn-linked IDBOperations with true postTurnEtag and syncing active plaintext editor", async () => {
    await indexedDBManager.saveFile(
      {
        id: "file-plain-active",
        title: "spec.md",
        content: "# Spec v1",
        etag: "etag-spec-v1",
        version: 1,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: false,
        encryptionMetadata: null,
        localRevision: 2,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    mockGetFile.mockImplementation(async (fid: string) => {
      if (fid === "file-plain-active") {
        return {
          success: true,
          data: buildRemoteFile({
            id: "file-plain-active",
            title: "spec.md",
            content: "# Spec v2 (Server Auto-Applied)",
            etag: "etag-spec-v2",
            version: 2,
            isEncrypted: false,
          }),
        };
      }
      if (fid === "file-new-created") {
        return {
          success: true,
          data: buildRemoteFile({
            id: "file-new-created",
            title: "new-adr.md",
            content: "# ADR-017",
            etag: "etag-new-v1",
            version: 1,
            isEncrypted: false,
          }),
        };
      }
      return { success: false, data: null };
    });

    let capturedOpts: StreamHandlerOptions | null = null;
    let capturedTurnId = "";
    mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
      capturedOpts = opts;
      capturedTurnId = opts.payload?.turnId ?? "";
      opts.onStart?.({
        type: "start",
        sessionId: "s-file-mut",
        threadId: opts.payload?.threadId ?? "t-fm",
        operationId: "op-fm",
      });
    });

    const { editor, getContent, setValueCalls } = createInMemoryEditor("# Spec v1");

    const { result } = renderHook(() =>
      useAIStream({
        fileId: "file-plain-active",
        workspaceId: VALID_WS_UUID,
        userId,
        editor,
      }),
    );

    await act(async () => {
      await result.current.startAgentSession("Apply full_auto workspace updates");
    });

    await act(async () => {
      await capturedOpts?.onFileMutated?.({
        type: "file_mutated",
        fileId: "file-plain-active",
        relativePath: "spec.md",
        action: "updated",
      });
      await capturedOpts?.onFileMutated?.({
        type: "file_mutated",
        fileId: "file-new-created",
        relativePath: "docs/new-adr.md",
        action: "created",
      });
      await capturedOpts?.onFileMutated?.({
        type: "file_mutated",
        fileId: "file-old-deleted",
        relativePath: "docs/obsolete.md",
        action: "deleted",
      });
    });

    const turnOps = await indexedDBManager.getOperationsByWorkspaceTurn(
      VALID_WS_UUID,
      capturedTurnId,
    );
    expect(turnOps).toHaveLength(3);

    const updateOp = turnOps.find((o) => o.fileId === "file-plain-active");
    expect(updateOp).toMatchObject({
      operationType: "update",
      postTurnEtag: "etag-spec-v2",
      baseVersion: 1,
      localRevision: 3,
      sentRevision: 2,
      status: "synced",
      attempts: 0,
      nextRetryAt: 0,
      snapshot: {
        content: "# Spec v1",
        etag: "etag-spec-v1",
        version: 1,
      },
    });
    expect(turnOps.find((o) => o.fileId === "file-new-created")?.operationType).toBe("create");
    expect(turnOps.find((o) => o.fileId === "file-old-deleted")?.operationType).toBe("delete");

    // Active non-encrypted editor & IDB synced to new content
    expect(getContent()).toBe("# Spec v2 (Server Auto-Applied)");
    expect(setValueCalls[setValueCalls.length - 1]).toEqual({
      content: "# Spec v2 (Server Auto-Applied)",
      origin: "agent.mutation",
    });
    const idbUpdated = await indexedDBManager.getFile("file-plain-active", userId);
    expect(idbUpdated?.content).toBe("# Spec v2 (Server Auto-Applied)");
    expect(idbUpdated?.etag).toBe("etag-spec-v2");

    expect(result.current.mutatedTurns[0].mutatedFiles).toHaveLength(3);
  });

  it("persists non-active-file ghost_hunk_proposed into IndexedDB without polluting activeGhostHunks, then hydrates on tab switch", async () => {
    let capturedOpts: StreamHandlerOptions | null = null;
    mockConsumeAgentStream.mockImplementationOnce(async (opts: StreamHandlerOptions) => {
      capturedOpts = opts;
      opts.onStart?.({
        type: "start",
        sessionId: "s-persist-hunks",
        threadId: "t-ph",
        operationId: "op-ph",
      });
    });

    const editorA = createInMemoryEditor("# File A\n\nBody A.");
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WorkspaceTabsProvider>{children}</WorkspaceTabsProvider>
    );

    const hookA = renderHook(
      () =>
        useAIStream({
          fileId: "file-a",
          workspaceId: VALID_WS_UUID,
          userId,
          editor: editorA.editor,
        }),
      { wrapper },
    );

    await act(async () => {
      await hookA.result.current.startAgentSession("Propose multi-file hunks");
    });

    // Propose hunk for non-active file-b: activeGhostHunks MUST remain empty, status running_graph,
    // and raw server numeric offsets (42..88) MUST be preserved rather than clamped to 0..0.
    act(() => {
      capturedOpts?.onGhostHunkProposed?.({
        type: "ghost_hunk_proposed",
        fileId: "file-b",
        headingSlug: "security",
        hunks: [
          {
            hunkId: "hunk-file-b-1",
            from: 42,
            to: 88,
            replacementText: "# Security Updated",
          },
        ],
      });
    });

    expect(hookA.result.current.activeGhostHunks).toHaveLength(0);
    expect(hookA.result.current.status).toBe("running_graph");
    expect(hookA.result.current.ghostHunksByFileId["file-b"]).toHaveLength(1);
    expect(hookA.result.current.ghostHunksByFileId["file-b"][0]).toMatchObject({
      hunkId: "hunk-file-b-1",
      from: 42,
      to: 88,
    });

    // Verify persisted in IndexedDB under pending_ghost_hunks_${VALID_WS_UUID} with offsets intact
    await waitFor(async () => {
      const persisted = await indexedDBManager.loadPendingGhostHunks(VALID_WS_UUID);
      expect(persisted?.ghostHunksByFileId["file-b"]).toHaveLength(1);
      expect(persisted?.ghostHunksByFileId["file-b"][0]).toMatchObject({
        hunkId: "hunk-file-b-1",
        from: 42,
        to: 88,
      });
    });

    hookA.unmount();

    // Opening file-b in a new hook loads from IDB and hydrates directly into editorB
    const editorB = createInMemoryEditor("# Security\n\nOld text");
    const hookB = renderHook(
      () =>
        useAIStream({
          fileId: "file-b",
          workspaceId: VALID_WS_UUID,
          userId,
          editor: editorB.editor,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(hookB.result.current.ghostHunksByFileId["file-b"]).toHaveLength(1);
    });

    act(() => {
      hookB.result.current.hydrateGhostHunksForFile("file-b", editorB.editor);
    });

    expect(hookB.result.current.activeGhostHunks).toHaveLength(1);
    expect(hookB.result.current.activeGhostHunks[0].hunkId).toBe("hunk-file-b-1");
    expect(hookB.result.current.status).toBe("preview_ready");
    expect(editorB.editor.startGhostSession).toHaveBeenCalledTimes(1);
  });
});
