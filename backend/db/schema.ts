import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  ContentPart,
  MessageRole,
  MessageStatus,
  ProviderId,
} from "../../shared/types";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
});

export const canvases = sqliteTable(
  "canvases",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // Circular reference with nodes.canvasId; no FK constraint here, enforced in app.
    seedNodeId: text("seed_node_id").notNull(),
    defaultProvider: text("default_provider").$type<ProviderId>().notNull(),
    defaultModel: text("default_model").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => ({
    userIdx: index("canvases_user_idx").on(table.userId),
  }),
);

export const nodes = sqliteTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    providerOverride: text("provider_override").$type<ProviderId>(),
    modelOverride: text("model_override"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => ({
    canvasIdx: index("nodes_canvas_idx").on(table.canvasId),
  }),
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    role: text("role").$type<MessageRole>().notNull(),
    content: text("content", { mode: "json" })
      .$type<ContentPart[]>()
      .notNull(),
    provider: text("provider").$type<ProviderId>(),
    model: text("model"),
    orderIndex: integer("order_index").notNull(),
    status: text("status").$type<MessageStatus>().notNull(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => ({
    nodeOrderIdx: uniqueIndex("messages_node_order_idx").on(
      table.nodeId,
      table.orderIndex,
    ),
  }),
);

export const edges = sqliteTable(
  "edges",
  {
    id: text("id").primaryKey(),
    sourceNodeId: text("source_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    sourceMessageId: text("source_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    // One inbound edge per node (v1 tree constraint).
    targetNodeId: text("target_node_id")
      .notNull()
      .unique()
      .references(() => nodes.id, { onDelete: "cascade" }),
    citationStart: integer("citation_start").notNull(),
    citationEnd: integer("citation_end").notNull(),
    citationText: text("citation_text").notNull(),
    kind: text("kind").notNull().default("spawn"),
    createdAt: text("created_at").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => ({
    sourceNodeIdx: index("edges_source_node_idx").on(table.sourceNodeId),
    sourceMessageIdx: index("edges_source_message_idx").on(table.sourceMessageId),
  }),
);

export const providerConfigs = sqliteTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ProviderId>().notNull(),
    apiKey: text("api_key").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    userProviderIdx: uniqueIndex("provider_configs_user_provider_idx").on(
      table.userId,
      table.provider,
    ),
  }),
);

export type User = typeof users.$inferSelect;
