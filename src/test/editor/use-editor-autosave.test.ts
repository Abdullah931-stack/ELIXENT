/**
 * @vitest-environment jsdom
 *
 * useEditorAutosave contract tests (Phase 17 extraction).
 *
 * Validates the frozen hook contract:
 * 1. Debounced persistence with latest content and target fileId.
 * 2. Coalescing of rapid edits into a single write.
 * 3. Suspension while the AI write lock is held or the editor is blocked,
 *    with resumption once the lock is released.
 * 4. Timer cancellation on fileId change, unmount, and explicit cancel.
 * 5. Unmount flush only when dirty.
 *
 * All collaborators (persist, flushOnUnmount, getContent, isBlocked, onUserEdit)
 * are injected callbacks; no modules are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
    useEditorAutosave,
    type UseEditorAutosaveOptions,
} from "../../hooks/use-editor-autosave";

const DEBOUNCE_MS = 500;

type HookProps = Pick<UseEditorAutosaveOptions, "fileId" | "isWriteLocked">;

function setup(initialProps: HookProps = { fileId: "file-a", isWriteLocked: false }) {
    const editor = { content: "" as string | null, blocked: false };
    const persist = vi.fn<UseEditorAutosaveOptions["persist"]>().mockResolvedValue(undefined);
    const flushOnUnmount = vi.fn<UseEditorAutosaveOptions["flushOnUnmount"]>();
    const onUserEdit = vi.fn<NonNullable<UseEditorAutosaveOptions["onUserEdit"]>>();

    const hook = renderHook(
        (props: HookProps) =>
            useEditorAutosave({
                ...props,
                debounceMs: DEBOUNCE_MS,
                isBlocked: () => editor.blocked,
                persist,
                flushOnUnmount,
                getContent: () => editor.content,
                onUserEdit,
            }),
        { initialProps },
    );

    /** Simulates a user keystroke: the adapter content changes, then the change handler fires. */
    const edit = (content: string) => {
        editor.content = content;
        act(() => hook.result.current.handleEditorChange(content));
    };

    const advance = async (ms: number) => {
        await act(async () => {
            vi.advanceTimersByTime(ms);
        });
    };

    return { hook, editor, persist, flushOnUnmount, onUserEdit, edit, advance };
}

describe("useEditorAutosave", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("persists latest content for the current file once the debounce expires", async () => {
        const { persist, edit, advance } = setup();

        edit("hello");
        await advance(DEBOUNCE_MS - 1);
        expect(persist).not.toHaveBeenCalled();

        await advance(1);
        expect(persist).toHaveBeenCalledTimes(1);
        expect(persist).toHaveBeenCalledWith("hello", "file-a");
    });

    it("coalesces rapid successive edits into a single write of the final content", async () => {
        const { persist, edit, advance } = setup();

        edit("h");
        await advance(DEBOUNCE_MS / 2);
        edit("he");
        await advance(DEBOUNCE_MS / 2);
        edit("hey");
        await advance(DEBOUNCE_MS);

        expect(persist).toHaveBeenCalledTimes(1);
        expect(persist).toHaveBeenCalledWith("hey", "file-a");
    });

    it("withholds the write while the AI lock is held and resumes once it is released", async () => {
        const { hook, persist, edit, advance } = setup({ fileId: "file-a", isWriteLocked: true });

        edit("draft during stream");
        await advance(DEBOUNCE_MS * 2);

        expect(persist).not.toHaveBeenCalled();
        expect(hook.result.current.isDirty).toBe(true);

        hook.rerender({ fileId: "file-a", isWriteLocked: false });
        await advance(DEBOUNCE_MS);

        expect(persist).toHaveBeenCalledTimes(1);
        expect(persist).toHaveBeenCalledWith("draft during stream", "file-a");
    });

    it("skips the write while the editor reports itself blocked and keeps the edit dirty", async () => {
        const { hook, editor, persist, edit, advance } = setup();
        editor.blocked = true;

        edit("edit during hydration");
        await advance(DEBOUNCE_MS * 2);

        expect(persist).not.toHaveBeenCalled();
        expect(hook.result.current.isDirty).toBe(true);
    });

    it("drops the pending write for the previous file when fileId changes", async () => {
        const { hook, persist, edit, advance } = setup();

        edit("content of file a");
        hook.rerender({ fileId: "file-b", isWriteLocked: false });
        await advance(DEBOUNCE_MS * 2);

        expect(persist).not.toHaveBeenCalled();
    });

    it("flushes dirty content on unmount and never fires the cancelled timer afterwards", async () => {
        const { hook, persist, flushOnUnmount, edit, advance } = setup();

        edit("unsaved");
        hook.unmount();
        await advance(DEBOUNCE_MS * 2);

        expect(flushOnUnmount).toHaveBeenCalledTimes(1);
        expect(flushOnUnmount).toHaveBeenCalledWith("unsaved", "file-a");
        expect(persist).not.toHaveBeenCalled();
    });

    it("does not flush on unmount when there are no unsaved edits", () => {
        const { hook, flushOnUnmount } = setup();

        hook.unmount();

        expect(flushOnUnmount).not.toHaveBeenCalled();
    });

    it("cancelAutosave aborts the pending write", async () => {
        const { hook, persist, edit, advance } = setup();

        edit("to be cancelled");
        act(() => hook.result.current.cancelAutosave());
        await advance(DEBOUNCE_MS * 2);

        expect(persist).not.toHaveBeenCalled();
    });

    it("markClean and markDirty toggle the dirty flag observed by callers", () => {
        const { hook, edit } = setup();

        edit("x");
        expect(hook.result.current.isDirty).toBe(true);

        act(() => hook.result.current.markClean());
        expect(hook.result.current.isDirty).toBe(false);

        act(() => hook.result.current.markDirty());
        expect(hook.result.current.isDirty).toBe(true);
    });

    it("notifies onUserEdit with the edited content", () => {
        const { onUserEdit, edit } = setup();

        edit("typed text");

        expect(onUserEdit).toHaveBeenCalledWith("typed text");
    });

    describe("Window Lifecycle Listeners (pagehide and beforeunload — REQ-COND-FLUSH)", () => {
        it("flushes dirty content immediately upon window pagehide event", async () => {
            const { flushOnUnmount, persist, edit, advance } = setup();

            edit("unsaved before pagehide");
            expect(flushOnUnmount).not.toHaveBeenCalled();

            // Trigger window pagehide (browser navigation / tab unload)
            act(() => {
                window.dispatchEvent(new Event("pagehide"));
            });

            expect(flushOnUnmount).toHaveBeenCalledTimes(1);
            expect(flushOnUnmount).toHaveBeenCalledWith("unsaved before pagehide", "file-a");

            // Verify the debounce timer was cancelled and does not execute later
            await advance(DEBOUNCE_MS * 2);
            expect(persist).not.toHaveBeenCalled();
        });

        it("flushes dirty content immediately upon window beforeunload event", async () => {
            const { flushOnUnmount, persist, edit, advance } = setup();

            edit("unsaved before beforeunload");
            expect(flushOnUnmount).not.toHaveBeenCalled();

            // Trigger window beforeunload (browser refresh / close)
            act(() => {
                window.dispatchEvent(new Event("beforeunload"));
            });

            expect(flushOnUnmount).toHaveBeenCalledTimes(1);
            expect(flushOnUnmount).toHaveBeenCalledWith("unsaved before beforeunload", "file-a");

            // Verify debounce timer cancellation
            await advance(DEBOUNCE_MS * 2);
            expect(persist).not.toHaveBeenCalled();
        });

        it("does NOT flush upon window pagehide or beforeunload when editor is clean", () => {
            const { flushOnUnmount } = setup();

            act(() => {
                window.dispatchEvent(new Event("pagehide"));
                window.dispatchEvent(new Event("beforeunload"));
            });

            expect(flushOnUnmount).not.toHaveBeenCalled();
        });

        it("cleans up window event listeners on hook unmount to prevent memory leaks", () => {
            const { hook, flushOnUnmount, edit } = setup();

            edit("some edit");
            // First unmount flushes the unmount edit
            hook.unmount();
            expect(flushOnUnmount).toHaveBeenCalledTimes(1);

            flushOnUnmount.mockClear();

            // Trigger window unload events after unmount
            act(() => {
                window.dispatchEvent(new Event("pagehide"));
                window.dispatchEvent(new Event("beforeunload"));
            });

            // Must not be called again after unmount
            expect(flushOnUnmount).not.toHaveBeenCalled();
        });
    });
});
