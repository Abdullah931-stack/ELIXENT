// @vitest-environment jsdom
/**
 * Phase 5 (Wave 5.2) — Tier 1 Single-Transaction CodeMirror Ctrl+Z & Heading Slug Navigation
 *
 * Covers:
 * - `src/components/editor/markdown/editor-adapter.ts` (`replaceRanges` single-tx `agent.mutation` +
 *   `isolateHistory.of("full")`, and `scrollToHeading`)
 * - `src/components/editor/markdown/streaming-ghost.ts` (`acceptGhostHunk` `"ai.accept.hunk"` &
 *   `acceptAllGhostHunks` `"ai.accept.all"` with `isolateHistory.of("full")`)
 * - `src/client/routes/editor-page.tsx` (`#headingSlug` initial hash & `hashchange` scroll wiring)
 *
 * Specifications: SRS-03 §5.1 (`REQ-UNDO-01`) & §4 (`REQ-GRAPH-UI-04` section jump).
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createEditorAdapter } from "@/components/editor/markdown/editor-adapter";
import { codeMirrorStreamingGhostField } from "@/components/editor/markdown/streaming-ghost";
import type { EditorAdapter, GhostHunk } from "@/components/editor/markdown/types";

const { mockScrollToHeading, mockUseEditorOrchestrator } = vi.hoisted(() => ({
  mockScrollToHeading: vi.fn().mockReturnValue(true),
  mockUseEditorOrchestrator: vi.fn(),
}));

vi.mock("@/client/navigation", () => ({
  useAppParams: () => ({ fileId: "file-hash-1" }),
  useAppNavigate: () => vi.fn(),
}));

vi.mock("@/lib/auth/client-identity", () => ({
  buildLoginRedirectPath: () => "/login",
  resolveInitialClientUserIdSync: () => "user-hash-1",
  resolveLocalFirstAuthUser: vi.fn().mockResolvedValue({ id: "user-hash-1" }),
}));

vi.mock("@/hooks/use-editor-orchestrator", () => ({
  useEditorOrchestrator: (...args: unknown[]) => mockUseEditorOrchestrator(...args),
}));

vi.mock("@/components/editor/markdown", () => ({
  MarkdownEditor: ({ onAdapterReady }: { onAdapterReady?: (a: EditorAdapter) => void }) => {
    React.useEffect(() => {
      onAdapterReady?.({
        getValue: () => "# Intro\n\n## Storage Layer\n\nBody.\n\n## API Contracts\n\nSpec.",
        setValue: vi.fn(),
        getSelection: () => ({ from: 0, to: 0 }),
        setSelection: vi.fn(),
        replaceRange: vi.fn(),
        replaceRanges: vi.fn(),
        getSelectedText: () => "",
        insertMarkdown: vi.fn(),
        setEditable: vi.fn(),
        focus: vi.fn(),
        blur: vi.fn(),
        hasFocus: () => false,
        undo: () => false,
        redo: () => false,
        canUndo: () => false,
        canRedo: () => false,
        getWordCount: () => 10,
        getCharCount: () => 50,
        getLineCount: () => 5,
        getHeadingCount: () => 3,
        getMode: () => "live",
        setMode: vi.fn(),
        getDirectionSettings: () => ({ mode: "auto", lockCodeBlocksLTR: true }),
        setDirectionSettings: vi.fn(),
        destroy: vi.fn(),
        scrollToHeading: mockScrollToHeading,
      } as EditorAdapter & { scrollToHeading: (slug: string) => boolean });
    }, [onAdapterReady]);
    return React.createElement("div", { "data-testid": "mock-md-editor" });
  },
}));

vi.mock("@/components/editor/ai-toolbar", () => ({
  AIToolbar: () => React.createElement("div", { "data-testid": "mock-ai-toolbar" }),
}));
vi.mock("@/components/editor/search-replace", () => ({
  SearchReplace: () => null,
}));
vi.mock("@/components/editor/ai-stream-status", () => ({
  AIStreamStatus: () => null,
}));
vi.mock("@/components/agent/chat-panel", () => ({
  AgentChatPanel: () => null,
}));
vi.mock("@/components/sync/sync-indicator", () => ({
  SyncIndicator: () => null,
}));
vi.mock("@/components/sync/conflict-dialog", () => ({
  ConflictDialog: () => null,
}));
vi.mock("@/components/vault", () => ({
  VaultUnlockModal: () => null,
}));
vi.mock("@/components/export/export-warning-modal", () => ({
  ExportWarningModal: () => null,
}));

import EditorPage from "@/client/routes/editor-page";

function mountRealCodeMirror(initialDoc: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);

  const recordedUserEvents: Array<string | undefined> = [];

  const view = new EditorView({
    state: EditorState.create({
      doc: initialDoc,
      extensions: [
        history(),
        codeMirrorStreamingGhostField,
        EditorState.transactionFilter.of((tr) => {
          if (tr.docChanged) {
            recordedUserEvents.push(tr.annotation(Transaction.userEvent));
          }
          return tr;
        }),
      ],
    }),
    parent: host,
  });

  const adapter = createEditorAdapter(view, "source") as ReturnType<
    typeof createEditorAdapter
  > & { scrollToHeading: (headingSlug: string) => boolean };

  return {
    view,
    adapter,
    recordedUserEvents,
    destroy: () => {
      adapter.destroy();
      host.remove();
    },
  };
}

describe("Tier 1 Single-Transaction CodeMirror Ctrl+Z (REQ-UNDO-01)", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("replaceRanges applies multi-section edits as one isolated 'agent.mutation' transaction so a single undo reverts all sections without reverting prior user typing", () => {
    const initial =
      "# Overview\n\nAlpha body.\n\n## Storage\n\nBeta body.\n\n## Caching\n\nGamma body.";
    const { adapter, recordedUserEvents, destroy } = mountRealCodeMirror(initial);

    try {
      // Simulate user typing immediately before the agent mutation
      const introEnd = adapter.getValue().indexOf("Alpha body.") + "Alpha body.".length;
      adapter.replaceRange(introEnd, introEnd, " User note.");
      const afterUserTyping = adapter.getValue();
      expect(afterUserTyping).toContain("Alpha body. User note.");

      const alphaStart = afterUserTyping.indexOf("Alpha body.");
      const betaStart = afterUserTyping.indexOf("Beta body.");
      const gammaStart = afterUserTyping.indexOf("Gamma body.");

      // Apply 3 non-overlapping replacements in a single call (including an overlapping one that must be filtered safely)
      adapter.replaceRanges([
        { from: gammaStart, to: gammaStart + "Gamma body.".length, insert: "Redis cache." },
        { from: alphaStart, to: alphaStart + "Alpha body.".length, insert: "Architecture v2." },
        { from: alphaStart + 2, to: alphaStart + 6, insert: "OVERLAP_IGNORED" },
        { from: betaStart, to: betaStart + "Beta body.".length, insert: "PostgreSQL Neon." },
      ]);

      const afterAgent = adapter.getValue();
      expect(afterAgent).toContain("Architecture v2. User note.");
      expect(afterAgent).toContain("PostgreSQL Neon.");
      expect(afterAgent).toContain("Redis cache.");
      expect(afterAgent).not.toContain("OVERLAP_IGNORED");
      expect(recordedUserEvents[recordedUserEvents.length - 1]).toBe("agent.mutation");

      // 1st Ctrl+Z (undo): reverts ALL 3 agent ranges atomically while preserving the preceding user note!
      expect(adapter.undo()).toBe(true);
      expect(adapter.getValue()).toBe(afterUserTyping);

      // 2nd Ctrl+Z (undo): reverts the preceding user edit cleanly
      expect(adapter.undo()).toBe(true);
      expect(adapter.getValue()).toBe(initial);
    } finally {
      destroy();
    }
  });

  it("acceptAllGhostHunks commits all pending hunks as one isolated 'ai.accept.all' transaction reversible by a single undo", () => {
    const initial = "# Intro\n\nOld intro.\n\n## Security\n\nOld security.";
    const { adapter, recordedUserEvents, destroy } = mountRealCodeMirror(initial);

    try {
      // Prior user edit (must stay isolated from AI accept undo boundary)
      adapter.replaceRange(0, 0, "<!-- v1 -->\n");
      const docAfterUser = adapter.getValue();

      const introFrom = docAfterUser.indexOf("Old intro.");
      const secFrom = docAfterUser.indexOf("Old security.");

      const hunks: GhostHunk[] = [
        {
          hunkId: "h-intro",
          decisionIds: ["dec-1"],
          headingSlug: "intro",
          from: introFrom,
          to: introFrom + "Old intro.".length,
          originalSlice: "Old intro.",
          replacementText: "New intro.",
          status: "preview_ready",
        },
        {
          hunkId: "h-sec",
          decisionIds: ["dec-2"],
          headingSlug: "security",
          from: secFrom,
          to: secFrom + "Old security.".length,
          originalSlice: "Old security.",
          replacementText: "Zero-Knowledge Vault security.",
          status: "preview_ready",
        },
      ];

      adapter.startGhostSession?.("sess-undo-all", hunks);
      expect(adapter.acceptAllGhostHunks?.()).toBe(true);

      expect(adapter.getValue()).toContain("New intro.");
      expect(adapter.getValue()).toContain("Zero-Knowledge Vault security.");
      expect(adapter.getGhostHunks?.()).toHaveLength(0);
      expect(recordedUserEvents[recordedUserEvents.length - 1]).toBe("ai.accept.all");

      // Single undo reverses BOTH accepted hunks while keeping user's <!-- v1 --> header
      expect(adapter.undo()).toBe(true);
      expect(adapter.getValue()).toBe(docAfterUser);
    } finally {
      destroy();
    }
  });

  it("acceptGhostHunk commits a single hunk with 'ai.accept.hunk' + isolated history while preserving sibling hunks", () => {
    const initial = "First section.\n\nSecond section.";
    const { adapter, recordedUserEvents, destroy } = mountRealCodeMirror(initial);

    try {
      adapter.startGhostSession?.("sess-single", [
        {
          hunkId: "h-1",
          decisionIds: ["dec-1"],
          headingSlug: "first",
          from: 0,
          to: "First section.".length,
          originalSlice: "First section.",
          replacementText: "Updated first.",
          status: "preview_ready",
        },
        {
          hunkId: "h-2",
          decisionIds: ["dec-2"],
          headingSlug: "second",
          from: initial.indexOf("Second section."),
          to: initial.length,
          originalSlice: "Second section.",
          replacementText: "Updated second.",
          status: "preview_ready",
        },
      ]);

      expect(adapter.acceptGhostHunk?.("h-1")).toBe(true);
      expect(adapter.getValue()).toBe("Updated first.\n\nSecond section.");
      expect(adapter.getGhostHunks?.()).toHaveLength(1);
      expect(adapter.getGhostHunks?.()[0].hunkId).toBe("h-2");
      expect(recordedUserEvents[recordedUserEvents.length - 1]).toBe("ai.accept.hunk");

      expect(adapter.undo()).toBe(true);
      expect(adapter.getValue()).toBe(initial);
    } finally {
      destroy();
    }
  });
});

describe("Heading Slug Scroll Navigation (editor-adapter.ts & editor-page.tsx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = "";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
    document.body.innerHTML = "";
  });

  it.each([
    { rawSlug: "storage-layer", expectedFound: true },
    { rawSlug: "#storage-layer", expectedFound: true },
    { rawSlug: "  #Storage-Layer  ", expectedFound: true },
    { rawSlug: "non-existent-heading", expectedFound: false },
    { rawSlug: "", expectedFound: false },
  ])(
    "scrollToHeading('$rawSlug') returns $expectedFound and positions cursor at the matching heading offset",
    ({ rawSlug, expectedFound }) => {
      const doc = "# Intro\n\nOverview.\n\n## Storage Layer\n\nPostgreSQL details.";
      const { adapter, destroy } = mountRealCodeMirror(doc);

      try {
        const expectedOffset = doc.indexOf("## Storage Layer");
        const found = adapter.scrollToHeading(rawSlug);
        expect(found).toBe(expectedFound);

        if (expectedFound) {
          expect(adapter.getSelection()).toEqual({
            from: expectedOffset,
            to: expectedOffset,
          });
        } else {
          expect(adapter.getSelection()).toEqual({ from: 0, to: 0 });
        }
      } finally {
        destroy();
      }
    },
  );

  it("EditorPage triggers adapter.scrollToHeading on initial #headingSlug hash when hydration is ready and on subsequent hashchange events", async () => {
    mockUseEditorOrchestrator.mockReturnValue({
      title: "Architecture",
      hydration: "ready",
      aiStatus: "idle",
      aiError: null,
      agentGraphStage: null,
      activeQuestionQueue: [],
      masterDecisionLedger: {},
      activeGhostHunks: [],
      activeGhostHunksCount: 0,
      selectedSystem2ModelId: "google/gemini-3.8-flash",
      setSelectedSystem2ModelId: vi.fn(),
      permissionMode: "safe",
      setPermissionMode: vi.fn(),
      startAgentSession: vi.fn(),
      resumeAgentInterrupt: vi.fn(),
      resumeInsufficientCreditsTask: vi.fn(),
      stopAIOperation: vi.fn(),
      resetAI: vi.fn(),
      acceptGhostHunk: vi.fn(),
      rejectGhostHunk: vi.fn(),
      acceptAllGhostHunks: vi.fn(),
      rejectAllGhostHunks: vi.fn(),
      mutatedTurns: [],
      revertingTurnId: null,
      isRevertingSession: false,
      handleRevertTurn: vi.fn(),
      handleRevertSession: vi.fn(),
      zkAiNotice: null,
      isCommitting: false,
      isAIActive: false,
      isAIConflict: false,
      isSaving: false,
      lastSaved: null,
      error: null,
      setError: vi.fn(),
      activeConflict: null,
      isConflictDialogOpen: false,
      setIsConflictDialogOpen: vi.fn(),
      isResolvingConflict: false,
      handleResolveConflict: vi.fn(),
      syncHook: {
        status: "idle",
        connectionState: "online",
        pendingCount: 0,
        lastSyncResult: null,
        sync: vi.fn(),
      },
      handleEditorChange: vi.fn(),
      isEncrypted: false,
      allowAIOnEncryptedFiles: true,
      isVaultLocked: false,
      isUnlockModalOpen: false,
      setIsUnlockModalOpen: vi.fn(),
      handleVaultUnlocked: vi.fn(),
    });

    window.location.hash = "#storage-layer";
    render(React.createElement(EditorPage));

    await waitFor(() => {
      expect(mockScrollToHeading).toHaveBeenCalledWith("storage-layer");
    });

    window.location.hash = "#api-contracts";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(mockScrollToHeading).toHaveBeenCalledWith("api-contracts");
    });
  });
});
