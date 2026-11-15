import { describe, expect, test } from "bun:test";

import { generationSampleTable, userTable } from "lib/db/schema";
import { AI_TRAINING_CONSENT_VERSION, createSampleStore } from "./sampleStore";

type Db = Parameters<typeof createSampleStore>[0];

interface RecordedInsert {
  table: unknown;
  values: Record<string, unknown>;
  set?: Record<string, unknown>;
}

interface FakeOptions {
  /** The user row the fake returns from a select (none when omitted). */
  userRow?: { consent: boolean; version: string | null };
}

/**
 * A minimal chainable Drizzle fake that records writes and serves one fixed
 * select result, so the store's consent gating and erase-on-withdrawal can be
 * asserted without a live database. It deliberately ignores the column
 * projection: the test fixes the row shape via `userRow`
 */
const makeDb = (opts: FakeOptions = {}) => {
  const inserts: RecordedInsert[] = [];
  const deletes: { table: unknown }[] = [];
  const selectResult = opts.userRow ? [opts.userRow] : [];

  const db = {
    select: () => ({ from: () => ({ where: async () => selectResult }) }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (cfg: { set?: Record<string, unknown> }) => {
          inserts.push({ table, values, set: cfg?.set });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        deletes.push({ table });
      },
    }),
  } as unknown as Db;

  return { db, inserts, deletes };
};

describe("createSampleStore", () => {
  describe("capture", () => {
    test("stores the prompt and code for a user who opted in under the current terms", async () => {
      const { db, inserts } = makeDb({
        userRow: { consent: true, version: AI_TRAINING_CONSENT_VERSION },
      });

      await createSampleStore(db).capture({
        generationId: "gen-1",
        userId: "user-1",
        prompt: "a 10mm cube",
        code: "const part = cube(10);",
        model: "test-model",
      });

      expect(inserts).toHaveLength(1);
      expect(inserts[0]?.table).toBe(generationSampleTable);
      expect(inserts[0]?.values).toMatchObject({
        generationId: "gen-1",
        identityProviderId: "user-1",
        prompt: "a 10mm cube",
        code: "const part = cube(10);",
        model: "test-model",
      });
    });

    test("stores nothing when the user has not opted in", async () => {
      const { db, inserts } = makeDb({
        userRow: { consent: false, version: AI_TRAINING_CONSENT_VERSION },
      });

      await createSampleStore(db).capture({
        generationId: "gen-1",
        userId: "user-1",
        prompt: "secret prompt",
        code: "secret code",
      });

      expect(inserts).toHaveLength(0);
    });

    test("stores nothing when the user has no record at all", async () => {
      const { db, inserts } = makeDb();

      await createSampleStore(db).capture({
        generationId: "gen-1",
        userId: "user-1",
        prompt: "secret prompt",
        code: "secret code",
      });

      expect(inserts).toHaveLength(0);
    });

    test("stores nothing for consent granted under stale terms (version mismatch)", async () => {
      const { db, inserts } = makeDb({
        userRow: { consent: true, version: "1999-01-01" },
      });

      await createSampleStore(db).capture({
        generationId: "gen-1",
        userId: "user-1",
        prompt: "secret prompt",
        code: "secret code",
      });

      expect(inserts).toHaveLength(0);
    });
  });

  describe("setConsent", () => {
    test("a grant writes the flag, timestamp, and current terms version, deleting nothing", async () => {
      const { db, inserts, deletes } = makeDb();

      await createSampleStore(db).setConsent("user-1", true);

      expect(inserts).toHaveLength(1);
      expect(inserts[0]?.table).toBe(userTable);
      expect(inserts[0]?.values).toMatchObject({
        identityProviderId: "user-1",
        aiTrainingConsent: true,
        aiTrainingConsentVersion: AI_TRAINING_CONSENT_VERSION,
      });
      expect(inserts[0]?.values.aiTrainingConsentAt).toBeTruthy();
      // the upsert path (existing user) carries the same state
      expect(inserts[0]?.set).toMatchObject({
        aiTrainingConsent: true,
        aiTrainingConsentVersion: AI_TRAINING_CONSENT_VERSION,
      });
      expect(deletes).toHaveLength(0);
    });

    test("a withdrawal writes consent off and erases the user's stored samples", async () => {
      const { db, inserts, deletes } = makeDb();

      await createSampleStore(db).setConsent("user-1", false);

      expect(inserts[0]?.values).toMatchObject({ aiTrainingConsent: false });
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.table).toBe(generationSampleTable);
    });
  });

  describe("getConsent", () => {
    test("returns the stored consent flag", async () => {
      const { db } = makeDb({
        userRow: { consent: true, version: AI_TRAINING_CONSENT_VERSION },
      });

      expect(await createSampleStore(db).getConsent("user-1")).toBe(true);
    });

    test("defaults to false when the user has never opted in", async () => {
      const { db } = makeDb();

      expect(await createSampleStore(db).getConsent("user-1")).toBe(false);
    });
  });
});
