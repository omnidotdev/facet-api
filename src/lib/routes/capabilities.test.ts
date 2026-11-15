import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createCapabilitiesRoute } from "./capabilities";

type Billing = Parameters<typeof createCapabilitiesRoute>[0]["billing"];
type Store = NonNullable<
  Parameters<typeof createCapabilitiesRoute>[0]["store"]
>;

/** An Aether stub serving a fixed retail-USD balance and recording lookups */
const makeBilling = (balance: number | null = 1.2345) => {
  const calls: unknown[][] = [];
  const billing: Billing = {
    async getCreditBalance(...args) {
      calls.push(args);
      return balance === null ? null : { billingAccountId: "acct-1", balance };
    },
  };
  return { billing, calls };
};

/** A consent store stub serving a fixed opt-in state. */
const makeStore = (consent: boolean): Store => ({
  async getConsent() {
    return consent;
  },
});

const probe = (
  authenticate: (r: Request) => Promise<{ userId: string } | null>,
  billing: Billing = makeBilling().billing,
  tier = "free",
  store?: Store,
) =>
  createCapabilitiesRoute({
    authenticate,
    billing,
    resolveTier: async () => tier,
    store,
  }).handle(new Request("http://local/capabilities"));

const signedInAs = (userId: string) => async () => ({ userId });
const signedOut = async () => null;

describe("/capabilities", () => {
  const KEYS = [
    "SYNAPSE_API_URL",
    "SYNAPSE_GATEWAY_SECRET",
    "FACET_MANAGED_ALLOWLIST",
  ] as const;
  let snapshot: Record<string, string | undefined> = {};

  // Restore a key to its prior value, deleting it when it had none. Assigning
  // `process.env.X = undefined` would write the literal string "undefined",
  // which leaks a truthy value into the next test file (a non-empty allowlist)
  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
    process.env.SYNAPSE_API_URL = "https://api.synapse.test";
    process.env.SYNAPSE_GATEWAY_SECRET = "gw-secret";
    process.env.FACET_MANAGED_ALLOWLIST = "user-1";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  test("reports the pooled balance in whole credits and the tier for a managed user", async () => {
    const { billing, calls } = makeBilling(1.2345);
    const body = await (
      await probe(signedInAs("user-1"), billing, "pro")
    ).json();
    // $1.2345 retail is 123.45 credits, floored so the display never overstates.
    // Consent defaults off when no store is wired (the probe omits one here)
    expect(body).toEqual({
      signedIn: true,
      managedGeneration: true,
      tier: "pro",
      aiTrainingConsent: false,
      credits: { balance: 123 },
    });
    // the balance is the user's own pool (Facet bills the user personally)
    expect(calls).toEqual([["user", "user-1"]]);
  });

  test("rounds a sub-credit balance down and an overdrawn balance toward the debt", async () => {
    const tiny = await (
      await probe(signedInAs("user-1"), makeBilling(0.0099).billing)
    ).json();
    expect(tiny.credits).toEqual({ balance: 0 });

    const overdrawn = await (
      await probe(signedInAs("user-1"), makeBilling(-0.015).billing)
    ).json();
    expect(overdrawn.credits).toEqual({ balance: -2 });
  });

  test("an unknown balance (no account, or Aether down) omits it", async () => {
    const body = await (
      await probe(signedInAs("user-1"), makeBilling(null).billing)
    ).json();
    expect(body.managedGeneration).toBe(true);
    expect(body.credits).toBeUndefined();
  });

  test("a balance lookup failure omits the balance but still reports the capability", async () => {
    const failing: Billing = {
      async getCreditBalance() {
        throw new Error("aether down");
      },
    };
    const body = await (await probe(signedInAs("user-1"), failing)).json();
    expect(body.managedGeneration).toBe(true);
    expect(body.credits).toBeUndefined();
  });

  test("managed false for a signed-in user not on the allowlist (no balance)", async () => {
    const { billing, calls } = makeBilling();
    const body = await (await probe(signedInAs("stranger"), billing)).json();
    expect(body).toEqual({ signedIn: true, managedGeneration: false });
    expect(calls).toHaveLength(0);
  });

  test("reports the user's AI-training consent from the store", async () => {
    const body = await (
      await probe(
        signedInAs("user-1"),
        makeBilling().billing,
        "pro",
        makeStore(true),
      )
    ).json();
    expect(body.aiTrainingConsent).toBe(true);
  });

  test("a consent lookup failure defaults to off, never blocking the probe", async () => {
    const failing: Store = {
      async getConsent() {
        throw new Error("db down");
      },
    };
    const body = await (
      await probe(signedInAs("user-1"), makeBilling().billing, "free", failing)
    ).json();
    expect(body.managedGeneration).toBe(true);
    expect(body.aiTrainingConsent).toBe(false);
  });

  test("managed false when signed out", async () => {
    const body = await (await probe(signedOut)).json();
    expect(body).toEqual({ signedIn: false, managedGeneration: false });
  });

  test("an empty allowlist is open to any signed-in user", async () => {
    process.env.FACET_MANAGED_ALLOWLIST = "";
    const body = await (await probe(signedInAs("anyone"))).json();
    expect(body.managedGeneration).toBe(true);
    expect(body.credits.balance).toBe(123);
  });

  test("managed false when provisioning is not configured", async () => {
    delete process.env.SYNAPSE_GATEWAY_SECRET;
    const body = await (await probe(signedInAs("user-1"))).json();
    expect(body.managedGeneration).toBe(false);
  });
});
