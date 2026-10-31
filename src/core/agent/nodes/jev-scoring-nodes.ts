/**
 * Architectural Auditing & Conformal Decision Cascade (Stage 3)
 *
 * Implements Stage 3 nodes for the Elixent agent state graph
 * according to ELIXENT-ARCH-02 §1 & §3.4.
 *
 * Exported Symbols:
 * 1. `jevStructuringNode`: Neutralizes and bounds options, re-injecting historical alternatives.
 * 2. `decisionScorerNode`: Calls POST /v1/decisions with Conformal APS to score candidate decisions.
 * 3. `rawJevStructuringNode` / `rawDecisionScorerNode`: Unwrapped implementations for testing.
 */

import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { AgentGraphState, UnresolvedDecision } from "@/core/agent/state";
import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import { resolveProjectConceptTags } from "@/core/agent/taxonomy/predefined-tags";
import {
  createCanonicalDecisionBatchSchema,
  type CanonicalDecisionBatch,
  type DecisionEvaluationItem,
  type CanonicalOption,
} from "@/core/agent/schemas/decision-schemas";
import { evaluateDecisionBatch } from "@/lib/jev/client";
import { executeStructuredGeneration } from "@/lib/ai/client";
import { getApiKeys } from "@/lib/ai/key-rotation";

/** Model identifier for canonical option structuring and neutralization */
export const JEV_STRUCTURING_MODEL_ID = "google/gemini-3.8-flash";

/** Model identifier for single-pass decision scoring */
export const DECISION_SCORER_MODEL_ID = "typesafe/jev-1.13";

/** Message name constant identifying serialized canonical decision batches */
export const CANONICAL_BATCH_MESSAGE_NAME = "canonical_decision_batch";

/**
 * Normalizes text into a canonical lowercase underscore topic slug.
 *
 * @param text - Input topic string.
 * @returns Cleaned topic slug.
 */
function slugifyTopic(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.slice(0, 40) || "decision_topic";
}

/**
 * Constructs 3-4 canonical neutral options for a decision item,
 * reusing historical alternatives if available.
 *
 * @param topicSlug - Slug of the target topic.
 * @param existingAlternatives - Historical alternatives from prior decision nodes.
 * @returns Array of 3-4 canonical neutral options.
 */
function buildDefaultNeutralOptions(
  topicSlug: string,
  existingAlternatives?: ReadonlyArray<{
    optionKey: string;
    neutralSummary: string;
    rationaleAndPremises: string;
  }>,
): CanonicalOption[] {
  if (Array.isArray(existingAlternatives) && existingAlternatives.length >= 3) {
    return existingAlternatives.slice(0, 4).map((alt) => ({
      optionKey: alt.optionKey.replace(/[^a-z0-9_]/g, "_") || "option_1",
      neutralSummary: alt.neutralSummary.slice(0, 220),
      rationaleAndPremises: alt.rationaleAndPremises.slice(0, 400),
    }));
  }

  return [
    {
      optionKey: `${topicSlug}_primary`,
      neutralSummary: "Standard implementation following modular component boundaries and direct integration.",
      rationaleAndPremises: "Optimizes for low implementation complexity and predictable local state management.",
    },
    {
      optionKey: `${topicSlug}_conservative`,
      neutralSummary: "Conservative provisional implementation with strict fallback boundaries.",
      rationaleAndPremises: "Reduces blast radius and minimizes coupling with peripheral dependencies.",
    },
    {
      optionKey: `${topicSlug}_decoupled`,
      neutralSummary: "Fully decoupled asynchronous implementation utilizing isolated worker execution.",
      rationaleAndPremises: "Maximizes architectural resilience at the expense of slight coordination latency.",
    },
  ];
}

/**
 * Unwrapped implementation of `jevStructuringNode`.
 *
 * Transforms active assumptions into canonical adjudication items bounded to 3-4
 * mutually exclusive options. When reopening an existing decision from `master_ledger`,
 * historical evaluated alternatives and prior rationales are re-injected.
 *
 * @param state - The current agent graph state.
 * @param config - LangGraph execution config.
 * @returns Partial state update containing the serialized batch message.
 */
export async function rawJevStructuringNode(
  state: AgentGraphState,
  config?: RunnableConfig,
): Promise<Partial<AgentGraphState>> {
  const activeTags = resolveProjectConceptTags(state.project_taxonomy);
  const batchSchema = createCanonicalDecisionBatchSchema(activeTags);
  const assumptions = state.assumptions ?? [];
  const masterLedger = state.master_ledger ?? {};

  const decisionItems: DecisionEvaluationItem[] = [];

  for (const asmp of assumptions) {
    const priorNode = masterLedger[asmp.assumptionId];
    const topicSlug = slugifyTopic(asmp.conceptTags[0] ?? asmp.statement);

    // Filter concept tags to ensure they strictly adhere to active project tags
    const validTags = (asmp.conceptTags ?? []).filter((t) => activeTags.includes(t));
    const assignedTags = validTags.length > 0 ? validTags.slice(0, 6) : [activeTags[0]];

    const options = buildDefaultNeutralOptions(topicSlug, priorNode?.evaluatedAlternatives);

    const item: DecisionEvaluationItem = {
      decisionId: asmp.assumptionId,
      topicSlug,
      questionPrompt: asmp.statement || "Canonical decision prompt",
      conceptTags: assignedTags as [string, ...string[]],
      options,
      dependsOnDecisionIds: [...(asmp.dependsOn ?? [])],
      affectedSections: [...(asmp.affectedSections ?? [])],
      priorDecisionContext: priorNode
        ? {
            reopenedFromDecisionId: priorNode.decisionId,
            previousSelectedOptionKey: priorNode.selectedOptionKey,
            previousSelectionRationale: priorNode.selectionRationale,
            triggerForReevaluation: "Reopened due to modified premises or changed evidence.",
          }
        : undefined,
    };

    decisionItems.push(item);
  }

  // If no assumptions exist, provide a single neutral item so the batch schema remains valid
  if (decisionItems.length === 0) {
    const defaultSlug = "system_architecture";
    decisionItems.push({
      decisionId: `dec_${Date.now()}_default`,
      topicSlug: defaultSlug,
      questionPrompt: state.user_request?.prompt || "Standard baseline architectural adjudication",
      conceptTags: [activeTags[0]],
      options: buildDefaultNeutralOptions(defaultSlug),
      dependsOnDecisionIds: [],
      affectedSections: [],
    });
  }

  // Attempt structured generation with LLM to neutralize options if API keys are available
  const hasApiKeys = getApiKeys().length > 0 || Boolean(process.env.GEMINI_API_KEY);
  let finalBatch: CanonicalDecisionBatch = { items: decisionItems };

  if (hasApiKeys) {
    try {
      const promptText = `Structure and neutralize the following architectural decision candidates:\n${JSON.stringify(
        decisionItems,
        null,
        2,
      )}`;

      const structuredResult = await executeStructuredGeneration({
        modelId: JEV_STRUCTURING_MODEL_ID,
        schema: batchSchema,
        prompt: promptText,
        system:
          "You are an architectural option neutralizer. Bound candidate alternatives to 3-4 mutually exclusive options and strip rhetorical or marketing adjectives.",
        abortSignal: config?.signal,
      });

      if (structuredResult.object && Array.isArray(structuredResult.object.items)) {
        finalBatch = batchSchema.parse(structuredResult.object);
      }
    } catch {
      // Fallback to deterministic options on model failure
      finalBatch = batchSchema.parse({ items: decisionItems });
    }
  } else {
    finalBatch = batchSchema.parse({ items: decisionItems });
  }

  return {
    messages: [
      new AIMessage({
        name: CANONICAL_BATCH_MESSAGE_NAME,
        content: JSON.stringify(finalBatch),
      }),
    ],
  };
}

/**
 * Metered JEV structuring node wrapped with `withMeteredNodeGate`.
 */
export const jevStructuringNode = withMeteredNodeGate(
  "jev_structuring_node",
  JEV_STRUCTURING_MODEL_ID,
  rawJevStructuringNode,
);

/**
 * Unwrapped implementation of `decisionScorerNode`.
 *
 * Calls `evaluateDecisionBatch` with Conformal APS to score candidate decisions in parallel,
 * triaging outputs into direct approvals, conservative approvals, or unresolved decisions.
 *
 * @param state - The current agent graph state.
 * @param config - LangGraph execution config containing optional abortSignal.
 * @returns Partial state update with updated master ledger and unresolved ledger entries.
 */
export async function rawDecisionScorerNode(
  state: AgentGraphState,
  config?: RunnableConfig,
): Promise<Partial<AgentGraphState>> {
  const activeTags = resolveProjectConceptTags(state.project_taxonomy);
  const batchSchema = createCanonicalDecisionBatchSchema(activeTags);

  // 1. Retrieve canonical batch from recent messages or reconstruct from assumptions
  let batchToEvaluate: CanonicalDecisionBatch | null = null;
  const recentMessages = state.messages ?? [];

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const msg = recentMessages[i];
    if (
      msg._getType() === "ai" &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg as any).name === CANONICAL_BATCH_MESSAGE_NAME &&
      typeof msg.content === "string"
    ) {
      try {
        const parsed = JSON.parse(msg.content);
        batchToEvaluate = batchSchema.parse(parsed);
        break;
      } catch {
        // Continue search if message parsing failed
      }
    }
  }

  // Reconstruct if not found in message channel
  if (!batchToEvaluate) {
    const rawResult = await rawJevStructuringNode(state, config);
    const generatedMsg = rawResult.messages?.[0];
    if (generatedMsg && typeof generatedMsg.content === "string") {
      batchToEvaluate = batchSchema.parse(JSON.parse(generatedMsg.content));
    } else {
      batchToEvaluate = { items: [] };
    }
  }

  if (batchToEvaluate.items.length === 0) {
    return {
      unresolved_ledger: [],
      master_ledger: state.master_ledger ?? {},
    };
  }

  // 2. Dispatch batch to POST /v1/decisions client with Two-Tier Conformal APS Cascade
  const results = await evaluateDecisionBatch(batchToEvaluate, {
    modelId: DECISION_SCORER_MODEL_ID,
    activeConceptTags: activeTags,
    abortSignal: config?.signal,
  });

  const updatedLedger: Record<string, ATMSDecisionNode> = { ...(state.master_ledger ?? {}) };
  const unresolvedItems: UnresolvedDecision[] = [];

  const itemLookup = new Map<string, DecisionEvaluationItem>();
  for (const item of batchToEvaluate.items) {
    itemLookup.set(item.decisionId, item);
  }

  // 3. Triage results based on Conformal APS status
  for (const result of results) {
    if (result.status === "UNRESOLVED") {
      unresolvedItems.push({
        decisionId: result.decisionId,
        topicSlug: result.topicSlug,
        questionPrompt: result.questionPrompt,
        conceptTags: result.conceptTags,
        reason: result.reason || "Failed conformal APS criteria (ambiguous or insufficient evidence)",
      });
    } else {
      // APPROVED_DIRECT or APPROVED_CONSERVATIVE
      const matchingItem = itemLookup.get(result.decisionId);
      const node: ATMSDecisionNode = {
        decisionId: result.decisionId,
        topicSlug: result.topicSlug,
        questionPrompt: result.questionPrompt,
        conceptTags: [...result.conceptTags],
        selectedOptionKey: result.selectedOptionKey ?? "default_choice",
        selectionRationale: result.selectionRationale,
        runnerUpOptionKey: result.runnerUpOptionKey ?? null,
        evaluatedAlternatives: result.evaluatedAlternatives.map((alt) => ({
          optionKey: alt.optionKey,
          neutralSummary: alt.neutralSummary,
          rationaleAndPremises: alt.rationaleAndPremises,
          normalizedProbability: alt.normalizedProbability,
        })),
        status: result.status,
        impactTier: result.impactTier,
        isLoadBearing: result.isLoadBearing,
        dependsOn: [...(matchingItem?.dependsOnDecisionIds ?? [])],
        dependedBy: [],
        affectedSections: [...(matchingItem?.affectedSections ?? [])],
        updatedAt: new Date().toISOString(),
      };

      updatedLedger[result.decisionId] = node;
    }
  }

  const approvedCount = results.filter((r) => r.status !== "UNRESOLVED").length;
  const summaryMessage = new AIMessage({
    name: "decision_scoring_report",
    content: `Conformal APS evaluation complete. ${approvedCount} decisions approved, ${unresolvedItems.length} unresolved.`,
  });

  return {
    unresolved_ledger: unresolvedItems,
    master_ledger: updatedLedger,
    messages: [summaryMessage],
  };
}

/**
 * Metered decision scorer node wrapped with `withMeteredNodeGate`.
 */
export const decisionScorerNode = withMeteredNodeGate(
  "decision_scorer_node",
  DECISION_SCORER_MODEL_ID,
  rawDecisionScorerNode,
);
