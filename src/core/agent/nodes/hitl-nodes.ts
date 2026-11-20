/**
 * Stage 6 Human-in-the-Loop (HITL) Clarification Node (Node 6: `hitl_clarification_node`)
 *
 * Implements the native Elixent Graph Engine HITL interrupt & resumption protocol:
 * - Entry without `state.clarification_answers` (or with unapproved `DELETE_FILE` actions
 *   in `safe`/`semi_auto` modes): builds `ClarifyingQuestionBatch` and returns
 *   `{ status: "INTERRUPTED", interruptReason, stateDelta, interruptPayload }`.
 * - Resumption with `state.clarification_answers`: validates via `ClarificationResponseSchema`,
 *   stamps `status: "APPROVED_DIRECT"` and `provenance: "USER_EXPLICIT_HITL"`, records
 *   empirical conformal nonconformity feedback `1 - p_tilde(a_user)` into `calibrationStore`
 *   (BUG-02 fix), and updates `pending_file_actions`.
 */

import type {
  AgentGraphNodeFn,
  AgentInterruptReason,
  AgentRuntimeContext,
  NodeExecutionResult,
} from "@/core/agent/engine/runner";
import type {
  AgentConversationMessage,
  AgentGraphState,
  AgentGraphStateDelta,
  AssumptionItem,
  ClarifyingQuestionBatch,
  PendingFileLifecycleAction,
} from "@/core/agent/state";
import type { ATMSDecisionNode } from "@/core/agent/atms/dag";
import {
  computeMinimalSectionInvalidationMap,
  resolveATMSCascadeBFS,
  type LinkedAssumptionInput,
} from "@/core/agent/atms/invalidation";
import type { SectionTarget } from "@/core/agent/schemas/decision-schemas";
import { ClarificationResponseSchema } from "@/core/agent/schemas/decision-schemas";
import { calibrationStore } from "@/lib/jev/calibration-store";
import { TIER1_DEFAULT_MODEL } from "@/lib/jev/client";

type QuestionItem = ClarifyingQuestionBatch["questions"][number];

const APPROVAL_OPTION_KEYS = new Set([
  "approve",
  "approve_delete",
  "approved",
  "confirm",
  "yes",
]);

const REJECTION_OPTION_KEYS = new Set([
  "reject",
  "reject_delete",
  "rejected",
  "cancel",
  "deny",
  "defer",
  "no",
]);

function buildDefaultOptions(): QuestionItem["options"] {
  return [
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

function extractOptionsForCandidate(
  candidate: Record<string, unknown> | undefined,
): QuestionItem["options"] {
  if (
    Array.isArray(candidate?.evaluatedAlternatives) &&
    candidate.evaluatedAlternatives.length >= 2
  ) {
    return candidate.evaluatedAlternatives.map((alt) => {
      const record = alt as Record<string, unknown>;
      return {
        optionKey: String(record.optionKey),
        neutralSummary: String(record.neutralSummary),
        rationaleAndPremises: String(record.rationaleAndPremises ?? ""),
      };
    });
  }

  if (Array.isArray(candidate?.options) && candidate.options.length >= 2) {
    return candidate.options.map((opt) => {
      const record = opt as Record<string, unknown>;
      return {
        optionKey: String(record.optionKey),
        neutralSummary: String(record.neutralSummary),
        rationaleAndPremises: String(record.rationaleAndPremises ?? ""),
      };
    });
  }

  return buildDefaultOptions();
}

function buildQuestionQueue(
  state: Readonly<AgentGraphState>,
  unapprovedDeletions: readonly PendingFileLifecycleAction[],
): ClarifyingQuestionBatch {
  if (state.question_queue && state.question_queue.questions.length > 0) {
    return state.question_queue;
  }

  const candidateMap = new Map<string, Record<string, unknown>>();
  for (const cand of state.scored_decisions ?? []) {
    if (typeof cand?.decisionId === "string") {
      candidateMap.set(cand.decisionId, cand);
    }
  }

  const questions: QuestionItem[] = [];
  const seenQuestionIds = new Set<string>();

  for (const item of state.unresolved_ledger ?? []) {
    if (seenQuestionIds.has(item.decisionId)) {
      continue;
    }
    seenQuestionIds.add(item.decisionId);
    const candidate = candidateMap.get(item.decisionId);
    questions.push({
      questionId: item.decisionId,
      topicSlug: item.topicSlug,
      questionPrompt: item.questionPrompt,
      options: extractOptionsForCandidate(candidate),
      contextExplanation: item.reason
        ? `Resolution escalated to user: ${item.reason}`
        : "Awaiting architectural preference from user to proceed.",
    });
  }

  for (const action of unapprovedDeletions) {
    if (seenQuestionIds.has(action.actionId)) {
      continue;
    }
    seenQuestionIds.add(action.actionId);
    questions.push({
      questionId: action.actionId,
      topicSlug: "file-deletion-approval",
      questionPrompt: `Approve soft-deletion of "${action.relativePath}"?`,
      options: [
        {
          optionKey: "approve_delete",
          neutralSummary: `Approve deletion of ${action.relativePath}`,
          rationaleAndPremises: action.rationale,
        },
        {
          optionKey: "reject_delete",
          neutralSummary: `Keep ${action.relativePath} and skip deletion`,
          rationaleAndPremises:
            "Preserves the existing workspace file without soft-deletion.",
        },
      ],
      contextExplanation: action.rationale,
    });
  }

  return { questions };
}

function determineInterruptReason(
  state: Readonly<AgentGraphState>,
  unapprovedDeletions: readonly PendingFileLifecycleAction[],
): AgentInterruptReason {
  const isAntiDomino =
    Boolean(state.question_queue?.questions.length) ||
    (state.unresolved_ledger ?? []).some((item) =>
      item.reason.toUpperCase().includes("ANTI_DOMINO"),
    );

  if (isAntiDomino && state.question_queue && state.question_queue.questions.length > 0) {
    return "ANTI_DOMINO_CONFIRMATION_REQUIRED";
  }

  if (unapprovedDeletions.length > 0 && (state.unresolved_ledger ?? []).length === 0) {
    return "FILE_DELETION_APPROVAL_REQUIRED";
  }

  return "HITL_CLARIFICATION_REQUIRED";
}

function parseClarificationAnswers(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const direct = ClarificationResponseSchema.safeParse(raw);
  if (direct.success) {
    return direct.data.answers;
  }

  if (Array.isArray(raw)) {
    const wrapped = ClarificationResponseSchema.safeParse({ answers: raw });
    if (wrapped.success) {
      return wrapped.data.answers;
    }
  }

  return null;
}

/**
 * Canonical Node 6 (`hitl_clarification_node`).
 *
 * Suspends graph execution with a typed `INTERRUPTED` result when clarification,
 * Anti-Domino confirmation, or file-deletion approval is required, and applies
 * validated user answers with conformal feedback calibration on resumption.
 */
export const hitlClarificationNode: AgentGraphNodeFn = async (
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
): Promise<NodeExecutionResult> => {
  const requiresDeletionGate =
    ctx.permissionMode === "safe" || ctx.permissionMode === "semi_auto";
  const unapprovedDeletions = requiresDeletionGate
    ? (state.pending_file_actions ?? []).filter(
        (action) => action.type === "DELETE_FILE" && action.approved === undefined,
      )
    : [];

  const parsedAnswers = parseClarificationAnswers(state.clarification_answers);

  // Entry path: no validated user answers present yet -> suspend execution
  if (!parsedAnswers || parsedAnswers.length === 0) {
    const questionQueue = buildQuestionQueue(state, unapprovedDeletions);
    const interruptReason = determineInterruptReason(state, unapprovedDeletions);

    return {
      status: "INTERRUPTED",
      interruptReason,
      stateDelta: {
        question_queue: questionQueue,
      },
      interruptPayload: {
        questionQueue,
        pendingFileActions: state.pending_file_actions,
      },
    };
  }

  // Resumption path: apply answers, stamp provenance, and record conformal feedback (BUG-02)
  const answerById = new Map(
    parsedAnswers.map((ans) => [ans.questionId, ans]),
  );

  const updatedScoredDecisions: Array<Record<string, unknown>> = [];
  for (const decision of state.scored_decisions ?? []) {
    const decisionId =
      typeof decision.decisionId === "string" ? decision.decisionId : "";
    const answer = answerById.get(decisionId);

    if (!answer) {
      updatedScoredDecisions.push(decision);
      continue;
    }

    // Record empirical nonconformity score s(x, a_user) = 1 - p_tilde(a_user)
    const probabilities = decision.probabilities as
      | Record<string, unknown>
      | undefined;
    let rawProb: unknown =
      probabilities && typeof probabilities === "object"
        ? probabilities[answer.selectedOptionKey]
        : undefined;

    if (
      typeof rawProb !== "number" &&
      Array.isArray(decision.evaluatedAlternatives)
    ) {
      const matchedAlt = (
        decision.evaluatedAlternatives as Array<Record<string, unknown>>
      ).find((alt) => alt?.optionKey === answer.selectedOptionKey);
      rawProb = matchedAlt?.normalizedProbability;
    }

    if (typeof rawProb === "number" && Number.isFinite(rawProb)) {
      const clampedProb = Math.max(0, Math.min(1, rawProb));
      const nonconformityScore = 1 - clampedProb;
      const modelId =
        typeof decision.modelId === "string" && decision.modelId.trim().length > 0
          ? decision.modelId.trim()
          : TIER1_DEFAULT_MODEL;
      await calibrationStore.recordFeedbackScore(modelId, nonconformityScore);
    }

    const baseRationale =
      typeof decision.selectionRationale === "string"
        ? decision.selectionRationale
        : "";
    const updatedRationale = answer.customNotes
      ? baseRationale
        ? `${baseRationale} (User note: ${answer.customNotes})`
        : answer.customNotes
      : baseRationale || "Explicitly selected by user during HITL clarification.";

    updatedScoredDecisions.push({
      ...decision,
      status: "APPROVED_DIRECT",
      provenance: "USER_EXPLICIT_HITL",
      selectedOptionKey: answer.selectedOptionKey,
      selectionRationale: updatedRationale,
    });
  }

  // Handle Anti-Domino ESCALATE_TO_HITL resumptions (`antidomino_<priorId>`)
  let updatedMasterLedger: Record<string, ATMSDecisionNode> = {
    ...(state.master_ledger ?? {}),
  };
  let masterLedgerChanged = false;
  const updatedInvalidationMap: Record<string, SectionTarget[]> = {
    ...(state.invalidation_map ?? {}),
  };
  let invalidationMapChanged = false;
  const updatedGoverningConstraints: ATMSDecisionNode[] = [
    ...(state.governing_constraints ?? []),
  ];
  let governingConstraintsChanged = false;
  const updatedAssumptions: Array<
    AssumptionItem & { candidateDecisionIds?: readonly string[]; constrainedByPrior?: boolean }
  > = (state.assumptions ?? []).map((a) => ({ ...a }));
  let assumptionsChanged = false;

  for (const answer of parsedAnswers) {
    if (!answer.questionId.startsWith("antidomino_")) {
      continue;
    }
    const priorId = answer.questionId.slice("antidomino_".length);
    if (!priorId) {
      continue;
    }

    const matchingAssumptions = updatedAssumptions.filter((a) => {
      const candidateIds = a.candidateDecisionIds;
      return (
        (Array.isArray(candidateIds) && candidateIds.includes(priorId)) ||
        a.dependsOn?.includes(priorId)
      );
    });

    if (answer.selectedOptionKey === "confirm_override") {
      const overrideInputs: LinkedAssumptionInput[] =
        matchingAssumptions.length > 0
          ? matchingAssumptions.map((a) => ({
              assumption: {
                assumptionId: a.assumptionId,
                statement: a.statement,
                conceptTags: [...a.conceptTags],
                affectedSections: [...a.affectedSections],
                dependsOn: [...a.dependsOn],
              },
              relations: [
                {
                  targetDecisionId: priorId,
                  relationType: "REOPENS_OR_OVERRIDES",
                },
              ],
            }))
          : [
              {
                assumption: {
                  assumptionId: `override_${priorId}`,
                  statement: `User confirmed override of ${priorId}`,
                  conceptTags: [],
                  affectedSections: [],
                  dependsOn: [],
                },
                relations: [
                  {
                    targetDecisionId: priorId,
                    relationType: "REOPENS_OR_OVERRIDES",
                  },
                ],
              },
            ];

      const overrideInvalidation = computeMinimalSectionInvalidationMap(
        [priorId],
        updatedMasterLedger,
      );
      for (const [decId, sections] of Object.entries(overrideInvalidation)) {
        updatedInvalidationMap[decId] = sections;
        invalidationMapChanged = true;
      }

      const cascade = resolveATMSCascadeBFS(overrideInputs, updatedMasterLedger);
      updatedMasterLedger = cascade.updatedLedger;
      masterLedgerChanged = true;
    } else if (answer.selectedOptionKey === "preserve_prior") {
      const priorNode = updatedMasterLedger[priorId];
      if (
        priorNode &&
        !updatedGoverningConstraints.some((n) => n.decisionId === priorId)
      ) {
        updatedGoverningConstraints.push(priorNode);
        governingConstraintsChanged = true;
      }

      for (const assumption of matchingAssumptions) {
        assumption.constrainedByPrior = true;
        assumptionsChanged = true;
      }
    }
  }

  const updatedPendingFileActions: PendingFileLifecycleAction[] = (
    state.pending_file_actions ?? []
  ).map((action) => {
    const answer =
      answerById.get(action.actionId) ??
      (action.fileId ? answerById.get(`delete:${action.fileId}`) : undefined);
    if (!answer) {
      return action;
    }

    const keyLower = answer.selectedOptionKey.trim().toLowerCase();
    if (APPROVAL_OPTION_KEYS.has(keyLower)) {
      return { ...action, approved: true };
    }
    if (REJECTION_OPTION_KEYS.has(keyLower)) {
      return { ...action, approved: false };
    }
    return action;
  });

  const resumeMessage: AgentConversationMessage = {
    id: `hitl-resume-${ctx.turnId}-${Date.now()}`,
    role: "system",
    content: `User clarification submitted for ${parsedAnswers.length} item(s).`,
    createdAt: new Date().toISOString(),
  };

  const stateDelta: AgentGraphStateDelta = {
    scored_decisions: updatedScoredDecisions,
    unresolved_ledger: [],
    pending_file_actions: updatedPendingFileActions,
    question_queue: null,
    clarification_answers: null,
    messages: [resumeMessage],
    ...(masterLedgerChanged
      ? { master_ledger: updatedMasterLedger, replaceMasterLedger: true }
      : {}),
    ...(invalidationMapChanged ? { invalidation_map: updatedInvalidationMap } : {}),
    ...(governingConstraintsChanged
      ? { governing_constraints: updatedGoverningConstraints }
      : {}),
    ...(assumptionsChanged ? { assumptions: updatedAssumptions } : {}),
  };

  return {
    status: "COMPLETED",
    stateDelta,
  };
};
