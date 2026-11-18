import {
    pgTable,
    uuid,
    varchar,
    text,
    boolean,
    timestamp,
    uniqueIndex,
    index,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const workspaces = pgTable(
    "workspaces",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        name: varchar("name", { length: 255 }).notNull(),
        description: text("description"),
        isEncrypted: boolean("is_encrypted").notNull().default(false),
        defaultPermissionMode: varchar("default_permission_mode", { length: 32 })
            .$type<"safe" | "semi_auto" | "full_auto">()
            .notNull()
            .default("safe"),
        createdAt: timestamp("created_at").notNull().defaultNow(),
        updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("idx_workspaces_user_name").on(table.userId, table.name),
        index("idx_workspaces_user_updated").on(table.userId, table.updatedAt),
    ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
