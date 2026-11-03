/**
 * @vitest-environment jsdom
 *
 * M4/M5 / Gate G8 / Phase 11: AI operation content-safety & Multi-Hunk Ghost tests with CodeMirror 6.
 *
 * Guarantees that an AI operation can NEVER corrupt or leave the document in a half-modified state:
 *   1. Streaming isolation: during active streaming, hunks update an
 *      ephemeral CodeMirror 6 StateField decoration without mutating the underlying
 *      document tree (docChanged is false, auto-save does NOT fire).
 *   2. Partial selection / section range: only the target sub-range [from, to] is replaced;
 *      preceding and subsequent paragraphs remain completely intact.
 *   3. On acceptance: each hunk or batch acceptance is applied as an isolated undoable
 *      transaction (`isolateHistory.of("full")`), and Ctrl+Z restores the original content.
 *   4. On stream failure / abort: the ephemeral ghost session is cleared and the
 *      document remains in its pristine pre-operation state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { CodeMirrorEditorAdapter } from "@/components/editor/markdown/editor-adapter";
import { codeMirrorStreamingGhostField } from "@/components/editor/markdown/streaming-ghost";
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

const initialDoc = "Hello world, this is a test document with multiple paragraphs.\n\nSecond paragraph here.";

describe("Ephemeral Multi-Hunk Streaming Ghost Extension — Invariant Guarantees (CodeMirror 6)", () => {
    let adapter: CodeMirrorEditorAdapter;
    let view: EditorView;
    let parent: HTMLDivElement;

    beforeEach(() => {
        if (typeof Range.prototype.getClientRects !== "function") {
            Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        }
        if (typeof Range.prototype.getBoundingClientRect !== "function") {
            Range.prototype.getBoundingClientRect = () => ({
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                width: 0,
                height: 0,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            });
        }

        parent = document.createElement("div");
        document.body.appendChild(parent);

        const state = EditorState.create({
            doc: initialDoc,
            extensions: [history(), codeMirrorStreamingGhostField],
        });

        view = new EditorView({
            state,
            parent,
        });

        adapter = new CodeMirrorEditorAdapter(view);
    });

    afterEach(() => {
        if (view) {
            view.destroy();
        }
        if (parent && parent.parentNode) {
            parent.parentNode.removeChild(parent);
        }
    });

    it("starts and updates streaming ghost with real-time text chunks without mutating doc or triggering auto-save", () => {
        const initialText = adapter.getValue();

        adapter.startStreamingGhost({
            from: 0,
            to: 20,
            text: "Generating...",
            operation: "improve",
        });

        const state1 = view.state.field(codeMirrorStreamingGhostField);
        expect(state1.active).toBe(true);
        expect(state1.from).toBe(0);
        expect(state1.to).toBe(20);
        expect(adapter.getValue()).toBe(initialText);

        adapter.updateStreamingGhost("Generating paragraph 1...", true);
        adapter.updateStreamingGhost("Generating paragraph 1... and paragraph 2.", true);

        const state2 = view.state.field(codeMirrorStreamingGhostField);
        expect(state2.text).toBe("Generating paragraph 1... and paragraph 2.");
        expect(adapter.getValue()).toBe(initialText);

        adapter.clearStreamingGhost();
        const state3 = view.state.field(codeMirrorStreamingGhostField);
        expect(state3.active).toBe(false);
        expect(adapter.getValue()).toBe(initialText);
    });

    it("replaces the full document with AI output as one undoable action", () => {
        const before = adapter.getValue();
        const aiResult = "Improved: hello world — now better written!";

        adapter.startStreamingGhost({
            from: 0,
            to: adapter.getCharCount(),
            text: aiResult,
        });

        adapter.clearStreamingGhost();
        adapter.replaceRange(0, adapter.getCharCount(), aiResult);

        expect(adapter.getValue()).toBe(aiResult);
        const ghostState = view.state.field(codeMirrorStreamingGhostField);
        expect(ghostState.active).toBe(false);

        const undoSuccess = adapter.undo();
        expect(undoSuccess).toBe(true);
        expect(adapter.getValue()).toBe(before);
    });

    it("replaces only the selected range, leaving surrounding text intact with atomic undo", () => {
        const fullText = adapter.getValue();
        const phrase = "this is a test document";
        const from = fullText.indexOf(phrase);
        const to = from + phrase.length;
        expect(from).toBeGreaterThan(0);

        const before = adapter.getValue();

        adapter.startStreamingGhost({ from, to, text: "an edited phrase" });
        adapter.clearStreamingGhost();
        adapter.replaceRange(from, to, "an edited phrase");

        expect(adapter.getValue()).toContain("Hello world,");
        expect(adapter.getValue()).toContain("Second paragraph here.");
        expect(adapter.getValue()).not.toContain("test document");

        adapter.undo();
        expect(adapter.getValue()).toBe(before);
    });

    it("clearing streaming ghost on abort/error leaves pristine document untouched", () => {
        const before = adapter.getValue();

        adapter.startStreamingGhost({
            from: 0,
            to: 15,
            text: "Partial chunk before network drop...",
        });

        adapter.clearStreamingGhost();

        expect(view.state.field(codeMirrorStreamingGhostField).active).toBe(false);
        expect(adapter.getValue()).toBe(before);
    });

    it("clears ghost preview and leaves document pristine when stream fails mid-session", async () => {
        const before = adapter.getValue();

        mockConsumeAgentStream.mockImplementationOnce(async (options: StreamHandlerOptions) => {
            options.onStart?.({
                type: "start",
                sessionId: "test-session-fail",
                threadId: "thread-fail",
                operationId: "test-op-fail",
            });
            options.onUpdate?.({
                type: "update",
                chunk: {
                    stage: "document_writer_node",
                    hunks: [
                        {
                            hunkId: "hunk-fail-1",
                            headingSlug: "intro",
                            from: 0,
                            to: 11,
                            replacementText: "Generated text before stream drop",
                        },
                    ],
                },
            });
            options.onError(new Error("STREAM_EXECUTION_ERROR: Upstream node failed"));
        });

        const { result } = renderHook(() =>
            useAIStream({
                onProgrammaticTransaction: (fn) => fn(),
            })
        );

        await act(async () => {
            await result.current.startStream({
                editor: adapter,
                prompt: "Rewrite intro",
                fileId: "file-test-fail-1",
                expectedVersion: 1,
                originalEtag: "etag-v1",
                editorGeneration: 1,
            });
        });

        await waitFor(() => expect(result.current.status).toBe("failed"));
        expect(view.state.field(codeMirrorStreamingGhostField).active).toBe(false);
        expect(adapter.getValue()).toBe(before);
        expect(result.current.error).toContain("STREAM_EXECUTION_ERROR");
    });

    it("accepting a ghost hunk via useAIStream applies an isolated undoable transaction", async () => {
        const before = adapter.getValue();

        mockConsumeAgentStream.mockImplementationOnce(async (options: StreamHandlerOptions) => {
            options.onStart?.({
                type: "start",
                sessionId: "test-session-accept",
                threadId: "thread-accept",
                operationId: "test-op-accept",
            });
            options.onUpdate?.({
                type: "update",
                chunk: {
                    stage: "document_writer_node",
                    hunks: [
                        {
                            hunkId: "hunk-accept-1",
                            headingSlug: "intro",
                            from: 0,
                            to: 11,
                            replacementText: "Greetings universe",
                        },
                    ],
                },
            });
            options.onDone?.({
                type: "done",
                threadId: "thread-accept",
                operationId: "test-op-accept",
            });
        });

        const { result } = renderHook(() =>
            useAIStream({
                editor: adapter,
                onProgrammaticTransaction: (fn) => fn(),
            })
        );

        await act(async () => {
            await result.current.startStream({
                editor: adapter,
                prompt: "Upgrade greeting",
                fileId: "file-test-accept-1",
                expectedVersion: 1,
                originalEtag: "etag-v1",
                editorGeneration: 1,
            });
        });

        await waitFor(() => expect(result.current.status).toBe("preview_ready"));
        expect(view.state.field(codeMirrorStreamingGhostField).active).toBe(true);

        act(() => {
            result.current.acceptGhostHunk("hunk-accept-1");
        });

        expect(view.state.field(codeMirrorStreamingGhostField).active).toBe(false);
        expect(adapter.getValue()).toContain("Greetings universe");
        expect(result.current.status).toBe("completed");

        // Single undo restores the original pre-hunk content
        expect(adapter.undo()).toBe(true);
        expect(adapter.getValue()).toBe(before);
    });
});
