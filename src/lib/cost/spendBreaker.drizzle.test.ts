import { describe, expect, test } from "bun:test";

import { createDrizzleSpendBreaker } from "./spendBreaker.drizzle";

/**
 * A fake of the narrow Drizzle surface the breaker uses, capturing every insert
 * so the recorded amount can be asserted without a database
 */
const fakeDb = () => {
  const inserted: { day: string; spentCents: number }[] = [];
  const db = {
    insert: () => ({
      values: (row: { day: string; spentCents: number }) => {
        inserted.push(row);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
    select: () => ({
      from: () => ({ where: async () => [] }),
    }),
  };
  return {
    db: db as unknown as Parameters<typeof createDrizzleSpendBreaker>[0],
    inserted,
  };
};

describe("createDrizzleSpendBreaker record", () => {
  test("records whole cents, rounding fractional spend up", async () => {
    const { db, inserted } = fakeDb();
    const breaker = createDrizzleSpendBreaker(db, 100);

    await breaker.record(1.4);
    await breaker.record(0.0001);
    await breaker.record(3);

    expect(inserted.map((r) => r.spentCents)).toEqual([2, 1, 3]);
    expect(inserted.every((r) => Number.isInteger(r.spentCents))).toBe(true);
  });

  test("writes nothing for non-positive spend", async () => {
    const { db, inserted } = fakeDb();
    const breaker = createDrizzleSpendBreaker(db, 100);

    await breaker.record(0);
    await breaker.record(-2);

    expect(inserted).toEqual([]);
  });
});
