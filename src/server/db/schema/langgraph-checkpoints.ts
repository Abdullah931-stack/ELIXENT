import {
  pgTable,
  text,
  integer,
  jsonb,
  customType,
  primaryKey,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const checkpointMigrations = pgTable("checkpoint_migrations", {
  v: integer("v").primaryKey(),
});

export const checkpoints = pgTable(
  "checkpoints",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    parentCheckpointId: text("parent_checkpoint_id"),
    type: text("type"),
    checkpoint: jsonb("checkpoint").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.checkpointNs, table.checkpointId],
    }),
  ],
);

export const checkpointBlobs = pgTable(
  "checkpoint_blobs",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    channel: text("channel").notNull(),
    version: text("version").notNull(),
    type: text("type").notNull(),
    blob: bytea("blob"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.threadId,
        table.checkpointNs,
        table.channel,
        table.version,
      ],
    }),
  ],
);

export const checkpointWrites = pgTable(
  "checkpoint_writes",
  {
    threadId: text("thread_id").notNull(),
    checkpointNs: text("checkpoint_ns").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    taskId: text("task_id").notNull(),
    idx: integer("idx").notNull(),
    channel: text("channel").notNull(),
    type: text("type"),
    blob: bytea("blob").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.threadId,
        table.checkpointNs,
        table.checkpointId,
        table.taskId,
        table.idx,
      ],
    }),
  ],
);
