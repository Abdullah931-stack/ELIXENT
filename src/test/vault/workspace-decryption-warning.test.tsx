// @vitest-environment jsdom
/**
 * Phase 5 (Wave 5.1) — Workspace-Wide Decryption Confirmation Guard (`REQ-ZK-02`)
 *
 * Cross-Contract Verification:
 * - `src/components/vault/workspace-decryption-warning-modal.tsx`
 * - `src/components/files/file-context-menu.tsx` (single-file decrypt interception when `workspace.isEncrypted === true`)
 * - Real WebCrypto (`SyncCryptoGateway`) + real `sessionKeyStore` + real `IndexedDBManager` (`fake-indexeddb/auto`)
 *
 * Specification: SRS-02 §4.1 (`REQ-ZK-02`).
 */

import "fake-indexeddb/auto";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FileRecord, WorkspaceRecord } from "@/types/rpc-contracts";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";
import { indexedDBManager } from "@/lib/sync/indexeddb";

const {
  mockGetUserFiles,
  mockGetFile,
  mockDecryptEntireWorkspaceRpc,
  mockToggleFileEncryption,
  mockListWorkspacesRpc,
  mockResolveInitialClientUserIdSync,
  mockResolveLocalFirstAuthUser,
} = vi.hoisted(() => ({
  mockGetUserFiles: vi.fn(),
  mockGetFile: vi.fn(),
  mockDecryptEntireWorkspaceRpc: vi.fn(),
  mockToggleFileEncryption: vi.fn(),
  mockListWorkspacesRpc: vi.fn(),
  mockResolveInitialClientUserIdSync: vi.fn(),
  mockResolveLocalFirstAuthUser: vi.fn(),
}));

// Mock only the external HTTP/RPC & auth identity boundaries; crypto and IndexedDB are real.
vi.mock("@/client/rpc-client", () => ({
  getUserFiles: (...args: unknown[]) => mockGetUserFiles(...args),
  getFile: (...args: unknown[]) => mockGetFile(...args),
  decryptEntireWorkspaceRpc: (...args: unknown[]) =>
    mockDecryptEntireWorkspaceRpc(...args),
  toggleFileEncryption: (...args: unknown[]) =>
    mockToggleFileEncryption(...args),
  listWorkspacesRpc: (...args: unknown[]) => mockListWorkspacesRpc(...args),
  deleteFile: vi.fn(),
  restoreWorkspaceFileRpc: vi.fn(),
  renameFile: vi.fn(),
  copyFile: vi.fn(),
  moveFile: vi.fn(),
  getUserVaultProfile: vi.fn().mockResolvedValue({ success: false, data: null }),
  updateFileContent: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/auth/client-identity", () => ({
  resolveInitialClientUserIdSync: () => mockResolveInitialClientUserIdSync(),
  resolveLocalFirstAuthUser: (...args: unknown[]) =>
    mockResolveLocalFirstAuthUser(...args),
}));

vi.mock("@/client/navigation", () => ({
  navigateTo: vi.fn(),
}));

import { WorkspaceDecryptionWarningModal } from "@/components/vault/workspace-decryption-warning-modal";
import { FileContextMenu } from "@/components/files/file-context-menu";
import {
  WorkspaceTabsProvider,
  useWorkspaceTabs,
} from "@/components/editor/workspace-tab-bar";

const MANDATORY_REQ_ZK_02_COPY =
  "Decrypting any file inside an encrypted workspace requires decrypting the entire workspace and all of its files. Do you want to proceed?";

function buildFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: overrides.id ?? "file-1",
    userId: overrides.userId ?? "user-zk-1",
    workspaceId: overrides.workspaceId ?? "ws-encrypted-1",
    title: overrides.title ?? "secret.md",
    content: overrides.content ?? null,
    parentFolderId: overrides.parentFolderId ?? null,
    isFolder: overrides.isFolder ?? false,
    isAiExcluded: overrides.isAiExcluded ?? false,
    artifactRole: overrides.artifactRole ?? "document",
    isEncrypted: overrides.isEncrypted ?? true,
    encryptionMetadata: overrides.encryptionMetadata ?? null,
    etag: overrides.etag ?? "etag-1",
    version: overrides.version ?? 1,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function buildWorkspaceRecord(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id: overrides.id ?? "ws-encrypted-1",
    userId: overrides.userId ?? "user-zk-1",
    name: overrides.name ?? "Encrypted Vault Workspace",
    description: overrides.description ?? null,
    isEncrypted: overrides.isEncrypted ?? true,
    defaultPermissionMode: overrides.defaultPermissionMode ?? "safe",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("WorkspaceDecryptionWarningModal & FileContextMenu REQ-ZK-02 Guard (Wave 5.1)", () => {
  let userId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    sessionKeyStore.purgeKeys(false);

    userId = `user-zk-${Math.random().toString(36).slice(2, 10)}`;
    mockResolveInitialClientUserIdSync.mockReturnValue(userId);
    mockResolveLocalFirstAuthUser.mockResolvedValue({ id: userId });
    mockListWorkspacesRpc.mockResolvedValue({
      success: true,
      data: [buildWorkspaceRecord({ id: "ws-encrypted-1", userId, isEncrypted: true })],
    });
    mockDecryptEntireWorkspaceRpc.mockResolvedValue({
      success: true,
      data: buildWorkspaceRecord({ id: "ws-encrypted-1", userId, isEncrypted: false }),
    });
    mockToggleFileEncryption.mockResolvedValue({
      success: true,
      version: 2,
      etag: "etag-decrypted",
    });

    await indexedDBManager.init(userId);
  });

  afterEach(async () => {
    cleanup();
    sessionKeyStore.purgeKeys(false);
    await indexedDBManager.deleteDatabase();
  });

  it("displays exact REQ-ZK-02 copy and cancels cleanly without invoking decryptEntireWorkspaceRpc", () => {
    const onClose = vi.fn();

    render(
      <WorkspaceDecryptionWarningModal
        isOpen={true}
        onClose={onClose}
        workspaceId="ws-encrypted-1"
        userId={userId}
      />,
    );

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText(MANDATORY_REQ_ZK_02_COPY)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockDecryptEntireWorkspaceRpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "vault is locked",
      workspaceId: "ws-encrypted-1",
      unlockVault: false,
      expectedAlert: /Vault is locked/i,
    },
    {
      label: "workspaceId is missing",
      workspaceId: "",
      unlockVault: true,
      expectedAlert: /Workspace identifier is missing/i,
    },
  ])(
    "fails closed with an alert and skips RPC when $label",
    async ({ workspaceId, unlockVault, expectedAlert }) => {
      if (unlockVault) {
        const key = new Uint8Array(32);
        crypto.getRandomValues(key);
        sessionKeyStore.setMasterKey(key);
      }

      const onSuccess = vi.fn();
      const onClose = vi.fn();

      render(
        <WorkspaceDecryptionWarningModal
          isOpen={true}
          onClose={onClose}
          workspaceId={workspaceId}
          userId={userId}
          onSuccess={onSuccess}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Decrypt Workspace" }));

      const alertEl = await screen.findByRole("alert");
      expect(alertEl.textContent).toMatch(expectedAlert);
      expect(mockDecryptEntireWorkspaceRpc).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("decrypts only active encrypted non-folder files in the target workspace via real WebCrypto, pushes batch payload, and updates local IDB", async () => {
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    sessionKeyStore.setMasterKey(masterKey);

    // Encrypt two files in ws-encrypted-1 using real SyncCryptoGateway
    const encInline = await SyncCryptoGateway.encryptOutbound(
      "file-inline",
      "# Architecture Spec (Inline)",
      userId,
    );
    const encLazy = await SyncCryptoGateway.encryptOutbound(
      "file-lazy",
      '{"schemaVersion":"2.0.0","nodes":{}}',
      userId,
    );
    const encOtherWs = await SyncCryptoGateway.encryptOutbound(
      "file-other-ws",
      "Belongs to another workspace",
      userId,
    );

    // Seed local IndexedDB encrypted cache for file-inline
    await indexedDBManager.saveFile(
      {
        id: "file-inline",
        title: "arch.md",
        content: encInline.ciphertextBase64,
        etag: "etag-inline-v2",
        version: 2,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: true,
        encryptionMetadata: encInline.encryptionMetadata,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    mockGetUserFiles.mockResolvedValue({
      success: true,
      data: [
        // 1. Target workspace encrypted file with inline ciphertext
        buildFileRecord({
          id: "file-inline",
          workspaceId: "ws-encrypted-1",
          userId,
          title: "arch.md",
          content: encInline.ciphertextBase64,
          encryptionMetadata: encInline.encryptionMetadata,
          version: 2,
          etag: "etag-inline-v2",
          isEncrypted: true,
        }),
        // 2. Target workspace encrypted file requiring lazy hydration via getFile()
        buildFileRecord({
          id: "file-lazy",
          workspaceId: "ws-encrypted-1",
          userId,
          title: "decisions.ledger.json",
          artifactRole: "decision_ledger",
          content: null,
          encryptionMetadata: null,
          version: 5,
          etag: "etag-lazy-v5",
          isEncrypted: true,
        }),
        // 3. Excluded: encrypted file in a DIFFERENT workspace
        buildFileRecord({
          id: "file-other-ws",
          workspaceId: "ws-other",
          userId,
          title: "other.md",
          content: encOtherWs.ciphertextBase64,
          encryptionMetadata: encOtherWs.encryptionMetadata,
          isEncrypted: true,
        }),
        // 4. Excluded: soft-deleted tombstone in target workspace
        buildFileRecord({
          id: "file-deleted",
          workspaceId: "ws-encrypted-1",
          userId,
          title: "deleted.md",
          content: encInline.ciphertextBase64,
          encryptionMetadata: encInline.encryptionMetadata,
          isEncrypted: true,
          deletedAt: "2026-01-02T00:00:00.000Z",
        }),
        // 5. Excluded: folder & already-plaintext file
        buildFileRecord({
          id: "folder-1",
          workspaceId: "ws-encrypted-1",
          userId,
          title: "Specs",
          isFolder: true,
          isEncrypted: true,
        }),
        buildFileRecord({
          id: "file-already-plain",
          workspaceId: "ws-encrypted-1",
          userId,
          title: "notes.md",
          content: "already plain",
          isEncrypted: false,
        }),
      ],
    });

    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: "file-lazy",
        workspaceId: "ws-encrypted-1",
        userId,
        title: "decisions.ledger.json",
        content: encLazy.ciphertextBase64,
        encryptionMetadata: encLazy.encryptionMetadata,
        version: 5,
        etag: "etag-lazy-v5",
        isEncrypted: true,
      }),
    });

    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <WorkspaceDecryptionWarningModal
        isOpen={true}
        onClose={onClose}
        workspaceId="ws-encrypted-1"
        userId={userId}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Decrypt Workspace" }));

    await waitFor(() => {
      expect(mockDecryptEntireWorkspaceRpc).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    expect(mockDecryptEntireWorkspaceRpc).toHaveBeenCalledWith("ws-encrypted-1", [
      {
        fileId: "file-inline",
        content: "# Architecture Spec (Inline)",
        expectedVersion: 2,
        expectedETag: "etag-inline-v2",
      },
      {
        fileId: "file-lazy",
        content: '{"schemaVersion":"2.0.0","nodes":{}}',
        expectedVersion: 5,
        expectedETag: "etag-lazy-v5",
      },
    ]);

    // Local IDB record updated to plaintext with cleared encryption metadata
    const localAfter = await indexedDBManager.getFile("file-inline", userId);
    expect(localAfter).toMatchObject({
      content: "# Architecture Spec (Inline)",
      isEncrypted: false,
      encryptionMetadata: null,
      isDirty: false,
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces RPC failure in role='alert' without closing modal or invoking onSuccess", async () => {
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    sessionKeyStore.setMasterKey(masterKey);

    mockGetUserFiles.mockResolvedValue({ success: true, data: [] });
    mockDecryptEntireWorkspaceRpc.mockResolvedValue({
      success: false,
      error: "OCC conflict while decrypting workspace",
    });

    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <WorkspaceDecryptionWarningModal
        isOpen={true}
        onClose={onClose}
        workspaceId="ws-encrypted-1"
        userId={userId}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Decrypt Workspace" }));

    const alertEl = await screen.findByRole("alert");
    expect(alertEl.textContent).toContain(
      "OCC conflict while decrypting workspace",
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("FileContextMenu intercepts single-file decrypt inside an encrypted workspace and opens WorkspaceDecryptionWarningModal instead of calling toggleFileEncryption", async () => {
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    sessionKeyStore.setMasterKey(masterKey);

    let hydratedEncrypted = false;
    function WorkspaceReadyProbe() {
      const { activeWorkspace } = useWorkspaceTabs();
      hydratedEncrypted = Boolean(activeWorkspace?.isEncrypted);
      return null;
    }

    render(
      <WorkspaceTabsProvider>
        <WorkspaceReadyProbe />
        <FileContextMenu
          isOpen={true}
          onClose={vi.fn()}
          fileId="file-in-enc-ws"
          fileName="secret.md"
          isFolder={false}
          isEncrypted={true}
          userId={userId}
        />
      </WorkspaceTabsProvider>,
    );

    // Wait for WorkspaceTabsProvider to finish resolving activeWorkspace (isEncrypted: true)
    await waitFor(() => {
      expect(hydratedEncrypted).toBe(true);
    });

    fireEvent.click(screen.getByText("فك تشفير الملف"));

    // Must open REQ-ZK-02 warning modal and NEVER call single-file toggleFileEncryption
    expect(await screen.findByText(MANDATORY_REQ_ZK_02_COPY)).toBeDefined();
    expect(mockToggleFileEncryption).not.toHaveBeenCalled();
  });

  it("FileContextMenu allows selective single-file decrypt inside an unencrypted workspace without opening WorkspaceDecryptionWarningModal", async () => {
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    sessionKeyStore.setMasterKey(masterKey);

    const encrypted = await SyncCryptoGateway.encryptOutbound(
      "file-selective",
      "Selective plaintext content",
      userId,
    );
    await indexedDBManager.saveFile(
      {
        id: "file-selective",
        title: "selective.md",
        content: encrypted.ciphertextBase64,
        etag: "etag-sel-1",
        version: 1,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: true,
        encryptionMetadata: encrypted.encryptionMetadata,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    const onRefresh = vi.fn();
    const onClose = vi.fn();

    render(
      <FileContextMenu
        isOpen={true}
        onClose={onClose}
        fileId="file-selective"
        fileName="selective.md"
        isFolder={false}
        isEncrypted={true}
        isWorkspaceEncrypted={false}
        workspaceId="ws-plain"
        userId={userId}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByText("فك تشفير الملف"));

    await waitFor(() => {
      expect(mockToggleFileEncryption).toHaveBeenCalledWith(
        "file-selective",
        false,
        "Selective plaintext content",
        null,
        { expectedVersion: 1, expectedETag: "etag-sel-1" },
      );
    });
    expect(screen.queryByText(MANDATORY_REQ_ZK_02_COPY)).toBeNull();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
