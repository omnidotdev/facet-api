import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { generateDefaultDate, generateDefaultId } from "lib/db/util";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

/** What a job asks the model for: a first draft, a kernel-error repair, or a render-critic refine */
export const GENERATION_JOB_KINDS = ["draft", "repair", "refine"] as const;
export type GenerationJobKind = (typeof GENERATION_JOB_KINDS)[number];

/** Where a job is in its life: waiting, in flight, or finished either way */
export const GENERATION_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number];

/** A timestamp column without a default, for the lifecycle moments */
const lifecycleDate = () =>
  timestamp({ precision: 6, mode: "string", withTimezone: true });

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * Generation job: one managed AI generation run in the background, so it keeps
 * going (and its result waits) when the user closes the panel or leaves the page.
 *
 * Holds the user's prompt, the follow-up context a repair or refine needs, and
 * the result code, only for as long as the user needs them: a row is deleted
 * when the user dismisses it or at `expiresAt` (24 hours after it was queued),
 * whichever comes first, so this is never a second copy of anyone's data. It is
 * NOT the consented training dataset (`generation_sample`). Never holds a key:
 * BYOK stays on the synchronous `/generate` route, and the managed key is
 * provisioned again by the worker when the job runs.
 *
 * Status and kind are plain text checked by constraint (no pgEnum), and the
 * error carries only the stable code, the user-safe message, and the HTTP
 * status the synchronous route would have answered with
 */
export const generationJobTable = pgTable(
  "generation_job",
  {
    id: generateDefaultId(),
    // the requester, by identity-provider subject (the id auth resolves)
    userId: text().notNull(),
    // the personal workspace billed for the call
    workspaceId: text().notNull(),
    // correlation id shared with the generation's CloudEvents and samples
    generationId: text().notNull(),
    kind: text().$type<GenerationJobKind>().notNull(),
    status: text().$type<GenerationJobStatus>().notNull().default("queued"),
    prompt: text().notNull(),
    // follow-up context: the prior code for a repair or refine, plus the
    // kernel error (repair) or the critic's suggestion (refine)
    priorCode: text(),
    priorError: text(),
    suggestion: text(),
    // repair attempt counter, bounded at enqueue like the synchronous route
    attempt: integer().notNull().default(0),
    // whether the workspace was a paying customer at enqueue; only a
    // non-paying run is recorded against the free-tier spend breaker
    isPayingCustomer: boolean().notNull(),
    // the generated code, set only on success
    resultCode: text(),
    // stable error code, user-safe message, and HTTP status on failure
    errorCode: text(),
    errorMessage: text(),
    errorStatus: integer(),
    // the worker process that claimed the job and its liveness beat, so a
    // replica only ever finishes its own jobs and a dead one's are detected
    workerId: text(),
    heartbeatAt: lifecycleDate(),
    startedAt: lifecycleDate(),
    finishedAt: lifecycleDate(),
    // when the row (prompt and code included) is deleted at the latest
    expiresAt: lifecycleDate().notNull(),
    createdAt: generateDefaultDate(),
    updatedAt: generateDefaultDate(),
  },
  (table) => [
    index().on(table.userId, table.createdAt),
    index().on(table.status, table.createdAt),
    index().on(table.expiresAt),
    check(
      "generation_job_kind_check",
      sql`${table.kind} in (${inList(GENERATION_JOB_KINDS)})`,
    ),
    check(
      "generation_job_status_check",
      sql`${table.status} in (${inList(GENERATION_JOB_STATUSES)})`,
    ),
  ],
);

export type InsertGenerationJob = InferInsertModel<typeof generationJobTable>;
export type SelectGenerationJob = InferSelectModel<typeof generationJobTable>;
