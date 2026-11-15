import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { generateDefaultDate, generateDefaultId } from "lib/db/util";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

/**
 * Generation sample: consented AI training/eval data.
 *
 * One row per generation chain, written ONLY when the signed-in user has opted
 * in to AI training data (`user.aiTrainingConsent`). It holds the one datum
 * usage telemetry deliberately never carries: the user's prompt and the model's
 * final code. Everything else about a generation (model, token usage, critique
 * score, disposition) already travels as correlated CloudEvents and is joined
 * downstream by `generationId`, so this table stays narrow on purpose.
 *
 * Keyed by `generationId` (upsert, last write wins), so a refine or repair
 * re-entry overwrites the draft with the final code of the same chain rather
 * than stacking rows. Every row for a user is deleted when they withdraw
 * consent (see the `/consent` route), so the store never outlives the
 * permission it rests on
 */
export const generationSampleTable = pgTable(
  "generation_sample",
  {
    id: generateDefaultId(),
    // correlation id shared with the generation's CloudEvents, so the critique
    // and disposition for this chain join to this prompt/code pair downstream
    generationId: text().notNull().unique(),
    // the opted-in user, by identity-provider subject (the id auth resolves)
    identityProviderId: uuid().notNull(),
    // the eval pair: the user's request and the model's final generated code
    prompt: text().notNull(),
    code: text().notNull(),
    // the model that produced the code, for per-model eval slicing
    model: text(),
    createdAt: generateDefaultDate(),
    updatedAt: generateDefaultDate(),
  },
  (table) => [index().on(table.identityProviderId)],
);

export type InsertGenerationSample = InferInsertModel<
  typeof generationSampleTable
>;
export type SelectGenerationSample = InferSelectModel<
  typeof generationSampleTable
>;
