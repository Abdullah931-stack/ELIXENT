/**
 * @vitest-environment jsdom
 *
 * AI Preview Explicit Decision & Multi-Hunk Ghost Model Tests (Phase 11 / Wave 11.1)
 *
 * Validates the preview_ready multi-hunk decision flow in `useAIStream`:
 * 1. Stream completion parks proposed hunks in `preview_ready` WITHOUT mutating
 *    the underlying document until the user explicitly accepts.
 * 2. `rejectPreview()` / `rejectAllGhostHunks()` keeps the document pristine
 *    and dismantles all ghost hunks without invoking any client-side financial RPC.
 * 3. `commitPreview()` / `acceptAllGhostHunks()` applies one atomic local transaction
 *    and notifies `onAllHunksAccepted` for coalesced debounced sync.
 * 4. `retryPreview()` clears active hunks and starts a fresh agent stream session.
 * 5. Dynamic coordinate remapping (`mapPos`) and granular collision eviction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
    CodeMirrorEditorAdapter,
    createEditorAdapter,
} from '@/components/editor/markdown/editor-adapter';
import { createMarkdownExtensions } from '@/components/editor/markdown/markdown-extensions';
import type { StreamHandlerOptions } from '@/lib/ai/stream-handler';
import { useAIStream } from '@/hooks/use-ai-stream';

const mockCommitAIFileOperation = vi.fn();

vi.mock('@/server/actions/ai-commit', () => ({
    commitAIFileOperation: (...args: unknown[]) => mockCommitAIFileOperation(...args),
}));

const mockConsumeAgentStream = vi.fn();
vi.mock('@/lib/ai/stream-handler', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/ai/stream-handler')>();
    return {
        ...actual,
        consumeAgentStream: (...args: unknown[]) => mockConsumeAgentStream(...args),
        consumeAIStream: (...args: unknown[]) => mockConsumeAgentStream(...args),
    };
});

describe('AI Preview Explicit Decision & Multi-Hunk Ghost Model (preview_ready)', () => {
    let editor: CodeMirrorEditorAdapter;
    let view: EditorView;
    let container: HTMLElement;
    const initialContent = 'The quick brown fox jumps over the lazy dog.';

    const renderAIStream = (onAllHunksAccepted = vi.fn(), onHunkAccepted = vi.fn()) =>
        renderHook(() =>
            useAIStream({
                onAllHunksAccepted,
                onHunkAccepted,
                onError: vi.fn(),
                onProgrammaticTransaction: (fn) => fn(),
            })
        );

    const startDefaultStream = async (
        result: { current: ReturnType<typeof useAIStream> },
        targetEditor: CodeMirrorEditorAdapter = editor,
        prompt = 'Improve the sentence clarity'
    ) => {
        await act(async () => {
            await result.current.startStream({
                editor: targetEditor,
                prompt,
                fileId: 'file-1',
                expectedVersion: 1,
                originalEtag: 'etag-v1',
                editorGeneration: 1,
            });
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();

        if (typeof Range.prototype.getClientRects !== 'function') {
            Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        }
        if (typeof Range.prototype.getBoundingClientRect !== 'function') {
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

        mockConsumeAgentStream.mockImplementation(async (options: StreamHandlerOptions) => {
            options.onStart?.({
                type: 'start',
                sessionId: 's',
                threadId: 'thread-1',
                operationId: 'op',
            });
            options.onUpdate?.({
                type: 'update',
                chunk: {
                    stage: 'document_writer_node',
                    hunks: [
                        {
                            hunkId: 'hunk-1',
                            headingSlug: 'overview',
                            from: 0,
                            to: initialContent.length,
                            replacementText: 'Better text',
                            operation: 'translate',
                        },
                    ],
                },
            });
            options.onDone?.({
                type: 'done',
                threadId: 'thread-1',
                operationId: 'op',
            });
        });

        container = document.createElement('div');
        document.body.appendChild(container);

        const state = EditorState.create({
            doc: initialContent,
            extensions: createMarkdownExtensions({ mode: 'live' }),
        });
        view = new EditorView({ state, parent: container });
        editor = new CodeMirrorEditorAdapter(view);
    });

    it('parks the result in preview_ready without any commit or document mutation', async () => {
        const snapshotBefore = editor.getValue();
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        expect(mockCommitAIFileOperation).not.toHaveBeenCalled();
        expect(editor.getValue()).toBe(snapshotBefore);
        expect(result.current.previewText).toBe('Better text');
        expect(result.current.activeGhostHunks).toHaveLength(1);
    });

    it('rejectPreview dismantles ghost hunks, keeps document untouched, and never triggers client financial RPCs', async () => {
        const snapshotBefore = editor.getValue();
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        act(() => {
            result.current.rejectPreview();
        });

        expect(mockCommitAIFileOperation).not.toHaveBeenCalled();
        expect(editor.getValue()).toBe(snapshotBefore);
        expect(result.current.previewText).toBe('');
        expect(result.current.activeGhostHunks).toHaveLength(0);
    });

    it('commitPreview / acceptAllGhostHunks applies one atomic local replace and triggers onAllHunksAccepted', async () => {
        const onAllHunksAccepted = vi.fn();
        const { result } = renderAIStream(onAllHunksAccepted);

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        await act(async () => {
            await result.current.commitPreview();
        });

        expect(onAllHunksAccepted).toHaveBeenCalledTimes(1);
        expect(onAllHunksAccepted).toHaveBeenCalledWith('Better text');
        expect(mockCommitAIFileOperation).not.toHaveBeenCalled();

        expect(editor.getValue()).toContain('Better text');
        expect(result.current.status).toBe('completed');
        expect(result.current.previewText).toBe('');
        expect(result.current.activeGhostHunks).toHaveLength(0);
    });

    it('retryPreview clears previous hunks and starts a fresh agent stream session', async () => {
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        mockConsumeAgentStream.mockClear();

        await act(async () => {
            await result.current.retryPreview();
        });

        expect(mockConsumeAgentStream).toHaveBeenCalledTimes(1);
    });

    it('stopStream mid-generation aborts immediately and leaves document pristine', async () => {
        mockConsumeAgentStream.mockImplementation(async (options: StreamHandlerOptions) => {
            options.onStart?.({
                type: 'start',
                sessionId: 's',
                threadId: 'thread-1',
                operationId: 'op',
            });
            options.onUpdate?.({
                type: 'update',
                chunk: {
                    stage: 'document_writer_node',
                    hunks: [
                        {
                            hunkId: 'hunk-1',
                            headingSlug: 'overview',
                            from: 0,
                            to: 10,
                            replacementText: 'Partial ',
                        },
                    ],
                },
            });
        });
        const snapshotBefore = editor.getValue();
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('streaming_hunks'));

        act(() => {
            result.current.stopStream();
        });

        expect(editor.getValue()).toBe(snapshotBefore);
        expect(result.current.status).toBe('aborted');
    });

    describe('Markdown EditorAdapter & Dynamic Ghost Range Shifting', () => {
        it('dynamically maps ghost range forward when user edits document outside hunk range and accepts accurately', async () => {
            const initialText = 'Line 1: Prefix text.\nLine 2: TARGET_TO_IMPROVE.\nLine 3: Suffix text.';
            const testContainer = document.createElement('div');
            document.body.appendChild(testContainer);

            const state = EditorState.create({
                doc: initialText,
                extensions: createMarkdownExtensions({ mode: 'live' }),
            });
            const testView = new EditorView({ state, parent: testContainer });
            const adapter = createEditorAdapter(testView);

            const targetStart = initialText.indexOf('TARGET_TO_IMPROVE');
            const targetEnd = targetStart + 'TARGET_TO_IMPROVE'.length;
            adapter.setSelection(targetStart, targetEnd);

            mockConsumeAgentStream.mockImplementationOnce(async (options: StreamHandlerOptions) => {
                options.onStart?.({
                    type: 'start',
                    sessionId: 's-cm-1',
                    threadId: 'thread-cm-1',
                    operationId: 'op-cm-1',
                });
                options.onUpdate?.({
                    type: 'update',
                    chunk: {
                        stage: 'document_writer_node',
                        hunks: [
                            {
                                hunkId: 'hunk-cm-1',
                                headingSlug: 'target-section',
                                from: targetStart,
                                to: targetEnd,
                                replacementText: 'Better text',
                            },
                        ],
                    },
                });
                options.onDone?.({
                    type: 'done',
                    threadId: 'thread-cm-1',
                    operationId: 'op-cm-1',
                });
            });

            const onAllHunksAccepted = vi.fn();
            const { result } = renderAIStream(onAllHunksAccepted);

            await act(async () => {
                await result.current.startStream({
                    editor: adapter,
                    prompt: 'Improve target line',
                    fileId: 'file-cm-1',
                    expectedVersion: 1,
                    originalEtag: 'etag-v1',
                    editorGeneration: 1,
                });
            });

            await waitFor(() => expect(result.current.status).toBe('preview_ready'));

            const ghostRangeBefore = adapter.getGhostRange?.();
            expect(ghostRangeBefore).toEqual({ from: targetStart, to: targetEnd });

            // Concurrent user edit BEFORE the hunk range
            const prefixAddition = 'EXTRA_PREFIX_CHARS!!';
            testView.dispatch({
                changes: { from: 0, to: 0, insert: prefixAddition },
            });

            // StateField automatically shifts ghost range forward by prefixAddition.length
            const ghostRangeAfter = adapter.getGhostRange?.();
            expect(ghostRangeAfter).toEqual({
                from: targetStart + prefixAddition.length,
                to: targetEnd + prefixAddition.length,
            });

            await act(async () => {
                await result.current.commitPreview();
            });

            expect(result.current.status).toBe('completed');
            expect(onAllHunksAccepted).toHaveBeenCalledTimes(1);

            const currentDoc = adapter.getValue();
            expect(currentDoc).toContain(prefixAddition);
            expect(currentDoc).toContain('Better text');
            expect(currentDoc).not.toContain('TARGET_TO_IMPROVE');

            testView.destroy();
            testContainer.remove();
        });

        it('immediately aborts stream and clears ghost when user edits directly inside the target range', async () => {
            const initialText = 'Line 1: Prefix text.\nLine 2: TARGET_TO_IMPROVE.\nLine 3: Suffix text.';
            const testContainer = document.createElement('div');
            document.body.appendChild(testContainer);

            const state = EditorState.create({
                doc: initialText,
                extensions: createMarkdownExtensions({ mode: 'live' }),
            });
            const testView = new EditorView({ state, parent: testContainer });
            const adapter = createEditorAdapter(testView);

            const targetStart = initialText.indexOf('TARGET_TO_IMPROVE');
            const targetEnd = targetStart + 'TARGET_TO_IMPROVE'.length;
            adapter.setSelection(targetStart, targetEnd);

            mockConsumeAgentStream.mockImplementationOnce(async (options: StreamHandlerOptions) => {
                options.onStart?.({
                    type: 'start',
                    sessionId: 's-cm-2',
                    threadId: 'thread-cm-2',
                    operationId: 'op-cm-2',
                });
                options.onUpdate?.({
                    type: 'update',
                    chunk: {
                        stage: 'document_writer_node',
                        hunks: [
                            {
                                hunkId: 'hunk-cm-2',
                                headingSlug: 'target-section',
                                from: targetStart,
                                to: targetEnd,
                                replacementText: 'Better text',
                            },
                        ],
                    },
                });
                options.onDone?.({
                    type: 'done',
                    threadId: 'thread-cm-2',
                    operationId: 'op-cm-2',
                });
            });

            const { result } = renderAIStream();

            await act(async () => {
                await result.current.startStream({
                    editor: adapter,
                    prompt: 'Improve target line',
                    fileId: 'file-cm-2',
                    expectedVersion: 1,
                    originalEtag: 'etag-v1',
                    editorGeneration: 1,
                });
            });

            await waitFor(() => expect(result.current.status).toBe('preview_ready'));
            expect(adapter.getGhostRange?.()).toEqual({ from: targetStart, to: targetEnd });

            // Direct colliding edit inside the target hunk range
            testView.dispatch({
                changes: { from: targetStart + 2, to: targetStart + 8, insert: 'MODIFIED' },
            });

            expect(adapter.getGhostRange?.()).toBeNull();
            await waitFor(() => expect(result.current.status).toBe('aborted'));

            testView.destroy();
            testContainer.remove();
        });

        it('renders unified inline widget with interactive buttons and triggers accept on click', async () => {
            const testContainer = document.createElement('div');
            document.body.appendChild(testContainer);

            const docText = 'Original text to translate';
            const state = EditorState.create({
                doc: docText,
                extensions: createMarkdownExtensions({ mode: 'live' }),
            });
            const testView = new EditorView({ state, parent: testContainer });
            const adapter = createEditorAdapter(testView);

            mockConsumeAgentStream.mockImplementationOnce(async (options: StreamHandlerOptions) => {
                options.onStart?.({
                    type: 'start',
                    sessionId: 's-widget-1',
                    threadId: 'thread-widget-1',
                    operationId: 'op-widget-1',
                });
                options.onUpdate?.({
                    type: 'update',
                    chunk: {
                        stage: 'document_writer_node',
                        hunks: [
                            {
                                hunkId: 'hunk-widget-1',
                                headingSlug: 'translate-section',
                                from: 0,
                                to: docText.length,
                                replacementText: 'Better text',
                                operation: 'translate',
                            },
                        ],
                    },
                });
                options.onDone?.({
                    type: 'done',
                    threadId: 'thread-widget-1',
                    operationId: 'op-widget-1',
                });
            });

            const onHunkAccepted = vi.fn();
            const { result } = renderAIStream(vi.fn(), onHunkAccepted);

            await act(async () => {
                await result.current.startStream({
                    editor: adapter,
                    prompt: 'Translate section',
                    fileId: 'file-widget-1',
                    expectedVersion: 1,
                    originalEtag: 'etag-1',
                    editorGeneration: 1,
                });
            });

            await waitFor(() => expect(result.current.status).toBe('preview_ready'));

            await waitFor(() => {
                const el = testContainer.querySelector('.cm-ai-ghost-widget');
                expect(el).not.toBeNull();
                expect(el?.textContent).toContain('معاينة الذكاء الاصطناعي (translate)');
            });

            const widgetElement = testContainer.querySelector<HTMLElement>('.cm-ai-ghost-widget');
            expect(widgetElement).not.toBeNull();

            const buttons = widgetElement!.querySelectorAll<HTMLButtonElement>('button');
            const applyBtn = Array.from(buttons).find((b) =>
                b.textContent?.includes('تطبيق التعديل')
            );
            expect(applyBtn).toBeDefined();

            await act(async () => {
                applyBtn?.click();
            });

            await waitFor(() => expect(result.current.status).toBe('completed'));
            expect(onHunkAccepted).toHaveBeenCalledTimes(1);
            expect(adapter.getValue()).toBe('Better text');

            testView.destroy();
            testContainer.remove();
        });
    });
});
