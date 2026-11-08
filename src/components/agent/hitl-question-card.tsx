/**
 * Human-in-the-Loop (HITL) Clarification Question Card
 *
 * Renders diagnostic clarification question batches emitted by Stage 6
 * (`question_organizer_node` / `pure_interrupt_node`) and validates user
 * responses against `ClarificationResponseSchema` before resuming the
 * LangGraph execution thread.
 */

import React, { useState, useMemo, useCallback } from "react";
import {
  ClarificationResponseSchema,
  type ClarificationResponse,
} from "@/core/agent/schemas/decision-schemas";
import type { ClarifyingQuestionBatch } from "@/core/agent/reducers";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  Loader2,
  MessageSquarePlus,
  Send,
  Sparkles,
} from "lucide-react";

export type HITLQuestionItem = ClarifyingQuestionBatch["questions"][number];
export type HITLQuestionOption = HITLQuestionItem["options"][number];

export interface HITLQuestionCardProps {
  /** Batch of clarification questions from the active interrupt queue */
  questions?: ReadonlyArray<HITLQuestionItem>;
  /** Single clarification question convenience prop (normalized into a 1-item batch) */
  question?: HITLQuestionItem;
  /** Callback invoked once all answers pass ClarificationResponseSchema validation */
  onSubmit: (response: ClarificationResponse) => void | Promise<void>;
  /** Indicates an active resume submission is in flight */
  isSubmitting?: boolean;
  /** Disables all interactive inputs and submission */
  disabled?: boolean;
  /** Optional CSS class name for the root container */
  className?: string;
}

const MAX_CUSTOM_NOTES_LENGTH = 500;

export function HITLQuestionCard({
  questions,
  question,
  onSubmit,
  isSubmitting = false,
  disabled = false,
  className,
}: HITLQuestionCardProps) {
  const normalizedQuestions = useMemo<ReadonlyArray<HITLQuestionItem>>(() => {
    if (Array.isArray(questions) && questions.length > 0) {
      return questions;
    }
    if (question) {
      return [question];
    }
    return [];
  }, [questions, question]);

  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [customNotesByQuestion, setCustomNotesByQuestion] = useState<
    Record<string, string>
  >({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>({});

  const isControlDisabled = disabled || isSubmitting;

  const handleSelectOption = useCallback(
    (questionId: string, optionKey: string) => {
      if (isControlDisabled) return;
      setSelectedOptions((prev) => ({
        ...prev,
        [questionId]: optionKey,
      }));
      setQuestionErrors((prev) => {
        if (!prev[questionId]) return prev;
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
      setValidationError(null);
    },
    [isControlDisabled]
  );

  const handleNotesChange = useCallback(
    (questionId: string, value: string) => {
      if (isControlDisabled) return;
      setCustomNotesByQuestion((prev) => ({
        ...prev,
        [questionId]: value,
      }));
      setQuestionErrors((prev) => {
        if (!prev[questionId]) return prev;
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
      setValidationError(null);
    },
    [isControlDisabled]
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isControlDisabled || normalizedQuestions.length === 0) {
        return;
      }

      const nextQuestionErrors: Record<string, string> = {};
      const candidateAnswers = normalizedQuestions.map((item) => {
        const selectedOptionKey = (selectedOptions[item.questionId] ?? "").trim();
        const rawNotes = customNotesByQuestion[item.questionId] ?? "";
        const trimmedNotes = rawNotes.trim();

        const validOptionKeys = new Set(item.options.map((opt) => opt.optionKey));
        if (!selectedOptionKey || !validOptionKeys.has(selectedOptionKey)) {
          nextQuestionErrors[item.questionId] =
            "Please select an architectural option for this question.";
        }

        if (rawNotes.length > MAX_CUSTOM_NOTES_LENGTH) {
          nextQuestionErrors[item.questionId] =
            `Custom notes cannot exceed ${MAX_CUSTOM_NOTES_LENGTH} characters (currently ${rawNotes.length}).`;
        }

        // Preserve rawNotes when exceeding limit so Zod safeParse also records the max-length violation
        const effectiveNotes =
          rawNotes.length > MAX_CUSTOM_NOTES_LENGTH
            ? rawNotes
            : trimmedNotes.length > 0
              ? trimmedNotes
              : undefined;

        return {
          questionId: item.questionId,
          selectedOptionKey,
          ...(effectiveNotes !== undefined ? { customNotes: effectiveNotes } : {}),
        };
      });

      const parsed = ClarificationResponseSchema.safeParse({
        answers: candidateAnswers,
      });

      if (!parsed.success || Object.keys(nextQuestionErrors).length > 0) {
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            const answerIndex =
              typeof issue.path[1] === "number" ? issue.path[1] : undefined;
            const targetQuestion =
              answerIndex !== undefined
                ? normalizedQuestions[answerIndex]
                : undefined;
            if (targetQuestion && !nextQuestionErrors[targetQuestion.questionId]) {
              nextQuestionErrors[targetQuestion.questionId] = issue.message;
            }
          }
        }

        setQuestionErrors(nextQuestionErrors);

        const firstError =
          Object.values(nextQuestionErrors)[0] ??
          (!parsed.success
            ? parsed.error.issues[0]?.message
            : "Please complete all required clarification answers.");

        setValidationError(
          firstError || "Please complete all required clarification answers."
        );
        return;
      }

      setQuestionErrors({});
      setValidationError(null);
      await onSubmit(parsed.data);
    },
    [
      customNotesByQuestion,
      isControlDisabled,
      normalizedQuestions,
      onSubmit,
      selectedOptions,
    ]
  );

  if (normalizedQuestions.length === 0) {
    return null;
  }

  const answeredCount = normalizedQuestions.filter((q) => {
    const selected = selectedOptions[q.questionId];
    return typeof selected === "string" && selected.trim().length > 0;
  }).length;

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="hitl-question-card"
      className={cn(
        "rounded-xl border border-indigo-500/30 bg-zinc-900/90 p-4 shadow-lg space-y-4 text-zinc-100",
        className
      )}
      noValidate
    >
      <div className="flex items-start justify-between gap-3 border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
            <HelpCircle className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
              <span>Architectural Clarification Required</span>
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            </h3>
            <p className="text-xs text-zinc-400">
              Select the preferred direction for each load-bearing decision below to resume synthesis.
            </p>
          </div>
        </div>
        <span
          className="inline-flex items-center rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-300 border border-zinc-700 shrink-0"
          data-testid="hitl-progress-badge"
        >
          {answeredCount}/{normalizedQuestions.length} answered
        </span>
      </div>

      <div className="space-y-5">
        {normalizedQuestions.map((item, index) => {
          const currentSelection = selectedOptions[item.questionId] ?? "";
          const currentNotes = customNotesByQuestion[item.questionId] ?? "";
          const isNotesOverLimit = currentNotes.length > MAX_CUSTOM_NOTES_LENGTH;
          const itemError = questionErrors[item.questionId];

          return (
            <div
              key={item.questionId}
              data-testid={`hitl-question-item-${item.questionId}`}
              className={cn(
                "rounded-lg border p-3.5 space-y-3 transition-colors",
                itemError
                  ? "border-rose-500/50 bg-rose-950/10"
                  : "border-zinc-800 bg-zinc-950/60"
              )}
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span
                    className="inline-flex items-center rounded-md bg-indigo-500/10 border border-indigo-500/25 px-2 py-0.5 text-[11px] font-mono font-medium text-indigo-300"
                    data-testid={`hitl-topic-slug-${item.questionId}`}
                  >
                    {item.topicSlug}
                  </span>
                  <span className="text-[11px] text-zinc-500 font-mono">
                    Question {index + 1} of {normalizedQuestions.length}
                  </span>
                </div>

                <p className="text-sm font-medium text-zinc-100 leading-snug">
                  {item.questionPrompt}
                </p>

                {item.contextExplanation && (
                  <p
                    className="text-xs text-zinc-400 leading-relaxed bg-zinc-900/70 rounded-md px-2.5 py-1.5 border border-zinc-800/80"
                    data-testid={`hitl-context-${item.questionId}`}
                  >
                    {item.contextExplanation}
                  </p>
                )}
              </div>

              <div
                role="radiogroup"
                aria-label={item.questionPrompt}
                className="space-y-2"
              >
                {item.options.map((option) => {
                  const isSelected = currentSelection === option.optionKey;
                  return (
                    <label
                      key={option.optionKey}
                      data-testid={`hitl-option-${item.questionId}-${option.optionKey}`}
                      onClick={() =>
                        handleSelectOption(item.questionId, option.optionKey)
                      }
                      className={cn(
                        "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-all",
                        isSelected
                          ? "border-indigo-500 bg-indigo-500/10 shadow-[0_0_12px_rgba(99,102,241,0.15)]"
                          : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900",
                        isControlDisabled && "opacity-60 cursor-not-allowed"
                      )}
                    >
                      <input
                        type="radio"
                        name={`hitl-question-${item.questionId}`}
                        value={option.optionKey}
                        checked={isSelected}
                        disabled={isControlDisabled}
                        onChange={() =>
                          handleSelectOption(item.questionId, option.optionKey)
                        }
                        className="mt-1 h-4 w-4 accent-indigo-500 shrink-0"
                      />
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-xs font-mono font-semibold text-indigo-300">
                            {option.optionKey}
                          </span>
                          {isSelected && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Selected
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-medium text-zinc-100">
                          {option.neutralSummary}
                        </p>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                          {option.rationaleAndPremises}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="space-y-1 pt-1">
                <div className="flex items-center justify-between text-[11px] text-zinc-400">
                  <label
                    htmlFor={`hitl-notes-${item.questionId}`}
                    className="flex items-center gap-1 font-medium"
                  >
                    <MessageSquarePlus className="h-3 w-3 text-zinc-500" />
                    <span>Additional Constraints or Custom Notes (optional)</span>
                  </label>
                  <span
                    data-testid={`hitl-char-count-${item.questionId}`}
                    className={cn(
                      "font-mono",
                      isNotesOverLimit ? "text-rose-400 font-semibold" : "text-zinc-500"
                    )}
                  >
                    {currentNotes.length}/{MAX_CUSTOM_NOTES_LENGTH}
                  </span>
                </div>
                <textarea
                  id={`hitl-notes-${item.questionId}`}
                  data-testid={`hitl-custom-notes-${item.questionId}`}
                  value={currentNotes}
                  onChange={(e) =>
                    handleNotesChange(item.questionId, e.target.value)
                  }
                  disabled={isControlDisabled}
                  rows={2}
                  placeholder="Specify optional architectural constraints, edge cases, or implementation notes..."
                  className={cn(
                    "w-full rounded-md border bg-zinc-900/80 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 transition-colors resize-y",
                    isNotesOverLimit
                      ? "border-rose-500/60 focus:border-rose-500 focus:ring-rose-500/40"
                      : "border-zinc-800 focus:border-indigo-500 focus:ring-indigo-500/40",
                    isControlDisabled && "opacity-60 cursor-not-allowed"
                  )}
                />
              </div>

              {itemError && (
                <div
                  role="alert"
                  data-testid={`hitl-question-error-${item.questionId}`}
                  className="flex items-center gap-1.5 text-xs text-rose-400 pt-0.5"
                >
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{itemError}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {validationError && (
        <div
          role="alert"
          data-testid="hitl-validation-error"
          className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-300"
        >
          <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
          <span>{validationError}</span>
        </div>
      )}

      <div className="flex items-center justify-end pt-1">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={isControlDisabled}
          data-testid="hitl-submit-button"
          className="gap-1.5"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Resuming Agent...</span>
            </>
          ) : (
            <>
              <Send className="h-3.5 w-3.5" />
              <span>Submit Clarification Decisions</span>
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
