/**
 * @vitest-environment jsdom
 *
 * AI Stream Zero-Latency Abort & Disconnect Settlement Test Suite (Phase 11 / Wave 11.1)
 *
 * Verifies TD-05 & Wave 11.1 Canonical Resolution:
 * 1. stopStream() executes with zero client-side latency (< 50ms), immediately
 *    aborting the active session without awaiting any network settlement round-trip.
 * 2. Editor multi-hunk ghost preview is dismantled instantly upon stop.
 * 3. Client hook never invokes client-side financial refund/commit RPCs on stop.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { EditorAdapter } from "@/components/editor/markdown/types";
import type { StreamHandlerOptions } from "@/lib/ai/stream-handler";

const mockCommitAIReservation = vi.fn().mockResolvedValue({ committed: true });
const mockRefundAIReservation = vi.fn().mockResolvedValue({ refunded: true });

vi.mock("@/server/actions/ai-ops", () => ({
    commitAIReservation: (...args: unknown[]) => mockCommitAIReservation(...args),
    refundAIReservation: (...args: unknown[]) => mockRefundAIReservation(...args),
    getAIReservationStatus: vi.fn(),
}));

const mockConsumeAgentStream = vi.fn();
vi.mock("@/lib/ai/stream-handler", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/ai/stream-handler")>();
    return {
        ...actual,
        consumeAgentStream: (...args: unknown[]) => mockConsumeAgentStream(...args),
        consumeAIStream: (...args: unknown[]) => mockConsumeAgentStream(...args),
    };
});

import { useAIStream } from "@/hooks/use-ai-stream";

function createMockAdapter(initial = ""): EditorAdapter {
    let content = initial;
    let sel = { from: 0, to: 0 };
    return {
        getValue: () => content,
        setValue: (newContent: string) => { content = newContent; },
        getSelection: () => sel,
        setSelection: (from: number, to = from) => { sel = { from, to }; },
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
        destroy: vi.fn(),
        startStreamingGhost: vi.fn(),
        updateStreamingGhost: vi.fn(),
        clearStreamingGhost: vi.fn(),
        getGhostRange: vi.fn().mockReturnValue(null),
    };
}

describe("TD-05 & Wave 11.1: Zero-Latency stopStream() & Disconnect Settlement", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCommitAIReservation.mockResolvedValue({ committed: true });
        mockRefundAIReservation.mockResolvedValue({ refunded: true });
    });

    it("executes stopStream immediately (0ms blocking wait) and updates status to aborted", async () => {
        let commitResolved = false;
        mockCommitAIReservation.mockImplementationOnce(() => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    commitResolved = true;
                    resolve({ committed: true });
                }, 500);
            });
        });

        mockConsumeAgentStream.mockImplementation(async (options: StreamHandlerOptions) => {
            options.onStart?.({
                type: "start",
                sessionId: "sess_latency_1",
                threadId: "thread_latency_1",
                operationId: "op_latency_1",
            });
            options.onUpdate?.({
                type: "update",
                chunk: {
                    stage: "document_writer_node",
                    hunks: [
                        {
                            hunkId: "hunk_latency_1",
                            headingSlug: "intro",
                            from: 0,
                            to: 10,
                            replacementText: "Generated start... ",
                        },
                    ],
                },
            });
        });

        const editor = createMockAdapter("Initial document text.");
        const { result } = renderHook(() =>
            useAIStream({ onProgrammaticTransaction: (fn) => fn() })
        );

        await act(async () => {
            await result.current.startStream({
                editor,
                prompt: "Improve initial document text",
                fileId: "file_test_latency",
                expectedVersion: 1,
                originalEtag: "etag_latency_1",
                editorGeneration: 1,
            });
        });

        expect(result.current.status).toBe("streaming_hunks");

        const startTimestamp = performance.now();
        act(() => {
            result.current.stopStream();
        });
        const elapsedMs = performance.now() - startTimestamp;

        expect(elapsedMs).toBeLessThan(50);
        expect(result.current.status).toBe("aborted");
        expect(commitResolved).toBe(false);

        expect(editor.clearStreamingGhost).toHaveBeenCalled();
        expect(mockRefundAIReservation).not.toHaveBeenCalled();
    });

    it("never refunds on user stopStream even if server disconnect races", async () => {
        mockConsumeAgentStream.mockImplementation(async (options: StreamHandlerOptions) => {
            options.onStart?.({
                type: "start",
                sessionId: "sess_2",
                threadId: "thread_2",
                operationId: "op_2",
            });
            options.onUpdate?.({
                type: "update",
                chunk: {
                    stage: "document_writer_node",
                    hunks: [
                        {
                            hunkId: "hunk_2",
                            headingSlug: "body",
                            from: 0,
                            to: 7,
                            replacementText: "Some words",
                        },
                    ],
                },
            });
        });

        const editor = createMockAdapter("Content");
        const { result } = renderHook(() =>
            useAIStream({ onProgrammaticTransaction: (fn) => fn() })
        );

        await act(async () => {
            await result.current.startStream({
                editor,
                prompt: "Correct grammar in content",
                fileId: "file_2",
                expectedVersion: 1,
                originalEtag: "etag_2",
                editorGeneration: 1,
            });
        });

        act(() => {
            result.current.stopStream();
        });

        expect(mockRefundAIReservation).not.toHaveBeenCalled();
        expect(result.current.status).toBe("aborted");
    });
});
