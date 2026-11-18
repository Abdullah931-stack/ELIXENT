import {
    pgTable,
    text,
    integer,
    uuid,
    timestamp,
    customType,
    primaryKey,
    index,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { workspaces } from "./workspaces";

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
    dataType() {
        return "bytea";
    },
});

export const agentCheckpoints = pgTable(
    "agent_checkpoints",
    {
        threadId: text("thread_id").notNull(),
        stepIndex: integer("step_index").notNull(),
        workspaceId: uuid("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "cascade" }),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        nodeId: text("node_id").notNull(),
        status: text("status")
            .$type<"RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED">()
            .notNull(),
        nextNodeId: text("next_node_id"),
        interruptReason: text("interrupt_reason").$type<
            | "HITL_CLARIFICATION_REQUIRED"
            | "FILE_DELETION_APPROVAL_REQUIRED"
            | "ANTI_DOMINO_CONFIRMATION_REQUIRED"
            | "INSUFFICIENT_CREDITS"
            | null
        >(),
        encryptedStateBlob: bytea("encrypted_state_blob").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.threadId, table.stepIndex] }),
        index("idx_agent_checkpoints_workspace_thread").on(
            table.workspaceId,
            table.threadId,
        ),
    ],
);

export type AgentCheckpoint = typeof agentCheckpoints.$inferSelect;
export type NewAgentCheckpoint = typeof agentCheckpoints.$inferInsert;
