// @vitest-environment jsdom

/**
 * useEditorConflict Contract & Behavior Tests (Phase 18 extraction).
 *
 * Validates the extracted conflict resolution and cross-tab synchronization controller:
 * 1. ACCEPTANCE: True 412 sets activeConflict and opens dialog; isBlockedByConflict() returns true.
 * 2. False-conflict suppression: Identical content modulo normalizeMarkdownSource bypasses modal and adopts server anchors.
 * 3. Resolution strategies ('local', 'server', 'merge'): conditioned writes target serverVersion anchors,
 *    modal closes, activeConflict clears, isResolvingConflict resets, and conflict_resolved broadcast emits.
 * 4. LUGX-010: Live concurrent editor edits during resolution preserve dirty state (markDirty called, markClean skipped).
 * 5. LUGX-013: Resolution failure or repeated 412 never overwrites editor content with stale snapshots.
 * 6. LUGX-051: Cross-tab file_encrypted retains dirty edits if dirty, but marks clean if clean.
 * 7. LUGX-049: Cross-tab vault_locked flushes dirty content before cancelAutosave; refuses plaintext flush if master key is missing.
 * 8. LUGX-020: Cross-tab file_saved retains local version if dirty, and adopts server version/content if clean.
 * 9. Anti-echo & teardown: Ignores self-broadcasts matching currentTabId and unsubscribes on unmount.
 *
 * System Boundaries & Mock Justifications:
 * - Server action `@/server/actions/file-ops` is mocked: network RPCs / DB operations cannot execute in isolated jsdom tests.
 * - All other modules are real: real `normalizeMarkdownSource`, real `classifyRemoteUpdate`,
 *   real `broadcastCrossTabEvent` / `subscribeCrossTabSync`, and real `sessionKeyStore`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import {
    useEditorConflict,
    type UseEditorConflictOptions,
} from "../../hooks/use-editor-conflict";
import { updateFileContent } from "../../server/actions/file-ops";
import {
    getSyncChannelName,
    setActiveSyncUserId,
    currentTabId,
    type CrossTabSyncEvent,
} from "../../lib/sync/cross-tab-sync";
import { sessionKeyStore } from "../../lib/sync/session-key-store";
import type { EditorAdapter } from "../../components/editor/markdown/types";
import type { IDBFile } from "../../lib/sync/idb-types";

// Polyfill window.BroadcastChannel in JSDOM using Node.js native globalThis.BroadcastChannel if omitted by jsdom
if (typeof window !== "undefined" && typeof window.BroadcastChannel === "undefined" && typeof globalThis.BroadcastChannel !== "undefined") {
    (window as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel = globalThis.BroadcastChannel;
}

// Minimal server action boundaries: database persistence cannot execute in isolated in-memory jsdom contract tests.
vi.mock("@/server/actions/file-ops", () => ({
    updateFileContent: vi.fn(),
    toggleFileEncryption: vi.fn(),
    renameFile: vi.fn(),
    deleteFile: vi.fn(),
}));

const openChannels: BroadcastChannel[] = [];

interface SetupFixture {
    fileId: string;
    userId: string;
    options: UseEditorConflictOptions;
    adapter: EditorAdapter;
    state: {
        title: string;
        version: number;
        etag: string | null;
        content: string;
        isDirty: boolean;
        isEncrypted: boolean;
        adapterContent: string;
    };
    sendSiblingBroadcast: (event: Omit<CrossTabSyncEvent, "timestamp">) => void;
}

function setup(overrides: Partial<UseEditorConflictOptions> = {}): SetupFixture {
    const fileId = overrides.fileId ?? `file-test-${Math.random().toString(36).slice(2, 9)}`;
    const userId = overrides.userId ?? `user-test-${Math.random().toString(36).slice(2, 9)}`;
    setActiveSyncUserId(userId);

    const state = {
        title: "Test Note",
        version: 1,
        etag: "etag-v1" as string | null,
        content: "Initial editor content",
        isDirty: false,
        isEncrypted: false,
        adapterContent: "Initial editor content",
    };

    const adapter: EditorAdapter = {
        getValue: vi.fn(() => state.adapterContent),
        setValue: vi.fn((val: string) => {
            state.adapterContent = val;
        }),
        getSelection: vi.fn(() => ({ from: 0, to: 0 })),
        setSelection: vi.fn(),
        replaceRange: vi.fn(),
        replaceRanges: vi.fn(),
        getSelectedText: vi.fn(() => ""),
        insertMarkdown: vi.fn(),
        setEditable: vi.fn(),
        focus: vi.fn(),
        blur: vi.fn(),
        hasFocus: vi.fn(() => false),
        undo: vi.fn(() => false),
        redo: vi.fn(() => false),
        canUndo: vi.fn(() => false),
        canRedo: vi.fn(() => false),
        getWordCount: vi.fn(() => 0),
        getCharCount: vi.fn(() => 0),
        getLineCount: vi.fn(() => 1),
        getHeadingCount: vi.fn(() => 0),
        getMode: vi.fn(() => "source" as const),
        setMode: vi.fn(),
        getDirectionSettings: vi.fn(() => ({ mode: "auto" as const, lockCodeBlocksLTR: true })),
        setDirectionSettings: vi.fn(),
        destroy: vi.fn(),
    };

    const options: UseEditorConflictOptions = {
        fileId,
        userId,
        getTitle: vi.fn(() => state.title),
        setTitle: vi.fn((t: string) => {
            state.title = t;
        }),
        getVersion: vi.fn(() => state.version),
        setVersion: vi.fn((v: number) => {
            state.version = v;
        }),
        getEtag: vi.fn(() => state.etag),
        setEtag: vi.fn((e: string | null) => {
            state.etag = e;
        }),
        markServerPersisted: vi.fn(),
        getEditorContent: vi.fn(() => state.content),
        setEditorContent: vi.fn((c: string) => {
            state.content = c;
        }),
        getAdapter: vi.fn(() => adapter),
        isProgrammaticUpdate: vi.fn(() => false),
        setProgrammaticUpdate: vi.fn(),
        incrementEditorGeneration: vi.fn(),
        isDirty: vi.fn(() => state.isDirty),
        markClean: vi.fn(() => {
            state.isDirty = false;
        }),
        markDirty: vi.fn(() => {
            state.isDirty = true;
        }),
        cancelAutosave: vi.fn(),
        isAIActive: vi.fn(() => false),
        isHydrated: vi.fn(() => true),
        setHydration: vi.fn(),
        setPendingRemoteUpdate: vi.fn(),
        setPendingEncryptedPayload: vi.fn(),
        isEncrypted: vi.fn(() => state.isEncrypted),
        setIsEncrypted: vi.fn((e: boolean) => {
            state.isEncrypted = e;
        }),
        getEncryptionMetadata: vi.fn(() => null),
        setEncryptionMetadata: vi.fn(),
        setIsVaultLocked: vi.fn(),
        setIsUnlockModalOpen: vi.fn(),
        handleVaultUnlocked: vi.fn(),
        saveLocal: vi.fn().mockResolvedValue(undefined),
        loadLocal: vi.fn().mockResolvedValue(null),
        isSyncInitialized: vi.fn(() => true),
        setError: vi.fn(),
        onNavigate: vi.fn(),
        resolveEffectiveUserId: vi.fn().mockResolvedValue(userId),
        buildFileAAD: vi.fn((uid, fid) => `vault:file:${uid}:${fid}`),
        ...overrides,
    };

    const sendSiblingBroadcast = (event: Omit<CrossTabSyncEvent, "timestamp">) => {
        const channel = new BroadcastChannel(getSyncChannelName());
        openChannels.push(channel);
        channel.postMessage({
            ...event,
            timestamp: Date.now(),
        });
    };

    return { fileId, userId, options, adapter, state, sendSiblingBroadcast };
}

describe("useEditorConflict", () => {
    beforeEach(() => {
        setActiveSyncUserId(null);
        sessionKeyStore.lock(false);
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
        for (const ch of openChannels) {
            try {
                ch.close();
            } catch {}
        }
        openChannels.length = 0;
        setActiveSyncUserId(null);
        sessionKeyStore.lock(false);
    });

    it("ACCEPTANCE: handle412Conflict with differing server version sets activeConflict and opens dialog (blocking writes)", async () => {
        const fixture = setup();
        const localBaselineSnapshot: IDBFile = {
            id: fixture.fileId,
            content: "Base document content",
            version: 1,
            etag: "etag-base-v1",
            title: "Test Note",
            parentFolderId: null,
            isFolder: false,
            isDirty: false,
            isEncrypted: false,
            baseSnapshot: {
                content: "Base document content",
                version: 1,
                etag: "etag-base-v1",
                title: "Test Note",
                parentFolderId: null,
            },
            lastSyncedAt: Date.now() - 5000,
            lastModified: Date.now() - 5000,
        };
        vi.mocked(fixture.options.loadLocal).mockResolvedValue(localBaselineSnapshot);

        const { result } = renderHook(() => useEditorConflict(fixture.options));

        expect(result.current.isConflictDialogOpen).toBe(false);
        expect(result.current.activeConflict).toBeNull();
        expect(result.current.isBlockedByConflict()).toBe(false);

        await act(async () => {
            await result.current.handle412Conflict(
                {
                    version: 2,
                    etag: "etag-server-v2",
                    content: "Conflicting server edit",
                    updatedAt: "2026-10-13T12:00:00.000Z",
                },
                "Local uncommitted edit"
            );
        });

        expect(result.current.isConflictDialogOpen).toBe(true);
        expect(result.current.isBlockedByConflict()).toBe(true);
        expect(result.current.activeConflict).not.toBeNull();

        const conflict = result.current.activeConflict;
        expect(conflict?.fileId).toBe(fixture.fileId);
        expect(conflict?.localVersion.content).toBe("Local uncommitted edit");
        expect(conflict?.localVersion.version).toBe(1);
        expect(conflict?.localVersion.etag).toBe("etag-v1");
        expect(conflict?.serverVersion.content).toBe("Conflicting server edit");
        expect(conflict?.serverVersion.version).toBe(2);
        expect(conflict?.serverVersion.etag).toBe("etag-server-v2");
        expect(conflict?.baseVersion?.content).toBe("Base document content");
        expect(conflict?.baseVersion?.version).toBe(1);
        expect(conflict?.baseVersion?.etag).toBe("etag-base-v1");
    });

    it("suppresses conflict dialog and adopts server version/etag when server and local content match modulo normalization", async () => {
        const fixture = setup();
        fixture.state.content = "Section A\r\nItem 1\r\nItem 2";
        fixture.state.adapterContent = fixture.state.content;

        const { result } = renderHook(() => useEditorConflict(fixture.options));

        await act(async () => {
            await result.current.handle412Conflict(
                {
                    version: 4,
                    etag: "etag-normalized-v4",
                    // LF line endings matching CRLF local content via normalizeMarkdownSource
                    content: "Section A\nItem 1\nItem 2",
                    updatedAt: "2026-10-13T12:00:00.000Z",
                },
                fixture.state.content
            );
        });

        expect(result.current.isConflictDialogOpen).toBe(false);
        expect(result.current.activeConflict).toBeNull();
        expect(result.current.isBlockedByConflict()).toBe(false);

        expect(fixture.options.setVersion).toHaveBeenCalledWith(4);
        expect(fixture.options.setEtag).toHaveBeenCalledWith("etag-normalized-v4");
        expect(fixture.options.markClean).toHaveBeenCalled();
        expect(fixture.options.saveLocal).toHaveBeenCalledWith(
            expect.objectContaining({
                id: fixture.fileId,
                version: 4,
                etag: "etag-normalized-v4",
                isDirty: false,
            })
        );
    });

    it.each(["local", "server", "merge"] as const)(
        "resolves conflict using '%s' strategy with serverVersion anchors, closes dialog, and broadcasts resolution",
        async (strategy) => {
            const fixture = setup();
            const { result } = renderHook(() => useEditorConflict(fixture.options));

            // Establish an active conflict first
            await act(async () => {
                await result.current.handle412Conflict(
                    {
                        version: 8,
                        etag: "etag-server-v8",
                        content: "Server conflicting text",
                        updatedAt: "2026-10-13T12:00:00.000Z",
                    },
                    "Local conflicting text"
                );
            });
            expect(result.current.isConflictDialogOpen).toBe(true);

            // Sibling tab channel to capture cross-tab broadcast
            const siblingListener = new BroadcastChannel(getSyncChannelName());
            openChannels.push(siblingListener);
            const capturedBroadcasts: CrossTabSyncEvent[] = [];
            siblingListener.onmessage = (event: MessageEvent<CrossTabSyncEvent>) => {
                capturedBroadcasts.push(event.data);
            };

            vi.mocked(updateFileContent).mockResolvedValueOnce({
                success: true,
                version: 9,
                etag: "etag-resolved-v9",
            });

            const resolvedContent = `Resolved via ${strategy} strategy`;
            await act(async () => {
                await result.current.handleResolveConflict({
                    strategy,
                    content: resolvedContent,
                });
            });

            // Conditioned write MUST target conflict serverVersion anchors
            expect(updateFileContent).toHaveBeenCalledWith(fixture.fileId, resolvedContent, {
                expectedVersion: 8,
                expectedETag: "etag-server-v8",
            });

            expect(result.current.isConflictDialogOpen).toBe(false);
            expect(result.current.activeConflict).toBeNull();
            expect(result.current.isResolvingConflict).toBe(false);
            expect(result.current.isBlockedByConflict()).toBe(false);

            expect(fixture.options.setVersion).toHaveBeenCalledWith(9);
            expect(fixture.options.setEtag).toHaveBeenCalledWith("etag-resolved-v9");
            expect(fixture.options.setEditorContent).toHaveBeenCalledWith(resolvedContent);

            await waitFor(() => {
                expect(capturedBroadcasts.length).toBeGreaterThan(0);
            });
            expect(capturedBroadcasts[0]).toMatchObject({
                type: "conflict_resolved",
                fileId: fixture.fileId,
                version: 9,
                etag: "etag-resolved-v9",
            });
        }
    );

    it("preserves dirty state when live editor content differs from resolution content (LUGX-010)", async () => {
        const fixture = setup();
        const { result } = renderHook(() => useEditorConflict(fixture.options));

        await act(async () => {
            await result.current.handle412Conflict(
                {
                    version: 3,
                    etag: "etag-server-v3",
                    content: "Server text",
                },
                "Initial local text"
            );
        });

        vi.mocked(updateFileContent).mockImplementationOnce(async () => {
            // Simulate concurrent user keystrokes in the live editor while network write is in-flight
            vi.mocked(fixture.adapter.getValue).mockReturnValue("Concurrent user typing during resolution");
            return {
                success: true,
                version: 4,
                etag: "etag-resolved-v4",
            };
        });

        await act(async () => {
            await result.current.handleResolveConflict({
                strategy: "merge",
                content: "Static resolved merge",
            });
        });

        // LUGX-010 contract: markClean MUST NOT be called; markDirty MUST be called
        expect(fixture.options.markClean).not.toHaveBeenCalled();
        expect(fixture.options.markDirty).toHaveBeenCalled();
        expect(fixture.options.saveLocal).toHaveBeenCalledWith(
            expect.objectContaining({
                isDirty: true,
                version: 4,
            })
        );
    });

    it("does not call setEditorContent with stale content on resolution failure or repeated 412 (LUGX-013)", async () => {
        const fixture = setup();
        const { result } = renderHook(() => useEditorConflict(fixture.options));

        await act(async () => {
            await result.current.handle412Conflict(
                {
                    version: 5,
                    etag: "etag-server-v5",
                    content: "Server text v5",
                },
                "My current editor draft"
            );
        });

        vi.mocked(fixture.options.setEditorContent).mockClear();

        // Subcase A: Network error / server rejection
        vi.mocked(updateFileContent).mockResolvedValueOnce({
            success: false,
            error: "500 Internal Server Error",
        });

        await act(async () => {
            await result.current.handleResolveConflict({
                strategy: "local",
                content: "My current editor draft",
            });
        });

        expect(fixture.options.setEditorContent).not.toHaveBeenCalled();
        expect(fixture.options.setError).toHaveBeenCalledWith("500 Internal Server Error");
        expect(result.current.activeConflict).not.toBeNull();

        // Subcase B: Repeated 412 conflict returned during resolution write
        vi.mocked(updateFileContent).mockResolvedValueOnce({
            success: false,
            status: "conflict",
            serverVersion: {
                version: 6,
                etag: "etag-server-v6",
                content: "Stale concurrent update from third-party client",
                updatedAt: "2026-10-13T12:05:00.000Z",
            },
        });

        await act(async () => {
            await result.current.handleResolveConflict({
                strategy: "server",
                content: "Server text v5",
            });
        });

        expect(fixture.options.setEditorContent).not.toHaveBeenCalled();
        expect(result.current.activeConflict?.serverVersion.version).toBe(6);
        expect(result.current.activeConflict?.serverVersion.etag).toBe("etag-server-v6");
        expect(fixture.options.setError).toHaveBeenCalledWith(
            "حدث تعديل جديد على الخادم أثناء حل التعارض. يرجى المراجعة والتأكيد مجدداً."
        );
    });

    it("preserves dirty edits on cross-tab file_encrypted while marking clean when not dirty (LUGX-051)", async () => {
        const fixture = setup();
        renderHook(() => useEditorConflict(fixture.options));

        // Part 1: While DIRTY -> markClean must NOT be called
        fixture.state.isDirty = true;
        fixture.sendSiblingBroadcast({
            type: "file_encrypted",
            fileId: fixture.fileId,
            version: 7,
            etag: "etag-enc-v7",
            metadata: { algorithm: "AES-GCM-256", iv: "test-iv" },
            senderTabId: "sibling-tab-dirty-test",
        });

        await waitFor(() => {
            expect(fixture.options.setIsEncrypted).toHaveBeenCalledWith(true);
        });
        expect(fixture.options.setVersion).toHaveBeenCalledWith(7);
        expect(fixture.options.setEtag).toHaveBeenCalledWith("etag-enc-v7");
        expect(fixture.options.markClean).not.toHaveBeenCalled();

        vi.mocked(fixture.options.markClean).mockClear();

        // Part 2: While CLEAN -> markClean MUST be called
        fixture.state.isDirty = false;
        fixture.sendSiblingBroadcast({
            type: "file_encrypted",
            fileId: fixture.fileId,
            version: 8,
            etag: "etag-enc-v8",
            senderTabId: "sibling-tab-clean-test",
        });

        await waitFor(() => {
            expect(fixture.options.markClean).toHaveBeenCalled();
        });
        expect(fixture.options.setVersion).toHaveBeenCalledWith(8);
    });

    it("flushes dirty edits to saveLocal before cancelAutosave on cross-tab vault_locked, and blocks plaintext flush when key is missing (LUGX-049)", async () => {
        const fixture = setup();
        renderHook(() => useEditorConflict(fixture.options));

        // Part 1: Unencrypted file while dirty -> saveLocal with isDirty:true BEFORE cancelAutosave
        fixture.state.isDirty = true;
        fixture.state.isEncrypted = false;

        fixture.sendSiblingBroadcast({
            type: "vault_locked",
            senderTabId: "sibling-tab-lock-1",
        });

        await waitFor(() => {
            expect(fixture.options.cancelAutosave).toHaveBeenCalled();
        });
        expect(fixture.options.saveLocal).toHaveBeenCalledWith(
            expect.objectContaining({
                id: fixture.fileId,
                isDirty: true,
                isEncrypted: false,
            })
        );

        const saveOrder = vi.mocked(fixture.options.saveLocal).mock.invocationCallOrder[0];
        const cancelOrder = vi.mocked(fixture.options.cancelAutosave).mock.invocationCallOrder[0];
        expect(saveOrder).toBeDefined();
        expect(cancelOrder).toBeDefined();
        expect(saveOrder).toBeLessThan(cancelOrder);

        // Part 2: Encrypted file with missing master key -> NO plaintext saveLocal, NO markClean
        vi.mocked(fixture.options.saveLocal).mockClear();
        vi.mocked(fixture.options.cancelAutosave).mockClear();
        vi.mocked(fixture.options.markClean).mockClear();

        fixture.state.isDirty = true;
        fixture.state.isEncrypted = true;
        sessionKeyStore.lock(false); // Master key is strictly absent

        fixture.sendSiblingBroadcast({
            type: "vault_locked",
            senderTabId: "sibling-tab-lock-2",
        });

        await waitFor(() => {
            expect(fixture.options.cancelAutosave).toHaveBeenCalled();
        });
        expect(fixture.options.saveLocal).not.toHaveBeenCalled();
        expect(fixture.options.markClean).not.toHaveBeenCalled();
        expect(fixture.options.setIsVaultLocked).toHaveBeenCalledWith(true);
        expect(fixture.options.setIsUnlockModalOpen).toHaveBeenCalledWith(true);
    });

    it("retains local version when dirty on cross-tab file_saved, and adopts remote version when clean (LUGX-020)", async () => {
        const fixture = setup();
        renderHook(() => useEditorConflict(fixture.options));

        // Part 1: While DIRTY -> retains version anchors for optimistic conflict guard
        fixture.state.isDirty = true;
        vi.mocked(fixture.options.loadLocal).mockResolvedValueOnce({
            id: fixture.fileId,
            content: "Local dirty edits",
            version: 1,
            etag: "etag-v1",
            title: "Test Note",
            parentFolderId: null,
            isFolder: false,
            isDirty: true,
            isEncrypted: false,
            lastSyncedAt: Date.now(),
            lastModified: Date.now(),
        });

        fixture.sendSiblingBroadcast({
            type: "file_saved",
            fileId: fixture.fileId,
            version: 15,
            etag: "etag-remote-v15",
            senderTabId: "sibling-tab-save-dirty",
        });

        await waitFor(() => {
            expect(fixture.options.loadLocal).toHaveBeenCalledWith(fixture.fileId);
        });
        // Small delay to verify asynchronous callback did not call setVersion
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fixture.options.setVersion).not.toHaveBeenCalledWith(15);
        expect(fixture.options.setEditorContent).not.toHaveBeenCalled();

        // Part 2: While CLEAN -> adopts remote version, etag, and content atomically
        fixture.state.isDirty = false;
        vi.mocked(fixture.options.loadLocal).mockResolvedValueOnce({
            id: fixture.fileId,
            content: "Remote clean synced content",
            version: 16,
            etag: "etag-remote-v16",
            title: "Test Note",
            parentFolderId: null,
            isFolder: false,
            isDirty: false,
            isEncrypted: false,
            lastSyncedAt: Date.now(),
            lastModified: Date.now(),
        });

        fixture.sendSiblingBroadcast({
            type: "file_saved",
            fileId: fixture.fileId,
            version: 16,
            etag: "etag-remote-v16",
            senderTabId: "sibling-tab-save-clean",
        });

        await waitFor(() => {
            expect(fixture.options.setVersion).toHaveBeenCalledWith(16);
        });
        expect(fixture.options.setEtag).toHaveBeenCalledWith("etag-remote-v16");
        expect(fixture.options.markClean).toHaveBeenCalled();
        expect(fixture.options.setEditorContent).toHaveBeenCalledWith("Remote clean synced content");
    });

    it("ignores cross-tab events originating from the current tab and unsubscribes on unmount", async () => {
        const fixture = setup();
        const { unmount } = renderHook(() => useEditorConflict(fixture.options));

        // Part 1: Anti-echo filter (same currentTabId)
        fixture.sendSiblingBroadcast({
            type: "file_saved",
            fileId: fixture.fileId,
            version: 99,
            etag: "etag-echo-v99",
            senderTabId: currentTabId, // SAME TAB ID!
        });

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(fixture.options.loadLocal).not.toHaveBeenCalled();
        expect(fixture.options.setVersion).not.toHaveBeenCalled();

        // Part 2: Unmount teardown
        unmount();
        vi.mocked(fixture.options.loadLocal).mockClear();
        vi.mocked(fixture.options.cancelAutosave).mockClear();

        fixture.sendSiblingBroadcast({
            type: "vault_locked",
            senderTabId: "external-tab-after-unmount",
        });

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(fixture.options.cancelAutosave).not.toHaveBeenCalled();
        expect(fixture.options.saveLocal).not.toHaveBeenCalled();
    });

    it("performs silent automated 3-way merge on 412 when baseSnapshot is present and edits do not overlap", async () => {
        const baseDoc = "Line 1\nLine 2\nLine 3\nLine 4";
        const localDoc = "Line 1\nLine 2\nLine 3\nLine 4 local";
        const serverDoc = "Line 1\nLine 2 server\nLine 3\nLine 4";
        const expectedMerged = "Line 1\nLine 2 server\nLine 3\nLine 4 local";

        const fixture = setup({
            getVersion: vi.fn(() => 1),
            getEtag: vi.fn(() => "etag-v1"),
            getEditorContent: vi.fn(() => localDoc),
            loadLocal: vi.fn().mockResolvedValue({
                id: "file-conflict-test",
                content: localDoc,
                version: 1,
                etag: "etag-v1",
                isDirty: true,
                isEncrypted: false,
                baseSnapshot: {
                    content: baseDoc,
                    etag: "etag-base",
                    version: 1,
                    title: "Test File",
                    parentFolderId: null,
                },
            }),
        });

        vi.mocked(updateFileContent).mockResolvedValueOnce({
            success: true,
            version: 3,
            etag: "etag-merged-v3",
        });

        const { result } = renderHook(() => useEditorConflict(fixture.options));

        await act(async () => {
            await result.current.handle412Conflict(
                {
                    version: 2,
                    etag: "etag-server-v2",
                    content: serverDoc,
                    updatedAt: new Date().toISOString(),
                },
                localDoc
            );
        });

        // Verifications:
        // 1. Silent resolution: Dialog should NOT open and activeConflict should remain null
        expect(result.current.isConflictDialogOpen).toBe(false);
        expect(result.current.activeConflict).toBeNull();

        // 2. Automated push: Pushed merged content to server with expectedVersion 2
        expect(updateFileContent).toHaveBeenCalledWith(
            fixture.fileId,
            expectedMerged,
            expect.objectContaining({ expectedVersion: 2 })
        );

        // 3. Editor updated with merged content
        expect(fixture.options.setEditorContent).toHaveBeenCalledWith(expectedMerged);
        expect(fixture.options.setVersion).toHaveBeenCalledWith(3);
        expect(fixture.options.setEtag).toHaveBeenCalledWith("etag-merged-v3");
        expect(fixture.options.markClean).toHaveBeenCalled();
    });
});
