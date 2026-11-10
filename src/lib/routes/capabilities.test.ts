import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createCapabilitiesRoute } from "./capabilities";

import type { CreditStore } from "lib/cost/creditStore";

const makeCreditStore = (usedCredits = 10, capCredits = 100): CreditStore => ({
  async getMonthlyUsage() {
    return { usedCredits, capCredits };
  },
  async recordSpend() {},
});

const probe = (
  authenticate: (r: Request) => Promise<{ userId: string } | null>,
  creditStore: CreditStore = makeCreditStore(),
) =>
  createCapabilitiesRoute({ authenticate, creditStore }).handle(
    new Request("http://local/capabilities"),
  );

const signedInAs = (userId: string) => async () => ({ userId });
const signedOut = async () => null;

describe("/capabilities", () => {
  const prevKey = process.env.SYNAPSE_API_KEY;
  const prevList = process.env.FACET_MANAGED_ALLOWLIST;

  // Restore a key to its prior value, deleting it when it had none. Assigning
  // `process.env.X = undefined` would write the literal string "undefined",
  // which leaks a truthy value into the next test file (a non-empty allowlist)
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => {
    process.env.SYNAPSE_API_KEY = "server-key";
    process.env.FACET_MANAGED_ALLOWLIST = "user-1";
  });
  afterEach(() => {
    restore("SYNAPSE_API_KEY", prevKey);
    restore("FACET_MANAGED_ALLOWLIST", prevList);
  });

  test("managed true (with credit balance) for an allowlisted signed-in user", async () => {
    const body = await (
      await probe(signedInAs("user-1"), makeCreditStore(10, 100))
    ).json();
    expect(body).toEqual({
      signedIn: true,
      managedGeneration: true,
      credits: { used: 10, cap: 100, remaining: 90 },
    });
  });

  test("managed false for a signed-in user not on the allowlist (no balance)", async () => {
    const body = await (await probe(signedInAs("stranger"))).json();
    expect(body).toEqual({ signedIn: true, managedGeneration: false });
  });

  test("managed false when signed out", async () => {
    const body = await (await probe(signedOut)).json();
    expect(body).toEqual({ signedIn: false, managedGeneration: false });
  });

  test("an empty allowlist is open to any signed-in user", async () => {
    process.env.FACET_MANAGED_ALLOWLIST = "";
    const body = await (await probe(signedInAs("anyone"))).json();
    expect(body.managedGeneration).toBe(true);
    expect(body.credits.remaining).toBe(90);
  });

  test("managed false when no server key is configured", async () => {
    process.env.SYNAPSE_API_KEY = "";
    const body = await (await probe(signedInAs("user-1"))).json();
    expect(body.managedGeneration).toBe(false);
  });

  test("remaining never goes negative when usage exceeds the cap", async () => {
    const body = await (
      await probe(signedInAs("user-1"), makeCreditStore(120, 100))
    ).json();
    expect(body.credits).toEqual({ used: 120, cap: 100, remaining: 0 });
  });

  test("a meter failure omits the balance but still reports the capability", async () => {
    const failing: CreditStore = {
      async getMonthlyUsage() {
        throw new Error("db down");
      },
      async recordSpend() {},
    };
    const body = await (await probe(signedInAs("user-1"), failing)).json();
    expect(body.managedGeneration).toBe(true);
    expect(body.credits).toBeUndefined();
  });
});
