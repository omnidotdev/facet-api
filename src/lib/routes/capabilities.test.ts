import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createCapabilitiesRoute } from "./capabilities";

import type { WorkspaceFunding } from "lib/billing/facetBilling";

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

type Authenticate = Parameters<
  typeof createCapabilitiesRoute
>[0]["authenticate"];

/** A free-tier workspace that has bought credits (the default probed user) */
const FUNDED: WorkspaceFunding = {
  billingAccountId: "acct-1",
  paidCreditsUsd: 10,
  isPayingCustomer: true,
  cardVerified: false,
};

/** A free-tier workspace that never paid */
const NOT_FUNDED: WorkspaceFunding = {
  billingAccountId: null,
  paidCreditsUsd: 0,
  isPayingCustomer: false,
  cardVerified: false,
};

const probe = (
  authenticate: Authenticate,
  billing: Billing = makeBilling().billing,
  tier = "free",
  store?: Store,
  tierCalls: string[] = [],
  funding: WorkspaceFunding | Error = FUNDED,
  fundingCalls: string[] = [],
  cardOffer?: () => Promise<{ monthlyCredits: number } | null>,
) =>
  createCapabilitiesRoute({
    authenticate,
    billing,
    resolveTier: async (workspaceId) => {
      tierCalls.push(workspaceId);
      return tier;
    },
    resolveFunding: async (workspaceId) => {
      fundingCalls.push(workspaceId);
      if (funding instanceof Error) throw funding;
      return funding;
    },
    resolveCardOffer: cardOffer,
    store,
  }).handle(new Request("http://local/capabilities"));

/** A signed-in user whose personal workspace is `ws-<userId>` (slug `<userId>`) */
const signedInAs =
  (
    userId: string,
    personalWorkspace: { id: string; slug: string } | null = {
      id: `ws-${userId}`,
      slug: userId,
    },
  ): Authenticate =>
  async () => ({ userId, personalWorkspace });
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

  test("reports the personal workspace's pooled balance in whole credits, its tier, and its slug", async () => {
    const { billing, calls } = makeBilling(1.2345);
    const tierCalls: string[] = [];
    const body = await (
      await probe(signedInAs("user-1"), billing, "pro", undefined, tierCalls)
    ).json();
    // $1.2345 retail is 123.45 credits, floored so the display never overstates.
    // Consent defaults off when no store is wired (the probe omits one here)
    expect(body).toEqual({
      signedIn: true,
      managedGeneration: true,
      tier: "pro",
      aiTrainingConsent: false,
      workspace: { slug: "user-1" },
      credits: { balance: 123 },
    });
    // balance and tier are the personal workspace's (where a plan bought in the
    // account hub lives), never the user entity's
    expect(calls).toEqual([["organization", "ws-user-1"]]);
    expect(tierCalls).toEqual(["ws-user-1"]);
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

  test("a token without a personal workspace asks for re-auth (no balance, no workspace)", async () => {
    const { billing, calls } = makeBilling();
    const tierCalls: string[] = [];
    const body = await (
      await probe(
        signedInAs("user-1", null),
        billing,
        "pro",
        undefined,
        tierCalls,
      )
    ).json();
    expect(body).toEqual({
      signedIn: true,
      managedGeneration: false,
      reauthRequired: true,
    });
    expect(calls).toHaveLength(0);
    expect(tierCalls).toHaveLength(0);
  });

  test("no re-auth hint for a user off the whitelist, even without a workspace", async () => {
    const body = await (await probe(signedInAs("stranger", null))).json();
    expect(body).toEqual({ signedIn: true, managedGeneration: false });
  });

  test("consent stays per user, keyed on the user id", async () => {
    const seen: string[] = [];
    const store: Store = {
      async getConsent(userId) {
        seen.push(userId);
        return true;
      },
    };
    await probe(signedInAs("user-1"), makeBilling().billing, "free", store);
    expect(seen).toEqual(["user-1"]);
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
  describe("paying customers only", () => {
    test("a paid tier is eligible without a funding lookup", async () => {
      const fundingCalls: string[] = [];
      const body = await (
        await probe(
          signedInAs("user-1"),
          makeBilling().billing,
          "pro",
          undefined,
          [],
          NOT_FUNDED,
          fundingCalls,
        )
      ).json();
      expect(body.managedGeneration).toBe(true);
      expect(body.paymentRequired).toBeUndefined();
      expect(fundingCalls).toHaveLength(0);
    });

    test("a free workspace that bought credits is eligible", async () => {
      const fundingCalls: string[] = [];
      const body = await (
        await probe(
          signedInAs("user-1"),
          makeBilling(0.5).billing,
          "free",
          undefined,
          [],
          FUNDED,
          fundingCalls,
        )
      ).json();
      expect(body).toEqual({
        signedIn: true,
        managedGeneration: true,
        tier: "free",
        aiTrainingConsent: false,
        workspace: { slug: "user-1" },
        credits: { balance: 50 },
      });
      expect(fundingCalls).toEqual(["ws-user-1"]);
    });

    test("a free workspace with a verified card is eligible on the free allowance", async () => {
      const body = await (
        await probe(
          signedInAs("user-1"),
          makeBilling(0.5).billing,
          "free",
          undefined,
          [],
          {
            billingAccountId: "acct-1",
            paidCreditsUsd: 0,
            isPayingCustomer: false,
            cardVerified: true,
          },
        )
      ).json();
      expect(body).toEqual({
        signedIn: true,
        managedGeneration: true,
        tier: "free",
        freeAllowance: true,
        aiTrainingConsent: false,
        workspace: { slug: "user-1" },
        credits: { balance: 50 },
      });
    });

    test("a free, never-paid workspace is told payment is required, with its tier, slug, and balance", async () => {
      // a free grant may leave a balance, but it never unlocks managed AI
      const body = await (
        await probe(
          signedInAs("user-1"),
          makeBilling(0.25).billing,
          "free",
          makeStore(true),
          [],
          NOT_FUNDED,
        )
      ).json();
      expect(body).toEqual({
        signedIn: true,
        managedGeneration: false,
        paymentRequired: true,
        tier: "free",
        workspace: { slug: "user-1" },
        credits: { balance: 25 },
      });
    });

    test("a refused workspace is offered free AI credits while the offer is on", async () => {
      const body = await (
        await probe(
          signedInAs("user-1"),
          makeBilling(0).billing,
          "free",
          undefined,
          [],
          NOT_FUNDED,
          [],
          async () => ({ monthlyCredits: 50 }),
        )
      ).json();
      expect(body.paymentRequired).toBe(true);
      expect(body.cardOffer).toEqual({ monthlyCredits: 50 });
    });

    test("no card offer while it is off or the lookup fails", async () => {
      for (const cardOffer of [
        async () => null,
        async () => {
          throw new Error("aether down");
        },
      ]) {
        const body = await (
          await probe(
            signedInAs("user-1"),
            makeBilling(0).billing,
            "free",
            undefined,
            [],
            NOT_FUNDED,
            [],
            cardOffer,
          )
        ).json();
        expect(body.paymentRequired).toBe(true);
        expect(body.cardOffer).toBeUndefined();
      }
    });

    test("a never-paid workspace with an unknown balance omits credits", async () => {
      const body = await (
        await probe(
          signedInAs("user-1"),
          makeBilling(null).billing,
          "free",
          undefined,
          [],
          NOT_FUNDED,
        )
      ).json();
      expect(body).toEqual({
        signedIn: true,
        managedGeneration: false,
        paymentRequired: true,
        tier: "free",
        workspace: { slug: "user-1" },
      });
    });

    test("a funding lookup failure fails closed (payment required)", async () => {
      const body = await (
        await probe(
          signedInAs("user-1"),
          makeBilling().billing,
          "free",
          undefined,
          [],
          new Error("aether down"),
        )
      ).json();
      expect(body.managedGeneration).toBe(false);
      expect(body.paymentRequired).toBe(true);
    });

    test("no funding lookup for a user off the whitelist or without a workspace", async () => {
      const fundingCalls: string[] = [];
      await probe(
        signedInAs("stranger"),
        makeBilling().billing,
        "free",
        undefined,
        [],
        FUNDED,
        fundingCalls,
      );
      await probe(
        signedInAs("user-1", null),
        makeBilling().billing,
        "free",
        undefined,
        [],
        FUNDED,
        fundingCalls,
      );
      expect(fundingCalls).toHaveLength(0);
    });
  });
});
