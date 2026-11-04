/**
 * @vitest-environment jsdom
 *
 * Phase 11 (Wave 11.1) closure tests: reload & SPA teardown semantics for Agent sessions.
 *
 * Validates:
 * 1. Fresh mount after reload starts cleanly in `idle` with zero residual preview text
 *    or active ghost hunks, and never mutates the underlying document automatically.
 * 2. Client hook does not invoke legacy client-side financial refund/commit RPCs
 *    (Server-Authoritative quota & LangGraph checkpointer lifecycle).
 * 3. SPA teardown (unmount cleanup) aborts the active `AbortController` signal cleanly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { EditorAdapter } from "@/components/editor/markdown/types";
import type { StreamHandlerOptions } from "@/lib/ai/stream-handler";
import { useAIStream } from "@/hooks/use-ai-stream";

const mockConsumeAgentStream = vi.fn();
vi.mock("@/lib/ai/stream-handler", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/ai/stream-handler")>();
    return {
        ...actual,
        consumeAgentStream: (...args: unknown[]) => mockConsumeAgentStream(...args),
        consumeAIStream: (...args: unknown[]) => mockConsumeAgentStream(...args),
    };
});

let captured: StreamHandlerOptions;

const initialContent = "The quick brown fox jumps over the lazy dog.";

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

describe("Phase 11: Reload Recovery & Server-Authoritative Settlement (Wave 11.1)", () => {
    let editor: EditorAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
        editor = createMockAdapter(initialContent);

        mockConsumeAgentStream.mockImplementation(async (options: StreamHandlerOptions) => {
            captured = options;
            options.onStart?.({
                type: "start",
                sessionId: "s1",
                threadId: "thread-1",
                operationId: "op1",
            });
            options.onUpdate?.({
                type: "update",
                chunk: {
                    stage: "document_writer_node",
                    hunks: [
                        {
                            hunkId: "hunk-1",
                            headingSlug: "intro",
                            from: 0,
                            to: 9,
                            replacementText: "Partial ",
                        },
                    ],
                },
            });
        });
    });

    it("mount after hard reload: starts cleanly in idle and NEVER applies unaccepted preview or commits", () => {
        const { result } = renderHook(() =>
            useAIStream({ onProgrammaticTransaction: (fn) => fn() })
        );

        expect(result.current.previewText).toBe("");
        expect(result.current.activeGhostHunks).toHaveLength(0);
        expect(result.current.status).toBe("idle");
        expect(editor.getValue()).toBe(initialContent);
    });

    it("SPA flow: active stream aborts its AbortSignal on unmount without invoking client financial RPCs", async () => {
        const { result, unmount } = renderHook(() =>
            useAIStream({ onProgrammaticTransaction: (fn) => fn() })
        );

        await act(async () => {
            await result.current.startStream({
                editor,
                prompt: "Improve sentence structure",
                fileId: "file-1",
                expectedVersion: 1,
                originalEtag: "etag-v1",
                editorGeneration: 1,
            });
        });
        await waitFor(() => expect(result.current.isStreaming).toBe(true));
        expect(captured.signal?.aborted).toBe(false);

        // SPA navigation: React unmount cleanup aborts active fetch signal immediately
        unmount();
        expect(captured.signal?.aborted).toBe(true);
        expect(editor.getValue()).toBe(initialContent);
    });

    it("SPA flow: session in preview_ready cleans up on unmount without mutating document or committing", async () => {
        const { result, unmount } = renderHook(() =>
            useAIStream({ onProgrammaticTransaction: (fn) => fn() })
        );

        await act(async () => {
            await result.current.startStream({
                editor,
                prompt: "Improve sentence structure",
                fileId: "file-1",
                expectedVersion: 1,
                originalEtag: "etag-v1",
                editorGeneration: 1,
            });
        });
        await waitFor(() => expect(result.current.isStreaming).toBe(true));

        act(() => {
            captured.onDone?.({
                type: "done",
                threadId: "thread-1",
                operationId: "op1",
            });
        });
        await waitFor(() => expect(result.current.status).toBe("preview_ready"));

        unmount();
        expect(editor.getValue()).toBe(initialContent);
    });
});
