// @vitest-environment jsdom
/**
 * Phase 5 (Wave 5.2) — `INV-UNDO-SYNC` Editor State Resync, Stale-ETag Guard
 * & `AgentChatPanel` Revert Turn / Revert Session Controls
 *
 * Cross-Contract Verification:
 * - Real `useEditorOrchestrator` + Real `IndexedDBManager` (`fake-indexeddb/auto`)
 * - Real `syncRollback` (`SyncRollback.rollbackAgentTurn`) + Real `SyncCryptoGateway`
 * - Real `WorkspaceTabsProvider` + Real `AgentChatPanel`
 * - External boundaries only (`@/client/rpc-client`, `@/lib/ai/stream-handler`,
 *   `@/lib/supabase/client`, `@/client/navigation`) mocked.
 *
 * Specifications: SRS-03 §5.2 (`REQ-UNDO-02..04` & `INV-UNDO-SYNC`).
 */

import "fake-indexeddb/auto";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { EditorAdapter } from "@/components/editor/markdown/types";
import type { StreamHandlerOptions } from "@/lib/ai/stream-handler";
import type { FileRecord, WorkspaceRecord } from "@/types/rpc-contracts";
import type { AgentMutatedTurn } from "@/hooks/use-ai-stream";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";

const {
  mockGetFile,
  mockUpdateFileContent,
  mockToggleFileEncryption,
  mockDeleteFile,
  mockRestoreWorkspaceFileRpc,
  mockRenameFile,
  mockGetUserVaultProfile,
  mockGetUserFiles,
  mockListWorkspacesRpc,
  mockConsumeAgentStream,
  mockResolveInitialClientUserIdSync,
} = vi.hoisted(() => ({
  mockGetFile: vi.fn(),
  mockUpdateFileContent: vi.fn(),
  mockToggleFileEncryption: vi.fn(),
  mockDeleteFile: vi.fn(),
  mockRestoreWorkspaceFileRpc: vi.fn(),
  mockRenameFile: vi.fn(),
  mockGetUserVaultProfile: vi.fn(),
  mockGetUserFiles: vi.fn(),
  mockListWorkspacesRpc: vi.fn(),
  mockConsumeAgentStream: vi.fn(),
  mockResolveInitialClientUserIdSync: vi.fn(),
}));

vi.mock("@/client/rpc-client", () => ({
  getFile: (...args: unknown[]) => mockGetFile(...args),
  updateFileContent: (...args: unknown[]) => mockUpdateFileContent(...args),
  toggleFileEncryption: (...args: unknown[]) => mockToggleFileEncryption(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  restoreWorkspaceFileRpc: (...args: unknown[]) => mockRestoreWorkspaceFileRpc(...args),
  renameFile: (...args: unknown[]) => mockRenameFile(...args),
  getUserVaultProfile: (...args: unknown[]) => mockGetUserVaultProfile(...args),
  getUserFiles: (...args: unknown[]) => mockGetUserFiles(...args),
  listWorkspacesRpc: (...args: unknown[]) => mockListWorkspacesRpc(...args),
}));

vi.mock("@/lib/ai/stream-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/stream-handler")>();
  return {
    ...actual,
    consumeAgentStream: (opts: StreamHandlerOptions) => mockConsumeAgentStream(opts),
  };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-undo-fallback" } } }),
    },
  }),
}));

vi.mock("@/client/navigation", () => ({
  navigateTo: vi.fn(),
}));

vi.mock("@/lib/auth/client-identity", () => ({
  resolveInitialClientUserIdSync: () => mockResolveInitialClientUserIdSync(),
}));

import { useEditorOrchestrator } from "@/hooks/use-editor-orchestrator";
import { WorkspaceTabsProvider } from "@/components/editor/workspace-tab-bar";
import { AgentChatPanel } from "@/components/agent/chat-panel";

const WS_UUID = "22222222-3333-4444-8555-666666666666";

function createControllableEditor(initialContent = "") {
  let content = initialContent;
  const setValueCalls: Array<{ content: string; origin?: string }> = [];

  const editor = {
    getValue: () => content,
    setValue: vi.fn((next: string, origin?: string) => {
      content = next;
      setValueCalls.push({ content: next, origin });
    }),
    getSelection: () => ({ from: 0, to: 0 }),
    setSelection: vi.fn(),
    setEditable: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    hasFocus: () => false,
    clearGhostSession: vi.fn(),
    clearStreamingGhost: vi.fn(),
    startGhostSession: vi.fn(),
    upsertGhostHunk: vi.fn(),
    getGhostHunks: () => [],
    acceptGhostHunk: vi.fn(),
    rejectGhostHunk: vi.fn(),
    acceptAllGhostHunks: vi.fn(),
  } as unknown as EditorAdapter;

  return { editor, getContent: () => content, setValueCalls };
}

function buildFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: overrides.id ?? "file-undo-1",
    userId: overrides.userId ?? "user-undo-1",
    workspaceId: overrides.workspaceId ?? WS_UUID,
    title: overrides.title ?? "architecture.md",
    content: overrides.content ?? "# Post-Turn Content",
    parentFolderId: null,
    isFolder: false,
    isAiExcluded: false,
    artifactRole: "document",
    isEncrypted: overrides.isEncrypted ?? false,
    encryptionMetadata: overrides.encryptionMetadata ?? null,
    etag: overrides.etag ?? "etag-v2",
    version: overrides.version ?? 2,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function buildWorkspace(userId: string): WorkspaceRecord {
  return {
    id: WS_UUID,
    userId,
    name: "Undo Sync Workspace",
    description: null,
    isEncrypted: false,
    defaultPermissionMode: "semi_auto",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("useEditorOrchestrator — INV-UNDO-SYNC & Stale-ETag Rollback Guards (Wave 5.2)", () => {
  let userId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    sessionKeyStore.purgeKeys(false);

    userId = `user-inv-${Math.random().toString(36).slice(2, 10)}`;
    mockResolveInitialClientUserIdSync.mockReturnValue(userId);
    mockGetUserVaultProfile.mockResolvedValue({ success: false, data: null });
    mockGetUserFiles.mockResolvedValue({ success: true, data: [] });
    mockListWorkspacesRpc.mockResolvedValue({
      success: true,
      data: [buildWorkspace(userId)],
    });
    mockUpdateFileContent.mockResolvedValue({
      success: true,
      version: 3,
      etag: "etag-v3",
    });
    mockDeleteFile.mockResolvedValue({ success: true });
    mockRestoreWorkspaceFileRpc.mockResolvedValue({ success: true });

    await indexedDBManager.init(userId);
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    sessionKeyStore.purgeKeys(false);
    await indexedDBManager.deleteDatabase();
  });

  it("enforces INV-UNDO-SYNC on handleRevertTurn: restores snapshot to active editor, cancels pending autosave, clears dirty state, and prevents autosave overwrite", async () => {
    const fileId = "file-undo-plain";
    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: fileId,
        userId,
        content: "# Post-Turn Agent Edit",
        etag: "etag-v2",
        version: 2,
      }),
    });

    await indexedDBManager.saveFile(
      {
        id: fileId,
        title: "architecture.md",
        content: "# Post-Turn Agent Edit",
        etag: "etag-v2",
        version: 2,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: false,
        encryptionMetadata: null,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    await indexedDBManager.addOperation({
      id: "op-turn-1",
      operationId: "op-turn-1",
      userId,
      workspaceId: WS_UUID,
      threadId: "thread-1",
      turnId: "turn-1",
      postTurnEtag: "etag-v2",
      fileId,
      operationType: "update",
      position: 0,
      content: "# Post-Turn Agent Edit",
      timestamp: 2000,
      synced: true,
      status: "synced",
      snapshot: {
        content: "# Pre-Turn Original Content",
        etag: "etag-v1",
        version: 1,
      },
    });

    const { editor, getContent, setValueCalls } = createControllableEditor();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WorkspaceTabsProvider>{children}</WorkspaceTabsProvider>
    );

    const { result } = renderHook(
      () =>
        useEditorOrchestrator({
          fileId,
          userId,
          projectId: WS_UUID,
          editor,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.hydration).toBe("ready");
    });

    // Trigger a dirty edit so an autosave debounce timer is actively queued
    act(() => {
      result.current.handleEditorChange("# Unsaved Local Typing Before Revert");
    });
    expect(result.current.isDirty).toBe(true);

    // Execute handleRevertTurn -> must cancel autosave, restore pre-turn snapshot, push revert to server, mark clean
    mockUpdateFileContent.mockClear();
    let reverted = false;
    await act(async () => {
      reverted = await result.current.handleRevertTurn("turn-1");
    });

    expect(reverted).toBe(true);
    expect(getContent()).toBe("# Pre-Turn Original Content");
    expect(result.current.content).toBe("# Pre-Turn Original Content");
    expect(result.current.isDirty).toBe(false);
    expect(setValueCalls[setValueCalls.length - 1]).toEqual({
      content: "# Pre-Turn Original Content",
      origin: "rollback",
    });

    // Rollback persists the restored snapshot to PostgreSQL once
    expect(mockUpdateFileContent).toHaveBeenCalledTimes(1);
    expect(mockUpdateFileContent).toHaveBeenCalledWith(
      fileId,
      "# Pre-Turn Original Content",
    );

    // Wait beyond the 1,000ms autosave debounce window to prove cancelled autosave NEVER overwrites reverted state
    await new Promise((r) => setTimeout(r, 1200));
    expect(mockUpdateFileContent).toHaveBeenCalledTimes(1);
  });

  it("prompts confirmation when currentFile.etag !== op.postTurnEtag, aborts when declined, and proceeds when confirmed", async () => {
    const fileId = "file-stale-check";
    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: fileId,
        userId,
        content: "# Newer Manual Edit",
        etag: "etag-v3-manual",
        version: 3,
      }),
    });

    await indexedDBManager.saveFile(
      {
        id: fileId,
        title: "stale.md",
        content: "# Newer Manual Edit",
        etag: "etag-v3-manual",
        version: 3,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: false,
        encryptionMetadata: null,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    await indexedDBManager.addOperation({
      id: "op-stale-1",
      operationId: "op-stale-1",
      userId,
      workspaceId: WS_UUID,
      threadId: "thread-stale",
      turnId: "turn-stale",
      postTurnEtag: "etag-v2-agent", // diverges from currentFile.etag ("etag-v3-manual")
      fileId,
      operationType: "update",
      position: 0,
      content: "# Agent Edit v2",
      timestamp: 2000,
      synced: true,
      status: "synced",
      snapshot: {
        content: "# Pre-Agent v1",
        etag: "etag-v1",
        version: 1,
      },
    });

    const confirmSpy = vi.spyOn(window, "confirm");
    const { editor, getContent } = createControllableEditor();

    const { result } = renderHook(() =>
      useEditorOrchestrator({
        fileId,
        userId,
        projectId: WS_UUID,
        editor,
      }),
    );

    await waitFor(() => expect(result.current.hydration).toBe("ready"));

    // 1. User declines stale-ETag confirmation -> aborts rollback, keeps newer manual content
    confirmSpy.mockReturnValueOnce(false);
    let declinedResult = true;
    await act(async () => {
      declinedResult = await result.current.handleRevertTurn("turn-stale");
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(declinedResult).toBe(false);
    expect(getContent()).toBe("# Newer Manual Edit");

    // 2. User confirms -> proceeds and restores # Pre-Agent v1
    confirmSpy.mockReturnValueOnce(true);
    let confirmedResult = false;
    await act(async () => {
      confirmedResult = await result.current.handleRevertTurn("turn-stale");
    });

    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(confirmedResult).toBe(true);
    expect(getContent()).toBe("# Pre-Agent v1");
    confirmSpy.mockRestore();
  });

  it("decrypts restored ciphertext into plaintext for active encrypted files and navigates to /workspace when reverting an active agent-created file", async () => {
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    sessionKeyStore.setMasterKey(masterKey);

    const encFileId = "file-enc-revert";
    const preEnc = await SyncCryptoGateway.encryptOutbound(
      encFileId,
      "# Original Encrypted Plaintext",
      userId,
    );
    const postEnc = await SyncCryptoGateway.encryptOutbound(
      encFileId,
      "# Agent Mutated Encrypted Plaintext",
      userId,
    );

    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: encFileId,
        userId,
        content: postEnc.ciphertextBase64,
        isEncrypted: true,
        encryptionMetadata: postEnc.encryptionMetadata,
        etag: "etag-enc-v2",
        version: 2,
      }),
    });

    await indexedDBManager.saveFile(
      {
        id: encFileId,
        title: "vault.md",
        content: postEnc.ciphertextBase64,
        etag: "etag-enc-v2",
        version: 2,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: true,
        encryptionMetadata: postEnc.encryptionMetadata,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    await indexedDBManager.addOperation({
      id: "op-enc-revert",
      operationId: "op-enc-revert",
      userId,
      workspaceId: WS_UUID,
      threadId: "thread-enc",
      turnId: "turn-enc-1",
      postTurnEtag: "etag-enc-v2",
      fileId: encFileId,
      operationType: "update",
      position: 0,
      content: postEnc.ciphertextBase64,
      timestamp: 2000,
      synced: true,
      status: "synced",
      isEncrypted: true,
      snapshot: {
        content: preEnc.ciphertextBase64,
        etag: "etag-enc-v1",
        version: 1,
        encryptionMetadata: preEnc.encryptionMetadata,
      },
    });

    expect(preEnc.encryptionMetadata.iv).not.toBe(postEnc.encryptionMetadata.iv);

    const { editor: encEditor, getContent: getEncContent } = createControllableEditor();
    const encHook = renderHook(() =>
      useEditorOrchestrator({
        fileId: encFileId,
        userId,
        projectId: WS_UUID,
        editor: encEditor,
      }),
    );

    await waitFor(() => expect(encHook.result.current.hydration).toBe("ready"));
    expect(getEncContent()).toBe("# Agent Mutated Encrypted Plaintext");

    // Revert encrypted turn: SyncRollback restores both pre-turn ciphertext AND pre-turn IV,
    // pushes encrypted snapshot to server, and orchestrator decrypts via real WebCrypto AES-GCM.
    mockToggleFileEncryption.mockClear();
    await act(async () => {
      const ok = await encHook.result.current.handleRevertTurn("turn-enc-1");
      expect(ok).toBe(true);
    });
    expect(getEncContent()).toBe("# Original Encrypted Plaintext");
    expect(mockToggleFileEncryption).toHaveBeenCalledWith(
      encFileId,
      true,
      preEnc.ciphertextBase64,
      preEnc.encryptionMetadata,
    );
    const restoredEncIdb = await indexedDBManager.getFile(encFileId, userId);
    expect(restoredEncIdb?.content).toBe(preEnc.ciphertextBase64);
    expect(restoredEncIdb?.encryptionMetadata?.iv).toBe(preEnc.encryptionMetadata.iv);

    encHook.unmount();

    // Now test reverting an active agent-created file -> navigates back to /workspace
    const createdFileId = "file-created-active";
    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: createdFileId,
        userId,
        content: "# Created By Agent",
        etag: "etag-c-v1",
        version: 1,
      }),
    });
    await indexedDBManager.saveFile(
      {
        id: createdFileId,
        title: "created.md",
        content: "# Created By Agent",
        etag: "etag-c-v1",
        version: 1,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: false,
        encryptionMetadata: null,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );
    await indexedDBManager.addOperation({
      id: "op-created-active",
      operationId: "op-created-active",
      userId,
      workspaceId: WS_UUID,
      threadId: "thread-cr",
      turnId: "turn-cr-1",
      fileId: createdFileId,
      operationType: "create",
      position: 0,
      content: "# Created By Agent",
      timestamp: 3000,
      synced: true,
      status: "synced",
    });

    const onNavigate = vi.fn();
    const { editor: crEditor } = createControllableEditor();
    const crHook = renderHook(() =>
      useEditorOrchestrator({
        fileId: createdFileId,
        userId,
        projectId: WS_UUID,
        editor: crEditor,
        onNavigate,
      }),
    );

    await waitFor(() => expect(crHook.result.current.hydration).toBe("ready"));

    await act(async () => {
      await crHook.result.current.handleRevertTurn("turn-cr-1");
    });

    expect(mockDeleteFile).toHaveBeenCalledWith(createdFileId);
    expect(onNavigate).toHaveBeenCalledWith("/workspace");
    expect(crHook.result.current.isDirty).toBe(false);
  });

  it("handleRevertSession reverts multiple mutating turns in reverse order and marks session reverted", async () => {
    const fileId = "file-session-rev";
    // Initial mount hydration MUST resolve Version 1 so background Step 2 hydration
    // never overwrites seeded IDB (# Version 1) before Turn 1 & Turn 2 run under concurrency.
    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: fileId,
        userId,
        content: "# Version 1",
        etag: "etag-v1",
        version: 1,
      }),
    });

    await indexedDBManager.saveFile(
      {
        id: fileId,
        title: "session.md",
        content: "# Version 1",
        etag: "etag-v1",
        version: 1,
        parentFolderId: null,
        isFolder: false,
        isEncrypted: false,
        encryptionMetadata: null,
        lastModified: Date.now(),
        lastSyncedAt: Date.now(),
        isDirty: false,
      },
      userId,
    );

    // Emit 2 sequential mutating turns through the real orchestrator's stream hook
    let turnNum = 0;
    mockConsumeAgentStream.mockImplementation(async (opts: StreamHandlerOptions) => {
      turnNum += 1;
      const version = turnNum + 1;
      mockGetFile.mockResolvedValueOnce({
        success: true,
        data: buildFileRecord({
          id: fileId,
          userId,
          content: `# Version ${version}`,
          etag: `etag-v${version}`,
          version,
        }),
      });
      opts.onStart?.({
        type: "start",
        sessionId: `s-rev-${turnNum}`,
        threadId: "t-rev-sess",
        operationId: `op-rev-${turnNum}`,
      });
      await opts.onFileMutated?.({
        type: "file_mutated",
        fileId,
        relativePath: "session.md",
        action: "updated",
      });
      opts.onDone?.({
        type: "done",
        threadId: "t-rev-sess",
        operationId: `op-rev-${turnNum}`,
      });
    });

    const { editor, getContent } = createControllableEditor();
    const { result } = renderHook(() =>
      useEditorOrchestrator({
        fileId,
        userId,
        projectId: WS_UUID,
        editor,
      }),
    );

    await waitFor(() => expect(result.current.hydration).toBe("ready"));

    await act(async () => {
      await result.current.startAgentSession("Turn 1 update");
    });
    await act(async () => {
      await result.current.startAgentSession("Turn 2 update");
    });

    expect(result.current.mutatedTurns).toHaveLength(2);
    expect(getContent()).toBe("# Version 3");

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await act(async () => {
        await result.current.handleRevertSession();
      });
    } finally {
      confirmSpy.mockRestore();
    }

    expect(getContent()).toBe("# Version 1");
    expect(result.current.mutatedTurns.every((t) => t.isReverted)).toBe(true);
    expect(result.current.isDirty).toBe(false);
  });
});

describe("AgentChatPanel — Revert Turn, Revert Session & ZK Notice Controls (Wave 5.2)", () => {
  afterEach(() => {
    cleanup();
  });

  const baseProps = {
    isOpen: true,
    status: "completed" as const,
    selectedSystem2ModelId: "google/gemini-3.8-flash",
    onSelectSystem2Model: vi.fn(),
    permissionMode: "semi_auto" as const,
    onSelectPermissionMode: vi.fn(),
    onStartSession: vi.fn(),
    onResumeInterrupt: vi.fn(),
    onResumeInsufficientCredits: vi.fn(),
  };

  it("renders Revert Turn per un-reverted mutating turn, Revert Session in header, Reverted badge, and zkAiNotice banner", () => {
    const onRevertTurn = vi.fn();
    const onRevertSession = vi.fn();

    const turns: AgentMutatedTurn[] = [
      {
        turnId: "turn-1",
        threadId: "thread-1",
        workspaceId: WS_UUID,
        prompt: "Update storage architecture",
        timestamp: 1000,
        mutatedFiles: [
          { fileId: "f-1", relativePath: "architecture.md", action: "updated" },
          { fileId: "f-ledger", relativePath: "decisions.ledger.json", action: "updated" },
        ],
        isReverted: false,
      },
      {
        turnId: "turn-2",
        threadId: "thread-1",
        workspaceId: WS_UUID,
        prompt: "Already reverted turn",
        timestamp: 2000,
        mutatedFiles: [{ fileId: "f-2", relativePath: "old.md", action: "deleted" }],
        isReverted: true,
      },
    ];

    render(
      <AgentChatPanel
        {...baseProps}
        mutatedTurns={turns}
        onRevertTurn={onRevertTurn}
        onRevertSession={onRevertSession}
        zkAiNotice="Encrypted workspace files were decrypted transiently in memory."
      />,
    );

    expect(screen.getByTestId("agent-zk-ai-notice").textContent).toContain(
      "decrypted transiently in memory",
    );

    // Header Revert Session button is present because turn-1 is un-reverted
    const revertSessionBtn = screen.getByTestId("agent-revert-session-button");
    fireEvent.click(revertSessionBtn);
    expect(onRevertSession).toHaveBeenCalledTimes(1);

    // Turn 1 shows Revert Turn button and mutated file badges
    const revertTurn1Btn = screen.getByTestId("agent-revert-turn-turn-1");
    expect(screen.getByTestId("agent-turn-card-turn-1").textContent).toContain(
      "architecture.md (updated)",
    );
    expect(screen.getByTestId("agent-turn-card-turn-1").textContent).toContain(
      "decisions.ledger.json (updated)",
    );
    fireEvent.click(revertTurn1Btn);
    expect(onRevertTurn).toHaveBeenCalledWith("turn-1");

    // Turn 2 is reverted: shows "Reverted" label and hides Revert Turn button
    expect(screen.queryByTestId("agent-revert-turn-turn-2")).toBeNull();
    expect(screen.getByTestId("agent-turn-card-turn-2").textContent).toContain(
      "Reverted",
    );
  });

  it("maintains full backward compatibility when Wave 5.2 optional revert/notice props are omitted", () => {
    render(<AgentChatPanel {...baseProps} />);

    expect(screen.queryByTestId("agent-revert-session-button")).toBeNull();
    expect(screen.queryByTestId("agent-turn-mutations")).toBeNull();
    expect(screen.queryByTestId("agent-zk-ai-notice")).toBeNull();
  });
});
