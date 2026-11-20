/**
 * Node 2: Dual-Domain Search & Discovery (`search_discovery_node`)
 *
 * Native Graph Engine Stage 1 node (`ADR-009`, `ADR-012`, `SRS-01` §2.3 & §4.2).
 *
 * Responsibilities:
 * 1. Exposes the 8-Tool Dual Toolset:
 *    - 4 Workspace Document Tools (`listWorkspaceTree`, `listHeadingsTree`,
 *      `searchLexicalWithASTBreadcrumb`, `readSectionByHeading`) backed by `ctx.workspaceProvider`.
 *    - 4 Decision Ledger Graph Tools (`searchDecisionLedger`, `getDecisionNodeDetails`,
 *      `traverseDecisionDependencies`, `getSectionGoverningDecisions`) backed by `createDecisionGraphTools`.
 * 2. Executes `executeToolAgentGeneration` bounded by `maxSteps = 6` (`ctx.selectedSystem2ModelId`).
 * 3. Deterministically synthesizes `search_report` (`SearchReport`) from `result.steps`
 *    by pairing each `toolCallId` with its exact `(args.fileId, args.headingSlug)` (`BUG-07` fix).
 */

import { tool, type StepResult, type ToolSet } from "ai";
import { z } from "zod";
import type {
  AgentGraphNodeFn,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type {
  AgentGraphState,
  SearchReport,
  SearchReportEvidence,
} from "@/core/agent/state";
import { toProviderLedgerDocument } from "@/core/agent/atms/dag";
import { createDecisionGraphTools } from "@/core/agent/tools/decision-graph-tools";
import type {
  HeadingNode,
  LexicalMatchResult,
  SectionReadResult,
} from "@/core/workspace/provider";
import { executeToolAgentGeneration } from "@/lib/ai/client";
import { getApiKeys } from "@/lib/ai/key-rotation";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import {
  isVaultRef,
  resolveVaultRefJustInTime,
  storeEphemeralVaultSection,
} from "@/lib/vault/ephemeral-memory-map";

/** Maximum exploration steps permitted for the search discovery agent. */
export const SEARCH_AGENT_STEP_CEILING = 6;

/**
 * Builds the 4 workspace document inspection tools bound to `ctx.workspaceProvider`.
 */
function createWorkspaceDocumentTools(ctx: AgentRuntimeContext) {
  return {
    listWorkspaceTree: tool({
      description:
        "List all non-deleted, non-AI-excluded files and folders in the active workspace.",
      inputSchema: z.object({}),
      execute: async () => {
        return ctx.workspaceProvider.listWorkspaceTree();
      },
    }),

    listHeadingsTree: tool({
      description:
        "List the complete markdown heading hierarchy tree for target workspace files (or all files if omitted).",
      inputSchema: z.object({
        fileIds: z
          .array(z.string())
          .optional()
          .describe("Optional workspace file IDs to inspect"),
      }),
      execute: async ({ fileIds }) => {
        return ctx.workspaceProvider.listHeadingsTree(fileIds);
      },
    }),

    searchLexicalWithASTBreadcrumb: tool({
      description:
        "Search workspace files using path-coupled BM25 lexical search with AST breadcrumbs.",
      inputSchema: z.object({
        fileIds: z
          .array(z.string())
          .optional()
          .describe("Optional target file IDs"),
        query: z.string().min(1).describe("Search keywords"),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum match count"),
      }),
      execute: async ({ fileIds, query, maxResults }) => {
        return ctx.workspaceProvider.searchLexicalWithASTBreadcrumb({
          fileIds,
          query,
          maxResults,
        });
      },
    }),

    readSectionByHeading: tool({
      description:
        "Read body content of a specific document section by file ID and heading slug.",
      inputSchema: z.object({
        fileId: z.string().min(1).describe("Target file ID"),
        headingSlug: z.string().min(1).describe("Target heading slug"),
      }),
      execute: async ({ fileId, headingSlug }) => {
        const section = await ctx.workspaceProvider.readSectionByHeading(
          fileId,
          headingSlug,
        );
        if (section.isVaultRef && !isVaultRef(section.contentOrVaultRef)) {
          storeEphemeralVaultSection(
            fileId,
            headingSlug,
            section.contentOrVaultRef,
          );
        }
        return section;
      },
    }),
  };
}

interface RawToolCallRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

/**
 * Deterministically synthesizes `SearchReport` from `executeToolAgentGeneration` `steps`
 * by pairing each `toolResult.toolCallId` with its exact `toolCall` arguments (`BUG-07` fix).
 */
function synthesizeSearchReportFromSteps(
  steps: readonly StepResult<ToolSet>[],
  agentSummaryText: string,
  initialInspectionPaths: readonly string[],
): SearchReport {
  const evidenceItems: SearchReportEvidence[] = [];
  const inspectedPathSet = new Set<string>(initialInspectionPaths);

  for (const step of steps) {
    const callById = new Map<string, RawToolCallRecord>();

    for (const rawCall of step.toolCalls ?? []) {
      const callRecord = rawCall as unknown as {
        toolCallId?: string;
        id?: string;
        toolName?: string;
        name?: string;
        input?: Record<string, unknown>;
        args?: Record<string, unknown>;
      };
      const toolCallId = callRecord.toolCallId ?? callRecord.id ?? "";
      const toolName = callRecord.toolName ?? callRecord.name ?? "";
      const args = callRecord.input ?? callRecord.args ?? {};
      if (toolCallId) {
        callById.set(toolCallId, { toolCallId, toolName, args });
      }
    }

    for (const rawResult of step.toolResults ?? []) {
      const resRecord = rawResult as unknown as {
        toolCallId?: string;
        toolName?: string;
        output?: unknown;
        result?: unknown;
      };
      const toolCallId = resRecord.toolCallId ?? "";
      const matchedCall = toolCallId ? callById.get(toolCallId) : undefined;
      const toolName = resRecord.toolName ?? matchedCall?.toolName ?? "";
      const args = matchedCall?.args ?? {};
      const output = resRecord.output ?? resRecord.result;

      if (!output || typeof output !== "object") continue;

      if (toolName === "readSectionByHeading") {
        const section = output as Partial<SectionReadResult>;
        const fileId =
          typeof section.fileId === "string" && section.fileId.length > 0
            ? section.fileId
            : String(args.fileId ?? "");
        const headingSlug =
          typeof section.headingSlug === "string" && section.headingSlug.length > 0
            ? section.headingSlug
            : String(args.headingSlug ?? "");

        if (!fileId || !headingSlug) continue;

        inspectedPathSet.add(`${fileId}#${headingSlug}`);

        const rawContent =
          typeof section.contentOrVaultRef === "string"
            ? section.contentOrVaultRef
            : "";
        const breadcrumbStr =
          typeof section.breadcrumb === "string" && section.breadcrumb.length > 0
            ? section.breadcrumb
            : headingSlug;

        evidenceItems.push({
          fileId,
          headingSlug,
          breadcrumb: breadcrumbStr.split(" > "),
          textExcerpt: rawContent.slice(0, 500),
          vaultRef:
            section.isVaultRef || isVaultRef(rawContent)
              ? rawContent
              : undefined,
        });
      } else if (toolName === "listHeadingsTree" && !Array.isArray(output)) {
        const tree = output as Record<string, HeadingNode[]>;
        for (const [fileId, headings] of Object.entries(tree)) {
          if (!Array.isArray(headings)) continue;
          for (const h of headings) {
            if (!h?.headingSlug) continue;
            inspectedPathSet.add(`${fileId}#${h.headingSlug}`);
            evidenceItems.push({
              fileId,
              headingSlug: h.headingSlug,
              breadcrumb:
                typeof h.breadcrumb === "string" && h.breadcrumb.length > 0
                  ? h.breadcrumb.split(" > ")
                  : [h.headingSlug],
              textExcerpt: `[Heading Level ${h.level}] ${h.title}`,
            });
          }
        }
      } else if (
        toolName === "searchLexicalWithASTBreadcrumb" &&
        Array.isArray(output)
      ) {
        const matches = output as LexicalMatchResult[];
        for (const m of matches) {
          if (!m?.fileId || !m?.headingSlug) continue;
          inspectedPathSet.add(`${m.fileId}#${m.headingSlug}`);
          evidenceItems.push({
            fileId: m.fileId,
            headingSlug: m.headingSlug,
            breadcrumb:
              typeof m.headingBreadcrumb === "string" &&
              m.headingBreadcrumb.length > 0
                ? m.headingBreadcrumb.split(" > ")
                : [m.headingSlug],
            textExcerpt: m.matchedExcerpt ?? "",
            vaultRef: isVaultRef(m.matchedExcerpt ?? "")
              ? m.matchedExcerpt
              : undefined,
          });
        }
      }
    }
  }

  const inspectedPaths = Array.from(inspectedPathSet);
  const summary =
    agentSummaryText.trim().length > 0
      ? agentSummaryText.trim()
      : evidenceItems.length > 0
        ? `Synthesized ${evidenceItems.length} evidence items across ${inspectedPaths.length} workspace paths.`
        : "Workspace and decision-ledger discovery completed with no section evidence extracted.";

  return {
    evidenceItems,
    inspectedPaths,
    summary,
  };
}

/**
 * Deterministic offline/hermetic fallback discovery when no API key is configured.
 */
async function runDeterministicFallbackDiscovery(
  dereferencedPrompt: string,
  targetFileIds: readonly string[],
  initialInspectionPaths: readonly string[],
  ctx: AgentRuntimeContext,
): Promise<SearchReport> {
  const evidenceItems: SearchReportEvidence[] = [];
  const inspectedPathSet = new Set<string>(initialInspectionPaths);

  try {
    if (targetFileIds.length > 0) {
      const tree = await ctx.workspaceProvider.listHeadingsTree([...targetFileIds]);
      for (const [fileId, headings] of Object.entries(tree)) {
        for (const h of headings) {
          inspectedPathSet.add(`${fileId}#${h.headingSlug}`);
          evidenceItems.push({
            fileId,
            headingSlug: h.headingSlug,
            breadcrumb:
              typeof h.breadcrumb === "string" && h.breadcrumb.length > 0
                ? h.breadcrumb.split(" > ")
                : [h.headingSlug],
            textExcerpt: `[Heading Level ${h.level}] ${h.title}`,
          });
        }
      }

      if (dereferencedPrompt.trim().length > 0) {
        const matches =
          await ctx.workspaceProvider.searchLexicalWithASTBreadcrumb({
            fileIds: [...targetFileIds],
            query: dereferencedPrompt,
            maxResults: 5,
          });
        for (const m of matches) {
          inspectedPathSet.add(`${m.fileId}#${m.headingSlug}`);
          evidenceItems.push({
            fileId: m.fileId,
            headingSlug: m.headingSlug,
            breadcrumb:
              typeof m.headingBreadcrumb === "string" &&
              m.headingBreadcrumb.length > 0
                ? m.headingBreadcrumb.split(" > ")
                : [m.headingSlug],
            textExcerpt: m.matchedExcerpt,
            vaultRef: isVaultRef(m.matchedExcerpt)
              ? m.matchedExcerpt
              : undefined,
          });
        }
      }
    }
  } catch {
    // Graceful degradation for offline/empty workspaces
  }

  const inspectedPaths = Array.from(inspectedPathSet);
  return {
    evidenceItems,
    inspectedPaths,
    summary:
      evidenceItems.length > 0
        ? `Deterministic discovery extracted ${evidenceItems.length} evidence items across ${inspectedPaths.length} paths.`
        : "Deterministic workspace discovery completed with no section evidence extracted.",
  };
}

/**
 * Unwrapped implementation of `searchDiscoveryNode` (Node 2: `search_discovery_node`).
 */
export const rawSearchDiscoveryNode: AgentGraphNodeFn = async (
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> => {
  const targetFileIds = state.user_request?.targetFileIds ?? [];
  const dereferencedPrompt = resolveVaultRefJustInTime(
    state.user_request?.prompt ?? "",
  );
  const initialPaths = state.local_inspection_state ?? [];

  const hasApiKeys =
    getApiKeys().length > 0 || Boolean(process.env.GEMINI_API_KEY);

  let searchReport: SearchReport;

  if (hasApiKeys) {
    const workspaceTools = createWorkspaceDocumentTools(ctx);
    const decisionGraphTools = createDecisionGraphTools(() =>
      toProviderLedgerDocument({
        schemaVersion: "2.0.0",
        workspaceId: ctx.workspaceId,
        updatedAt: new Date().toISOString(),
        taxonomy: state.project_taxonomy,
        nodes: state.master_ledger,
        edges: state.ledger_edges,
      }),
    );

    const tools: ToolSet = {
      ...workspaceTools,
      ...decisionGraphTools,
    };

    try {
      const result = await executeToolAgentGeneration({
        modelId: ctx.selectedSystem2ModelId,
        tools,
        maxSteps: SEARCH_AGENT_STEP_CEILING,
        abortSignal: ctx.abortSignal,
        system: [
          "You are the Elixent Dual-Domain Search & Discovery Agent.",
          "Inspect workspace documents and the ATMS Decision Ledger to gather exact architectural evidence.",
          "Prefer targeted heading-tree inspection and section reads over blind full-workspace scans.",
          "When finished, summarize the key findings concisely.",
        ].join("\n"),
        prompt: [
          `Classified Intent: ${state.classified_intent ?? "WORKSPACE_READ_SEARCH"}`,
          `User Request: ${dereferencedPrompt}`,
          `Target File IDs: ${targetFileIds.length > 0 ? targetFileIds.join(", ") : "none"}`,
          `Known Inspection Paths: ${initialPaths.length > 0 ? initialPaths.join(", ") : "none"}`,
        ].join("\n"),
      });

      searchReport = synthesizeSearchReportFromSteps(
        result.steps,
        result.text,
        initialPaths,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      searchReport = await runDeterministicFallbackDiscovery(
        dereferencedPrompt,
        targetFileIds,
        initialPaths,
        ctx,
      );
    }
  } else {
    searchReport = await runDeterministicFallbackDiscovery(
      dereferencedPrompt,
      targetFileIds,
      initialPaths,
      ctx,
    );
  }

  return {
    status: "COMPLETED",
    stateDelta: {
      search_report: searchReport,
      local_inspection_state: [...searchReport.inspectedPaths],
      search_loop_count: 1,
    },
  };
};

/**
 * Metered Node 2 (`search_discovery_node`) wrapped with `withMeteredNodeGate`.
 */
export const searchDiscoveryNode: AgentGraphNodeFn = withMeteredNodeGate(
  "search_discovery_node",
  "system2",
  rawSearchDiscoveryNode,
  { isSystem2Node: true },
);
