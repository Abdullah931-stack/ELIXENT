import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export interface EvaluatedAlternativeRecord {
  optionKey: string;
  neutralSummary: string;
  rationaleAndPremises: string;
  normalizedProbability?: number;
}

export const projectDecisionLedger = pgTable(
  "project_decision_ledger",
  {
    projectId: text("project_id").notNull(),
    decisionId: text("decision_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    topicSlug: text("topic_slug").notNull(),
    questionPrompt: text("question_prompt").notNull(),
    conceptTags: jsonb("concept_tags").$type<string[]>().notNull().default([]),
    selectedOptionKey: text("selected_option_key").notNull(),
    selectionRationale: text("selection_rationale").notNull(),
    runnerUpOptionKey: text("runner_up_option_key"),
    evaluatedAlternatives: jsonb("evaluated_alternatives")
      .$type<EvaluatedAlternativeRecord[]>()
      .notNull()
      .default([]),
    status: text("status")
      .$type<"APPROVED_DIRECT" | "APPROVED_CONSERVATIVE">()
      .notNull(),
    impactTier: text("impact_tier")
      .$type<"CORE_ARCHITECTURAL" | "PERIPHERAL">()
      .notNull(),
    isLoadBearing: boolean("is_load_bearing").notNull().default(false),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    dependedBy: jsonb("depended_by").$type<string[]>().notNull().default([]),
    affectedSections: jsonb("affected_sections")
      .$type<Array<{ fileId: string; headingSlug: string }>>()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.decisionId] }),
    index("idx_project_decision_user_project").on(
      table.userId,
      table.projectId,
    ),
  ],
);

export type ProjectDecisionLedgerRow =
  typeof projectDecisionLedger.$inferSelect;
export type NewProjectDecisionLedgerRow =
  typeof projectDecisionLedger.$inferInsert;
