import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { generateDefaultDate, generateDefaultId } from "lib/db/util";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

/**
 * Workspace table.
 *
 * Carried from the Elysia template scaffolding (migration 0001). The schema
 * definition was dropped during Phase A de-templating while the migration and
 * snapshot kept the table, leaving the generated state and the schema out of
 * sync. Restored here so `db:generate` diffs against the real table instead of
 * planning a destructive drop. It is unused by the AI gateway
 */
export const workspaceTable = pgTable(
  "workspace",
  {
    id: generateDefaultId(),
    organizationId: text().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    createdAt: generateDefaultDate(),
    updatedAt: generateDefaultDate(),
    deletedAt: timestamp(),
    deletionReason: text(),
  },
  (table) => [
    uniqueIndex().on(table.id),
    uniqueIndex("workspace_org_slug_idx").on(table.organizationId, table.slug),
    index("workspace_org_idx").on(table.organizationId),
  ],
);

export type InsertWorkspace = InferInsertModel<typeof workspaceTable>;
export type SelectWorkspace = InferSelectModel<typeof workspaceTable>;
