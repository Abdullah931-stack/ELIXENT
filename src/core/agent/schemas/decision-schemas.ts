/**
 * Universal Decision & Agent State Zod Schemas
 *
 * Implements isomorphic, client-safe Zod v4 schemas and dynamic schema factories
 * governing architectural decisions, conformal prediction sets, ATMS dependency linking,
 * and human-in-the-loop clarification workflows.
 *
 * Architectural Invariants:
 * 1. Pure Isomorphic & Client-Safe: Zero imports of database, Redis, or Node-only modules.
 * 2. Closed-World Dynamic Tag Validation: Uses `createConceptTagEnum` to enforce that LLMs
 *    can only emit active, authorized concept tags from the project taxonomy.
 * 3. Zod v4 Compatibility: Built and typed against Zod v4.
 */

import { z } from "zod";
import {
  CONCEPT_TAG_FORMAT_REGEX,
  DEFAULT_CONCEPT_TAGS,
  EmptyProjectTaxonomyError,
  resolveProjectConceptTags,
} from "../taxonomy/predefined-tags";

// ---------------------------------------------------------------------------
// 1. Concept Tag Format & Mutation Schemas
// ---------------------------------------------------------------------------

export const ConceptTagFormatSchema = z
  .string()
  .regex(
    CONCEPT_TAG_FORMAT_REGEX,
    "Concept tag must start with lowercase letter and contain only lowercase letters, numbers, and underscores (2-64 chars)"
  );
export type ConceptTagFormat = z.infer<typeof ConceptTagFormatSchema>;

export const ProjectTagMutationSchema = z.object({
  addTags: z.array(ConceptTagFormatSchema).default([]),
  removeTags: z.array(ConceptTagFormatSchema).default([]),
  rationale: z.string().max(300).optional(),
});
export type ProjectTagMutation = z.infer<typeof ProjectTagMutationSchema>;

// ---------------------------------------------------------------------------
// 2. Static Structural & Component Schemas
// ---------------------------------------------------------------------------

export const SectionTargetSchema = z.object({
  fileId: z.string().min(1),
  headingSlug: z.string().min(1),
});
export type SectionTarget = z.infer<typeof SectionTargetSchema>;

export const CanonicalOptionSchema = z.object({
  optionKey: z.string().regex(/^[a-z0-9_]+$/),
  neutralSummary: z.string().max(220),
  rationaleAndPremises: z.string().max(400),
});
export type CanonicalOption = z.infer<typeof CanonicalOptionSchema>;

export const EvaluatedAlternativeSchema = z.object({
  optionKey: z.string(),
  neutralSummary: z.string(),
  rationaleAndPremises: z.string(),
  normalizedProbability: z.number().min(0).max(1).optional(),
});
export type EvaluatedAlternative = z.infer<typeof EvaluatedAlternativeSchema>;

export const SearchEvidenceItemSchema = z.object({
  fileId: z.string().min(1),
  headingSlug: z.string().min(1),
  breadcrumb: z.array(z.string()),
  textExcerpt: z.string(),
  vaultRef: z.string().optional(),
});
export type SearchEvidenceItem = z.infer<typeof SearchEvidenceItemSchema>;

export const SearchReportSchema = z.object({
  evidenceItems: z.array(SearchEvidenceItemSchema),
  inspectedPaths: z.array(z.string()),
  summary: z.string(),
});
export type SearchReport = z.infer<typeof SearchReportSchema>;

export const RelationalLinkTypeEnum = z.enum([
  "INDEPENDENT",
  "DEPENDS_ON",
  "REOPENS_OR_OVERRIDES",
  "REFINES",
]);
export type RelationalLinkType = z.infer<typeof RelationalLinkTypeEnum>;

export const RelationalLinkPairInputSchema = z.object({
  assumptionId: z.string(),
  candidateDecisionId: z.string(),
  assumptionStatement: z.string(),
  candidatePrompt: z.string(),
  candidateSelectedOption: z.string(),
  sharedConceptTags: z.array(z.string()).default([]),
});
export type RelationalLinkPairInput = z.infer<typeof RelationalLinkPairInputSchema>;

export const RelationalAdjudicationItemSchema = z.object({
  assumptionId: z.string(),
  targetDecisionId: z.string(),
  relationType: RelationalLinkTypeEnum,
  confidence: z.number().min(0).max(1),
  justification: z.string().max(300),
});
export type RelationalAdjudicationItem = z.infer<typeof RelationalAdjudicationItemSchema>;

export const RelationalAdjudicationBatchSchema = z.object({
  relations: z.array(RelationalAdjudicationItemSchema),
});
export type RelationalAdjudicationBatch = z.infer<typeof RelationalAdjudicationBatchSchema>;

export const ClarificationQuestionItemSchema = z.object({
  questionId: z.string(),
  topicSlug: z.string(),
  questionPrompt: z.string(),
  options: z.array(CanonicalOptionSchema).min(2).max(4),
  contextExplanation: z.string().max(400).optional(),
});
export type ClarificationQuestionItem = z.infer<typeof ClarificationQuestionItemSchema>;

export const QuestionQueueSchema = z.object({
  questions: z.array(ClarificationQuestionItemSchema).min(1).max(5),
});
export type QuestionQueue = z.infer<typeof QuestionQueueSchema>;

export const ClarificationResponseSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string(),
      selectedOptionKey: z.string(),
      customNotes: z.string().max(500).optional(),
    })
  ),
});
export type ClarificationResponse = z.infer<typeof ClarificationResponseSchema>;

// ---------------------------------------------------------------------------
// 3. Dynamic Schema Factories
// ---------------------------------------------------------------------------

/**
 * Creates a dynamic Zod enum constrained strictly to the active concept tags.
 */
export function createConceptTagEnum(activeTags?: readonly string[]) {
  if (activeTags !== undefined) {
    const deduplicated = Array.from(new Set(activeTags));
    if (deduplicated.length === 0) {
      throw new EmptyProjectTaxonomyError();
    }
    return z.enum(deduplicated as [string, ...string[]]);
  }
  return z.enum(resolveProjectConceptTags());
}

/**
 * Creates a DecisionEvaluationItem schema bounded by the active concept tags.
 */
export function createDecisionEvaluationItemSchema(activeTags?: readonly string[]) {
  const TagEnum = createConceptTagEnum(activeTags);
  return z.object({
    decisionId: z.string(),
    topicSlug: z.string().regex(/^[a-z0-9_]+$/),
    questionPrompt: z.string(),
    conceptTags: z.array(TagEnum).min(1).max(6),
    options: z.array(CanonicalOptionSchema).min(3).max(4),
    priorDecisionContext: z
      .object({
        reopenedFromDecisionId: z.string().optional(),
        previousSelectedOptionKey: z.string().optional(),
        previousSelectionRationale: z.string().optional(),
        triggerForReevaluation: z.string().optional(),
      })
      .optional(),
    dependsOnDecisionIds: z.array(z.string()).default([]),
    affectedSections: z.array(SectionTargetSchema).default([]),
  });
}

/**
 * Creates a CanonicalDecisionBatch schema bounded by the active concept tags.
 */
export function createCanonicalDecisionBatchSchema(activeTags?: readonly string[]) {
  const itemSchema = createDecisionEvaluationItemSchema(activeTags);
  return z.object({
    items: z.array(itemSchema).min(1).max(12),
  });
}

/**
 * Creates an AssumptionItem schema bounded by the active concept tags.
 */
export function createAssumptionItemSchema(activeTags?: readonly string[]) {
  const TagEnum = createConceptTagEnum(activeTags);
  return z.object({
    assumptionId: z.string(),
    statement: z.string(),
    assumptionStatement: z.string().optional(),
    conceptTags: z.array(TagEnum).min(1).max(6),
    affectedSections: z.array(SectionTargetSchema).default([]),
    dependsOn: z.array(z.string()).default([]),
  });
}

/**
 * Creates an AssumptionExtractionBatch schema bounded by the active concept tags.
 */
export function createAssumptionExtractionBatchSchema(activeTags?: readonly string[]) {
  const itemSchema = createAssumptionItemSchema(activeTags);
  return z.object({
    assumptions: z.array(itemSchema),
  });
}

// ---------------------------------------------------------------------------
// 4. Pre-instantiated Default Schemas
// ---------------------------------------------------------------------------

export const ConceptTagEnum = createConceptTagEnum(DEFAULT_CONCEPT_TAGS);
export type ConceptTagEnumType = z.infer<typeof ConceptTagEnum>;

export const DecisionEvaluationItemSchema =
  createDecisionEvaluationItemSchema(DEFAULT_CONCEPT_TAGS);
export type DecisionEvaluationItem = z.infer<typeof DecisionEvaluationItemSchema>;

export const CanonicalDecisionBatchSchema =
  createCanonicalDecisionBatchSchema(DEFAULT_CONCEPT_TAGS);
export type CanonicalDecisionBatch = z.infer<typeof CanonicalDecisionBatchSchema>;

export const AssumptionItemSchema =
  createAssumptionItemSchema(DEFAULT_CONCEPT_TAGS);
export type AssumptionItem = z.infer<typeof AssumptionItemSchema>;

export const AssumptionExtractionBatchSchema =
  createAssumptionExtractionBatchSchema(DEFAULT_CONCEPT_TAGS);
export type AssumptionExtractionBatch = z.infer<typeof AssumptionExtractionBatchSchema>;
