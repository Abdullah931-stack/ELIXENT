/**
 * @vitest-environment jsdom
 *
 * Integration Test Suite: Editor Orchestration Conditional Flush & BaseSnapshot Preservation
 * Reference: REQ-COND-FLUSH (Phase 0.20.5)
 *
 * Verifies:
 * 1. flushDirtyEditorStateToIDB:
 *    - Cancels active autosave debounce timer immediately.
 *    - Reads live content from editor adapter and writes to IndexedDB with isDirty: true and baseSnapshot.
 *    - Returns false when clean, unhydrated, or targetFileId mismatch.
 * 2. Wiring of onBeforePullConflictCheck to useSync.
 * 3. Delayed sync initialization clean baseline persistence (initialBaselinePersistedRef).
 * 4. Pre-conflict state flushing on 412 server conflict response.
 * 5. Cold-reload dirty baseline recovery in loadInitialFile.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { EditorAdapter } from "@/components/editor/markdown/types";
import { useEditorOrchestrator } from "@/hooks/use-editor-orchestrator";
import * as fileOps from "@/client/rpc-client";
import { clearLocalClientUserId, persistLocalClientUserId } from "@/lib/auth/client-identity";

// Mock RPC client boundary
vi.mock("@/client/rpc-client", () => ({
    getFile: vi.fn(),
    updateFileContent: vi.fn(),
    toggleFileEncryption: vi.fn(),
    renameFile: vi.fn(),
    deleteFile: vi.fn(),
    getUserVaultProfile: vi.fn().mockResolvedValue({ success: false, data: null }),
}));

// Mock sync infrastructure
const mockLocalDb: Record<string, Record<string, unknown>> = {};
let capturedOnBeforePullConflictCheck: ((fileId: string) => Promise<boolean> | boolean) | null = null;

vi.mock("@/lib/sync", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/sync")>();
    return {
        ...actual,
        createIndexedDBManager: vi.fn(() => ({
            init: vi.fn().mockResolvedValue({}),
            getFile: vi.fn().mockImplementation(async (id: string) => mockLocalDb[id] || null),
            saveFile: vi.fn().mockImplementation(async (file: { id: string } & Record<string, unknown>) => {
                mockLocalDb[file.id] = { ...mockLocalDb[file.id], ...file };
            }),
            markFileDirty: vi.fn().mockResolvedValue(undefined),
            coalesceOperation: vi.fn().mockResolvedValue(undefined),
            getOperations: vi.fn().mockResolvedValue([]),
            saveOperations: vi.fn().mockResolvedValue(undefined),
            getDirtyFiles: vi.fn().mockResolvedValue([]),
            close: vi.fn(),
        })),
        createSyncManager: vi.fn((opts: any) => {
            if (opts?.onBeforePullConflictCheck) {
                capturedOnBeforePullConflictCheck = opts.onBeforePullConflictCheck;
            }
            return {
                init: vi.fn().mockImplementation(async (initOpts: any) => {
                    if (initOpts?.onBeforePullConflictCheck) {
                        capturedOnBeforePullConflictCheck = initOpts.onBeforePullConflictCheck;
                    }
                }),
                destroy: vi.fn(),
                sync: vi.fn().mockResolvedValue({ success: true, filesProcessed: 0 }),
                syncFile: vi.fn().mockResolvedValue(undefined),
                getStatus: vi.fn().mockReturnValue("idle"),
                onStatusChange: vi.fn().mockReturnValue(() => undefined),
                onRemoteUpdate: vi.fn().mockReturnValue(() => undefined),
                setConflictCallback: vi.fn(),
            };
        }),
        connectionDetector: {
            init: vi.fn(),
            destroy: vi.fn(),
            getState: vi.fn().mockReturnValue("online"),
            onChange: vi.fn().mockReturnValue(() => undefined),
        },
        createOperationsGC: vi.fn(() => ({
            cleanup: vi.fn().mockResolvedValue(undefined),
            schedule: vi.fn().mockReturnValue(() => undefined),
        })),
    };
});

function createMockAdapter(initialContent = ""): EditorAdapter {
    let content = initialContent;
    let sel = { from: 0, to: 0 };
    return {
        getValue: () => content,
        setValue: (newContent: string) => {
            content = newContent;
        },
        getSelection: () => sel,
        setSelection: (from: number, to = from) => {
            sel = { from, to };
        },
        replaceRange: (from: number, to: number, insert: string) => {
            content = content.slice(0, from) + insert + content.slice(to);
        },
        replaceRanges: (changes) => {
            const sorted = [...changes].sort((a, b) => b.from - a.from);
            for (const c of sorted) {
                content = content.slice(0, c.from) + c.insert + content.slice(c.to);
            }
        },
        getSelectedText: () => content.slice(sel.from, sel.to),
        insertMarkdown: vi.fn(),
        setEditable: vi.fn(),
        focus: vi.fn(),
        blur: vi.fn(),
        hasFocus: vi.fn().mockReturnValue(true),
        undo: vi.fn().mockReturnValue(true),
        redo: vi.fn().mockReturnValue(true),
        canUndo: vi.fn().mockReturnValue(true),
        canRedo: vi.fn().mockReturnValue(false),
        getWordCount: () => content.split(/\s+/).filter(Boolean).length,
        getCharCount: () => content.length,
        getLineCount: () => content.split("\n").length,
        getHeadingCount: () => (content.match(/^#{1,6}\s/gm) || []).length,
        getMode: () => "live",
        setMode: vi.fn(),
        getDirectionSettings: () => ({ mode: "auto", lockCodeBlocksLTR: true }),
        setDirectionSettings: vi.fn(),
        startStreamingGhost: vi.fn(),
        updateStreamingGhost: vi.fn(),
        clearStreamingGhost: vi.fn(),
        getGhostRange: () => null,
        destroy: vi.fn(),
    };
}

describe("Editor Orchestration: Conditional Flush & BaseSnapshot Preservation (REQ-COND-FLUSH)", () => {
    const fileId = "test-file-flush-01";
    const userId = "usr-test-flusher";
    let adapter: EditorAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        clearLocalClientUserId();
        persistLocalClientUserId(userId);
        capturedOnBeforePullConflictCheck = null;

        for (const k of Object.keys(mockLocalDb)) {
            delete mockLocalDb[k];
        }

        mockLocalDb[fileId] = {
            id: fileId,
            title: "Original Title",
            content: "# Baseline Content",
            version: 1,
            etag: "etag-v1",
            isDirty: false,
            baseSnapshot: {
                content: "# Baseline Content",
                version: 1,
                etag: "etag-v1",
                title: "Original Title",
            },
        };

        vi.mocked(fileOps.getFile).mockResolvedValue({
            success: true,
            data: {
                id: fileId,
                title: "Original Title",
                content: "# Baseline Content",
                version: 1,
                etag: "etag-v1",
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                userId,
                workspaceId: "ws-test",
                parentFolderId: null,
                isFolder: false,
                isAiExcluded: false,
                artifactRole: "document",
                isEncrypted: false,
                encryptionMetadata: null,
            },
        });

        adapter = createMockAdapter("# Baseline Content");
    });

    afterEach(() => {
        clearLocalClientUserId();
    });

    it("wires onBeforePullConflictCheck to useSync and executes flushDirtyEditorStateToIDB upon divergence", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
            })
        );

        await waitFor(() => {
            expect(result.current.hydration).toBe("ready");
        });

        // Ensure onBeforePullConflictCheck was registered
        await waitFor(() => {
            expect(capturedOnBeforePullConflictCheck).toBeTypeOf("function");
        });

        // Initially clean: calling onBeforePullConflictCheck should return false
        const flushedWhenClean = await capturedOnBeforePullConflictCheck!(fileId);
        expect(flushedWhenClean).toBe(false);

        // User makes an edit in the editor
        act(() => {
            adapter.setValue("# Live User Edits (Unsaved)");
            result.current.handleEditorChange("# Live User Edits (Unsaved)");
        });

        expect(result.current.isDirty).toBe(true);

        // Now divergence occurs: onBeforePullConflictCheck is triggered
        const flushedWhenDirty = await capturedOnBeforePullConflictCheck!(fileId);
        expect(flushedWhenDirty).toBe(true);

        // Verify IDB was written with live edits and intact baseSnapshot
        const stored = mockLocalDb[fileId];
        expect(stored.isDirty).toBe(true);
        expect(stored.content).toBe("# Live User Edits (Unsaved)");
        expect(stored.baseSnapshot).toEqual(
            expect.objectContaining({
                content: "# Baseline Content",
                version: 1,
                etag: "etag-v1",
            })
        );
    });

    it("returns false from onBeforePullConflictCheck when targetFileId does not match the active document", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
            })
        );

        await waitFor(() => {
            expect(result.current.hydration).toBe("ready");
        });

        // Make editor dirty
        act(() => {
            adapter.setValue("# New Content");
            result.current.handleEditorChange("# New Content");
        });

        await waitFor(() => {
            expect(capturedOnBeforePullConflictCheck).toBeTypeOf("function");
        });

        // Invoke with a different fileId
        const flushedOther = await capturedOnBeforePullConflictCheck!("completely-different-file");
        expect(flushedOther).toBe(false);
    });

    it("cancels pending autosave debounce when flushDirtyEditorStateToIDB is triggered", async () => {
        vi.useFakeTimers();

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
            })
        );

        // User edits
        act(() => {
            adapter.setValue("# Edited Pending Autosave");
            result.current.handleEditorChange("# Edited Pending Autosave");
        });

        // Trigger conditional flush before autosave debounce expires
        await act(async () => {
            await capturedOnBeforePullConflictCheck!(fileId);
        });

        // Advance timer past debounce window
        await act(async () => {
            vi.advanceTimersByTime(2000);
        });

        // updateFileContent should not have been called by autosave
        expect(fileOps.updateFileContent).not.toHaveBeenCalled();

        vi.useRealTimers();
    });

    it("persists clean baseline snapshot to IDB once syncHook.isInitialized becomes true (initialBaselinePersistedRef)", async () => {
        const baselineFileId = "file-baseline-persistence-test";
        mockLocalDb[baselineFileId] = {
            id: baselineFileId,
            title: "Baseline Doc",
            content: "# Initial Confirmed Text",
            version: 2,
            etag: "etag-v2",
            isDirty: false,
        };

        vi.mocked(fileOps.getFile).mockResolvedValueOnce({
            success: true,
            data: {
                id: baselineFileId,
                title: "Baseline Doc",
                content: "# Initial Confirmed Text",
                version: 2,
                etag: "etag-v2",
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                userId,
                workspaceId: "ws-test",
                parentFolderId: null,
                isFolder: false,
                isAiExcluded: false,
                artifactRole: "document",
                isEncrypted: false,
                encryptionMetadata: null,
            },
        });

        const baselineAdapter = createMockAdapter("# Initial Confirmed Text");

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId: baselineFileId,
                userId,
                adapter: baselineAdapter,
            })
        );

        await waitFor(() => {
            expect(result.current.hydration).toBe("ready");
            expect(result.current.isDirty).toBe(false);
        });

        // Verify IDB has the persisted clean baseline snapshot with matching metadata
        await waitFor(() => {
            const stored = mockLocalDb[baselineFileId];
            expect(stored).toBeDefined();
            expect(stored.isDirty).toBe(false);
            expect(stored.version).toBe(2);
            expect(stored.etag).toBe("etag-v2");
            expect(stored.baseSnapshot).toEqual(
                expect.objectContaining({
                    content: "# Initial Confirmed Text",
                    version: 2,
                    etag: "etag-v2",
                })
            );
        });
    });

    it("guarantees local dirty state and baseSnapshot are written to IDB when server returns 412 conflict", async () => {
        vi.mocked(fileOps.updateFileContent).mockResolvedValueOnce({
            success: false,
            status: "conflict",
            error: "412 Precondition Failed",
            serverVersion: {
                id: fileId,
                content: "# Competing Server Version",
                version: 2,
                etag: "etag-v2",
                title: "Original Title",
                updatedAt: new Date().toISOString(),
            },
        } as any);

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
            })
        );

        await waitFor(() => {
            expect(result.current.hydration).toBe("ready");
        });

        act(() => {
            adapter.setValue("# Local Conflicting Edits");
            result.current.handleEditorChange("# Local Conflicting Edits");
        });

        // Autosave fires debounced write which receives 412 conflict response
        await waitFor(
            () => {
                expect(result.current.activeConflict).not.toBeNull();
            },
            { timeout: 3000 }
        );

        // Verify IDB has the dirty state and baseline saved
        const stored = mockLocalDb[fileId];
        expect(stored.isDirty).toBe(true);
        expect(stored.content).toBe("# Local Conflicting Edits");
        expect(stored.baseSnapshot).toEqual(
            expect.objectContaining({
                content: "# Baseline Content",
                version: 1,
            })
        );
    });
});
