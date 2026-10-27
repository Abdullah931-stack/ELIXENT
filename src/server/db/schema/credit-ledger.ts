import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const executionModeEnum = pgEnum("ai_execution_mode", [
  "SINGLE_PASS_DECISION",
  "DISCRETE_THINKING",
  "STREAMING_GENERATIVE",
  "CREDIT_TOPUP",
]);

export const ledgerSettlementStatusEnum = pgEnum("ledger_settlement_status", [
  "SETTLED",
  "ABORTED",
  "TOPUP_APPLIED",
]);

export const creditLedgerTransactions = pgTable(
  "credit_ledger_transactions",
  {
    operationId: text("operation_id").primaryKey(), // StepKey or Stripe top-up ID for idempotency (Idempotency PK)
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
    nodeName: text("node_name"),
    modelId: text("model_id").notNull(),
    executionMode: executionModeEnum("execution_mode").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    deltaMicro: bigint("delta_micro", { mode: "bigint" }).notNull(), // Negative for debit, positive for credit top-up
    status: ledgerSettlementStatusEnum("status").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_credit_ledger_user_created").on(table.userId, table.createdAt),
    index("idx_credit_ledger_thread").on(table.threadId),
  ],
);

export type CreditLedgerTransaction =
  typeof creditLedgerTransactions.$inferSelect;
export type NewCreditLedgerTransaction =
  typeof creditLedgerTransactions.$inferInsert;
