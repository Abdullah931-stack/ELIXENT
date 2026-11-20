/**
 * Decision Graph Exploration Tools (Vercel AI SDK `tool()` Wrappers)
 *
 * Exposes the 4 read-only ATMS Decision Graph exploration primitives (`ADR-012`,
 * `SRS-01` §4.2) for System 1 / System 2 agents while keeping `atms/dag.ts` 100%
 * pure and client-bundle safe.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  type DecisionLedgerDocument,
  getDecisionNodeDetails,
  getSectionGoverningDecisions,
  searchDecisionLedger,
  traverseDecisionDependencies,
} from "@/core/agent/atms/dag";

export type LedgerDocumentProvider =
  | (() => DecisionLedgerDocument | Promise<DecisionLedgerDocument>);

export function createDecisionGraphTools(getLedgerDoc: LedgerDocumentProvider) {
  return {
    searchDecisionLedger: tool({
      description:
        "Search the workspace ATMS Decision Ledger by keyword query, concept tags, or fileId. Returns matching decision nodes sorted by changeWeight descending.",
      inputSchema: z.object({
        query: z.string().optional().describe("Optional text query matched against decisionId, topicSlug, prompt, option, rationale, or tags."),
        conceptTags: z.array(z.string()).optional().describe("Optional list of concept tags to filter by (matches any shared tag)."),
        fileId: z.string().optional().describe("Optional workspace fileId to filter decisions affecting that file."),
      }),
      execute: async (params) => {
        const doc = await getLedgerDoc();
        return searchDecisionLedger(doc, params);
      },
    }),

    getDecisionNodeDetails: tool({
      description:
        "Fetch full details of a specific DecisionGraphNode and all its incident directed edges.",
      inputSchema: z.object({
        decisionId: z.string().min(1).describe("The unique decisionId to inspect."),
      }),
      execute: async (params) => {
        const doc = await getLedgerDoc();
        return getDecisionNodeDetails(doc, params);
      },
    }),

    traverseDecisionDependencies: tool({
      description:
        "Perform cycle-safe BFS traversal upstream (dependsOn), downstream (dependedBy), or both from a root decisionId, returning visited nodes, edges, and topological order.",
      inputSchema: z.object({
        decisionId: z.string().min(1).describe("Root decisionId for graph traversal."),
        direction: z.enum(["upstream", "downstream", "both"]).describe("Traversal direction."),
        maxDepth: z.union([z.literal(1), z.literal(2), z.literal("all")]).describe("Maximum BFS depth (1, 2, or 'all')."),
      }),
      execute: async (params) => {
        const doc = await getLedgerDoc();
        return traverseDecisionDependencies(doc, params);
      },
    }),

    getSectionGoverningDecisions: tool({
      description:
        "Retrieve all decisions directly governing a file or headingSlug, along with their upstream load-bearing ancestors.",
      inputSchema: z.object({
        fileId: z.string().min(1).describe("Target fileId to inspect."),
        headingSlug: z.string().optional().describe("Optional headingSlug within the file."),
      }),
      execute: async (params) => {
        const doc = await getLedgerDoc();
        return getSectionGoverningDecisions(doc, params);
      },
    }),
  };
}
