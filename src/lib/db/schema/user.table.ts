import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { generateDefaultDate, generateDefaultId } from "lib/db/util";

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

/**
 * User table.
 */
export const userTable = pgTable(
  "user",
  {
    id: generateDefaultId(),
    // external ID used by identity provider
    identityProviderId: uuid().notNull().unique(),
    // opt-in consent to retain this user's prompts and generated models as AI
    // training/eval data. Default false: nothing is stored until the user turns
    // it on, and withdrawing it deletes their samples (see the /consent route)
    aiTrainingConsent: boolean().notNull().default(false),
    // when the current consent state was last set (granted or withdrawn), the
    // authoritative timestamp for "demonstrate consent" (GDPR Art. 7). The full
    // grant/withdraw history is the append-only `facet.user.consent_changed`
    // event stream; this row is the current state
    aiTrainingConsentAt: timestamp({
      precision: 6,
      mode: "string",
      withTimezone: true,
    }),
    // the version of the consent terms the user last acted under, so a later
    // material change to what is collected can require fresh consent rather than
    // silently relying on the old grant. Null until the user has ever acted
    aiTrainingConsentVersion: text(),
    createdAt: generateDefaultDate(),
    updatedAt: generateDefaultDate(),
  },
  (table) => [
    uniqueIndex().on(table.id),
    uniqueIndex().on(table.identityProviderId),
  ],
);

export type InsertUser = InferInsertModel<typeof userTable>;
export type SelectUser = InferSelectModel<typeof userTable>;
