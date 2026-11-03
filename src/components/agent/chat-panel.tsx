"use client";

/**
 * Elixent Architectural Agent Chat Panel
 *
 * Interactive control surface for the 7-stage LangGraph architectural agent:
 * 1. 7-Stage Architectural Graph Progress Indicator
 * 2. Justification-Driven ATMS Architectural Decision Ledger (`master_ledger`)
 * 3. Human-in-the-Loop (HITL) Clarification Gate (`HITLQuestionCard`)
 * 4. Multi-Hunk Ghost Review Bar (batch & per-hunk accept/reject controls)
 * 5. Prompt Composer & Session Lifecycle Controls (Start, Stop, Reset, Vault/Offline Guards)
 */

import React, { useState, useMemo, useCallback } from "react";
import type { ClarificationResponse } from "@/core/agent/schemas/decision-schemas";
import type { ClarifyingQuestionBatch } from "@/core/agent/reducers";
import type {
  ATMSDecisionNode,
  EvaluatedAlternativeRecord,
} from "@/core/agent/atms/dag";
import { isSystemReservedDecisionId } from "@/core/agent/taxonomy/predefined-tags";
import type { GhostHunk } from "@/components/editor/markdown/types";
import { HITLQuestionCard } from "@/components/agent/hitl-question-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  GitBranch,
  Layers,
  Loader2,
  Lock,
  Play,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Square,
  WifiOff,
  X,
} from "lucide-react";

export type AgentSessionStatus =
  | "idle"
  | "running_graph"
  | "awaiting_hitl"
  | "streaming_hunks"
  | "preview_ready"
  | "completed"
  | "aborted"
  | "failed";

export interface AgentChatPanelProps {
  isOpen?: boolean;
  onClose?: () => void;
  status: AgentSessionStatus;
  currentStage?: string | null;
  activeQuestionQueue?: ClarifyingQuestionBatch["questions"];
  masterDecisionLedger?:
    | Record<string, ATMSDecisionNode>
    | ReadonlyArray<ATMSDecisionNode>;
  activeGhostHunksCount?: number;
  activeGhostHunks?: ReadonlyArray<GhostHunk>;
  error?: string | null;
  onStartSession: (
    prompt: string,
    targetFileIds?: string[]
  ) => void | Promise<void>;
  onResumeInterrupt: (response: ClarificationResponse) => void | Promise<void>;
  onStopSession?: () => void;
  onResetSession?: () => void;
  onAcceptGhostHunk?: (hunkId: string) => void;
  onRejectGhostHunk?: (hunkId: string) => void;
  onAcceptAllGhostHunks?: () => void;
  onRejectAllGhostHunks?: () => void;
  targetFileIds?: string[];
  isEncrypted?: boolean;
  isVaultUnlocked?: boolean;
  allowAIOnEncryptedFiles?: boolean;
  isOffline?: boolean;
  className?: string;
}

export interface AgentGraphStageDefinition {
  readonly id:
    | "orchestrator"
    | "search"
    | "assumptions_jev"
    | "classifier"
    | "ledger"
    | "hitl_interrupt"
    | "writer";
  readonly stageNumber: number;
  readonly label: string;
  readonly nodeAliases: readonly string[];
}

export const AGENT_GRAPH_STAGES: readonly AgentGraphStageDefinition[] = [
  {
    id: "orchestrator",
    stageNumber: 1,
    label: "Stage 1: Orchestrator & Context",
    nodeAliases: ["orchestrator", "orchestrator_node", "stage_0", "stage_1", "1"],
  },
  {
    id: "search",
    stageNumber: 2,
    label: "Stage 2: Hybrid AST & BM25 Search",
    nodeAliases: [
      "search",
      "search_agent_node",
      "workspace_tool_node",
      "search_synthesizer_node",
      "internal_gap_planner_node",
      "stage_2",
      "2",
    ],
  },
  {
    id: "assumptions_jev",
    stageNumber: 3,
    label: "Stage 3: Assumption Extraction & JEv",
    nodeAliases: [
      "assumptions_jev",
      "assumption_analyzer_node",
      "atms_relational_linker_node",
      "jev_structuring_node",
      "decision_scorer_node",
      "stage_3",
      "3",
    ],
  },
  {
    id: "classifier",
    stageNumber: 4,
    label: "Stage 4: Conformal APS Classifier",
    nodeAliases: [
      "classifier",
      "confidence_classifier_node",
      "stage_4",
      "4",
    ],
  },
  {
    id: "ledger",
    stageNumber: 5,
    label: "Stage 5: ATMS Decision Ledger & Cascade",
    nodeAliases: ["ledger", "ledger_commit_node", "stage_5", "5"],
  },
  {
    id: "hitl_interrupt",
    stageNumber: 6,
    label: "Stage 6: HITL Clarification Gate",
    nodeAliases: [
      "hitl_interrupt",
      "question_organizer_node",
      "pure_interrupt_node",
      "hitl",
      "stage_6",
      "6",
    ],
  },
  {
    id: "writer",
    stageNumber: 7,
    label: "Stage 7: Section Writer & Diff3 Merge",
    nodeAliases: ["writer", "document_writer_node", "stage_7", "7"],
  },
] as const;

export type StageVisualState =
  | "completed"
  | "active"
  | "upcoming"
  | "failed"
  | "aborted";

function resolveStageIndex(currentStage?: string | null): number | null {
  if (!currentStage || typeof currentStage !== "string") {
    return null;
  }
  const normalized = currentStage.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  for (let i = 0; i < AGENT_GRAPH_STAGES.length; i++) {
    const stage = AGENT_GRAPH_STAGES[i];
    if (
      stage.id === normalized ||
      stage.label.toLowerCase() === normalized ||
      stage.nodeAliases.includes(normalized)
    ) {
      return i;
    }
  }
  return null;
}

function computeStageStates(
  status: AgentSessionStatus,
  currentStage?: string | null
): StageVisualState[] {
  const explicitIndex = resolveStageIndex(currentStage);

  if (status === "completed" || status === "preview_ready") {
    return AGENT_GRAPH_STAGES.map(() => "completed");
  }

  if (status === "streaming_hunks") {
    const writerIndex = AGENT_GRAPH_STAGES.length - 1;
    return AGENT_GRAPH_STAGES.map((_, idx) =>
      idx < writerIndex ? "completed" : "active"
    );
  }

  if (status === "awaiting_hitl") {
    const hitlIndex = 5;
    return AGENT_GRAPH_STAGES.map((_, idx) => {
      if (idx < hitlIndex) return "completed";
      if (idx === hitlIndex) return "active";
      return "upcoming";
    });
  }

  if (status === "running_graph") {
    const activeIdx = explicitIndex ?? 0;
    return AGENT_GRAPH_STAGES.map((_, idx) => {
      if (idx < activeIdx) return "completed";
      if (idx === activeIdx) return "active";
      return "upcoming";
    });
  }

  if (status === "failed" || status === "aborted") {
    const terminalState: StageVisualState =
      status === "failed" ? "failed" : "aborted";
    const stopIdx = explicitIndex ?? 0;
    return AGENT_GRAPH_STAGES.map((_, idx) => {
      if (idx < stopIdx) return "completed";
      if (idx === stopIdx) return terminalState;
      return "upcoming";
    });
  }

  // status === "idle"
  if (explicitIndex !== null) {
    return AGENT_GRAPH_STAGES.map((_, idx) => {
      if (idx < explicitIndex) return "completed";
      if (idx === explicitIndex) return "active";
      return "upcoming";
    });
  }

  return AGENT_GRAPH_STAGES.map(() => "upcoming");
}

function normalizeDecisionLedger(
  ledger?:
    | Record<string, ATMSDecisionNode>
    | ReadonlyArray<ATMSDecisionNode>
): ATMSDecisionNode[] {
  if (!ledger) return [];
  const rawList: ATMSDecisionNode[] = Array.isArray(ledger)
    ? [...ledger]
    : typeof ledger === "object"
      ? Object.entries(ledger as Record<string, ATMSDecisionNode>)
          .filter(([key]) => !isSystemReservedDecisionId(key))
          .map(([, node]) => node)
      : [];

  return rawList.filter(
    (node): node is ATMSDecisionNode =>
      Boolean(node) &&
      typeof node === "object" &&
      typeof node.decisionId === "string" &&
      !isSystemReservedDecisionId(node.decisionId)
  );
}

interface AlternativeDisplayFields {
  optionKey: string;
  summary: string;
  rationale: string;
  probabilityPercent: string | null;
}

function extractAlternativeDisplay(
  alt: EvaluatedAlternativeRecord & {
    summary?: string;
    rejectionRationale?: string;
  }
): AlternativeDisplayFields {
  const summary = alt.neutralSummary || alt.summary || "";
  const rationale = alt.rationaleAndPremises || alt.rejectionRationale || "";
  const probabilityPercent =
    typeof alt.normalizedProbability === "number"
      ? `${Math.round(alt.normalizedProbability * 100)}%`
      : null;

  return {
    optionKey: alt.optionKey,
    summary,
    rationale,
    probabilityPercent,
  };
}

function DecisionNodeCard({ node }: { node: ATMSDecisionNode }) {
  const isCore = node.impactTier === "CORE_ARCHITECTURAL";
  const isDirect = node.status === "APPROVED_DIRECT";

  return (
    <div
      data-testid={`decision-node-${node.decisionId}`}
      className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3.5 space-y-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="inline-flex items-center rounded-md bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 font-mono text-[11px] font-medium text-indigo-300"
            data-testid={`decision-topic-${node.decisionId}`}
          >
            {node.topicSlug}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide border",
              isDirect
                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                : "bg-amber-500/10 text-amber-300 border-amber-500/25"
            )}
            data-testid={`decision-status-${node.decisionId}`}
          >
            {node.status}
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium border",
              isCore
                ? "bg-purple-500/10 text-purple-300 border-purple-500/25"
                : "bg-zinc-800 text-zinc-300 border-zinc-700"
            )}
            data-testid={`decision-impact-${node.decisionId}`}
          >
            {node.impactTier}
          </span>
        </div>

        <span
          data-testid={`decision-load-bearing-${node.decisionId}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border",
            node.isLoadBearing
              ? "bg-rose-500/10 text-rose-300 border-rose-500/25"
              : "bg-zinc-900 text-zinc-400 border-zinc-800"
          )}
        >
          {node.isLoadBearing ? "Load-Bearing" : "Non-Load-Bearing"}
        </span>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-zinc-100 leading-snug">
          {node.questionPrompt}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-zinc-400">Selected Option:</span>
          <span
            data-testid={`decision-selected-option-${node.decisionId}`}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 font-mono text-xs font-semibold text-emerald-300"
          >
            <CheckCircle2 className="h-3 w-3" />
            {node.selectedOptionKey}
          </span>
          {node.runnerUpOptionKey && (
            <span
              data-testid={`decision-runner-up-${node.decisionId}`}
              className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 font-mono text-[11px] text-amber-300"
            >
              Runner-Up: {node.runnerUpOptionKey}
            </span>
          )}
        </div>
      </div>

      <div className="rounded-md bg-zinc-900/80 border border-zinc-800/80 p-2.5 space-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Selection Rationale
        </span>
        <p
          data-testid={`decision-rationale-${node.decisionId}`}
          className="text-xs text-zinc-200 leading-relaxed"
        >
          {node.selectionRationale}
        </p>
      </div>

      {Array.isArray(node.conceptTags) && node.conceptTags.length > 0 && (
        <div
          className="flex items-center gap-1.5 flex-wrap"
          data-testid={`decision-tags-${node.decisionId}`}
        >
          {node.conceptTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-full bg-zinc-900 border border-zinc-700/80 px-2 py-0.5 font-mono text-[10px] text-zinc-300"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {Array.isArray(node.evaluatedAlternatives) &&
        node.evaluatedAlternatives.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Evaluated Alternatives ({node.evaluatedAlternatives.length})
            </span>
            <div
              className="space-y-1.5"
              data-testid={`decision-alternatives-${node.decisionId}`}
            >
              {node.evaluatedAlternatives.map((rawAlt) => {
                const alt = extractAlternativeDisplay(rawAlt);
                const isSelected = alt.optionKey === node.selectedOptionKey;
                const isRunnerUp =
                  Boolean(node.runnerUpOptionKey) &&
                  alt.optionKey === node.runnerUpOptionKey;

                return (
                  <div
                    key={alt.optionKey}
                    data-testid={`decision-alternative-${node.decisionId}-${alt.optionKey}`}
                    className={cn(
                      "rounded-md border p-2 space-y-1",
                      isSelected
                        ? "border-emerald-500/30 bg-emerald-950/15"
                        : isRunnerUp
                          ? "border-amber-500/30 bg-amber-950/15"
                          : "border-zinc-800/80 bg-zinc-900/40"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-semibold text-zinc-200">
                          {alt.optionKey}
                        </span>
                        {isSelected && (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[10px] font-medium text-emerald-300">
                            Selected
                          </span>
                        )}
                        {isRunnerUp && (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.2 text-[10px] font-medium text-amber-300">
                            Runner-Up
                          </span>
                        )}
                      </div>
                      {alt.probabilityPercent && (
                        <span className="font-mono text-[10px] text-zinc-400">
                          {alt.probabilityPercent}
                        </span>
                      )}
                    </div>
                    {alt.summary && (
                      <p className="text-xs text-zinc-200">{alt.summary}</p>
                    )}
                    {alt.rationale && (
                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        {alt.rationale}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

      {((Array.isArray(node.dependsOn) && node.dependsOn.length > 0) ||
        (Array.isArray(node.dependedBy) && node.dependedBy.length > 0) ||
        (Array.isArray(node.affectedSections) &&
          node.affectedSections.length > 0)) && (
        <div className="border-t border-zinc-800/80 pt-2 space-y-1.5 text-[11px] text-zinc-400">
          {Array.isArray(node.dependsOn) && node.dependsOn.length > 0 && (
            <div
              className="flex items-center gap-1.5 flex-wrap"
              data-testid={`decision-depends-on-${node.decisionId}`}
            >
              <GitBranch className="h-3 w-3 text-indigo-400 shrink-0" />
              <span className="font-medium text-zinc-300">Depends On:</span>
              {node.dependsOn.map((depId) => (
                <span
                  key={depId}
                  className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300"
                >
                  {depId}
                </span>
              ))}
            </div>
          )}

          {Array.isArray(node.dependedBy) && node.dependedBy.length > 0 && (
            <div
              className="flex items-center gap-1.5 flex-wrap"
              data-testid={`decision-depended-by-${node.decisionId}`}
            >
              <GitBranch className="h-3 w-3 text-purple-400 shrink-0" />
              <span className="font-medium text-zinc-300">Depended By:</span>
              {node.dependedBy.map((depId) => (
                <span
                  key={depId}
                  className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-purple-300"
                >
                  {depId}
                </span>
              ))}
            </div>
          )}

          {Array.isArray(node.affectedSections) &&
            node.affectedSections.length > 0 && (
              <div
                className="flex items-center gap-1.5 flex-wrap"
                data-testid={`decision-sections-${node.decisionId}`}
              >
                <Layers className="h-3 w-3 text-emerald-400 shrink-0" />
                <span className="font-medium text-zinc-300">
                  Affected Sections:
                </span>
                {node.affectedSections.map((sec) => (
                  <span
                    key={`${sec.fileId}:${sec.headingSlug}`}
                    className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
                  >
                    {sec.fileId}#{sec.headingSlug}
                  </span>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

export function AgentChatPanel({
  isOpen = true,
  onClose,
  status,
  currentStage = null,
  activeQuestionQueue,
  masterDecisionLedger,
  activeGhostHunksCount,
  activeGhostHunks,
  error = null,
  onStartSession,
  onResumeInterrupt,
  onStopSession,
  onResetSession,
  onAcceptGhostHunk,
  onRejectGhostHunk,
  onAcceptAllGhostHunks,
  onRejectAllGhostHunks,
  targetFileIds,
  isEncrypted = false,
  isVaultUnlocked = true,
  allowAIOnEncryptedFiles = true,
  isOffline = false,
  className,
}: AgentChatPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);

  const stageStates = useMemo(
    () => computeStageStates(status, currentStage),
    [status, currentStage]
  );

  const ledgerNodes = useMemo(
    () => normalizeDecisionLedger(masterDecisionLedger),
    [masterDecisionLedger]
  );

  const effectiveHunkCount = Math.max(
    activeGhostHunksCount ?? 0,
    activeGhostHunks?.length ?? 0
  );

  const isRunning =
    status === "running_graph" || status === "streaming_hunks";
  const isResettable =
    status === "completed" ||
    status === "failed" ||
    status === "aborted" ||
    status === "preview_ready";
  const hasActiveQuestions =
    Array.isArray(activeQuestionQueue) && activeQuestionQueue.length > 0;
  const showHITLSection = hasActiveQuestions || status === "awaiting_hitl";

  const isVaultShieldBlocked = isEncrypted && !allowAIOnEncryptedFiles;
  const isVaultLockedBlocked =
    isEncrypted && allowAIOnEncryptedFiles && !isVaultUnlocked;
  const isExecutionBlocked =
    isOffline || isVaultShieldBlocked || isVaultLockedBlocked;

  const handleStartSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = prompt.trim();
      if (!trimmed || isRunning || isStarting || isExecutionBlocked) {
        return;
      }
      setIsStarting(true);
      try {
        await onStartSession(trimmed, targetFileIds);
        setPrompt("");
      } finally {
        setIsStarting(false);
      }
    },
    [
      isExecutionBlocked,
      isRunning,
      isStarting,
      onStartSession,
      prompt,
      targetFileIds,
    ]
  );

  const handleResumeSubmit = useCallback(
    async (response: ClarificationResponse) => {
      if (isResuming || isExecutionBlocked) return;
      setIsResuming(true);
      try {
        await onResumeInterrupt(response);
      } finally {
        setIsResuming(false);
      }
    },
    [isExecutionBlocked, isResuming, onResumeInterrupt]
  );

  if (!isOpen) {
    return null;
  }

  return (
    <aside
      data-testid="agent-chat-panel"
      aria-label="Elixent Architectural Agent Panel"
      className={cn(
        "flex flex-col h-full w-full max-w-md border-l border-zinc-800 bg-zinc-950 text-zinc-100 overflow-hidden",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
            <Bot className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
              <span>Elixent Architectural Agent</span>
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            </h2>
            <p className="text-[11px] text-zinc-400" data-testid="agent-status-badge">
              Status: <span className="font-mono text-zinc-200">{status}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {isResettable && onResetSession && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onResetSession}
              data-testid="agent-reset-button"
              title="Reset Agent Session"
              className="gap-1 text-xs text-zinc-300"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reset</span>
            </Button>
          )}
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              data-testid="agent-close-button"
              title="Close Agent Panel"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar">
        {isOffline && (
          <div
            role="status"
            data-testid="agent-offline-notice"
            className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
          >
            <WifiOff className="h-4 w-4 text-amber-400 shrink-0" />
            <span>
              Offline mode active. Agent graph execution requires network connectivity.
            </span>
          </div>
        )}

        {isVaultShieldBlocked && (
          <div
            role="status"
            data-testid="agent-vault-shield-notice"
            className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
          >
            <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" />
            <span>
              Zero-Knowledge AI Shield is active. Enable AI access on encrypted files to run the agent.
            </span>
          </div>
        )}

        {isVaultLockedBlocked && (
          <div
            role="status"
            data-testid="agent-vault-locked-notice"
            className="flex items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200"
          >
            <Lock className="h-4 w-4 text-indigo-400 shrink-0" />
            <span>
              Vault is locked. Unlock your Zero-Knowledge Vault to provide ephemeral decrypted context.
            </span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="agent-error-alert"
            className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200"
          >
            <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-rose-300">Agent Execution Error</p>
              <p className="mt-0.5 break-words">{error}</p>
            </div>
          </div>
        )}

        <section
          aria-label="7-Stage Architectural Graph Progress"
          data-testid="agent-stage-progress"
          className="rounded-xl border border-zinc-800/90 bg-zinc-900/40 p-3.5 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              7-Stage Graph Pipeline
            </h3>
            {currentStage && (
              <span
                className="font-mono text-[11px] text-indigo-300"
                data-testid="agent-current-stage-label"
              >
                {currentStage}
              </span>
            )}
          </div>

          <ol className="space-y-1.5">
            {AGENT_GRAPH_STAGES.map((stage, idx) => {
              const visualState = stageStates[idx];
              return (
                <li
                  key={stage.id}
                  data-testid={`agent-stage-${stage.id}`}
                  data-stage-state={visualState}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs border transition-colors",
                    visualState === "completed" &&
                      "border-emerald-500/25 bg-emerald-950/15 text-emerald-200",
                    visualState === "active" &&
                      "border-indigo-500/50 bg-indigo-500/15 text-indigo-100 font-medium shadow-[0_0_10px_rgba(99,102,241,0.15)]",
                    visualState === "failed" &&
                      "border-rose-500/40 bg-rose-950/20 text-rose-200",
                    visualState === "aborted" &&
                      "border-amber-500/40 bg-amber-950/20 text-amber-200",
                    visualState === "upcoming" &&
                      "border-zinc-800/60 bg-zinc-900/30 text-zinc-500"
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {visualState === "completed" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    ) : visualState === "active" ? (
                      <Loader2 className="h-3.5 w-3.5 text-indigo-400 animate-spin shrink-0" />
                    ) : visualState === "failed" || visualState === "aborted" ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                    )}
                    <span className="truncate">{stage.label}</span>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wider opacity-75 shrink-0">
                    {visualState}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        {effectiveHunkCount > 0 && (
          <section
            aria-label="Multi-Hunk Ghost Review"
            data-testid="agent-ghost-review-bar"
            className="rounded-xl border border-indigo-500/35 bg-indigo-950/20 p-3.5 space-y-3"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span
                  data-testid="agent-ghost-hunks-count"
                  className="inline-flex items-center justify-center rounded-full bg-indigo-500/20 border border-indigo-500/40 px-2 py-0.5 font-mono text-xs font-semibold text-indigo-200"
                >
                  {effectiveHunkCount}{" "}
                  {effectiveHunkCount === 1 ? "hunk" : "hunks"}
                </span>
                <span className="text-xs font-medium text-zinc-200">
                  Pending Surgical Diff3 Previews
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                {onAcceptAllGhostHunks && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={onAcceptAllGhostHunks}
                    data-testid="agent-accept-all-hunks"
                    className="h-7 px-2.5 text-xs gap-1"
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>Accept All Hunks</span>
                  </Button>
                )}
                {onRejectAllGhostHunks && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={onRejectAllGhostHunks}
                    data-testid="agent-reject-all-hunks"
                    className="h-7 px-2.5 text-xs gap-1"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span>Reject All Hunks</span>
                  </Button>
                )}
              </div>
            </div>

            {Array.isArray(activeGhostHunks) && activeGhostHunks.length > 0 && (
              <div className="space-y-2 pt-1">
                {activeGhostHunks.map((hunk) => (
                  <div
                    key={hunk.hunkId}
                    data-testid={`agent-ghost-hunk-${hunk.hunkId}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono text-indigo-300 font-medium truncate">
                          #{hunk.headingSlug}
                        </span>
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                          {hunk.status}
                        </span>
                      </div>
                      {Array.isArray(hunk.decisionIds) &&
                        hunk.decisionIds.length > 0 && (
                          <p className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">
                            Decisions: {hunk.decisionIds.join(", ")}
                          </p>
                        )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {onAcceptGhostHunk && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onAcceptGhostHunk(hunk.hunkId)}
                          data-testid={`agent-accept-hunk-${hunk.hunkId}`}
                          className="h-7 px-2 text-xs text-emerald-300 hover:text-emerald-200 hover:bg-emerald-950/40"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>Accept</span>
                        </Button>
                      )}
                      {onRejectGhostHunk && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onRejectGhostHunk(hunk.hunkId)}
                          data-testid={`agent-reject-hunk-${hunk.hunkId}`}
                          className="h-7 px-2 text-xs text-rose-300 hover:text-rose-200 hover:bg-rose-950/40"
                        >
                          <X className="h-3.5 w-3.5" />
                          <span>Reject</span>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {showHITLSection && (
          <section
            aria-label="Human-in-the-Loop Clarification Queue"
            data-testid="agent-hitl-section"
            className="space-y-2"
          >
            {hasActiveQuestions ? (
              <HITLQuestionCard
                questions={activeQuestionQueue}
                onSubmit={handleResumeSubmit}
                isSubmitting={isResuming}
                disabled={isExecutionBlocked}
              />
            ) : (
              <div className="rounded-xl border border-indigo-500/30 bg-zinc-900/60 p-4 text-xs text-zinc-300 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-400 shrink-0" />
                <span>Awaiting human-in-the-loop clarification batch...</span>
              </div>
            )}
          </section>
        )}

        <section
          aria-label="Architectural Decision Ledger"
          data-testid="agent-decision-ledger"
          className="space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              ATMS Decision Ledger ({ledgerNodes.length})
            </h3>
          </div>

          {ledgerNodes.length === 0 ? (
            <div
              data-testid="agent-decision-ledger-empty"
              className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-4 text-center text-xs text-zinc-500"
            >
              No architectural decisions recorded in the ledger yet.
            </div>
          ) : (
            <div className="space-y-3">
              {ledgerNodes.map((node) => (
                <DecisionNodeCard key={node.decisionId} node={node} />
              ))}
            </div>
          )}
        </section>
      </div>

      <form
        onSubmit={handleStartSubmit}
        data-testid="agent-prompt-form"
        className="border-t border-zinc-800 bg-zinc-900/60 p-3.5 space-y-2.5 shrink-0"
      >
        <textarea
          data-testid="agent-prompt-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isRunning || isStarting || isExecutionBlocked}
          rows={3}
          placeholder="Describe the architectural specification, refactoring goal, or section changes..."
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 disabled:opacity-60 resize-none"
        />

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {isRunning && onStopSession && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onStopSession}
                data-testid="agent-stop-button"
                className="gap-1.5"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Stop</span>
              </Button>
            )}
          </div>

          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={
              !prompt.trim() || isRunning || isStarting || isExecutionBlocked
            }
            data-testid="agent-start-button"
            className="gap-1.5 ml-auto"
          >
            {isRunning || isStarting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Running Agent...</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                <span>Run Architectural Agent</span>
              </>
            )}
          </Button>
        </div>
      </form>
    </aside>
  );
}
