import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  GitBranch,
  Layers,
  X,
  ExternalLink,
  AlertCircle,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getFile, getUserFiles } from "@/client/rpc-client";
import { navigateTo } from "@/client/navigation";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";
import { useOptionalWorkspaceTabs } from "@/components/editor/workspace-tab-bar";
import type { FileRecord } from "@/types/rpc-contracts";
import {
  type DecisionLedgerDocument,
  type DecisionGraphNode,
  type DirectedDecisionEdge,
  type DecisionEdgeRelation,
  traverseDecisionDependencies,
  getDecisionNodeDetails,
} from "@/core/agent/atms/dag";

export interface DecisionGraphExplorerProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly workspaceId?: string;
  readonly ledgerDocument?: DecisionLedgerDocument | null;
  readonly onJumpToSection?: (fileId: string, headingSlug: string) => void;
}

type DepthFilter = 1 | 2 | "all";

interface PositionedNode {
  readonly node: DecisionGraphNode;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
}

interface GraphLayout {
  readonly positionedNodes: readonly PositionedNode[];
  readonly nodePositionMap: ReadonlyMap<string, PositionedNode>;
  readonly width: number;
  readonly height: number;
}

const NODE_WIDTH = 216;
const NODE_HEIGHT = 76;
const COL_GAP = 88;
const ROW_GAP = 28;
const PADDING_X = 36;
const PADDING_Y = 36;

const EDGE_COLORS: Record<DecisionEdgeRelation, string> = {
  DEPENDS_ON: "#6366f1",
  REFINES: "#10b981",
  OVERRIDES: "#f59e0b",
};

/**
 * Computes a deterministic left-to-right topological layer layout.
 * Upstream dependencies sit on the left; dependent decisions sit on the right.
 * Cycles and orphan nodes are placed deterministically without infinite loops.
 */
function computeTopologicalLayers(
  nodes: readonly DecisionGraphNode[],
  edges: readonly DirectedDecisionEdge[],
): GraphLayout {
  if (nodes.length === 0) {
    return {
      positionedNodes: [],
      nodePositionMap: new Map(),
      width: 640,
      height: 360,
    };
  }

  const sortedNodes = [...nodes].sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  const nodeIds = new Set(sortedNodes.map((n) => n.decisionId));

  // Edge: sourceDecisionId depends on targetDecisionId => target -> source
  const upstreamByNode = new Map<string, Set<string>>();
  const downstreamByNode = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    upstreamByNode.set(id, new Set());
    downstreamByNode.set(id, new Set());
  }

  for (const edge of edges) {
    if (
      nodeIds.has(edge.sourceDecisionId) &&
      nodeIds.has(edge.targetDecisionId) &&
      edge.sourceDecisionId !== edge.targetDecisionId
    ) {
      upstreamByNode.get(edge.sourceDecisionId)!.add(edge.targetDecisionId);
      downstreamByNode.get(edge.targetDecisionId)!.add(edge.sourceDecisionId);
    }
  }

  for (const node of sortedNodes) {
    for (const parentId of node.dependsOn ?? []) {
      if (nodeIds.has(parentId) && parentId !== node.decisionId) {
        upstreamByNode.get(node.decisionId)!.add(parentId);
        downstreamByNode.get(parentId)!.add(node.decisionId);
      }
    }
  }

  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    inDegree.set(id, upstreamByNode.get(id)!.size);
  }

  const layerById = new Map<string, number>();
  const queue: string[] = [];

  for (const node of sortedNodes) {
    if ((inDegree.get(node.decisionId) ?? 0) === 0) {
      layerById.set(node.decisionId, 0);
      queue.push(node.decisionId);
    }
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    processed.add(currentId);
    const currentLayer = layerById.get(currentId) ?? 0;

    const children = Array.from(downstreamByNode.get(currentId) ?? []).sort();
    for (const childId of children) {
      const nextLayer = Math.max(layerById.get(childId) ?? 0, currentLayer + 1);
      layerById.set(childId, nextLayer);
      const remaining = (inDegree.get(childId) ?? 1) - 1;
      inDegree.set(childId, remaining);
      if (remaining === 0 && !processed.has(childId)) {
        queue.push(childId);
      }
    }
  }

  // Handle any remaining nodes involved in cycles deterministically
  let maxAssignedLayer = 0;
  for (const layer of layerById.values()) {
    if (layer > maxAssignedLayer) maxAssignedLayer = layer;
  }

  for (const node of sortedNodes) {
    if (!layerById.has(node.decisionId)) {
      let parentMax = -1;
      for (const parentId of upstreamByNode.get(node.decisionId) ?? []) {
        const parentLayer = layerById.get(parentId);
        if (parentLayer !== undefined && parentLayer > parentMax) {
          parentMax = parentLayer;
        }
      }
      layerById.set(
        node.decisionId,
        parentMax >= 0 ? parentMax + 1 : maxAssignedLayer + 1,
      );
    }
  }

  const columns = new Map<number, DecisionGraphNode[]>();
  for (const node of sortedNodes) {
    const layer = layerById.get(node.decisionId) ?? 0;
    const list = columns.get(layer) ?? [];
    list.push(node);
    columns.set(layer, list);
  }

  const positionedNodes: PositionedNode[] = [];
  const nodePositionMap = new Map<string, PositionedNode>();
  const layerKeys = Array.from(columns.keys()).sort((a, b) => a - b);

  let maxRows = 1;
  for (const layer of layerKeys) {
    const colNodes = columns.get(layer) ?? [];
    colNodes.sort((a, b) => {
      const weightDiff = (b.changeWeight?.total ?? 0) - (a.changeWeight?.total ?? 0);
      return weightDiff !== 0 ? weightDiff : a.decisionId.localeCompare(b.decisionId);
    });
    if (colNodes.length > maxRows) maxRows = colNodes.length;

    colNodes.forEach((node, row) => {
      const x = PADDING_X + layer * (NODE_WIDTH + COL_GAP);
      const y = PADDING_Y + row * (NODE_HEIGHT + ROW_GAP);
      const positioned: PositionedNode = { node, layer, row, x, y };
      positionedNodes.push(positioned);
      nodePositionMap.set(node.decisionId, positioned);
    });
  }

  const width = Math.max(
    640,
    PADDING_X * 2 + Math.max(1, layerKeys.length) * NODE_WIDTH + Math.max(0, layerKeys.length - 1) * COL_GAP,
  );
  const height = Math.max(
    360,
    PADDING_Y * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP,
  );

  return { positionedNodes, nodePositionMap, width, height };
}

function buildBezierEdgePath(
  upstreamPos: PositionedNode,
  downstreamPos: PositionedNode,
): { path: string; midX: number; midY: number } {
  const startX = upstreamPos.x + NODE_WIDTH;
  const startY = upstreamPos.y + NODE_HEIGHT / 2;
  const endX = downstreamPos.x;
  const endY = downstreamPos.y + NODE_HEIGHT / 2;

  const dx = Math.max(48, Math.abs(endX - startX) * 0.5);
  const cp1x = startX + dx;
  const cp2x = endX - dx;

  const path = `M ${startX} ${startY} C ${cp1x} ${startY}, ${cp2x} ${endY}, ${endX} ${endY}`;
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  return { path, midX, midY };
}

function getWeightBadgeClasses(totalWeight: number | undefined): string {
  const weight = totalWeight ?? 0;
  if (weight >= 75) return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  if (weight >= 45) return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
}

function triggerLedgerDownload(doc: DecisionLedgerDocument): void {
  const json = JSON.stringify(doc, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `decisions.ledger.${doc.workspaceId || "workspace"}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function DecisionGraphExplorer({
  isOpen,
  onClose,
  workspaceId,
  ledgerDocument,
  onJumpToSection,
}: DecisionGraphExplorerProps): React.JSX.Element | null {
  const workspaceTabs = useOptionalWorkspaceTabs();

  const [loadedLedger, setLoadedLedger] = useState<DecisionLedgerDocument | null>(null);
  const [workspaceFileMap, setWorkspaceFileMap] = useState<ReadonlyMap<string, FileRecord>>(
    () => new Map(),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [depthFilter, setDepthFilter] = useState<DepthFilter>("all");

  const activeLedger = ledgerDocument ?? loadedLedger;

  useEffect(() => {
    if (!isOpen || ledgerDocument) {
      return;
    }

    let cancelled = false;

    async function fetchLedgerFromWorkspace(): Promise<void> {
      setIsLoading(true);
      setLoadError(null);
      try {
        const listRes = await getUserFiles();
        if (!listRes.success || !listRes.data) {
          throw new Error(listRes.error || "Failed to load workspace files.");
        }

        const fileMap = new Map<string, FileRecord>();
        for (const f of listRes.data) {
          if (!workspaceId || f.workspaceId === workspaceId) {
            fileMap.set(f.id, f);
          }
        }
        if (!cancelled) {
          setWorkspaceFileMap(fileMap);
        }

        const ledgerRecord = listRes.data.find(
          (f) =>
            f.artifactRole === "decision_ledger" &&
            f.deletedAt == null &&
            (!workspaceId || f.workspaceId === workspaceId),
        );

        if (!ledgerRecord) {
          if (!cancelled) {
            setLoadedLedger(null);
          }
          return;
        }

        const fileRes = await getFile(ledgerRecord.id);
        if (!fileRes.success || !fileRes.data) {
          throw new Error(fileRes.error || "Failed to fetch decision ledger file.");
        }

        const rawContent = fileRes.data.content ?? "";
        let plaintext = rawContent;

        if (fileRes.data.isEncrypted) {
          const decrypted = await SyncCryptoGateway.decryptInbound({
            fileId: fileRes.data.id,
            content: rawContent,
            isEncrypted: true,
            encryptionMetadata: fileRes.data.encryptionMetadata ?? null,
            userId: fileRes.data.userId,
          });
          if (decrypted.isVaultLocked) {
            throw new Error("Vault is locked. Unlock your vault to inspect encrypted decisions.");
          }
          if (decrypted.status === "error") {
            throw new Error(decrypted.error ?? "Failed to decrypt decision ledger.");
          }
          plaintext = decrypted.content;
        }

        const parsed = JSON.parse(plaintext) as DecisionLedgerDocument;
        if (!cancelled) {
          setLoadedLedger(parsed);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load decision graph.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchLedgerFromWorkspace();
    return () => {
      cancelled = true;
    };
  }, [isOpen, ledgerDocument, workspaceId]);

  const nodes = useMemo<DecisionGraphNode[]>(() => {
    if (!activeLedger?.nodes) return [];
    return Object.values(activeLedger.nodes).filter(Boolean);
  }, [activeLedger]);

  const edges = useMemo<DirectedDecisionEdge[]>(() => {
    if (!activeLedger?.edges) return [];
    return activeLedger.edges;
  }, [activeLedger]);

  const layout = useMemo(() => computeTopologicalLayers(nodes, edges), [nodes, edges]);

  const traversalResult = useMemo(() => {
    if (!activeLedger || !selectedNodeId) return null;
    return traverseDecisionDependencies(activeLedger, {
      decisionId: selectedNodeId,
      direction: "both",
      maxDepth: depthFilter,
    });
  }, [activeLedger, selectedNodeId, depthFilter]);

  const highlightedNodeIds = useMemo(() => {
    if (!traversalResult) return null;
    return new Set(traversalResult.visitedNodes.map((n) => n.decisionId));
  }, [traversalResult]);

  const highlightedEdgeIds = useMemo(() => {
    if (!traversalResult) return null;
    return new Set(traversalResult.traversedEdges.map((e) => e.edgeId));
  }, [traversalResult]);

  const selectedNodeDetails = useMemo(() => {
    if (!activeLedger || !selectedNodeId) return null;
    return getDecisionNodeDetails(activeLedger, { decisionId: selectedNodeId });
  }, [activeLedger, selectedNodeId]);

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeId) return null;
    return edges.find((e) => e.edgeId === selectedEdgeId) ?? null;
  }, [edges, selectedEdgeId]);

  const handleJumpToSection = useCallback(
    (fileId: string, headingSlug: string) => {
      if (onJumpToSection) {
        onJumpToSection(fileId, headingSlug);
        return;
      }

      const fileRecord = workspaceFileMap.get(fileId);
      if (workspaceTabs) {
        workspaceTabs.openTab({
          fileId,
          title: fileRecord?.title ?? fileId,
          relativePath: fileRecord?.title ?? fileId,
          isDirty: false,
          isEncrypted: Boolean(fileRecord?.isEncrypted),
        });
      }
      navigateTo(`/workspace/editor/${fileId}#${headingSlug}`);
    },
    [onJumpToSection, workspaceFileMap, workspaceTabs],
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Decision Graph Explorer"
    >
      <div className="w-full max-w-6xl h-[85vh] bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Top Toolbar */}
        <div className="h-14 px-4 border-b border-zinc-800 flex items-center justify-between gap-3 bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <GitBranch className="w-5 h-5 text-indigo-400" />
            <h2 className="text-sm font-semibold text-zinc-100">Decision Graph Explorer</h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
              {nodes.length} {nodes.length === 1 ? "node" : "nodes"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Depth Filter */}
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-md p-0.5">
              <span className="text-[11px] text-zinc-400 px-2 flex items-center gap-1">
                <Layers className="w-3 h-3" />
                Depth:
              </span>
              {([
                { value: 1 as const, label: "1 Hop" },
                { value: 2 as const, label: "2 Hops" },
                { value: "all" as const, label: "Full Chain" },
              ]).map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => setDepthFilter(opt.value)}
                  className={cn(
                    "px-2 py-1 text-xs rounded transition-colors",
                    depthFilter === opt.value
                      ? "bg-indigo-600 text-white"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {activeLedger && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs border-zinc-700 hover:border-indigo-500"
                onClick={() => triggerLedgerDownload(activeLedger)}
              >
                <Download className="w-3.5 h-3.5" />
                Download JSON
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close Decision Graph Explorer"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Main Content: SVG Canvas + Inspector Drawer */}
        <div className="flex-1 flex min-h-0">
          {/* Graph Canvas */}
          <div className="flex-1 overflow-auto bg-zinc-950 relative">
            {isLoading ? (
              <div className="h-full flex items-center justify-center text-zinc-400 gap-2 text-sm">
                <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                <span>Loading decision ledger...</span>
              </div>
            ) : loadError ? (
              <div className="h-full flex flex-col items-center justify-center text-rose-400 gap-2 p-6 text-center">
                <AlertCircle className="w-6 h-6" />
                <p className="text-sm font-medium">{loadError}</p>
              </div>
            ) : nodes.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-2 p-6 text-center">
                <GitBranch className="w-8 h-8 text-zinc-700" />
                <p className="text-sm font-medium text-zinc-400">No decisions recorded yet</p>
                <p className="text-xs text-zinc-500 max-w-sm">
                  Decisions made by the agent will appear here as an interactive dependency graph.
                </p>
              </div>
            ) : (
              <svg
                width={layout.width}
                height={layout.height}
                className="block select-none"
                data-testid="decision-graph-svg"
              >
                <defs>
                  {(["DEPENDS_ON", "REFINES", "OVERRIDES"] as const).map((rel) => (
                    <marker
                      key={rel}
                      id={`arrow-${rel}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 10 5 L 0 9 z" fill={EDGE_COLORS[rel]} />
                    </marker>
                  ))}
                </defs>

                {/* Directed Bézier Edges */}
                {edges.map((edge) => {
                  const upstream = layout.nodePositionMap.get(edge.targetDecisionId);
                  const downstream = layout.nodePositionMap.get(edge.sourceDecisionId);
                  if (!upstream || !downstream) return null;

                  const { path, midX, midY } = buildBezierEdgePath(upstream, downstream);
                  const isSelected = selectedEdgeId === edge.edgeId;
                  const isHighlighted =
                    !highlightedEdgeIds || highlightedEdgeIds.has(edge.edgeId);
                  const stroke = EDGE_COLORS[edge.relation] ?? "#6366f1";

                  return (
                    <g
                      key={edge.edgeId}
                      className="cursor-pointer"
                      opacity={isHighlighted ? 1 : 0.2}
                      onClick={() => {
                        setSelectedEdgeId(edge.edgeId);
                        setSelectedNodeId(null);
                      }}
                    >
                      {/* Invisible wider hit target for reliable edge clicking */}
                      <path d={path} fill="none" stroke="transparent" strokeWidth={14} />
                      <path
                        d={path}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={isSelected ? 3 : 2}
                        strokeDasharray={edge.relation === "OVERRIDES" ? "5 4" : undefined}
                        markerEnd={`url(#arrow-${edge.relation})`}
                      />
                      <rect
                        x={midX - 36}
                        y={midY - 9}
                        width={72}
                        height={18}
                        rx={4}
                        fill="#09090b"
                        stroke={isSelected ? "#ffffff" : stroke}
                        strokeWidth={1}
                      />
                      <text
                        x={midX}
                        y={midY + 3}
                        textAnchor="middle"
                        className="text-[9px] font-mono fill-zinc-200 pointer-events-none"
                      >
                        {edge.relation}
                      </text>
                    </g>
                  );
                })}

                {/* Decision Nodes */}
                {layout.positionedNodes.map(({ node, x, y }) => {
                  const isSelected = selectedNodeId === node.decisionId;
                  const isHighlighted =
                    !highlightedNodeIds || highlightedNodeIds.has(node.decisionId);
                  const weightTotal = node.changeWeight?.total ?? 0;
                  const isConservative = node.status === "APPROVED_CONSERVATIVE";

                  return (
                    <g
                      key={node.decisionId}
                      transform={`translate(${x}, ${y})`}
                      className="cursor-pointer"
                      opacity={isHighlighted ? 1 : 0.25}
                      onClick={() => {
                        setSelectedNodeId(node.decisionId);
                        setSelectedEdgeId(null);
                      }}
                    >
                      <rect
                        width={NODE_WIDTH}
                        height={NODE_HEIGHT}
                        rx={10}
                        fill={isSelected ? "#1e1b4b" : "#18181b"}
                        stroke={
                          isSelected
                            ? "#818cf8"
                            : isConservative
                              ? "#f59e0b"
                              : "#3f3f46"
                        }
                        strokeWidth={isSelected ? 2 : 1.25}
                      />
                      <text
                        x={12}
                        y={22}
                        className="text-[11px] font-semibold fill-zinc-100"
                      >
                        {node.topicSlug.length > 22
                          ? `${node.topicSlug.slice(0, 22)}…`
                          : node.topicSlug}
                      </text>
                      <text
                        x={12}
                        y={40}
                        className="text-[10px] fill-zinc-400"
                      >
                        {node.selectedOptionKey.length > 26
                          ? `${node.selectedOptionKey.slice(0, 26)}…`
                          : node.selectedOptionKey}
                      </text>
                      {/* Status & Weight Badges */}
                      <rect
                        x={12}
                        y={49}
                        width={84}
                        height={18}
                        rx={4}
                        fill={isConservative ? "#78350f" : "#064e3b"}
                      />
                      <text
                        x={54}
                        y={61}
                        textAnchor="middle"
                        className="text-[9px] font-medium fill-zinc-100"
                      >
                        {isConservative ? "CONSERVATIVE" : "DIRECT"}
                      </text>

                      <rect
                        x={104}
                        y={49}
                        width={54}
                        height={18}
                        rx={4}
                        fill="#27272a"
                      />
                      <text
                        x={131}
                        y={61}
                        textAnchor="middle"
                        className="text-[9px] font-mono fill-zinc-200"
                      >
                        W:{weightTotal}
                      </text>
                    </g>
                  );
                })}
              </svg>
            )}
          </div>

          {/* Inspector Drawer */}
          {(selectedNodeDetails?.node || selectedEdge) && (
            <aside
              className="w-96 border-l border-zinc-800 bg-zinc-900/70 overflow-y-auto p-4 space-y-5"
              aria-label="Decision Inspector Drawer"
            >
              {selectedEdge && !selectedNodeDetails?.node && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono uppercase tracking-wider text-indigo-400">
                      Edge Inspector
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedEdgeId(null)}
                      className="text-zinc-400 hover:text-zinc-200"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-2 text-xs">
                    <div className="font-semibold text-zinc-100">{selectedEdge.relation}</div>
                    <div className="text-zinc-400">
                      Source: <span className="text-zinc-200 font-mono">{selectedEdge.sourceDecisionId}</span>
                    </div>
                    <div className="text-zinc-400">
                      Target: <span className="text-zinc-200 font-mono">{selectedEdge.targetDecisionId}</span>
                    </div>
                    {selectedEdge.confidence !== undefined && (
                      <div className="text-zinc-400">
                        Confidence: <span className="text-zinc-200">{Math.round(selectedEdge.confidence * 100)}%</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-300 mb-1">Justification</h3>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      {selectedEdge.justification || "No explicit edge justification recorded."}
                    </p>
                  </div>
                </div>
              )}

              {selectedNodeDetails?.node && (
                <div className="space-y-5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="text-[11px] font-mono text-indigo-400">
                        {selectedNodeDetails.node.decisionId}
                      </span>
                      <h3 className="text-sm font-semibold text-zinc-100 mt-0.5">
                        {selectedNodeDetails.node.topicSlug}
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedNodeId(null)}
                      className="text-zinc-400 hover:text-zinc-200"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <p className="text-xs text-zinc-300 leading-relaxed">
                    {selectedNodeDetails.node.questionPrompt}
                  </p>

                  {/* Justification */}
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-semibold text-zinc-200">Justification</h4>
                    <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-300 leading-relaxed">
                      {selectedNodeDetails.node.selectionRationale}
                    </div>
                  </div>

                  {/* ChangeWeight Breakdown */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-zinc-200">Change Weight Breakdown</h4>
                      <span
                        className={cn(
                          "text-[11px] font-mono px-2 py-0.5 rounded border",
                          getWeightBadgeClasses(selectedNodeDetails.node.changeWeight?.total),
                        )}
                      >
                        Total: {selectedNodeDetails.node.changeWeight?.total ?? 0}
                      </span>
                    </div>
                    {selectedNodeDetails.node.changeWeight ? (
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        {(
                          [
                            ["Structural", selectedNodeDetails.node.changeWeight.structural],
                            ["Provenance", selectedNodeDetails.node.changeWeight.provenance],
                            ["Topology", selectedNodeDetails.node.changeWeight.topology],
                            ["Surface", selectedNodeDetails.node.changeWeight.surface],
                          ] as const
                        ).map(([label, val]) => (
                          <div
                            key={label}
                            className="p-2 rounded bg-zinc-950 border border-zinc-800 flex items-center justify-between"
                          >
                            <span className="text-zinc-400">{label}</span>
                            <span className="font-mono text-zinc-200">{val}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-zinc-500">No changeWeight breakdown recorded.</p>
                    )}
                  </div>

                  {/* Linked Decisions */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-zinc-200">Linked Decisions</h4>
                    <div className="space-y-1.5 text-xs">
                      <div className="text-zinc-400">
                        Upstream ({selectedNodeDetails.node.dependsOn.length}):
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {selectedNodeDetails.node.dependsOn.length === 0 ? (
                          <span className="text-zinc-600">None</span>
                        ) : (
                          selectedNodeDetails.node.dependsOn.map((depId) => (
                            <button
                              key={depId}
                              type="button"
                              onClick={() => setSelectedNodeId(depId)}
                              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-indigo-600/30 text-zinc-200 font-mono text-[11px] flex items-center gap-1"
                            >
                              {depId}
                              <ChevronRight className="w-3 h-3" />
                            </button>
                          ))
                        )}
                      </div>

                      <div className="text-zinc-400 pt-1">
                        Downstream ({selectedNodeDetails.node.dependedBy.length}):
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {selectedNodeDetails.node.dependedBy.length === 0 ? (
                          <span className="text-zinc-600">None</span>
                        ) : (
                          selectedNodeDetails.node.dependedBy.map((childId) => (
                            <button
                              key={childId}
                              type="button"
                              onClick={() => setSelectedNodeId(childId)}
                              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-indigo-600/30 text-zinc-200 font-mono text-[11px] flex items-center gap-1"
                            >
                              {childId}
                              <ChevronRight className="w-3 h-3" />
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Evaluated Alternatives */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-zinc-200">
                      Evaluated Alternatives ({selectedNodeDetails.node.evaluatedAlternatives.length})
                    </h4>
                    <div className="space-y-2">
                      {selectedNodeDetails.node.evaluatedAlternatives.map((alt) => {
                        const isWinner = alt.optionKey === selectedNodeDetails.node?.selectedOptionKey;
                        return (
                          <div
                            key={alt.optionKey}
                            className={cn(
                              "p-2.5 rounded-lg border text-xs space-y-1",
                              isWinner
                                ? "bg-indigo-950/30 border-indigo-500/40"
                                : "bg-zinc-950 border-zinc-800",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-zinc-100">{alt.optionKey}</span>
                              {isWinner && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                                  Selected
                                </span>
                              )}
                            </div>
                            <p className="text-zinc-300">{alt.neutralSummary}</p>
                            {alt.rationaleAndPremises && (
                              <p className="text-zinc-500 text-[11px]">{alt.rationaleAndPremises}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Affected Sections */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-zinc-200">
                      Affected Sections ({selectedNodeDetails.node.affectedSections.length})
                    </h4>
                    {selectedNodeDetails.node.affectedSections.length === 0 ? (
                      <p className="text-xs text-zinc-500">No sections linked.</p>
                    ) : (
                      <div className="space-y-1">
                        {selectedNodeDetails.node.affectedSections.map((sec) => {
                          const targetKey = `${sec.fileId}#${sec.headingSlug}`;
                          return (
                            <button
                              key={targetKey}
                              type="button"
                              onClick={() => handleJumpToSection(sec.fileId, sec.headingSlug)}
                              className="w-full px-2.5 py-1.5 rounded bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-left text-xs text-indigo-300 flex items-center justify-between gap-2 transition-colors"
                            >
                              <span className="truncate font-mono">{targetKey}</span>
                              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
