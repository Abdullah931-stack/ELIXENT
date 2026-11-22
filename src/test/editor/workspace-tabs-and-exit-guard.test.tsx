// @vitest-environment jsdom
/**
 * Phase 5 (Wave 5.1) — Multi-Tab Workspace Bar, Persistent Ghost Edits,
 * Unresolved Edits Tracker, 3-Choice Exit Modal & Workspace Layout Cross-Contract Suite
 *
 * Covers:
 * - `src/components/editor/workspace-tab-bar.tsx` (WorkspaceTabsProvider & WorkspaceTabBar)
 * - `src/components/editor/unresolved-edits-tracker.tsx` (UnresolvedEditsTracker)
 * - `src/components/editor/pending-edits-exit-modal.tsx` (PendingEditsExitModal)
 * - `src/client/routes/workspace-layout.tsx` (WorkspaceLayoutRouteView)
 *
 * Specifications: SRS-03 §3.1 (`REQ-TABS-01..04`) & §3.2 (`REQ-EXIT-01..03`).
 */

import "fake-indexeddb/auto";
import React, { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { GhostHunk } from "@/components/editor/markdown/types";
import type { WorkspaceRecord } from "@/types/rpc-contracts";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";

const {
  mockNavigateTo,
  mockListWorkspacesRpc,
  mockGetFile,
  mockUpdateFileContent,
  mockToggleFileEncryption,
  mockResolveInitialClientUserIdSync,
  mockResolveLocalFirstAuthUser,
  mockBlockerState,
  mockUseBlockerCapture,
  mockRouterRef,
} = vi.hoisted(() => ({
  mockNavigateTo: vi.fn(),
  mockListWorkspacesRpc: vi.fn(),
  mockGetFile: vi.fn(),
  mockUpdateFileContent: vi.fn(),
  mockToggleFileEncryption: vi.fn(),
  mockResolveInitialClientUserIdSync: vi.fn(),
  mockResolveLocalFirstAuthUser: vi.fn(),
  mockBlockerState: {
    status: "idle" as "idle" | "blocked",
    proceed: vi.fn(),
    reset: vi.fn(),
  },
  mockUseBlockerCapture: {
    lastOptions: null as {
      shouldBlockFn?: (args: { next: { pathname: string } }) => boolean;
      enableBeforeUnload?: boolean;
      withResolver?: boolean;
    } | null,
  },
  mockRouterRef: {
    current: {} as Record<string, unknown> | null,
  },
}));

// Mock only true external boundaries: navigation, HTTP RPC, auth identity, and TanStack Router hooks.
vi.mock("@/client/navigation", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
}));

vi.mock("@/client/rpc-client", () => ({
  listWorkspacesRpc: (...args: unknown[]) => mockListWorkspacesRpc(...args),
  getFile: (...args: unknown[]) => mockGetFile(...args),
  updateFileContent: (...args: unknown[]) => mockUpdateFileContent(...args),
  toggleFileEncryption: (...args: unknown[]) =>
    mockToggleFileEncryption(...args),
}));

vi.mock("@/lib/auth/client-identity", () => ({
  buildLoginRedirectPath: () => "/login",
  resolveInitialClientUserIdSync: () => mockResolveInitialClientUserIdSync(),
  resolveLocalFirstAuthUser: (...args: unknown[]) =>
    mockResolveLocalFirstAuthUser(...args),
}));

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div data-testid="workspace-outlet">Editor Outlet</div>,
  useRouter: () => mockRouterRef.current,
  useBlocker: (opts: {
    shouldBlockFn?: (args: { next: { pathname: string } }) => boolean;
    enableBeforeUnload?: boolean;
    withResolver?: boolean;
  }) => {
    mockUseBlockerCapture.lastOptions = opts;
    return mockBlockerState;
  },
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
    <a href={to ?? "#"} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/layout/sidebar", () => ({
  Sidebar: ({ userId }: { userId?: string }) => (
    <aside data-testid="workspace-sidebar" data-user-id={userId ?? ""}>
      Sidebar
    </aside>
  ),
}));

import {
  WorkspaceTabBar,
  WorkspaceTabsProvider,
  useWorkspaceTabs,
  type WorkspaceTabsContextValue,
} from "@/components/editor/workspace-tab-bar";
import { UnresolvedEditsTracker } from "@/components/editor/unresolved-edits-tracker";
import { PendingEditsExitModal } from "@/components/editor/pending-edits-exit-modal";
import { WorkspaceLayoutRouteView } from "@/client/routes/workspace-layout";

function buildWorkspace(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id: overrides.id ?? "ws-primary",
    userId: overrides.userId ?? "user-tabs-1",
    name: overrides.name ?? "Architecture Workspace",
    description: overrides.description ?? null,
    isEncrypted: overrides.isEncrypted ?? false,
    defaultPermissionMode: overrides.defaultPermissionMode ?? "safe",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function buildHunk(overrides: Partial<GhostHunk> = {}): GhostHunk {
  return {
    hunkId: overrides.hunkId ?? "hunk-1",
    decisionIds: overrides.decisionIds ?? ["dec-1"],
    headingSlug: overrides.headingSlug ?? "overview",
    from: overrides.from ?? 0,
    to: overrides.to ?? 5,
    originalSlice: overrides.originalSlice ?? "Hello",
    replacementText: overrides.replacementText ?? "Greetings",
    status: overrides.status ?? "preview_ready",
    operation: overrides.operation ?? "replace",
    onReject: overrides.onReject,
  };
}

function ContextHarness({
  onContext,
}: {
  onContext: (ctx: WorkspaceTabsContextValue) => void;
}) {
  const ctx = useWorkspaceTabs();
  useEffect(() => {
    onContext(ctx);
  }, [ctx, onContext]);
  return null;
}

describe("WorkspaceTabsProvider, WorkspaceTabBar & UnresolvedEditsTracker (REQ-TABS-01..04)", () => {
  let userId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    sessionKeyStore.purgeKeys(false);
    mockRouterRef.current = {};
    mockBlockerState.status = "idle";
    mockUseBlockerCapture.lastOptions = null;

    userId = `user-tabs-${Math.random().toString(36).slice(2, 10)}`;
    mockResolveInitialClientUserIdSync.mockReturnValue(userId);
    mockResolveLocalFirstAuthUser.mockResolvedValue({ id: userId });
    mockListWorkspacesRpc.mockResolvedValue({
      success: true,
      data: [buildWorkspace({ id: "ws-primary", userId })],
    });
    mockUpdateFileContent.mockResolvedValue({ success: true });
    mockToggleFileEncryption.mockResolvedValue({ success: true });
    mockGetFile.mockResolvedValue({ success: false, data: null });

    await indexedDBManager.init(userId);
  });

  afterEach(async () => {
    cleanup();
    sessionKeyStore.purgeKeys(false);
    await indexedDBManager.deleteDatabase();
  });

  it("manages 3 independent open tabs, preserves pending ghost hunks across tab closure & reload, and deterministically switches adjacent tabs", async () => {
    let latestCtx!: WorkspaceTabsContextValue;

    const { unmount } = render(
      <WorkspaceTabsProvider>
        <ContextHarness onContext={(c) => (latestCtx = c)} />
        <WorkspaceTabBar />
      </WorkspaceTabsProvider>,
    );

    await waitFor(() => {
      expect(latestCtx.activeWorkspaceId).toBe("ws-primary");
    });

    // Open 3 independent files with distinct selection, dirty, encryption, and scroll state
    act(() => {
      latestCtx.openTab({
        fileId: "file-1",
        title: "intro.md",
        relativePath: "docs/intro.md",
        isDirty: true,
        isEncrypted: false,
        cursorSelection: { from: 4, to: 12 },
        scrollTop: 120,
      });
      latestCtx.openTab({
        fileId: "file-2",
        title: "vault.md",
        relativePath: "docs/vault.md",
        isDirty: false,
        isEncrypted: true,
        cursorSelection: { from: 20, to: 20 },
        scrollTop: 340,
      });
      latestCtx.openTab({
        fileId: "file-3",
        title: "api.md",
        relativePath: "docs/api.md",
        isDirty: false,
        isEncrypted: false,
        cursorSelection: { from: 0, to: 5 },
        scrollTop: 0,
      });
    });

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(latestCtx.openTabs[0].cursorSelection).toEqual({ from: 4, to: 12 });
    expect(latestCtx.openTabs[1].scrollTop).toBe(340);
    expect(screen.getByLabelText("Unsaved changes")).toBeDefined();
    expect(screen.getByLabelText("Encrypted file")).toBeDefined();

    // Attach 2 pending ghost hunks to file-2 and 1 to file-3
    const h1 = buildHunk({ hunkId: "h-f2-1", replacementText: "Updated A" });
    const h2 = buildHunk({ hunkId: "h-f2-2", replacementText: "Updated B" });
    const h3 = buildHunk({ hunkId: "h-f3-1", replacementText: "Updated C" });

    act(() => {
      latestCtx.setGhostHunksForFile("file-2", [h1, h2], "turn-10");
      latestCtx.setGhostHunksForFile("file-3", [h3], "turn-10");
    });

    expect(latestCtx.totalPendingGhostCount).toBe(3);
    expect(
      screen.getByRole("button", { name: "3 Unresolved Edits in 2 Files" }),
    ).toBeDefined();

    // Activate middle tab (file-2) by clicking it
    fireEvent.click(screen.getByRole("tab", { name: /vault\.md/i }));
    expect(latestCtx.activeFileId).toBe("file-2");
    expect(mockNavigateTo).toHaveBeenCalledWith("/workspace/editor/file-2");

    // Close active tab (file-2) via (X) -> activates adjacent tab (file-3) AND retains file-2 hunks!
    fireEvent.click(screen.getByRole("button", { name: "Close vault.md" }));

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(latestCtx.activeFileId).toBe("file-3");
    expect(mockNavigateTo).toHaveBeenCalledWith("/workspace/editor/file-3");
    expect(latestCtx.ghostHunksByFileId["file-2"]).toHaveLength(2);
    expect(latestCtx.totalPendingGhostCount).toBe(3);

    // Open UnresolvedEditsTracker popover: file-2 shows "Closed", file-3 shows "Open"
    fireEvent.click(
      screen.getByRole("button", { name: "3 Unresolved Edits in 2 Files" }),
    );
    const popover = screen.getByRole("dialog", { name: "Unresolved AI edits" });
    expect(popover.textContent).toContain("Closed");
    expect(popover.textContent).toContain("Open");

    // Wait for IndexedDB persistence of pending_ghost_hunks_ws-primary
    await waitFor(async () => {
      const persisted =
        await indexedDBManager.loadPendingGhostHunks("ws-primary");
      expect(persisted?.ghostHunksByFileId["file-2"]).toHaveLength(2);
      expect(persisted?.turnIdByHunkId["h-f2-1"]).toBe("turn-10");
    });

    // Click "Open & Review" for the closed file -> re-opens tab & navigates
    const reviewButtons = screen.getAllByRole("button", {
      name: "Open & Review",
    });
    fireEvent.click(reviewButtons[0]);
    expect(latestCtx.openTabs.some((t) => t.fileId === "file-2")).toBe(true);
    expect(mockNavigateTo).toHaveBeenCalledWith("/workspace/editor/file-2");

    // Close all 3 tabs -> last close navigates to /workspace
    // Note: file-2 was reopened from UnresolvedEditsTracker while closed, so its fallback title is "file-2"
    fireEvent.click(screen.getByRole("button", { name: "Close intro.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Close api.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Close file-2" }));
    expect(latestCtx.activeFileId).toBeNull();
    expect(mockNavigateTo).toHaveBeenLastCalledWith("/workspace");

    // Unmount and remount fresh provider to verify IndexedDB reload hydration
    unmount();

    let reloadedCtx!: WorkspaceTabsContextValue;
    render(
      <WorkspaceTabsProvider>
        <ContextHarness onContext={(c) => (reloadedCtx = c)} />
        <UnresolvedEditsTracker compact />
      </WorkspaceTabsProvider>,
    );

    await waitFor(() => {
      expect(reloadedCtx.totalPendingGhostCount).toBe(3);
      expect(reloadedCtx.ghostHunksByFileId["file-2"]).toHaveLength(2);
      expect(reloadedCtx.turnIdByHunkId["h-f2-2"]).toBe("turn-10");
    });
    expect(screen.getByText("3 Unresolved")).toBeDefined();
  });

  it("acceptAllPendingInFile applies multiple hunks in reverse offset order for both plaintext and encrypted files and persists to IDB/RPC", async () => {
    const rawMasterKey = new Uint8Array(32);
    crypto.getRandomValues(rawMasterKey);
    sessionKeyStore.setMasterKey(rawMasterKey);

    // Seed plaintext file in real IDB
    await indexedDBManager.saveFile({
      id: "plain-file",
      title: "plain.md",
      content: "Alpha Beta Gamma",
      etag: "etag-p1",
      version: 2,
      parentFolderId: null,
      isFolder: false,
      isEncrypted: false,
      encryptionMetadata: null,
      lastModified: Date.now(),
      lastSyncedAt: Date.now(),
      isDirty: true,
    });

    // Seed real AES-GCM encrypted file in real IDB
    const encInitial = await SyncCryptoGateway.encryptOutbound(
      "enc-file",
      "Secret Old Value",
      userId,
    );
    await indexedDBManager.saveFile({
      id: "enc-file",
      title: "secret.md",
      content: encInitial.ciphertextBase64,
      etag: "etag-e1",
      version: 4,
      parentFolderId: null,
      isFolder: false,
      isEncrypted: true,
      encryptionMetadata: encInitial.encryptionMetadata,
      lastModified: Date.now(),
      lastSyncedAt: Date.now(),
      isDirty: true,
    });

    let ctx!: WorkspaceTabsContextValue;
    render(
      <WorkspaceTabsProvider>
        <ContextHarness onContext={(c) => (ctx = c)} />
      </WorkspaceTabsProvider>,
    );

    await waitFor(() => expect(ctx.activeWorkspaceId).toBe("ws-primary"));

    // Two hunks on plain-file (given in ascending order; must apply without offset drift)
    act(() => {
      ctx.setGhostHunksForFile("plain-file", [
        buildHunk({
          hunkId: "hp-1",
          from: 0,
          to: 5,
          originalSlice: "Alpha",
          replacementText: "FIRST",
        }),
        buildHunk({
          hunkId: "hp-2",
          from: 11,
          to: 16,
          originalSlice: "Gamma",
          replacementText: "LAST",
        }),
      ]);
      ctx.setGhostHunksForFile("enc-file", [
        buildHunk({
          hunkId: "he-1",
          from: 7,
          to: 10,
          originalSlice: "Old",
          replacementText: "New",
        }),
      ]);
    });

    await act(async () => {
      await ctx.acceptAllPendingInFile("plain-file");
    });

    expect(mockUpdateFileContent).toHaveBeenCalledWith(
      "plain-file",
      "FIRST Beta LAST",
      { expectedVersion: 2, expectedETag: "etag-p1" },
    );
    const updatedPlain = await indexedDBManager.getFile("plain-file", userId);
    expect(updatedPlain?.content).toBe("FIRST Beta LAST");
    expect(updatedPlain?.isDirty).toBe(false);
    expect(ctx.ghostHunksByFileId["plain-file"]).toBeUndefined();

    await act(async () => {
      await ctx.acceptAllPendingInFile("enc-file");
    });

    expect(mockToggleFileEncryption).toHaveBeenCalledTimes(1);
    const [calledFileId, calledIsEnc, calledCiphertext, calledMeta] =
      mockToggleFileEncryption.mock.calls[0];
    expect(calledFileId).toBe("enc-file");
    expect(calledIsEnc).toBe(true);
    expect(calledCiphertext).not.toContain("Secret New Value");

    // Decrypt the outbound ciphertext via real SyncCryptoGateway to verify exact integrity
    const decryptedCheck = await SyncCryptoGateway.decryptInbound({
      fileId: "enc-file",
      content: calledCiphertext,
      isEncrypted: true,
      encryptionMetadata: calledMeta,
      userId,
    });
    expect(decryptedCheck.status).toBe("decrypted");
    expect(decryptedCheck.content).toBe("Secret New Value");
  });

  it("UnresolvedEditsTracker Accept All / Reject All invokes callbacks and clears tracker pill", async () => {
    const onRejectHunk = vi.fn();
    const saveFlush = vi.fn().mockResolvedValue(undefined);
    let ctx!: WorkspaceTabsContextValue;

    render(
      <WorkspaceTabsProvider>
        <ContextHarness onContext={(c) => (ctx = c)} />
        <UnresolvedEditsTracker />
      </WorkspaceTabsProvider>,
    );

    await waitFor(() => expect(ctx.activeWorkspaceId).toBe("ws-primary"));

    // Hidden when no pending edits exist
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      ctx.registerSaveFlushHandler(saveFlush);
      ctx.setGhostHunksForFile("f-reject", [
        buildHunk({ hunkId: "hr-1", onReject: onRejectHunk }),
      ]);
    });

    // Singular grammar check: "1 Unresolved Edit in 1 File"
    const pill = screen.getByRole("button", {
      name: "1 Unresolved Edit in 1 File",
    });
    fireEvent.click(pill);
    fireEvent.click(
      screen.getByRole("button", { name: "Reject All in Workspace" }),
    );

    expect(onRejectHunk).toHaveBeenCalledTimes(1);
    expect(ctx.totalPendingGhostCount).toBe(0);
    expect(screen.queryByRole("button")).toBeNull();

    // Now test Accept All in Workspace invokes registered saveFlushHandler
    act(() => {
      ctx.setGhostHunksForFile("f-accept", [buildHunk({ hunkId: "ha-1" })]);
    });

    fireEvent.click(
      screen.getByRole("button", { name: "1 Unresolved Edit in 1 File" }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Accept All in Workspace" }),
      );
    });

    await waitFor(() => {
      expect(saveFlush).toHaveBeenCalledTimes(1);
      expect(ctx.totalPendingGhostCount).toBe(0);
    });
  });
});

describe("PendingEditsExitModal & WorkspaceLayoutRouteView (REQ-EXIT-01..03)", () => {
  let userId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockRouterRef.current = {};
    mockBlockerState.status = "idle";
    mockUseBlockerCapture.lastOptions = null;

    userId = `user-exit-${Math.random().toString(36).slice(2, 10)}`;
    mockResolveInitialClientUserIdSync.mockReturnValue(userId);
    mockResolveLocalFirstAuthUser.mockResolvedValue({ id: userId });
    mockListWorkspacesRpc.mockResolvedValue({
      success: true,
      data: [buildWorkspace({ id: "ws-exit", userId })],
    });
    mockUpdateFileContent.mockResolvedValue({ success: true });
    mockGetFile.mockResolvedValue({ success: false, data: null });

    await indexedDBManager.init(userId);
  });

  afterEach(async () => {
    cleanup();
    await indexedDBManager.deleteDatabase();
  });

  it("blocks external routes and allows intra-workspace routes via useBlocker, and toggles beforeunload guard", async () => {
    let ctx!: WorkspaceTabsContextValue;

    render(
      <WorkspaceTabsProvider>
        <ContextHarness onContext={(c) => (ctx = c)} />
        <PendingEditsExitModal />
      </WorkspaceTabsProvider>,
    );

    await waitFor(() => expect(ctx.activeWorkspaceId).toBe("ws-exit"));

    // Clean state: shouldBlockFn returns false, beforeunload is NOT prevented
    expect(
      mockUseBlockerCapture.lastOptions?.shouldBlockFn?.({
        next: { pathname: "/dashboard" },
      }),
    ).toBe(false);

    const cleanUnloadEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnloadEvent);
    expect(cleanUnloadEvent.defaultPrevented).toBe(false);

    // Dirty / pending state: blocks /dashboard & /account, permits /workspace/*
    act(() => {
      ctx.setGhostHunksForFile("f-1", [buildHunk({ hunkId: "h-guard-1" })]);
    });

    expect(
      mockUseBlockerCapture.lastOptions?.shouldBlockFn?.({
        next: { pathname: "/dashboard" },
      }),
    ).toBe(true);
    expect(
      mockUseBlockerCapture.lastOptions?.shouldBlockFn?.({
        next: { pathname: "/account" },
      }),
    ).toBe(true);
    expect(
      mockUseBlockerCapture.lastOptions?.shouldBlockFn?.({
        next: { pathname: "/workspace/editor/f-2" },
      }),
    ).toBe(false);

    const dirtyUnloadEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnloadEvent);
    expect(dirtyUnloadEvent.defaultPrevented).toBe(true);
  });

  it("handles Save & Leave, Discard & Leave, and Stay choices accurately when navigation is blocked", async () => {
    mockBlockerState.status = "blocked";
    const saveFlush = vi.fn().mockResolvedValue(undefined);
    const discardFlush = vi.fn();
    const onReject = vi.fn();
    let ctx!: WorkspaceTabsContextValue;

    render(
      <WorkspaceTabsProvider>
        <ContextHarness onContext={(c) => (ctx = c)} />
        <PendingEditsExitModal />
      </WorkspaceTabsProvider>,
    );

    await waitFor(() => expect(ctx.activeWorkspaceId).toBe("ws-exit"));

    act(() => {
      ctx.registerSaveFlushHandler(saveFlush);
      ctx.registerDiscardFlushHandler?.(discardFlush);
      ctx.openTab({
        fileId: "f-dirty",
        title: "dirty.md",
        relativePath: "dirty.md",
        isDirty: true,
        isEncrypted: false,
      });
      ctx.setGhostHunksForFile("f-dirty", [
        buildHunk({ hunkId: "h-exit-1", onReject }),
      ]);
    });

    // 1. Stay: resets blocker without saving or discarding
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(mockBlockerState.reset).toHaveBeenCalledTimes(1);
    expect(mockBlockerState.proceed).not.toHaveBeenCalled();
    expect(discardFlush).not.toHaveBeenCalled();
    expect(ctx.totalPendingGhostCount).toBe(1);
    expect(ctx.hasUnsavedDirtyBuffer).toBe(true);

    // 2. Discard & Leave: invokes discardFlush handler, rejects hunks, clears dirty state without flushing, proceeds navigation
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard & Leave" }));
    });
    expect(discardFlush).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(saveFlush).not.toHaveBeenCalled();
    expect(mockBlockerState.proceed).toHaveBeenCalledTimes(1);
    expect(ctx.totalPendingGhostCount).toBe(0);
    expect(ctx.hasUnsavedDirtyBuffer).toBe(false);

    // 3. Save & Leave: accepts hunks, flushes dirty buffers, proceeds navigation
    mockBlockerState.proceed.mockClear();
    act(() => {
      ctx.updateTabState("f-dirty", { isDirty: true });
      ctx.setGhostHunksForFile("f-dirty", [buildHunk({ hunkId: "h-exit-2" })]);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save & Leave" }));
    });
    await waitFor(() => {
      expect(saveFlush).toHaveBeenCalledTimes(1);
      expect(mockBlockerState.proceed).toHaveBeenCalledTimes(1);
      expect(ctx.totalPendingGhostCount).toBe(0);
      expect(ctx.hasUnsavedDirtyBuffer).toBe(false);
    });
  });

  it.each([
    {
      label: "both pending hunks and dirty buffer",
      pendingCount: 2,
      isDirty: true,
      expectedCopy: "You have 2 unresolved AI edits and unsaved file changes.",
    },
    {
      label: "single pending hunk only",
      pendingCount: 1,
      isDirty: false,
      expectedCopy: "You have 1 unresolved AI edit pending review.",
    },
    {
      label: "dirty buffer only",
      pendingCount: 0,
      isDirty: true,
      expectedCopy: "You have unsaved changes in open workspace files.",
    },
  ])(
    "renders accurate modal warning copy for $label",
    async ({ pendingCount, isDirty, expectedCopy }) => {
      mockBlockerState.status = "blocked";
      let ctx!: WorkspaceTabsContextValue;

      render(
        <WorkspaceTabsProvider>
          <ContextHarness onContext={(c) => (ctx = c)} />
          <PendingEditsExitModal />
        </WorkspaceTabsProvider>,
      );

      await waitFor(() => expect(ctx.activeWorkspaceId).toBe("ws-exit"));

      act(() => {
        if (isDirty) {
          ctx.openTab({
            fileId: "f-copy",
            title: "copy.md",
            relativePath: "copy.md",
            isDirty: true,
            isEncrypted: false,
          });
        }
        if (pendingCount > 0) {
          ctx.setGhostHunksForFile(
            "f-copy",
            Array.from({ length: pendingCount }, (_, i) =>
              buildHunk({ hunkId: `h-copy-${i}` }),
            ),
          );
        }
      });

      expect(screen.getByText(expectedCopy)).toBeDefined();
    },
  );

  it("WorkspaceLayoutRouteView mounts WorkspaceTabBar directly above Outlet alongside Sidebar and PendingEditsExitModal", async () => {
    render(<WorkspaceLayoutRouteView />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-sidebar")).toBeDefined();
    });

    const tablist = screen.getByRole("tablist", {
      name: "Open workspace tabs",
    });
    const outlet = screen.getByTestId("workspace-outlet");
    expect(tablist).toBeDefined();
    expect(outlet).toBeDefined();

    // WorkspaceTabBar must precede the main Outlet in DOM order
    expect(
      Boolean(
        tablist.compareDocumentPosition(outlet) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });
});
