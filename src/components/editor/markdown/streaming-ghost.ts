import {
    StateEffect,
    StateField,
    RangeSetBuilder,
    Transaction,
} from "@codemirror/state";
import {
    EditorView as CMEditorView,
    Decoration as CMDecoration,
    WidgetType as CMWidgetType,
} from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { GhostHunk, MultiHunkGhostState } from "./types";

export type { GhostHunk, MultiHunkGhostState };

export interface CMStreamingGhostOptions {
    from: number;
    to: number;
    text?: string;
    operation?: string;
    isStreaming?: boolean;
    onApply?: () => void;
    onReject?: () => void;
    onRetry?: () => void;
    onStop?: () => void;
}

/** Legacy type compatibility */
export type StreamingGhostState = MultiHunkGhostState;

const RTL_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function detectTextDirection(text: string): "rtl" | "ltr" {
    return RTL_REGEX.test(text) ? "rtl" : "ltr";
}

/**
 * StateEffects for Multi-Hunk Ghost Session Management
 */
export const startGhostSessionEffect = StateEffect.define<{
    sessionId: string;
    hunks?: GhostHunk[];
}>();

export const upsertGhostHunkEffect = StateEffect.define<GhostHunk>();

export const removeGhostHunkEffect = StateEffect.define<string | { hunkId: string }>();

export const clearGhostSessionEffect = StateEffect.define<void>();

/**
 * Legacy StateEffects for single ghost range backward compatibility
 */
export const startGhostEffect = StateEffect.define<CMStreamingGhostOptions>();

export const updateGhostEffect = StateEffect.define<{
    text: string;
    isStreaming?: boolean;
}>();

export const clearGhostEffect = StateEffect.define<void>();

/**
 * Helper to construct an immutable MultiHunkGhostState with legacy backward-compatibility accessors
 */
export function createMultiHunkGhostState(
    sessionId: string | null = null,
    hunks: GhostHunk[] = []
): MultiHunkGhostState {
    const first = hunks[0];
    const isStreaming = first ? first.status === "streaming" : false;
    return {
        sessionId,
        hunks,
        active: hunks.length > 0,
        from: first?.from ?? 0,
        to: first?.to ?? 0,
        text: first?.replacementText ?? "",
        operation: first?.operation,
        isStreaming,
        onApply: first?.onApply,
        onReject: first?.onReject,
        onRetry: first?.onRetry,
        onStop: first?.onStop,
    };
}

/**
 * CodeMirror 6 Widget rendering an interactive Dark Glassmorphism preview card
 * for a specific ghost hunk with inline accept/reject/retry actions.
 */
export class CMStreamingGhostWidget extends CMWidgetType {
    private view?: CMEditorView;

    constructor(readonly hunk: GhostHunk) {
        super();
    }

    eq(other: CMStreamingGhostWidget): boolean {
        return (
            this.hunk.hunkId === other.hunk.hunkId &&
            this.hunk.replacementText === other.hunk.replacementText &&
            this.hunk.status === other.hunk.status &&
            this.hunk.headingSlug === other.hunk.headingSlug &&
            this.hunk.operation === other.hunk.operation &&
            this.hunk.from === other.hunk.from &&
            this.hunk.to === other.hunk.to
        );
    }

    private renderActions(actionsContainer: HTMLElement): void {
        actionsContainer.innerHTML = "";
        const isStreaming = this.hunk.status === "streaming";

        if (isStreaming) {
            if (this.hunk.onStop) {
                const stopBtn = document.createElement("button");
                stopBtn.type = "button";
                stopBtn.className =
                    "flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-300 text-xs font-medium transition-colors cursor-pointer select-none";
                stopBtn.innerHTML = `
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke-width="2"></circle>
                        <rect x="9" y="9" width="6" height="6" fill="currentColor"></rect>
                    </svg>
                    <span>إيقاف التوليد</span>
                `;
                stopBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.hunk.onStop?.();
                });
                actionsContainer.appendChild(stopBtn);
            }
        } else {
            // Preview ready - Actions: Reject, Retry (if provided), Accept/Apply
            const rejectBtn = document.createElement("button");
            rejectBtn.type = "button";
            rejectBtn.className =
                "flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-300 text-xs font-medium transition-colors cursor-pointer select-none";
            rejectBtn.innerHTML = `
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke-width="2"></circle>
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 9l-6 6m0-6l6 6"></path>
                </svg>
                <span>رفض</span>
            `;
            rejectBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.hunk.onReject) {
                    this.hunk.onReject();
                } else if (this.view) {
                    rejectGhostHunk(this.view, this.hunk.hunkId);
                }
            });
            actionsContainer.appendChild(rejectBtn);

            if (this.hunk.onRetry) {
                const retryBtn = document.createElement("button");
                retryBtn.type = "button";
                retryBtn.className =
                    "flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-xs font-medium transition-colors cursor-pointer select-none";
                retryBtn.innerHTML = `
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                    </svg>
                    <span>إعادة المحاولة</span>
                `;
                retryBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.hunk.onRetry?.();
                });
                actionsContainer.appendChild(retryBtn);
            }

            const applyBtn = document.createElement("button");
            applyBtn.type = "button";
            applyBtn.className =
                "flex items-center gap-1 px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer select-none";
            applyBtn.innerHTML = `
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>
                </svg>
                <span>تطبيق التعديل</span>
            `;
            applyBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.hunk.onApply) {
                    this.hunk.onApply();
                } else if (this.view) {
                    acceptGhostHunk(this.view, this.hunk.hunkId);
                }
            });
            actionsContainer.appendChild(applyBtn);
        }
    }

    toDOM(view: CMEditorView): HTMLElement {
        this.view = view;
        const isStreaming = this.hunk.status === "streaming";
        const container = document.createElement("div");
        container.className =
            "cm-ai-ghost-widget block my-2.5 p-3.5 rounded-xl bg-zinc-900/95 border border-emerald-500/40 text-zinc-100 shadow-xl max-w-full overflow-hidden transition-all backdrop-blur-md";

        // Header with Operation / Heading & Actions
        const header = document.createElement("div");
        header.className =
            "flex items-center justify-between border-b border-zinc-800/90 pb-2.5 mb-2.5 select-none";

        const titleBadge = document.createElement("div");
        titleBadge.className =
            "cm-ai-ghost-title-badge flex items-center gap-2 text-emerald-400 text-xs font-mono font-medium uppercase tracking-wider";
        const titleLabel = this.hunk.operation || this.hunk.headingSlug || "معالجة ذكية";
        titleBadge.innerHTML = `
            <svg class="w-4 h-4 ${isStreaming ? "animate-pulse" : ""} text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"></path>
            </svg>
            <span class="cm-ai-ghost-title-text">معاينة الذكاء الاصطناعي (${titleLabel})</span>
        `;
        if (isStreaming) {
            const pingDot = document.createElement("span");
            pingDot.className =
                "cm-ai-ghost-ping-dot w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block";
            titleBadge.appendChild(pingDot);
        }
        header.appendChild(titleBadge);

        const actions = document.createElement("div");
        actions.className = "cm-ai-ghost-actions flex items-center gap-2";
        this.renderActions(actions);
        header.appendChild(actions);

        container.appendChild(header);

        // Content container
        const dir = detectTextDirection(this.hunk.replacementText || "");
        const contentBox = document.createElement("div");
        contentBox.setAttribute("dir", dir);
        contentBox.className =
            "cm-ai-ghost-content text-sm leading-relaxed whitespace-pre-wrap text-zinc-200 max-h-64 overflow-y-auto custom-scrollbar font-normal p-2.5 rounded-lg bg-zinc-950/60 border border-zinc-800/60";

        const textSpan = document.createElement("span");
        textSpan.className = "cm-ai-ghost-text";
        textSpan.textContent =
            this.hunk.replacementText || (isStreaming ? "جاري استقبال البيانات..." : "...");
        contentBox.appendChild(textSpan);

        if (isStreaming) {
            const cursor = document.createElement("span");
            cursor.className =
                "cm-ai-ghost-cursor inline-block w-1.5 h-4 bg-emerald-400 ml-1 align-middle animate-pulse rounded-xs shadow-[0_0_8px_rgba(52,211,153,0.8)]";
            contentBox.appendChild(cursor);
        }

        container.appendChild(contentBox);

        return container;
    }

    updateDOM(dom: HTMLElement, view: CMEditorView): boolean {
        this.view = view;
        const textNode = dom.querySelector(".cm-ai-ghost-text");
        const contentBox = dom.querySelector(".cm-ai-ghost-content");
        const actionsBox = dom.querySelector(".cm-ai-ghost-actions") as HTMLElement;
        const titleText = dom.querySelector(".cm-ai-ghost-title-text");
        const titleBadge = dom.querySelector(".cm-ai-ghost-title-badge");

        if (textNode && contentBox && actionsBox) {
            const isStreaming = this.hunk.status === "streaming";
            textNode.textContent =
                this.hunk.replacementText || (isStreaming ? "جاري استقبال البيانات..." : "...");
            const dir = detectTextDirection(this.hunk.replacementText || "");
            contentBox.setAttribute("dir", dir);

            if (titleText) {
                const titleLabel = this.hunk.operation || this.hunk.headingSlug || "معالجة ذكية";
                titleText.textContent = `معاينة الذكاء الاصطناعي (${titleLabel})`;
            }

            const pingDot = titleBadge?.querySelector(".cm-ai-ghost-ping-dot");
            if (isStreaming && !pingDot && titleBadge) {
                const dot = document.createElement("span");
                dot.className =
                    "cm-ai-ghost-ping-dot w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block";
                titleBadge.appendChild(dot);
            } else if (!isStreaming && pingDot) {
                pingDot.remove();
            }

            const cursorNode = dom.querySelector(".cm-ai-ghost-cursor");
            if (isStreaming && !cursorNode) {
                const cursor = document.createElement("span");
                cursor.className =
                    "cm-ai-ghost-cursor inline-block w-1.5 h-4 bg-emerald-400 ml-1 align-middle animate-pulse rounded-xs shadow-[0_0_8px_rgba(52,211,153,0.8)]";
                contentBox.appendChild(cursor);
            } else if (!isStreaming && cursorNode) {
                cursorNode.remove();
            }

            this.renderActions(actionsBox);
            return true;
        }
        return false;
    }

    ignoreEvent(): boolean {
        return true;
    }
}

/**
 * CodeMirror 6 StateField for tracking and dynamically shifting Multi-Hunk Ghost preview ranges.
 * Implements ELIXENT-ARCH-03 §4.1:
 * - Automatically remaps coordinates of remaining hunks via tr.changes.mapPos(hunk.from, 1) and tr.changes.mapPos(hunk.to, -1)
 * - Implements granular collision semantics: intersecting edits invalidate only the affected hunk, leaving other hunks intact.
 */
export const codeMirrorStreamingGhostField = StateField.define<MultiHunkGhostState>({
    create(): MultiHunkGhostState {
        return createMultiHunkGhostState(null, []);
    },
    update(value, tr): MultiHunkGhostState {
        let currentSessionId = value.sessionId;
        let currentHunks = [...value.hunks];

        for (const effect of tr.effects) {
            if (effect.is(startGhostSessionEffect)) {
                currentSessionId = effect.value.sessionId;
                const safeHunks = (effect.value.hunks || []).map((h) => {
                    const safeFrom = Math.max(0, Math.min(h.from, tr.newDoc.length));
                    const safeTo = Math.max(safeFrom, Math.min(h.to, tr.newDoc.length));
                    return {
                        ...h,
                        from: safeFrom,
                        to: safeTo,
                        originalSlice:
                            h.originalSlice !== undefined
                                ? h.originalSlice
                                : tr.newDoc.sliceString(safeFrom, safeTo),
                    };
                });
                currentHunks = safeHunks;
            } else if (effect.is(upsertGhostHunkEffect)) {
                const incoming = effect.value;
                const safeFrom = Math.max(0, Math.min(incoming.from, tr.newDoc.length));
                const safeTo = Math.max(safeFrom, Math.min(incoming.to, tr.newDoc.length));
                const sanitizedHunk: GhostHunk = {
                    ...incoming,
                    from: safeFrom,
                    to: safeTo,
                    originalSlice:
                        incoming.originalSlice !== undefined
                            ? incoming.originalSlice
                            : tr.newDoc.sliceString(safeFrom, safeTo),
                };
                const idx = currentHunks.findIndex((h) => h.hunkId === incoming.hunkId);
                if (idx >= 0) {
                    currentHunks[idx] = sanitizedHunk;
                } else {
                    currentHunks.push(sanitizedHunk);
                }
            } else if (effect.is(removeGhostHunkEffect)) {
                const targetId =
                    typeof effect.value === "string" ? effect.value : effect.value.hunkId;
                currentHunks = currentHunks.filter((h) => h.hunkId !== targetId);
                if (currentHunks.length === 0) {
                    currentSessionId = null;
                }
            } else if (effect.is(clearGhostSessionEffect)) {
                currentSessionId = null;
                currentHunks = [];
            }
            // Legacy StateEffects support
            else if (effect.is(startGhostEffect)) {
                const safeFrom = Math.max(0, Math.min(effect.value.from, tr.newDoc.length));
                const safeTo = Math.max(safeFrom, Math.min(effect.value.to, tr.newDoc.length));
                const legacyHunk: GhostHunk = {
                    hunkId: "legacy-ghost-hunk",
                    decisionIds: [],
                    headingSlug: "",
                    from: safeFrom,
                    to: safeTo,
                    originalSlice: tr.newDoc.sliceString(safeFrom, safeTo),
                    replacementText: effect.value.text || "",
                    status: effect.value.isStreaming === false ? "preview_ready" : "streaming",
                    operation: effect.value.operation,
                    onApply: effect.value.onApply,
                    onReject: effect.value.onReject,
                    onRetry: effect.value.onRetry,
                    onStop: effect.value.onStop,
                };
                currentSessionId = "legacy-session";
                currentHunks = [legacyHunk];
            } else if (effect.is(updateGhostEffect)) {
                if (currentHunks.length > 0) {
                    const first = currentHunks[0];
                    currentHunks[0] = {
                        ...first,
                        replacementText: effect.value.text,
                        status:
                            effect.value.isStreaming === false
                                ? "preview_ready"
                                : effect.value.isStreaming === true
                                ? "streaming"
                                : first.status,
                    };
                }
            } else if (effect.is(clearGhostEffect)) {
                currentSessionId = null;
                currentHunks = [];
            }
        }

        // Remapping & Collision Handling on Document Changes
        if (tr.docChanged && currentHunks.length > 0) {
            const isAIAllAccept = tr.annotation(Transaction.userEvent) === "ai.accept.all";
            if (isAIAllAccept) {
                return createMultiHunkGhostState(null, []);
            }

            const remainingHunks: GhostHunk[] = [];

            for (const hunk of currentHunks) {
                let collides = false;
                tr.changes.iterChanges((fromA, toA) => {
                    if (collides) return;
                    if (hunk.from === hunk.to) {
                        if (fromA <= hunk.from && toA >= hunk.from) {
                            collides = true;
                        }
                    } else {
                        if (fromA < hunk.to && toA > hunk.from) {
                            collides = true;
                        }
                    }
                });

                if (collides) {
                    // Collision occurred for this hunk: abort and dismiss it
                    if (typeof hunk.onStop === "function") {
                        const onStop = hunk.onStop;
                        queueMicrotask(() => {
                            try {
                                onStop();
                            } catch (e) {
                                console.error("[StreamingGhost] Error in onStop callback:", e);
                            }
                        });
                    }
                    // Hunk is invalidated and dropped from state
                } else {
                    // Non-colliding hunk: remap positions forward/backward
                    const mappedFrom = Math.max(
                        0,
                        Math.min(tr.changes.mapPos(hunk.from, 1), tr.newDoc.length)
                    );
                    const mappedTo = Math.max(
                        mappedFrom,
                        Math.min(tr.changes.mapPos(hunk.to, -1), tr.newDoc.length)
                    );
                    remainingHunks.push({
                        ...hunk,
                        from: mappedFrom,
                        to: mappedTo,
                    });
                }
            }

            currentHunks = remainingHunks;
            if (currentHunks.length === 0) {
                currentSessionId = null;
            }
        }

        return createMultiHunkGhostState(currentSessionId, currentHunks);
    },
    provide(field) {
        return CMEditorView.decorations.compute([field], (state) => {
            const ghost = state.field(field, false);
            if (!ghost || ghost.hunks.length === 0) return CMDecoration.none;
            const builder = new RangeSetBuilder<CMDecoration>();
            const docLen = state.doc.length;

            // Sort hunks strictly by start position to uphold RangeSetBuilder invariants
            const sortedHunks = [...ghost.hunks].sort(
                (a, b) => a.from - b.from || a.to - b.to
            );

            let lastPos = -1;
            for (const hunk of sortedHunks) {
                const from = Math.max(0, Math.min(hunk.from, docLen));
                const to = Math.max(from, Math.min(hunk.to, docLen));

                // Guard against duplicate start positions
                if (lastPos !== -1 && from <= lastPos) continue;

                // 1. Widget decoration displaying live streamed preview and action buttons
                builder.add(
                    from,
                    from,
                    CMDecoration.widget({
                        widget: new CMStreamingGhostWidget(hunk),
                        side: from > 0 ? -1 : 0,
                    })
                );

                // 2. Inline mark decoration to dim and strike through targeted selection
                if (from !== to) {
                    builder.add(
                        from,
                        to,
                        CMDecoration.mark({
                            class: "opacity-35 line-through decoration-zinc-500 bg-zinc-800/30 rounded px-0.5 transition-opacity",
                        })
                    );
                }

                lastPos = from;
            }

            return builder.finish();
        });
    },
});

/**
 * Atomically accept an individual ghost hunk by ID.
 * Emits a single transaction tagged with Transaction.userEvent.of("ai.accept.hunk")
 * and isolateHistory.of("full") so that Ctrl+Z undo reverts ONLY this hunk cleanly.
 */
export function acceptGhostHunk(view: CMEditorView, hunkId: string): boolean {
    if (!hunkId) return false;
    const ghostState = view.state.field(codeMirrorStreamingGhostField, false);
    if (!ghostState || ghostState.hunks.length === 0) return false;

    const hunk = ghostState.hunks.find((h) => h.hunkId === hunkId);
    if (!hunk) return false;

    const docLen = view.state.doc.length;
    const safeFrom = Math.max(0, Math.min(hunk.from, docLen));
    const safeTo = Math.max(safeFrom, Math.min(hunk.to, docLen));

    view.dispatch({
        changes: { from: safeFrom, to: safeTo, insert: hunk.replacementText },
        effects: removeGhostHunkEffect.of(hunkId),
        annotations: [
            Transaction.userEvent.of("ai.accept.hunk"),
            isolateHistory.of("full"),
        ],
    });

    return true;
}

/**
 * Reject an individual ghost hunk by ID.
 * Removes the hunk from state without mutating the document or creating an undo step.
 */
export function rejectGhostHunk(view: CMEditorView, hunkId: string): boolean {
    if (!hunkId) return false;
    const ghostState = view.state.field(codeMirrorStreamingGhostField, false);
    if (!ghostState || ghostState.hunks.length === 0) return false;

    const hunk = ghostState.hunks.find((h) => h.hunkId === hunkId);
    if (!hunk) return false;

    view.dispatch({
        effects: removeGhostHunkEffect.of(hunkId),
    });

    if (typeof hunk.onReject === "function") {
        try {
            hunk.onReject();
        } catch (e) {
            console.error("[StreamingGhost] Error in onReject callback:", e);
        }
    }

    return true;
}

/**
 * Atomically accept all remaining ghost hunks in a single combined transaction.
 * Combined changes are applied against original non-overlapping coordinates in sorted order,
 * annotated with Transaction.userEvent.of("ai.accept.all") and isolateHistory.of("full")
 * so a single Ctrl+Z reverts the entire acceptance in one step.
 */
export function acceptAllGhostHunks(view: CMEditorView): boolean {
    const ghostState = view.state.field(codeMirrorStreamingGhostField, false);
    if (!ghostState || ghostState.hunks.length === 0) return false;

    const docLen = view.state.doc.length;
    const sortedHunks = [...ghostState.hunks].sort(
        (a, b) => a.from - b.from || a.to - b.to
    );

    const validChanges: { from: number; to: number; insert: string }[] = [];
    let lastTo = -1;
    for (const hunk of sortedHunks) {
        const safeFrom = Math.max(0, Math.min(hunk.from, docLen));
        const safeTo = Math.max(safeFrom, Math.min(hunk.to, docLen));
        if (safeFrom >= lastTo) {
            validChanges.push({
                from: safeFrom,
                to: safeTo,
                insert: hunk.replacementText,
            });
            lastTo = safeTo;
        }
    }

    if (validChanges.length === 0) return false;

    view.dispatch({
        changes: validChanges,
        effects: clearGhostSessionEffect.of(),
        annotations: [
            Transaction.userEvent.of("ai.accept.all"),
            isolateHistory.of("full"),
        ],
    });

    return true;
}
