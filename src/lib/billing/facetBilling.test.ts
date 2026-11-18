import { describe, expect, test } from "bun:test";

import {
  FACET_APP_ID,
  createFundingResolver,
  createTierResolver,
  getWorkspaceCreditBalance,
  isPaidTier,
  resolveManagedEligibility,
  workspaceBillingEntity,
} from "./facetBilling";

import type { WorkspaceFunding } from "./facetBilling";

const WORKSPACE = "6f1c2a8e-4b7d-4e2a-9c1f-0a1b2c3d4e5f";

describe("facet billing scope", () => {
  test("Facet bills under its own Aether app id", () => {
    expect(FACET_APP_ID).toBe("facet");
  });

  test("bills the workspace (organization), never the user entity", () => {
    expect(workspaceBillingEntity(WORKSPACE)).toEqual({
      entityType: "organization",
      entityId: WORKSPACE,
    });
  });
});

describe("getWorkspaceCreditBalance", () => {
  test("reads the workspace's pooled balance on the organization entity", async () => {
    const seen: unknown[] = [];
    const balance = await getWorkspaceCreditBalance(
      {
        async getCreditBalance(...args) {
          seen.push(args);
          return { billingAccountId: "acct-1", balance: 4.2 };
        },
      },
      WORKSPACE,
    );
    expect(balance).toBe(4.2);
    expect(seen).toEqual([["organization", WORKSPACE]]);
  });

  test("an unknown balance is null", async () => {
    expect(
      await getWorkspaceCreditBalance(
        { getCreditBalance: async () => null },
        WORKSPACE,
      ),
    ).toBeNull();
  });
});

describe("createTierResolver", () => {
  test("reads the workspace's tier entitlement for the facet app", async () => {
    const seen: unknown[] = [];
    const resolve = createTierResolver({
      async checkEntitlement(...args) {
        seen.push(args);
        return "pro";
      },
    });

    expect(await resolve(WORKSPACE)).toBe("pro");
    expect(seen).toEqual([["organization", WORKSPACE, "facet", "tier"]]);
  });

  test("normalizes the tier value", async () => {
    const resolve = createTierResolver({
      checkEntitlement: async () => "  Pro ",
    });
    expect(await resolve(WORKSPACE)).toBe("pro");
  });

  test("no entitlement resolves to free", async () => {
    const resolve = createTierResolver({ checkEntitlement: async () => null });
    expect(await resolve(WORKSPACE)).toBe("free");
  });

  test("an Aether failure degrades to free, never paid", async () => {
    const resolve = createTierResolver({
      checkEntitlement: async () => {
        throw new Error("aether down");
      },
    });
    expect(await resolve(WORKSPACE)).toBe("free");
  });
});

describe("isPaidTier", () => {
  test("only a non-free tier is paid", () => {
    expect(isPaidTier("free")).toBe(false);
    expect(isPaidTier("pro")).toBe(true);
  });
});

/** A fetch fake answering every request with the given response, recording each call */
const makeFetch = (respond: () => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
};

const NOT_FUNDED: WorkspaceFunding = {
  billingAccountId: null,
  paidCreditsUsd: 0,
  isPayingCustomer: false,
  cardVerified: false,
};

const FUNDED = {
  billingAccountId: "acct-1",
  paidCreditsUsd: 10,
  isPayingCustomer: true,
  cardVerified: false,
};

/** A free workspace that never paid but whose owner verified a card */
const CARD_VERIFIED: WorkspaceFunding = {
  billingAccountId: "acct-1",
  paidCreditsUsd: 0,
  isPayingCustomer: false,
  cardVerified: true,
};

describe("createFundingResolver", () => {
  test("reads the workspace's funding from Aether with the service key", async () => {
    const { fetchImpl, calls } = makeFetch(() => Response.json(FUNDED));
    const resolve = createFundingResolver({
      baseUrl: "https://aether.test/",
      serviceApiKey: "svc-key",
      fetch: fetchImpl,
    });

    expect(await resolve(WORKSPACE)).toEqual(FUNDED);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://aether.test/credits/facet/organization/${WORKSPACE}/funding`,
    );
    expect(new Headers(calls[0]?.init?.headers).get("x-service-api-key")).toBe(
      "svc-key",
    );
    // every lookup is bounded by a timeout
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("reads a verified card only from a real boolean true", async () => {
    for (const [cardVerified, expected] of [
      [true, true],
      ["true", false],
      [1, false],
      [undefined, false],
    ] as const) {
      const { fetchImpl } = makeFetch(() =>
        Response.json({ ...NOT_FUNDED, cardVerified }),
      );
      const resolve = createFundingResolver({
        baseUrl: "https://aether.test",
        serviceApiKey: "svc-key",
        fetch: fetchImpl,
      });
      expect((await resolve(WORKSPACE)).cardVerified).toBe(expected);
    }
  });

  test("a workspace that never bought credits is not a paying customer", async () => {
    const { fetchImpl } = makeFetch(() => Response.json(NOT_FUNDED));
    const resolve = createFundingResolver({
      baseUrl: "https://aether.test",
      serviceApiKey: "svc-key",
      fetch: fetchImpl,
    });
    expect(await resolve(WORKSPACE)).toEqual(NOT_FUNDED);
  });

  test("without an Aether URL nobody is a paying customer and nothing is fetched", async () => {
    const { fetchImpl, calls } = makeFetch(() => Response.json(FUNDED));
    const resolve = createFundingResolver({
      baseUrl: undefined,
      serviceApiKey: "svc-key",
      fetch: fetchImpl,
    });
    expect(await resolve(WORKSPACE)).toEqual(NOT_FUNDED);
    expect(calls).toHaveLength(0);
  });

  test("without a service key nobody is a paying customer and nothing is fetched", async () => {
    const { fetchImpl, calls } = makeFetch(() => Response.json(FUNDED));
    const resolve = createFundingResolver({
      baseUrl: "https://aether.test",
      serviceApiKey: undefined,
      fetch: fetchImpl,
    });
    expect(await resolve(WORKSPACE)).toEqual(NOT_FUNDED);
    expect(calls).toHaveLength(0);
  });

  describe("fails closed (never a paying customer on doubt)", () => {
    const failures: [string, () => Response | Promise<Response>][] = [
      ["a non-2xx response", () => Response.json(FUNDED, { status: 500 })],
      ["a 404 (no billing account)", () => new Response(null, { status: 404 })],
      ["a non-JSON body", () => new Response("<html>oops</html>")],
      ["a network failure", () => Promise.reject(new Error("ECONNREFUSED"))],
      [
        "a timeout",
        () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      ],
      ["a body that is not an object", () => Response.json(true)],
      [
        "a truthy but non-boolean flag",
        () => Response.json({ ...FUNDED, isPayingCustomer: "true" }),
      ],
      [
        "a paying flag with no paid credits",
        () => Response.json({ ...FUNDED, paidCreditsUsd: 0 }),
      ],
      [
        "a paying flag with a non-numeric paid amount",
        () => Response.json({ ...FUNDED, paidCreditsUsd: "10" }),
      ],
    ];

    for (const [name, respond] of failures) {
      test(name, async () => {
        const { fetchImpl } = makeFetch(respond);
        const resolve = createFundingResolver({
          baseUrl: "https://aether.test",
          serviceApiKey: "svc-key",
          fetch: fetchImpl,
          onError: () => {},
        });
        expect((await resolve(WORKSPACE)).isPayingCustomer).toBe(false);
      });
    }
  });

  test("a failed lookup is reported server-side without the service key", async () => {
    const reported: string[] = [];
    const { fetchImpl } = makeFetch(() => new Response(null, { status: 503 }));
    const resolve = createFundingResolver({
      baseUrl: "https://aether.test",
      serviceApiKey: "svc-key",
      fetch: fetchImpl,
      onError: (reason) => reported.push(reason),
    });

    await resolve(WORKSPACE);

    expect(reported).toHaveLength(1);
    expect(reported[0]).not.toContain("svc-key");
  });
});

describe("resolveManagedEligibility", () => {
  const fundingOf = (funding: WorkspaceFunding | Error) => {
    const calls: string[] = [];
    const resolveFunding = async (workspaceId: string) => {
      calls.push(workspaceId);
      if (funding instanceof Error) throw funding;
      return funding;
    };
    return { resolveFunding, calls };
  };

  test("a paid tier is eligible without a funding lookup", async () => {
    const { resolveFunding, calls } = fundingOf(NOT_FUNDED);
    const eligibility = await resolveManagedEligibility(
      { resolveTier: async () => "pro", resolveFunding },
      WORKSPACE,
    );
    expect(eligibility).toEqual({
      tier: "pro",
      isPayingCustomer: true,
      freeAllowance: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("a free workspace that bought credits is eligible", async () => {
    const { resolveFunding, calls } = fundingOf(FUNDED);
    const eligibility = await resolveManagedEligibility(
      { resolveTier: async () => "free", resolveFunding },
      WORKSPACE,
    );
    expect(eligibility).toEqual({
      tier: "free",
      isPayingCustomer: true,
      freeAllowance: false,
    });
    expect(calls).toEqual([WORKSPACE]);
  });

  test("a free workspace that never paid is not eligible", async () => {
    const { resolveFunding } = fundingOf(NOT_FUNDED);
    const eligibility = await resolveManagedEligibility(
      { resolveTier: async () => "free", resolveFunding },
      WORKSPACE,
    );
    expect(eligibility).toEqual({
      tier: "free",
      isPayingCustomer: false,
      freeAllowance: false,
    });
  });

  test("a free workspace with a verified card gets the free allowance, never paying", async () => {
    const { resolveFunding } = fundingOf(CARD_VERIFIED);
    const eligibility = await resolveManagedEligibility(
      { resolveTier: async () => "free", resolveFunding },
      WORKSPACE,
    );
    expect(eligibility).toEqual({
      tier: "free",
      isPayingCustomer: false,
      freeAllowance: true,
    });
  });

  test("a funding resolver that throws fails closed", async () => {
    const { resolveFunding } = fundingOf(new Error("aether down"));
    const eligibility = await resolveManagedEligibility(
      { resolveTier: async () => "free", resolveFunding },
      WORKSPACE,
    );
    expect(eligibility.isPayingCustomer).toBe(false);
    expect(eligibility.freeAllowance).toBe(false);
  });
});
