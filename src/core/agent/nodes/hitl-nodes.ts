/**
 * Stage 6 Human-in-the-Loop (HITL) Question Organizer & Pure Interrupt Nodes
 *
 * Implements the replay-safe human-in-the-loop interaction protocol (ELIXENT-ARCH-02 §6):
 * 1. `questionOrganizerNode`: Generates and structures clarifying question batches from
 *    `unresolved_ledger`, populating `question_queue` prior to checkpoint persistence.
 * 2. `pureInterruptNode`: Replay-safe stateless interrupt node.
 *
 * CRITICAL ARCHITECTURAL INVARIANTS FOR pureInterruptNode:
 * - ZERO model calls, ZERO network requests, and ZERO external writes before `interrupt()`.
 * - Never swallows `GraphInterrupt` exception.
 * - Enforces client-contract typed resumption using `ClarificationResponseSchema`.
 * - Returns `new Command({ update: { question_queue: null, ... }, goto: "assumption_analyzer_node" })`
 *   to cleanly re-enter Stage 2 upon resumption.
 */

import { Command, interrupt } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  AgentGraphState,
  ClarifyingQuestionBatch,
} from "@/core/agent/state";
import { ClarificationResponseSchema } from "@/core/agent/schemas/decision-schemas";

/**
 * Stage 6 Question Organizer Node.
 *
 * Synthesizes unresolved decisions from `state.unresolved_ledger` into a structured,
 * canonical `ClarifyingQuestionBatch` stored in `state.question_queue`.
 *
 * Guarantees:
 * 1. Completes normally before transitioning to `pure_interrupt_node`, ensuring that
 *    the checkpointer persists `state.question_queue` before the execution freezes.
 * 2. Options are formatted neutrally without leading or preferential language.
 *
 * @param state - Current agent graph state.
 * @param _config - Optional runnable configuration.
 * @returns State delta with populated `question_queue`.
 */
export async function questionOrganizerNode(
  state: AgentGraphState,
  _config?: RunnableConfig,
): Promise<Partial<AgentGraphState>> {
  const unresolvedItems = state.unresolved_ledger ?? [];
  const stateRecord = state as unknown as Record<string, unknown>;

  // Collect candidate decisions from staged or scored decisions to preserve existing options
  const existingCandidates = (
    Array.isArray(stateRecord.staged_decisions)
      ? stateRecord.staged_decisions
      : Array.isArray(stateRecord.scored_decisions)
      ? stateRecord.scored_decisions
      : []
  ) as Array<Record<string, unknown>>;

  const candidateMap = new Map<string, Record<string, unknown>>();
  for (const cand of existingCandidates) {
    if (typeof cand?.decisionId === "string") {
      candidateMap.set(cand.decisionId, cand);
    }
  }

  const questions: Array<{
    readonly questionId: string;
    readonly topicSlug: string;
    readonly questionPrompt: string;
    readonly options: ReadonlyArray<{
      readonly optionKey: string;
      readonly neutralSummary: string;
      readonly rationaleAndPremises: string;
    }>;
    readonly contextExplanation?: string;
  }> = [];

  for (const item of unresolvedItems) {
    const candidate = candidateMap.get(item.decisionId);
    let options: ReadonlyArray<{
      readonly optionKey: string;
      readonly neutralSummary: string;
      readonly rationaleAndPremises: string;
    }> = [];

    // If candidate previously had evaluated alternatives, use them
    if (Array.isArray(candidate?.evaluatedAlternatives) && candidate.evaluatedAlternatives.length >= 2) {
      options = candidate.evaluatedAlternatives.map((alt) => ({
        optionKey: String(alt.optionKey),
        neutralSummary: String(alt.neutralSummary),
        rationaleAndPremises: String(alt.rationaleAndPremises),
      }));
    } else if (Array.isArray(candidate?.options) && candidate.options.length >= 2) {
      options = candidate.options.map((opt) => ({
        optionKey: String(opt.optionKey),
        neutralSummary: String(opt.neutralSummary),
        rationaleAndPremises: String(opt.rationaleAndPremises),
      }));
    } else {
      // Default canonical triad of architectural alternatives
      options = [
        {
          optionKey: "approve_conservative",
          neutralSummary: "Adopt conservative, decoupled design",
          rationaleAndPremises:
            "Minimizes coupling and allows seamless rollback without invasive downstream changes.",
        },
        {
          optionKey: "adopt_direct_solution",
          neutralSummary: "Adopt direct, high-performance integrated design",
          rationaleAndPremises:
            "Optimizes runtime performance and unified integration across dependent modules.",
        },
        {
          optionKey: "defer_implementation",
          neutralSummary: "Defer decision and retain current baseline",
          rationaleAndPremises:
            "Avoids premature architectural commitments until further workspace evidence is gathered.",
        },
      ];
    }

    questions.push({
      questionId: item.decisionId,
      topicSlug: item.topicSlug,
      questionPrompt: item.questionPrompt,
      options,
      contextExplanation: item.reason
        ? `Resolution escalated to user: ${item.reason}`
        : "Awaiting architectural preference from user to proceed.",
    });
  }

  const batch: ClarifyingQuestionBatch = {
    questions,
  };

  return {
    question_queue: batch,
  };
}

/**
 * Stage 6 Pure Human-in-the-Loop (HITL) Interrupt Node.
 *
 * Suspends graph execution via `interrupt()` and emits the structured payload to the client.
 *
 * CRITICAL ARCHITECTURAL INVARIANTS:
 * 1. Zero Model Calls: Absolutely NO LLM invocation, network fetch, or external state write
 *    occurs before or during `interrupt()`.
 * 2. Never Swallows GraphInterrupt: Wrapping `interrupt()` in a generic `try/catch` is strictly
 *    prohibited. LangGraph relies on the unhandled `GraphInterrupt` exception to cleanly
 *    checkpoint state and terminate the serverless execution step.
 * 3. Idempotent Resumption: Resuming via `new Command({ resume })` re-runs this node from line 1.
 *    Because this node contains zero billable operations, resumption has zero double-billing risk.
 * 4. Explicit Transition to Stage 2: Returns `new Command({ update: { question_queue: null }, goto: "assumption_analyzer_node" })`.
 *
 * @param state - Current agent graph state.
 * @param _config - Optional runnable configuration.
 * @returns LangGraph Command updating state and routing to `assumption_analyzer_node`.
 */
export async function pureInterruptNode(
  state: AgentGraphState,
  _config?: RunnableConfig,
): Promise<Command> {
  const stateRecord = state as unknown as Record<string, unknown>;

  // Check if credit exhaustion triggered direct transition to pure_interrupt_node
  const isCreditFailure =
    Boolean(stateRecord.credit_exhausted) ||
    Boolean(stateRecord.insufficient_credits) ||
    Boolean(stateRecord.credit_failure) ||
    Boolean(stateRecord.creditFailure) ||
    stateRecord.interrupt_reason === "INSUFFICIENT_CREDITS" ||
    stateRecord.code === "INSUFFICIENT_CREDITS";

  let resumeData: unknown;

  if (isCreditFailure || !state.question_queue) {
    // Financial interrupt payload
    resumeData = interrupt({
      code: "INSUFFICIENT_CREDITS",
      availableMicro: (stateRecord.availableMicro as number | undefined) ?? 0,
      requiredMicro: (stateRecord.requiredMicro as number | undefined) ?? 0,
      message: "Credit balance exhausted. Please top up your wallet to resume execution.",
    });
  } else {
    // Clarifying question batch interrupt payload
    resumeData = interrupt(state.question_queue, {
      responseSchema: ClarificationResponseSchema,
    });
  }

  // Contractual validation of resumed user clarifications
  const parsedResponse = ClarificationResponseSchema.safeParse(resumeData);
  const answers = parsedResponse.success ? parsedResponse.data.answers : [];

  return new Command({
    update: {
      question_queue: null,
      unresolved_ledger: [],
      messages: [
        new AIMessage({
          content: `User clarification submitted for ${answers.length} item(s). Re-entering Stage 2 assumption analysis.`,
        }),
      ],
      ...(answers.length > 0 ? { clarification_answers: answers } : {}),
    },
    goto: "assumption_analyzer_node",
  });
}
