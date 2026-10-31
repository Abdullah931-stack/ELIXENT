// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState, Transaction, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, isolateHistory } from "@codemirror/commands";
import {
    createMarkdownExtensions,
    createEditorAdapter,
    EditorAdapter,
    GhostHunk,
} from "@/components/editor/markdown";
import {
    codeMirrorStreamingGhostField,
    CMStreamingGhostWidget,
} from "@/components/editor/markdown/streaming-ghost";

describe("Phase 10: Multi-Hunk Ghost Editor Extension & Atomic Acceptance", () => {
    let parent: HTMLDivElement;
    let view: EditorView;
    let adapter: EditorAdapter;

    const sampleDoc = [
        "# Section 1",
        "Original alpha content.",
        "",
        "# Section 2",
        "Original beta content.",
        "",
        "# Section 3",
        "Original gamma content.",
    ].join("\n");

    function initEditor(initialDoc = sampleDoc): { view: EditorView; adapter: EditorAdapter } {
        parent = document.createElement("div");
        document.body.appendChild(parent);

        const extensions = createMarkdownExtensions({
            mode: "live",
            placeholder: "Type markdown here...",
        });

        const state = EditorState.create({
            doc: initialDoc,
            extensions: [
                ...extensions,
                history(),
            ],
        });

        view = new EditorView({
            state,
            parent,
        });

        adapter = createEditorAdapter(view, "live");
        return { view, adapter };
    }

    beforeEach(() => {
        initEditor();
    });

    afterEach(() => {
        if (view) {
            view.destroy();
        }
        if (parent && parent.parentNode) {
            parent.parentNode.removeChild(parent);
        }
    });

    describe("1. Multi-Hunk Ghost Session Initialization & Upsert", () => {
        it("should initialize a multi-hunk session and retrieve all hunks via adapter", () => {
            const doc = adapter.getValue();
            const from1 = doc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;
            const from2 = doc.indexOf("Original beta content.");
            const to2 = from2 + "Original beta content.".length;

            const hunks: GhostHunk[] = [
                {
                    hunkId: "hunk-alpha",
                    decisionIds: ["dec-1"],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "Updated alpha text.",
                    status: "streaming",
                },
                {
                    hunkId: "hunk-beta",
                    decisionIds: ["dec-2"],
                    headingSlug: "section-2",
                    from: from2,
                    to: to2,
                    originalSlice: "Original beta content.",
                    replacementText: "Updated beta text.",
                    status: "preview_ready",
                },
            ];

            adapter.startGhostSession?.("session-101", hunks);

            const activeHunks = adapter.getGhostHunks?.() ?? [];
            expect(activeHunks).toHaveLength(2);
            expect(activeHunks[0].hunkId).toBe("hunk-alpha");
            expect(activeHunks[0].status).toBe("streaming");
            expect(activeHunks[1].hunkId).toBe("hunk-beta");
            expect(activeHunks[1].status).toBe("preview_ready");

            const ghostState = view.state.field(codeMirrorStreamingGhostField);
            expect(ghostState.sessionId).toBe("session-101");
            expect(ghostState.active).toBe(true);
        });

        it("should upsert existing hunk to update status and text, or append new hunk", () => {
            const hunk1: GhostHunk = {
                hunkId: "hunk-1",
                decisionIds: ["dec-1"],
                headingSlug: "section-1",
                from: 12,
                to: 35,
                originalSlice: "Original alpha content.",
                replacementText: "Streaming chunk 1...",
                status: "streaming",
            };

            adapter.startGhostSession?.("session-upsert", [hunk1]);
            expect(adapter.getGhostHunks?.()[0].replacementText).toBe("Streaming chunk 1...");

            // Upsert existing hunk to preview_ready with final text
            adapter.upsertGhostHunk?.({
                ...hunk1,
                replacementText: "Final proposed alpha text.",
                status: "preview_ready",
            });

            let hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks).toHaveLength(1);
            expect(hunks[0].replacementText).toBe("Final proposed alpha text.");
            expect(hunks[0].status).toBe("preview_ready");

            // Upsert a brand new hunk
            const hunk2: GhostHunk = {
                hunkId: "hunk-2",
                decisionIds: ["dec-2"],
                headingSlug: "section-2",
                from: 48,
                to: 70,
                originalSlice: "Original beta content.",
                replacementText: "Proposed beta text.",
                status: "preview_ready",
            };
            adapter.upsertGhostHunk?.(hunk2);

            hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks).toHaveLength(2);
            expect(hunks[1].hunkId).toBe("hunk-2");
        });
    });

    describe("2. Coordinate Remapping via tr.changes.mapPos", () => {
        it("should dynamically shift all remaining hunks on edits before, between, and after hunks", () => {
            const doc = adapter.getValue();
            const from1 = doc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;
            const from2 = doc.indexOf("Original beta content.");
            const to2 = from2 + "Original beta content.".length;
            const from3 = doc.indexOf("Original gamma content.");
            const to3 = from3 + "Original gamma content.".length;

            adapter.startGhostSession?.("session-shift", [
                {
                    hunkId: "h-1",
                    decisionIds: [],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "Alpha New",
                    status: "preview_ready",
                },
                {
                    hunkId: "h-2",
                    decisionIds: [],
                    headingSlug: "section-2",
                    from: from2,
                    to: to2,
                    originalSlice: "Original beta content.",
                    replacementText: "Beta New",
                    status: "preview_ready",
                },
                {
                    hunkId: "h-3",
                    decisionIds: [],
                    headingSlug: "section-3",
                    from: from3,
                    to: to3,
                    originalSlice: "Original gamma content.",
                    replacementText: "Gamma New",
                    status: "preview_ready",
                },
            ]);

            // Case A: User inserts a prefix header before Hunk 1 (at position 0)
            const prefix = "# New Document Title\n\n";
            adapter.replaceRange(0, 0, prefix);

            let hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks[0].from).toBe(from1 + prefix.length);
            expect(hunks[0].to).toBe(to1 + prefix.length);
            expect(hunks[1].from).toBe(from2 + prefix.length);
            expect(hunks[1].to).toBe(to2 + prefix.length);
            expect(hunks[2].from).toBe(from3 + prefix.length);
            expect(hunks[2].to).toBe(to3 + prefix.length);

            // Case B: User types between Hunk 1 and Hunk 2
            const posBetween = hunks[0].to + 2; // In empty line or section header
            const insertedBetween = "A comment between sections.\n";
            adapter.replaceRange(posBetween, posBetween, insertedBetween);

            hunks = adapter.getGhostHunks?.() ?? [];
            // Hunk 1 must NOT shift
            expect(hunks[0].from).toBe(from1 + prefix.length);
            expect(hunks[0].to).toBe(to1 + prefix.length);
            // Hunk 2 and Hunk 3 must shift forward by insertedBetween.length
            expect(hunks[1].from).toBe(from2 + prefix.length + insertedBetween.length);
            expect(hunks[1].to).toBe(to2 + prefix.length + insertedBetween.length);
            expect(hunks[2].from).toBe(from3 + prefix.length + insertedBetween.length);
            expect(hunks[2].to).toBe(to3 + prefix.length + insertedBetween.length);

            // Case C: User types after Hunk 3 (at doc end)
            const docLen = adapter.getCharCount();
            adapter.replaceRange(docLen, docLen, "\n# Footer section");

            const hunksAfter = adapter.getGhostHunks?.() ?? [];
            // None of the 3 hunks should change coordinates
            expect(hunksAfter[0].from).toBe(hunks[0].from);
            expect(hunksAfter[1].from).toBe(hunks[1].from);
            expect(hunksAfter[2].from).toBe(hunks[2].from);
        });
    });

    describe("3. Granular Collision Semantics", () => {
        it("invalidates only the collided hunk while retaining other non-overlapping hunks", () => {
            const doc = adapter.getValue();
            const from1 = doc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;
            const from2 = doc.indexOf("Original beta content.");
            const to2 = from2 + "Original beta content.".length;

            const onStop1 = vi.fn();
            const onStop2 = vi.fn();

            adapter.startGhostSession?.("session-collision", [
                {
                    hunkId: "hunk-col-1",
                    decisionIds: [],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "Alpha AI text",
                    status: "streaming",
                    onStop: onStop1,
                },
                {
                    hunkId: "hunk-col-2",
                    decisionIds: [],
                    headingSlug: "section-2",
                    from: from2,
                    to: to2,
                    originalSlice: "Original beta content.",
                    replacementText: "Beta AI text",
                    status: "streaming",
                    onStop: onStop2,
                },
            ]);

            expect(adapter.getGhostHunks?.()).toHaveLength(2);

            // User types right inside Hunk 1's range (collision on Hunk 1 only)
            adapter.replaceRange(from1 + 5, from1 + 10, "USER_TYPING");

            const hunks = adapter.getGhostHunks?.() ?? [];
            // Hunk 1 must be dropped
            expect(hunks.find((h) => h.hunkId === "hunk-col-1")).toBeUndefined();
            // Hunk 2 must be preserved and its coordinates shifted
            const remainingHunk2 = hunks.find((h) => h.hunkId === "hunk-col-2");
            expect(remainingHunk2).toBeDefined();
            const shiftDelta = "USER_TYPING".length - 5;
            expect(remainingHunk2!.from).toBe(from2 + shiftDelta);
        });
    });

    describe("4. Granular Per-Hunk Atomic Acceptance & Rejection", () => {
        it("acceptGhostHunk applies only that hunk and allows atomic undo of that single hunk", () => {
            const initialDoc = adapter.getValue();
            const from1 = initialDoc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;
            const from2 = initialDoc.indexOf("Original beta content.");
            const to2 = from2 + "Original beta content.".length;

            adapter.startGhostSession?.("session-accept", [
                {
                    hunkId: "hunk-1",
                    decisionIds: ["dec-1"],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "REPLACED ALPHA",
                    status: "preview_ready",
                },
                {
                    hunkId: "hunk-2",
                    decisionIds: ["dec-2"],
                    headingSlug: "section-2",
                    from: from2,
                    to: to2,
                    originalSlice: "Original beta content.",
                    replacementText: "REPLACED BETA",
                    status: "preview_ready",
                },
            ]);

            // Accept Hunk 1 only
            const accepted = adapter.acceptGhostHunk?.("hunk-1");
            expect(accepted).toBe(true);

            // Document has Hunk 1 applied; Hunk 2 remains in state
            expect(adapter.getValue()).toContain("REPLACED ALPHA");
            expect(adapter.getValue()).toContain("Original beta content.");

            const hunksRemaining = adapter.getGhostHunks?.() ?? [];
            expect(hunksRemaining).toHaveLength(1);
            expect(hunksRemaining[0].hunkId).toBe("hunk-2");

            // Shifted coordinates of Hunk 2 must match new position of beta
            const expectedBetaPos = adapter.getValue().indexOf("Original beta content.");
            expect(hunksRemaining[0].from).toBe(expectedBetaPos);

            // Accept Hunk 2 as well
            const accepted2 = adapter.acceptGhostHunk?.("hunk-2");
            expect(accepted2).toBe(true);
            expect(adapter.getValue()).toContain("REPLACED BETA");
            expect(adapter.getGhostHunks?.()).toHaveLength(0);

            // Per-Hunk Atomic Undo: 1st undo reverts ONLY Hunk 2
            adapter.undo();
            expect(adapter.getValue()).toContain("REPLACED ALPHA");
            expect(adapter.getValue()).toContain("Original beta content.");

            // 2nd undo reverts Hunk 1 back to initialDoc
            adapter.undo();
            expect(adapter.getValue()).toBe(initialDoc);
        });

        it("rejectGhostHunk removes hunk from state without mutating doc or adding undo step", () => {
            const initialDoc = adapter.getValue();
            const from1 = initialDoc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;

            const onReject = vi.fn();
            adapter.startGhostSession?.("session-reject", [
                {
                    hunkId: "hunk-reject-me",
                    decisionIds: [],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "Unwanted AI text",
                    status: "preview_ready",
                    onReject,
                },
            ]);

            const rejected = adapter.rejectGhostHunk?.("hunk-reject-me");
            expect(rejected).toBe(true);
            expect(adapter.getValue()).toBe(initialDoc);
            expect(adapter.getGhostHunks?.()).toHaveLength(0);
            expect(onReject).toHaveBeenCalledTimes(1);

            // Should not add an undo step
            expect(adapter.canUndo()).toBe(false);
        });
    });

    describe("5. Accept All Hunks Single Atomic Transaction", () => {
        it("acceptAllGhostHunks applies all hunks in ONE transaction that reverts with ONE Ctrl+Z", () => {
            const initialDoc = adapter.getValue();
            const from1 = initialDoc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;
            const from2 = initialDoc.indexOf("Original beta content.");
            const to2 = from2 + "Original beta content.".length;
            const from3 = initialDoc.indexOf("Original gamma content.");
            const to3 = from3 + "Original gamma content.".length;

            adapter.startGhostSession?.("session-all", [
                {
                    hunkId: "hunk-1",
                    decisionIds: [],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "NEW ALPHA",
                    status: "preview_ready",
                },
                {
                    hunkId: "hunk-2",
                    decisionIds: [],
                    headingSlug: "section-2",
                    from: from2,
                    to: to2,
                    originalSlice: "Original beta content.",
                    replacementText: "NEW BETA",
                    status: "preview_ready",
                },
                {
                    hunkId: "hunk-3",
                    decisionIds: [],
                    headingSlug: "section-3",
                    from: from3,
                    to: to3,
                    originalSlice: "Original gamma content.",
                    replacementText: "NEW GAMMA",
                    status: "preview_ready",
                },
            ]);

            const acceptedAll = adapter.acceptAllGhostHunks?.();
            expect(acceptedAll).toBe(true);

            // All hunks applied simultaneously
            expect(adapter.getValue()).toContain("NEW ALPHA");
            expect(adapter.getValue()).toContain("NEW BETA");
            expect(adapter.getValue()).toContain("NEW GAMMA");
            expect(adapter.getGhostHunks?.()).toHaveLength(0);

            // Single undo restores all 3 hunks back to initial document
            const undoResult = adapter.undo();
            expect(undoResult).toBe(true);
            expect(adapter.getValue()).toBe(initialDoc);
        });
    });

    describe("6. Transaction Annotations (userEvent & isolateHistory)", () => {
        it("annotates acceptGhostHunk with ai.accept.hunk and isolateHistory", () => {
            let capturedUserEvent: string | undefined;
            let capturedIsolate: unknown;

            // Start hunk
            adapter.startGhostSession?.("session-anno", [
                {
                    hunkId: "hunk-anno",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: 0,
                    to: 5,
                    originalSlice: "# Sec",
                    replacementText: "# Heading",
                    status: "preview_ready",
                },
            ]);

            // Track transactions via temporary transactionFilter
            const filterExtension = EditorState.transactionFilter.of((tr) => {
                const userEvent = tr.annotation(Transaction.userEvent);
                if (userEvent?.startsWith("ai.accept")) {
                    capturedUserEvent = userEvent;
                    capturedIsolate = tr.annotation(isolateHistory);
                }
                return tr;
            });

            // Reconfigure view with filter
            view.dispatch({
                effects: StateEffect.appendConfig.of(filterExtension),
            });

            adapter.acceptGhostHunk?.("hunk-anno");

            expect(capturedUserEvent).toBe("ai.accept.hunk");
            expect(capturedIsolate).toBe("full");
        });

        it("annotates acceptAllGhostHunks with ai.accept.all and isolateHistory", () => {
            let capturedUserEvent: string | undefined;
            let capturedIsolate: unknown;

            const filterExtension = EditorState.transactionFilter.of((tr) => {
                const userEvent = tr.annotation(Transaction.userEvent);
                if (userEvent?.startsWith("ai.accept")) {
                    capturedUserEvent = userEvent;
                    capturedIsolate = tr.annotation(isolateHistory);
                }
                return tr;
            });

            view.dispatch({
                effects: StateEffect.appendConfig.of(filterExtension),
            });

            adapter.startGhostSession?.("session-all-anno", [
                {
                    hunkId: "h1",
                    decisionIds: [],
                    headingSlug: "sec1",
                    from: 0,
                    to: 2,
                    originalSlice: "# ",
                    replacementText: "## ",
                    status: "preview_ready",
                },
            ]);

            adapter.acceptAllGhostHunks?.();

            expect(capturedUserEvent).toBe("ai.accept.all");
            expect(capturedIsolate).toBe("full");
        });
    });

    describe("7. Defensive & Edge-Case Handling", () => {
        it("gracefully returns false for unknown or empty hunkId without modifying doc", () => {
            const before = adapter.getValue();

            expect(adapter.acceptGhostHunk?.("non-existent")).toBe(false);
            expect(adapter.acceptGhostHunk?.("")).toBe(false);
            expect(adapter.rejectGhostHunk?.("non-existent")).toBe(false);
            expect(adapter.rejectGhostHunk?.("")).toBe(false);
            expect(adapter.acceptAllGhostHunks?.()).toBe(false);

            expect(adapter.getValue()).toBe(before);
        });

        it("clears ghost session cleanly via clearGhostSession", () => {
            adapter.startGhostSession?.("session-clear", [
                {
                    hunkId: "hunk-clear",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: 0,
                    to: 5,
                    originalSlice: "text",
                    replacementText: "clear me",
                    status: "streaming",
                },
            ]);

            expect(adapter.getGhostHunks?.()).toHaveLength(1);
            adapter.clearGhostSession?.();
            expect(adapter.getGhostHunks?.()).toHaveLength(0);

            const ghostState = view.state.field(codeMirrorStreamingGhostField);
            expect(ghostState.sessionId).toBeNull();
            expect(ghostState.active).toBe(false);
        });
    });

    describe("8. Zero-Length Insertions (from === to)", () => {
        it("should insert text at cursor position without deleting any characters when accepted", () => {
            const initialDoc = adapter.getValue();
            const insertPoint = initialDoc.indexOf("Original beta content.");

            adapter.startGhostSession?.("session-zero-len", [
                {
                    hunkId: "zero-hunk",
                    decisionIds: ["dec-zero"],
                    headingSlug: "section-2",
                    from: insertPoint,
                    to: insertPoint,
                    originalSlice: "",
                    replacementText: ">>> INSERTED PREFIX <<< ",
                    status: "preview_ready",
                },
            ]);

            const hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks).toHaveLength(1);
            expect(hunks[0].from).toBe(hunks[0].to);

            const accepted = adapter.acceptGhostHunk?.("zero-hunk");
            expect(accepted).toBe(true);

            const updatedDoc = adapter.getValue();
            expect(updatedDoc).toContain(">>> INSERTED PREFIX <<< Original beta content.");
            expect(updatedDoc.length).toBe(initialDoc.length + ">>> INSERTED PREFIX <<< ".length);
        });

        it("should invalidate zero-length insertion when an edit intersects its exact position", () => {
            const insertPoint = 20;
            const onStop = vi.fn();

            adapter.startGhostSession?.("session-zero-collide", [
                {
                    hunkId: "zero-collide",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: insertPoint,
                    to: insertPoint,
                    originalSlice: "",
                    replacementText: "Insertion text",
                    status: "streaming",
                    onStop,
                },
            ]);

            expect(adapter.getGhostHunks?.()).toHaveLength(1);

            // Type across insertPoint (e.g. from 18 to 22)
            adapter.replaceRange(18, 22, "EDIT");

            expect(adapter.getGhostHunks?.()).toHaveLength(0);
        });

        it("should remap zero-length insertion coordinate forward on edits occurring before it", () => {
            const insertPoint = 30;

            adapter.startGhostSession?.("session-zero-remap", [
                {
                    hunkId: "zero-remap",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: insertPoint,
                    to: insertPoint,
                    originalSlice: "",
                    replacementText: "Insert",
                    status: "preview_ready",
                },
            ]);

            const prefix = "EXTRA_PREFIX_";
            adapter.replaceRange(0, 0, prefix);

            const hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks).toHaveLength(1);
            expect(hunks[0].from).toBe(insertPoint + prefix.length);
            expect(hunks[0].to).toBe(insertPoint + prefix.length);
        });

        it("should leave zero-length insertion coordinate unchanged on edits occurring strictly after it", () => {
            const insertPoint = 15;

            adapter.startGhostSession?.("session-zero-after", [
                {
                    hunkId: "zero-after",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: insertPoint,
                    to: insertPoint,
                    originalSlice: "",
                    replacementText: "Insert",
                    status: "preview_ready",
                },
            ]);

            adapter.replaceRange(40, 50, "MODIFIED_LATER");

            const hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks).toHaveLength(1);
            expect(hunks[0].from).toBe(insertPoint);
            expect(hunks[0].to).toBe(insertPoint);
        });
    });

    describe("9. Contiguous & Adjacent Ghost Hunks", () => {
        it("should maintain adjacent hunks with shared boundary (to1 === from2) and remap both on preceding edit", () => {
            adapter.setValue("Start ALPHA_BETA End");
            const doc = adapter.getValue();
            const from1 = doc.indexOf("ALPHA_");
            const to1 = from1 + "ALPHA_".length;
            const from2 = to1;
            const to2 = from2 + "BETA".length;

            adapter.startGhostSession?.("session-adjacent", [
                {
                    hunkId: "adj-1",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: from1,
                    to: to1,
                    originalSlice: "ALPHA_",
                    replacementText: "AAA_",
                    status: "preview_ready",
                },
                {
                    hunkId: "adj-2",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: from2,
                    to: to2,
                    originalSlice: "BETA",
                    replacementText: "BBB",
                    status: "preview_ready",
                },
            ]);

            const prefix = ">> ";
            adapter.replaceRange(0, 0, prefix);

            const hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks).toHaveLength(2);
            expect(hunks[0].from).toBe(from1 + prefix.length);
            expect(hunks[0].to).toBe(to1 + prefix.length);
            expect(hunks[1].from).toBe(to1 + prefix.length);
            expect(hunks[1].to).toBe(to2 + prefix.length);
        });

        it("should accept adjacent hunk 1 and dynamically shift adjacent hunk 2 to new boundary", () => {
            adapter.setValue("Start ALPHA_BETA End");
            const doc = adapter.getValue();
            const from1 = doc.indexOf("ALPHA_");
            const to1 = from1 + "ALPHA_".length;
            const from2 = to1;
            const to2 = from2 + "BETA".length;

            adapter.startGhostSession?.("session-adj-accept", [
                {
                    hunkId: "adj-1",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: from1,
                    to: to1,
                    originalSlice: "ALPHA_",
                    replacementText: "LONGER_ALPHA_REPLACEMENT_",
                    status: "preview_ready",
                },
                {
                    hunkId: "adj-2",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: from2,
                    to: to2,
                    originalSlice: "BETA",
                    replacementText: "BBB",
                    status: "preview_ready",
                },
            ]);

            const accepted1 = adapter.acceptGhostHunk?.("adj-1");
            expect(accepted1).toBe(true);

            expect(adapter.getValue()).toContain("Start LONGER_ALPHA_REPLACEMENT_BETA End");

            const hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks).toHaveLength(1);
            expect(hunks[0].hunkId).toBe("adj-2");
            const expectedBetaPos = adapter.getValue().indexOf("BETA");
            expect(hunks[0].from).toBe(expectedBetaPos);
            expect(hunks[0].to).toBe(expectedBetaPos + "BETA".length);

            const accepted2 = adapter.acceptGhostHunk?.("adj-2");
            expect(accepted2).toBe(true);
            expect(adapter.getValue()).toBe("Start LONGER_ALPHA_REPLACEMENT_BBB End");
        });

        it("should atomically accept all adjacent hunks in single transaction without coordinate overlaps", () => {
            adapter.setValue("PREFIX [ONE][TWO][THREE] SUFFIX");
            const doc = adapter.getValue();
            const p1 = doc.indexOf("[ONE]");
            const p2 = doc.indexOf("[TWO]");
            const p3 = doc.indexOf("[THREE]");

            adapter.startGhostSession?.("session-adj-all", [
                {
                    hunkId: "adj-1",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: p1,
                    to: p2,
                    originalSlice: "[ONE]",
                    replacementText: "1",
                    status: "preview_ready",
                },
                {
                    hunkId: "adj-2",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: p2,
                    to: p3,
                    originalSlice: "[TWO]",
                    replacementText: "2",
                    status: "preview_ready",
                },
                {
                    hunkId: "adj-3",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: p3,
                    to: p3 + "[THREE]".length,
                    originalSlice: "[THREE]",
                    replacementText: "3",
                    status: "preview_ready",
                },
            ]);

            const accepted = adapter.acceptAllGhostHunks?.();
            expect(accepted).toBe(true);
            expect(adapter.getValue()).toBe("PREFIX 123 SUFFIX");
            expect(adapter.getGhostHunks?.()).toHaveLength(0);

            adapter.undo();
            expect(adapter.getValue()).toBe("PREFIX [ONE][TWO][THREE] SUFFIX");
        });

        it("should invalidate only hunk 1 when user edits inside hunk 1, while preserving adjacent hunk 2", () => {
            adapter.setValue("Start ALPHA_BETA End");
            const doc = adapter.getValue();
            const from1 = doc.indexOf("ALPHA_");
            const to1 = from1 + "ALPHA_".length;
            const from2 = to1;
            const to2 = from2 + "BETA".length;

            adapter.startGhostSession?.("session-adj-col", [
                {
                    hunkId: "adj-1",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: from1,
                    to: to1,
                    originalSlice: "ALPHA_",
                    replacementText: "A",
                    status: "preview_ready",
                },
                {
                    hunkId: "adj-2",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: from2,
                    to: to2,
                    originalSlice: "BETA",
                    replacementText: "B",
                    status: "preview_ready",
                },
            ]);

            adapter.replaceRange(from1 + 1, from1 + 3, "ZZ");

            const hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks.find((h) => h.hunkId === "adj-1")).toBeUndefined();
            const preserved2 = hunks.find((h) => h.hunkId === "adj-2");
            expect(preserved2).toBeDefined();
        });
    });

    describe("10. Rapid Undo/Redo Chains & History Isolation", () => {
        it("should support rapid sequential accept, undo, and redo chains for individual hunks", () => {
            const initialDoc = adapter.getValue();
            const from1 = initialDoc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;
            const from2 = initialDoc.indexOf("Original beta content.");
            const to2 = from2 + "Original beta content.".length;

            adapter.startGhostSession?.("session-undo-redo", [
                {
                    hunkId: "hunk-ur-1",
                    decisionIds: [],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "NEW_ALPHA_1",
                    status: "preview_ready",
                },
                {
                    hunkId: "hunk-ur-2",
                    decisionIds: [],
                    headingSlug: "section-2",
                    from: from2,
                    to: to2,
                    originalSlice: "Original beta content.",
                    replacementText: "NEW_BETA_2",
                    status: "preview_ready",
                },
            ]);

            adapter.acceptGhostHunk?.("hunk-ur-1");
            adapter.acceptGhostHunk?.("hunk-ur-2");
            expect(adapter.getValue()).toContain("NEW_ALPHA_1");
            expect(adapter.getValue()).toContain("NEW_BETA_2");

            expect(adapter.canUndo()).toBe(true);
            adapter.undo();
            expect(adapter.getValue()).toContain("NEW_ALPHA_1");
            expect(adapter.getValue()).toContain("Original beta content.");

            expect(adapter.canRedo()).toBe(true);
            adapter.redo();
            expect(adapter.getValue()).toContain("NEW_ALPHA_1");
            expect(adapter.getValue()).toContain("NEW_BETA_2");

            adapter.undo();
            adapter.undo();
            expect(adapter.getValue()).toBe(initialDoc);

            adapter.redo();
            expect(adapter.getValue()).toContain("NEW_ALPHA_1");
            adapter.redo();
            expect(adapter.getValue()).toContain("NEW_BETA_2");
        });

        it("should isolate ghost hunk undo from interleaved manual user typing", () => {
            const initialDoc = adapter.getValue();
            const from1 = initialDoc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;

            adapter.startGhostSession?.("session-isolate", [
                {
                    hunkId: "hunk-iso",
                    decisionIds: [],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "GHOST_REPLACED",
                    status: "preview_ready",
                },
            ]);

            const docLen = adapter.getCharCount();
            adapter.replaceRange(docLen, docLen, "\nUser manual comment.");

            adapter.acceptGhostHunk?.("hunk-iso");
            expect(adapter.getValue()).toContain("GHOST_REPLACED");
            expect(adapter.getValue()).toContain("User manual comment.");

            adapter.undo();
            expect(adapter.getValue()).not.toContain("GHOST_REPLACED");
            expect(adapter.getValue()).toContain("User manual comment.");

            adapter.undo();
            expect(adapter.getValue()).toBe(initialDoc);
        });

        it("should support acceptAllGhostHunks followed by single undo and single redo restoring full state", () => {
            const initialDoc = adapter.getValue();
            const from1 = initialDoc.indexOf("Original alpha content.");
            const to1 = from1 + "Original alpha content.".length;

            adapter.startGhostSession?.("session-all-ur", [
                {
                    hunkId: "h-all-1",
                    decisionIds: [],
                    headingSlug: "section-1",
                    from: from1,
                    to: to1,
                    originalSlice: "Original alpha content.",
                    replacementText: "ACCEPTED_ALL_TEXT",
                    status: "preview_ready",
                },
            ]);

            adapter.acceptAllGhostHunks?.();
            expect(adapter.getValue()).toContain("ACCEPTED_ALL_TEXT");

            adapter.undo();
            expect(adapter.getValue()).toBe(initialDoc);

            adapter.redo();
            expect(adapter.getValue()).toContain("ACCEPTED_ALL_TEXT");
        });
    });

    describe("11. Complex Interspersed Edits & Multi-Hunk Re-alignment", () => {
        it("should dynamically re-align 3 hunks with insertions between hunks 1-2 and deletions between hunks 2-3", () => {
            adapter.setValue("AA-1111-BB-2222-CC-3333-DD");
            const doc = adapter.getValue();

            const p1 = doc.indexOf("1111");
            const p2 = doc.indexOf("2222");
            const p3 = doc.indexOf("3333");

            adapter.startGhostSession?.("session-interspersed", [
                {
                    hunkId: "h1",
                    decisionIds: [],
                    headingSlug: "s1",
                    from: p1,
                    to: p1 + 4,
                    originalSlice: "1111",
                    replacementText: "ONE",
                    status: "preview_ready",
                },
                {
                    hunkId: "h2",
                    decisionIds: [],
                    headingSlug: "s2",
                    from: p2,
                    to: p2 + 4,
                    originalSlice: "2222",
                    replacementText: "TWO",
                    status: "preview_ready",
                },
                {
                    hunkId: "h3",
                    decisionIds: [],
                    headingSlug: "s3",
                    from: p3,
                    to: p3 + 4,
                    originalSlice: "3333",
                    replacementText: "THREE",
                    status: "preview_ready",
                },
            ]);

            const bbPos = adapter.getValue().indexOf("BB");
            adapter.replaceRange(bbPos, bbPos, "EXTRA_LONG_INSERTION_");

            let hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks[0].from).toBe(p1);
            const shift1 = "EXTRA_LONG_INSERTION_".length;
            expect(hunks[1].from).toBe(p2 + shift1);
            expect(hunks[2].from).toBe(p3 + shift1);

            const ccPos = adapter.getValue().indexOf("-CC-");
            adapter.replaceRange(ccPos, ccPos + 4, "-");

            hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks[0].from).toBe(p1);
            expect(hunks[1].from).toBe(p2 + shift1);
            const shift2 = shift1 - 3;
            expect(hunks[2].from).toBe(p3 + shift2);
        });

        it("should handle atomic multi-range edits across the document while preserving non-colliding hunks", () => {
            adapter.setValue("SECTION_A\nSECTION_B\nSECTION_C");
            const doc = adapter.getValue();
            const posB = doc.indexOf("SECTION_B");

            adapter.startGhostSession?.("session-multi-range", [
                {
                    hunkId: "h-b",
                    decisionIds: [],
                    headingSlug: "b",
                    from: posB,
                    to: posB + "SECTION_B".length,
                    originalSlice: "SECTION_B",
                    replacementText: "UPDATED_B",
                    status: "preview_ready",
                },
            ]);

            adapter.replaceRanges([
                { from: 0, to: "SECTION_A".length, insert: "A_MODIFIED" },
                {
                    from: doc.indexOf("SECTION_C"),
                    to: doc.indexOf("SECTION_C") + "SECTION_C".length,
                    insert: "C_MODIFIED",
                },
            ]);

            const hunks = adapter.getGhostHunks?.() ?? [];
            expect(hunks).toHaveLength(1);
            expect(hunks[0].hunkId).toBe("h-b");
            const deltaA = "A_MODIFIED".length - "SECTION_A".length;
            expect(hunks[0].from).toBe(posB + deltaA);
        });
    });

    describe("12. CMStreamingGhostWidget Interactive DOM & Actions", () => {
        it("should render widget with stop button during streaming and trigger onStop callback", () => {
            const onStop = vi.fn();
            const hunk: GhostHunk = {
                hunkId: "widget-stream",
                decisionIds: [],
                headingSlug: "test-slug",
                from: 0,
                to: 5,
                originalSlice: "hello",
                replacementText: "streaming content",
                status: "streaming",
                operation: "تحسين النص",
                onStop,
            };

            const widget = new CMStreamingGhostWidget(hunk);
            const dom = widget.toDOM(view);

            expect(dom.classList.contains("cm-ai-ghost-widget")).toBe(true);
            const titleBadge = dom.querySelector(".cm-ai-ghost-title-badge");
            expect(titleBadge?.textContent).toContain("تحسين النص");

            const stopBtn = dom.querySelector("button");
            expect(stopBtn).toBeDefined();
            expect(stopBtn?.textContent).toContain("إيقاف التوليد");

            stopBtn?.click();
            expect(onStop).toHaveBeenCalledTimes(1);
        });

        it("should render widget with reject, retry, and apply buttons in preview_ready state and invoke callbacks", () => {
            const onReject = vi.fn();
            const onRetry = vi.fn();
            const onApply = vi.fn();

            const hunk: GhostHunk = {
                hunkId: "widget-preview",
                decisionIds: [],
                headingSlug: "test-slug",
                from: 0,
                to: 5,
                originalSlice: "hello",
                replacementText: "Final proposed text",
                status: "preview_ready",
                operation: "صياغة بديلة",
                onReject,
                onRetry,
                onApply,
            };

            const widget = new CMStreamingGhostWidget(hunk);
            const dom = widget.toDOM(view);

            const buttons = dom.querySelectorAll("button");
            expect(buttons.length).toBe(3);

            const [rejectBtn, retryBtn, applyBtn] = Array.from(buttons);
            expect(rejectBtn.textContent).toContain("رفض");
            expect(retryBtn.textContent).toContain("إعادة المحاولة");
            expect(applyBtn.textContent).toContain("تطبيق التعديل");

            rejectBtn.click();
            expect(onReject).toHaveBeenCalledTimes(1);

            retryBtn.click();
            expect(onRetry).toHaveBeenCalledTimes(1);

            applyBtn.click();
            expect(onApply).toHaveBeenCalledTimes(1);
        });

        it("should detect text direction: Arabic text gets dir=rtl, Latin text gets dir=ltr", () => {
            const arabicHunk: GhostHunk = {
                hunkId: "ar-1",
                decisionIds: [],
                headingSlug: "ar",
                from: 0,
                to: 0,
                originalSlice: "",
                replacementText: "مرحبا بك في إلكسنت",
                status: "preview_ready",
            };
            const widgetAr = new CMStreamingGhostWidget(arabicHunk);
            const domAr = widgetAr.toDOM(view);
            const contentAr = domAr.querySelector(".cm-ai-ghost-content");
            expect(contentAr?.getAttribute("dir")).toBe("rtl");

            const latinHunk: GhostHunk = {
                hunkId: "en-1",
                decisionIds: [],
                headingSlug: "en",
                from: 0,
                to: 0,
                originalSlice: "",
                replacementText: "Welcome to Elixent Editor",
                status: "preview_ready",
            };
            const widgetEn = new CMStreamingGhostWidget(latinHunk);
            const domEn = widgetEn.toDOM(view);
            const contentEn = domEn.querySelector(".cm-ai-ghost-content");
            expect(contentEn?.getAttribute("dir")).toBe("ltr");
        });

        it("should update existing DOM node cleanly when updateDOM is called", () => {
            const hunk: GhostHunk = {
                hunkId: "upd-1",
                decisionIds: [],
                headingSlug: "upd",
                from: 0,
                to: 5,
                originalSlice: "hello",
                replacementText: "Initial chunk",
                status: "streaming",
            };

            const widget = new CMStreamingGhostWidget(hunk);
            const dom = widget.toDOM(view);

            const updatedHunk: GhostHunk = {
                ...hunk,
                replacementText: "Completed text",
                status: "preview_ready",
            };
            const updatedWidget = new CMStreamingGhostWidget(updatedHunk);

            const updated = updatedWidget.updateDOM(dom, view);
            expect(updated).toBe(true);

            const textNode = dom.querySelector(".cm-ai-ghost-text");
            expect(textNode?.textContent).toBe("Completed text");
            expect(dom.querySelector(".cm-ai-ghost-ping-dot")).toBeNull();
        });

        it("should return true from ignoreEvent to prevent editor interference", () => {
            const hunk: GhostHunk = {
                hunkId: "evt-1",
                decisionIds: [],
                headingSlug: "evt",
                from: 0,
                to: 0,
                originalSlice: "",
                replacementText: "text",
                status: "preview_ready",
            };
            const widget = new CMStreamingGhostWidget(hunk);
            expect(widget.ignoreEvent()).toBe(true);
        });

        it("should correctly compare widgets via eq()", () => {
            const hunk1: GhostHunk = {
                hunkId: "eq-1",
                decisionIds: ["d1"],
                headingSlug: "slug-1",
                from: 0,
                to: 5,
                originalSlice: "orig",
                replacementText: "rep",
                status: "streaming",
                operation: "op1",
            };
            const hunk2: GhostHunk = { ...hunk1 };
            const hunk3: GhostHunk = { ...hunk1, replacementText: "different" };

            const w1 = new CMStreamingGhostWidget(hunk1);
            const w2 = new CMStreamingGhostWidget(hunk2);
            const w3 = new CMStreamingGhostWidget(hunk3);

            expect(w1.eq(w2)).toBe(true);
            expect(w1.eq(w3)).toBe(false);
        });
    });

    describe("13. Edge Cases & Session Dismantling", () => {
        it("should dismantle ghost session and reset sessionId to null when all hunks collide", () => {
            adapter.startGhostSession?.("session-dismantle", [
                {
                    hunkId: "h-dis-1",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: 5,
                    to: 15,
                    originalSlice: "slice1",
                    replacementText: "r1",
                    status: "preview_ready",
                },
                {
                    hunkId: "h-dis-2",
                    decisionIds: [],
                    headingSlug: "sec",
                    from: 25,
                    to: 35,
                    originalSlice: "slice2",
                    replacementText: "r2",
                    status: "preview_ready",
                },
            ]);

            expect(adapter.getGhostHunks?.()).toHaveLength(2);

            adapter.setValue("Completely new text replacing everything");

            expect(adapter.getGhostHunks?.()).toHaveLength(0);
            const state = view.state.field(codeMirrorStreamingGhostField);
            expect(state.sessionId).toBeNull();
            expect(state.active).toBe(false);
        });

        it("should handle empty replacement text in hunks cleanly", () => {
            const doc = adapter.getValue();
            const from = 10;
            const to = 20;

            adapter.startGhostSession?.("session-empty-rep", [
                {
                    hunkId: "h-empty",
                    decisionIds: [],
                    headingSlug: "sec",
                    from,
                    to,
                    originalSlice: doc.slice(from, to),
                    replacementText: "",
                    status: "preview_ready",
                },
            ]);

            const accepted = adapter.acceptGhostHunk?.("h-empty");
            expect(accepted).toBe(true);

            expect(adapter.getValue().length).toBe(doc.length - (to - from));
        });
    });
});
