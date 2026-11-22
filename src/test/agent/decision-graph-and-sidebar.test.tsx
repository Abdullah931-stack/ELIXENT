// @vitest-environment jsdom
/**
 * Phase 5 (Wave 5.1) — Native SVG DecisionGraphExplorer, Sidebar Controls
 * (`decision_ledger` filtering, Graph button, Workspace Switcher, ZIP Export)
 * & Wave 5.1 Architectural Boundary Contracts (`DEF-13`, `clientServerBoundaryGuardPlugin`)
 *
 * Covers:
 * - `src/components/agent/decision-graph-explorer.tsx` (SRS-03 §4 `REQ-GRAPH-UI-01..04`)
 * - `src/components/layout/sidebar.tsx` (Plan Wave 5.1 Task 5.B)
 * - Static & Vite boundary plugin verification across all 11 Wave 5.1 target modules
 */

import React, { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  DecisionGraphNode,
  DecisionLedgerDocument,
} from "@/core/agent/atms/dag";
import type { FileRecord, WorkspaceRecord } from "@/types/rpc-contracts";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";
import { WorkspaceZipExportError } from "@/lib/export/workspace-zip-exporter";

const {
  mockNavigateTo,
  mockGetUserFiles,
  mockGetDeletedFiles,
  mockGetFile,
  mockCreateFile,
  mockMoveFile,
  mockImportFile,
  mockListWorkspacesRpc,
  mockCreateWorkspaceRpc,
  mockExportWorkspaceAsZip,
  mockToast,
} = vi.hoisted(() => ({
  mockNavigateTo: vi.fn(),
  mockGetUserFiles: vi.fn(),
  mockGetDeletedFiles: vi.fn(),
  mockGetFile: vi.fn(),
  mockCreateFile: vi.fn(),
  mockMoveFile: vi.fn(),
  mockImportFile: vi.fn(),
  mockListWorkspacesRpc: vi.fn(),
  mockCreateWorkspaceRpc: vi.fn(),
  mockExportWorkspaceAsZip: vi.fn(),
  mockToast: vi.fn(),
}));

// Mock only external HTTP/RPC, navigation, auth, toast, and ZIP download boundaries.
vi.mock("@/client/navigation", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
}));

vi.mock("@/client/rpc-client", () => ({
  getUserFiles: (...args: unknown[]) => mockGetUserFiles(...args),
  getDeletedFiles: (...args: unknown[]) => mockGetDeletedFiles(...args),
  getFile: (...args: unknown[]) => mockGetFile(...args),
  createFile: (...args: unknown[]) => mockCreateFile(...args),
  moveFile: (...args: unknown[]) => mockMoveFile(...args),
  importFile: (...args: unknown[]) => mockImportFile(...args),
  listWorkspacesRpc: (...args: unknown[]) => mockListWorkspacesRpc(...args),
  createWorkspaceRpc: (...args: unknown[]) => mockCreateWorkspaceRpc(...args),
  deleteFile: vi.fn(),
  restoreWorkspaceFileRpc: vi.fn(),
  renameFile: vi.fn(),
  copyFile: vi.fn(),
  toggleFileEncryption: vi.fn(),
  updateFileContent: vi.fn(),
  getUserVaultProfile: vi.fn().mockResolvedValue({ success: false, data: null }),
  decryptEntireWorkspaceRpc: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-graph-1" } } }),
    },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/lib/parsers/pdf-ocr-engine", () => ({
  isOcrPackageInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/export/workspace-zip-exporter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/export/workspace-zip-exporter")>();
  return {
    ...actual,
    exportWorkspaceAsZip: (...args: unknown[]) =>
      mockExportWorkspaceAsZip(...args),
  };
});

import { DecisionGraphExplorer } from "@/components/agent/decision-graph-explorer";
import { Sidebar } from "@/components/layout/sidebar";
import {
  WorkspaceTabsProvider,
  useWorkspaceTabs,
  type WorkspaceTabsContextValue,
} from "@/components/editor/workspace-tab-bar";

function buildNode(
  overrides: Partial<DecisionGraphNode> & { decisionId: string },
): DecisionGraphNode {
  return {
    decisionId: overrides.decisionId,
    topicSlug: overrides.topicSlug ?? `topic-${overrides.decisionId}`,
    questionPrompt:
      overrides.questionPrompt ?? `Question for ${overrides.decisionId}?`,
    conceptTags: overrides.conceptTags ?? ["architecture"],
    selectedOptionKey: overrides.selectedOptionKey ?? "option-a",
    selectionRationale:
      overrides.selectionRationale ?? `Rationale for ${overrides.decisionId}`,
    runnerUpOptionKey: overrides.runnerUpOptionKey ?? "option-b",
    evaluatedAlternatives: overrides.evaluatedAlternatives ?? [
      {
        optionKey: overrides.selectedOptionKey ?? "option-a",
        neutralSummary: "Primary winning architecture option",
        rationaleAndPremises: "Lowest operational coupling",
      },
      {
        optionKey: "option-b",
        neutralSummary: "Secondary fallback option",
        rationaleAndPremises: "Higher migration cost",
      },
    ],
    status: overrides.status ?? "APPROVED_DIRECT",
    impactTier: overrides.impactTier ?? "CORE_ARCHITECTURAL",
    isLoadBearing: overrides.isLoadBearing ?? true,
    dependsOn: overrides.dependsOn ?? [],
    dependedBy: overrides.dependedBy ?? [],
    affectedSections: overrides.affectedSections ?? [],
    changeWeight: overrides.changeWeight ?? {
      total: 65,
      structural: 25,
      provenance: 15,
      topology: 15,
      surface: 10,
    },
  };
}

/**
 * Builds a 4-node chain: d1 <- d2 <- d3 <- d4
 * (d4 depends on d3, d3 refines d2, d2 depends on d1).
 * Supplied out of topological order to verify deterministic layout sorting.
 */
function buildChainLedger(): DecisionLedgerDocument {
  const d1 = buildNode({
    decisionId: "dec-1",
    topicSlug: "database-engine",
    selectedOptionKey: "postgresql",
    dependedBy: ["dec-2"],
    changeWeight: {
      total: 85,
      structural: 30,
      provenance: 20,
      topology: 20,
      surface: 15,
    },
    affectedSections: [
      { fileId: "file-arch", headingSlug: "storage-layer" },
    ],
  });
  const d2 = buildNode({
    decisionId: "dec-2",
    topicSlug: "orm-layer",
    selectedOptionKey: "drizzle-orm",
    status: "APPROVED_CONSERVATIVE",
    dependsOn: ["dec-1"],
    dependedBy: ["dec-3"],
    changeWeight: {
      total: 55,
      structural: 20,
      provenance: 15,
      topology: 10,
      surface: 10,
    },
    affectedSections: [
      { fileId: "file-arch", headingSlug: "orm-contracts" },
    ],
  });
  const d3 = buildNode({
    decisionId: "dec-3",
    topicSlug: "query-isolation",
    selectedOptionKey: "workspace-scoped-indexes",
    dependsOn: ["dec-2"],
    dependedBy: ["dec-4"],
    changeWeight: {
      total: 40,
      structural: 15,
      provenance: 10,
      topology: 10,
      surface: 5,
    },
  });
  const d4 = buildNode({
    decisionId: "dec-4",
    topicSlug: "cache-strategy",
    selectedOptionKey: "redis-write-through",
    dependsOn: ["dec-3"],
    changeWeight: {
      total: 30,
      structural: 10,
      provenance: 10,
      topology: 5,
      surface: 5,
    },
  });

  return {
    schemaVersion: "2.0.0",
    workspaceId: "ws-graph",
    updatedAt: "2026-02-01T00:00:00.000Z",
    taxonomy: null,
    // Intentionally out of order to verify deterministic topological column assignment
    nodes: {
      "dec-4": d4,
      "dec-2": d2,
      "dec-1": d1,
      "dec-3": d3,
    },
    edges: [
      {
        edgeId: "edge-2-1",
        sourceDecisionId: "dec-2",
        targetDecisionId: "dec-1",
        relation: "DEPENDS_ON",
        confidence: 0.92,
        justification: "Drizzle schema dialect requires PostgreSQL engine.",
      },
      {
        edgeId: "edge-3-2",
        sourceDecisionId: "dec-3",
        targetDecisionId: "dec-2",
        relation: "REFINES",
        confidence: 0.85,
        justification: "Adds composite unique indexes on Drizzle tables.",
      },
      {
        edgeId: "edge-4-3",
        sourceDecisionId: "dec-4",
        targetDecisionId: "dec-3",
        relation: "DEPENDS_ON",
        confidence: 0.78,
        justification: "Cache keys mirror workspace-scoped isolation rules.",
      },
    ],
  };
}

function buildFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: overrides.id ?? "file-doc-1",
    userId: overrides.userId ?? "user-graph-1",
    workspaceId: overrides.workspaceId ?? "ws-1",
    title: overrides.title ?? "architecture.md",
    content: overrides.content ?? "# Architecture",
    parentFolderId: overrides.parentFolderId ?? null,
    isFolder: overrides.isFolder ?? false,
    isAiExcluded: overrides.isAiExcluded ?? false,
    artifactRole: overrides.artifactRole ?? "document",
    isEncrypted: overrides.isEncrypted ?? false,
    encryptionMetadata: overrides.encryptionMetadata ?? null,
    etag: overrides.etag ?? "etag-1",
    version: overrides.version ?? 1,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function buildWorkspaceRecord(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id: overrides.id ?? "ws-1",
    userId: overrides.userId ?? "user-graph-1",
    name: overrides.name ?? "Primary Workspace",
    description: overrides.description ?? null,
    isEncrypted: overrides.isEncrypted ?? false,
    defaultPermissionMode: overrides.defaultPermissionMode ?? "safe",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function TabsBridge({
  onReady,
}: {
  onReady: (ctx: WorkspaceTabsContextValue) => void;
}) {
  const ctx = useWorkspaceTabs();
  useEffect(() => {
    onReady(ctx);
  }, [ctx, onReady]);
  return null;
}

describe("DecisionGraphExplorer — Native SVG Topological Graph & Inspector (REQ-GRAPH-UI-01..04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionKeyStore.purgeKeys(false);
  });

  afterEach(() => {
    cleanup();
    sessionKeyStore.purgeKeys(false);
  });

  it("lays out nodes in deterministic left-to-right topological columns with Bézier edges and supports Node/Edge inspection, Depth Filtering (1 Hop / 2 Hops / Full Chain), and section jumps", () => {
    const ledger = buildChainLedger();
    const onJumpToSection = vi.fn();

    render(
      <DecisionGraphExplorer
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-graph"
        ledgerDocument={ledger}
        onJumpToSection={onJumpToSection}
      />,
    );

    const svg = screen.getByTestId("decision-graph-svg");
    expect(svg.tagName.toLowerCase()).toBe("svg");

    // Verify deterministic left-to-right topological x positions: dec-1 < dec-2 < dec-3 < dec-4
    const getNodeGroupByTopic = (topic: string): SVGGElement => {
      const textEl = screen.getByText(topic);
      const group = textEl.closest("g");
      if (!group) throw new Error(`Missing <g> for ${topic}`);
      return group;
    };
    const parseTranslateX = (g: SVGGElement): number => {
      const match = /translate\(([-\d.]+),/.exec(g.getAttribute("transform") ?? "");
      return match ? Number(match[1]) : NaN;
    };

    const g1 = getNodeGroupByTopic("database-engine");
    const g2 = getNodeGroupByTopic("orm-layer");
    const g3 = getNodeGroupByTopic("query-isolation");
    const g4 = getNodeGroupByTopic("cache-strategy");

    expect(parseTranslateX(g1)).toBeLessThan(parseTranslateX(g2));
    expect(parseTranslateX(g2)).toBeLessThan(parseTranslateX(g3));
    expect(parseTranslateX(g3)).toBeLessThan(parseTranslateX(g4));

    // Verify Bézier edge paths (C control points) and edge labels exist
    const bezierPaths = Array.from(svg.querySelectorAll("path")).filter((p) =>
      /^M .+ C .+/.test(p.getAttribute("d") ?? ""),
    );
    expect(bezierPaths.length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("DEPENDS_ON").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("REFINES")).toBeDefined();

    // Click node dec-1 -> opens Decision Inspector Drawer with full details
    fireEvent.click(g1);
    const drawer = screen.getByLabelText("Decision Inspector Drawer");
    expect(drawer.textContent).toContain("dec-1");
    expect(drawer.textContent).toContain("Rationale for dec-1");
    expect(drawer.textContent).toContain("Total: 85");
    expect(drawer.textContent).toContain("Evaluated Alternatives (2)");
    expect(drawer.textContent).toContain("Selected");

    // Depth Filter: with dec-1 selected, "1 Hop" highlights dec-1 & dec-2, dims dec-3 & dec-4
    fireEvent.click(screen.getByRole("button", { name: "1 Hop" }));
    expect(g1.getAttribute("opacity")).toBe("1");
    expect(g2.getAttribute("opacity")).toBe("1");
    expect(g3.getAttribute("opacity")).toBe("0.25");
    expect(g4.getAttribute("opacity")).toBe("0.25");

    // "2 Hops" includes dec-3 while still dimming dec-4
    fireEvent.click(screen.getByRole("button", { name: "2 Hops" }));
    expect(g3.getAttribute("opacity")).toBe("1");
    expect(g4.getAttribute("opacity")).toBe("0.25");

    // "Full Chain" highlights all 4 nodes
    fireEvent.click(screen.getByRole("button", { name: "Full Chain" }));
    expect(g4.getAttribute("opacity")).toBe("1");

    // Click affected section link -> invokes onJumpToSection(fileId, headingSlug)
    fireEvent.click(
      screen.getByRole("button", { name: /file-arch#storage-layer/i }),
    );
    expect(onJumpToSection).toHaveBeenCalledWith("file-arch", "storage-layer");

    // Click downstream linked decision button in Inspector -> navigates to dec-2
    fireEvent.click(screen.getByRole("button", { name: "dec-2" }));
    expect(drawer.textContent).toContain("Rationale for dec-2");
    expect(drawer.textContent).toContain("Total: 55");

    // Click directed edge (REFINES) -> switches drawer to Edge Inspector
    const refinesEdgeGroup = screen.getByText("REFINES").closest("g")!;
    fireEvent.click(refinesEdgeGroup);
    expect(drawer.textContent).toContain("Edge Inspector");
    expect(drawer.textContent).toContain("85%");
    expect(drawer.textContent).toContain(
      "Adds composite unique indexes on Drizzle tables.",
    );
  });

  it("handles cyclic decision dependencies deterministically without infinite loops and supports Download JSON", () => {
    const cycleLedger: DecisionLedgerDocument = {
      schemaVersion: "2.0.0",
      workspaceId: "ws-cycle",
      updatedAt: "2026-02-01T00:00:00.000Z",
      taxonomy: null,
      nodes: {
        "c-a": buildNode({
          decisionId: "c-a",
          topicSlug: "cycle-alpha",
          dependsOn: ["c-b"],
          dependedBy: ["c-b"],
        }),
        "c-b": buildNode({
          decisionId: "c-b",
          topicSlug: "cycle-beta",
          dependsOn: ["c-a"],
          dependedBy: ["c-a"],
        }),
      },
      edges: [
        {
          edgeId: "e-ab",
          sourceDecisionId: "c-a",
          targetDecisionId: "c-b",
          relation: "DEPENDS_ON",
        },
        {
          edgeId: "e-ba",
          sourceDecisionId: "c-b",
          targetDecisionId: "c-a",
          relation: "OVERRIDES",
        },
      ],
    };

    const createObjectURL = vi.fn(() => "blob:ledger-json");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
    });
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(
      <DecisionGraphExplorer
        isOpen={true}
        onClose={vi.fn()}
        ledgerDocument={cycleLedger}
      />,
    );

    expect(screen.getByText("cycle-alpha")).toBeDefined();
    expect(screen.getByText("cycle-beta")).toBeDefined();
    expect(screen.getByText("2 nodes")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Download JSON/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ledger-json");

    anchorClickSpy.mockRestore();
  });

  it("loads and decrypts an encrypted decision_ledger from workspace RPC when ledgerDocument is omitted, and reports vault-locked error when locked", async () => {
    const ledger = buildChainLedger();
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    sessionKeyStore.setMasterKey(masterKey);

    const enc = await SyncCryptoGateway.encryptOutbound(
      "ledger-file-1",
      JSON.stringify(ledger),
      "user-graph-1",
    );

    mockGetUserFiles.mockResolvedValue({
      success: true,
      data: [
        buildFileRecord({
          id: "ledger-file-1",
          workspaceId: "ws-graph",
          title: "decisions.ledger.json",
          artifactRole: "decision_ledger",
          isEncrypted: true,
        }),
      ],
    });
    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: "ledger-file-1",
        workspaceId: "ws-graph",
        userId: "user-graph-1",
        title: "decisions.ledger.json",
        artifactRole: "decision_ledger",
        isEncrypted: true,
        content: enc.ciphertextBase64,
        encryptionMetadata: enc.encryptionMetadata,
      }),
    });

    const { unmount } = render(
      <DecisionGraphExplorer
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-graph"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("database-engine")).toBeDefined();
    });

    unmount();

    // Now lock the vault and verify fail-closed message
    sessionKeyStore.purgeKeys(false);
    const lockedRender = render(
      <DecisionGraphExplorer
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-graph"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Vault is locked\. Unlock your vault/i),
      ).toBeDefined();
    });
    lockedRender.unmount();

    // Now unlock with a mismatched key -> real AES-GCM fails with status === "error"
    // and DecisionGraphExplorer surfaces decryption error cleanly instead of JSON.parse crash
    const wrongKey = new Uint8Array(32);
    crypto.getRandomValues(wrongKey);
    sessionKeyStore.setMasterKey(wrongKey);
    render(
      <DecisionGraphExplorer
        isOpen={true}
        onClose={vi.fn()}
        workspaceId="ws-graph"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/decrypt/i)).toBeDefined();
    });
  });
});

describe("Sidebar — Decision Ledger Filtering, Graph Action, Workspace Switcher & ZIP Export (Wave 5.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    sessionKeyStore.purgeKeys(false);

    mockListWorkspacesRpc.mockResolvedValue({
      success: true,
      data: [
        buildWorkspaceRecord({ id: "ws-1", name: "Workspace Alpha" }),
        buildWorkspaceRecord({ id: "ws-2", name: "Workspace Beta" }),
      ],
    });
    mockGetDeletedFiles.mockResolvedValue({ success: true, data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("hides artifactRole='decision_ledger' from the Markdown file tree, shows active node count on Decision Graph button, renders compact UnresolvedEditsTracker, and switches workspaces", async () => {
    const ledger = buildChainLedger();

    mockGetUserFiles.mockResolvedValue({
      success: true,
      data: [
        buildFileRecord({
          id: "doc-ws1",
          workspaceId: "ws-1",
          title: "design-spec.md",
          artifactRole: "document",
        }),
        buildFileRecord({
          id: "ledger-ws1",
          workspaceId: "ws-1",
          title: "decisions.ledger.json",
          artifactRole: "decision_ledger",
        }),
        buildFileRecord({
          id: "doc-ws2",
          workspaceId: "ws-2",
          title: "beta-notes.md",
          artifactRole: "document",
        }),
      ],
    });
    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: "ledger-ws1",
        workspaceId: "ws-1",
        title: "decisions.ledger.json",
        artifactRole: "decision_ledger",
        content: JSON.stringify(ledger),
      }),
    });

    let ctx!: WorkspaceTabsContextValue;
    render(
      <WorkspaceTabsProvider>
        <TabsBridge onReady={(c) => (ctx = c)} />
        <Sidebar userId="user-graph-1" />
      </WorkspaceTabsProvider>,
    );

    // Wait for ws-1 files and ledger preload
    await waitFor(() => {
      expect(screen.getByText("design-spec.md")).toBeDefined();
    });

    // decisions.ledger.json MUST be filtered out of raw Markdown tree
    expect(screen.queryByText("decisions.ledger.json")).toBeNull();
    // ws-2 file MUST be isolated away while ws-1 is active
    expect(screen.queryByText("beta-notes.md")).toBeNull();

    // Decision Graph header button shows preloaded active node count (4) and opens explorer
    const graphBtn = await screen.findByRole("button", {
      name: /Decision Graph/i,
    });
    await waitFor(() => {
      expect(graphBtn.textContent).toContain("4");
    });

    fireEvent.click(graphBtn);
    expect(
      screen.getByRole("dialog", { name: "Decision Graph Explorer" }),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Close Decision Graph Explorer" }),
    );

    // Compact UnresolvedEditsTracker appears in Files header when pending hunks exist
    act(() => {
      ctx.setGhostHunksForFile("doc-ws1", [
        {
          hunkId: "h-sb-1",
          decisionIds: ["dec-1"],
          headingSlug: "intro",
          from: 0,
          to: 3,
          originalSlice: "Old",
          replacementText: "New",
          status: "preview_ready",
        },
      ]);
    });
    expect(screen.getByText("1 Unresolved")).toBeDefined();

    // Switching workspace updates file tree to ws-2
    const switcher = screen.getByLabelText("Active Workspace");
    fireEvent.change(switcher, { target: { value: "ws-2" } });

    await waitFor(() => {
      expect(screen.getByText("beta-notes.md")).toBeDefined();
    });
    expect(screen.queryByText("design-spec.md")).toBeNull();
  });

  it("Export Workspace (.zip) handles ENCRYPTED_EXPORT_UNCONFIRMED by prompting confirmation and retrying with confirmedPlaintextExport: true", async () => {
    mockGetUserFiles.mockResolvedValue({
      success: true,
      data: [
        buildFileRecord({
          id: "enc-doc-1",
          workspaceId: "ws-1",
          title: "vault-doc.md",
          isEncrypted: true,
        }),
      ],
    });
    mockGetFile.mockResolvedValue({
      success: true,
      data: buildFileRecord({
        id: "enc-doc-1",
        workspaceId: "ws-1",
        title: "vault-doc.md",
        isEncrypted: true,
        content: "ciphertext",
      }),
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const createObjectURL = vi.fn(() => "blob:ws-zip");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
    });
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    mockExportWorkspaceAsZip
      .mockRejectedValueOnce(
        new WorkspaceZipExportError(
          "ENCRYPTED_EXPORT_UNCONFIRMED",
          "Confirm plaintext export",
        ),
      )
      .mockResolvedValueOnce(new Blob(["PK\x03\x04"], { type: "application/zip" }));

    render(
      <WorkspaceTabsProvider>
        <Sidebar userId="user-graph-1" />
      </WorkspaceTabsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("vault-doc.md")).toBeDefined();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Export Workspace \(\.zip\)/i }),
    );

    await waitFor(() => {
      expect(mockExportWorkspaceAsZip).toHaveBeenCalledTimes(2);
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockExportWorkspaceAsZip).toHaveBeenNthCalledWith(
      1,
      "ws-1",
      expect.objectContaining({ confirmedPlaintextExport: false }),
    );
    expect(mockExportWorkspaceAsZip).toHaveBeenNthCalledWith(
      2,
      "ws-1",
      expect.objectContaining({ confirmedPlaintextExport: true }),
    );
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ws-zip");

    confirmSpy.mockRestore();
    anchorClickSpy.mockRestore();
  });
});
