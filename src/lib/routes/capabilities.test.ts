import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createCapabilitiesRoute } from "./capabilities";

const probe = (
  authenticate: (r: Request) => Promise<{ userId: string } | null>,
) =>
  createCapabilitiesRoute({ authenticate }).handle(
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

  test("managed true for an allowlisted signed-in user", async () => {
    const body = await (await probe(signedInAs("user-1"))).json();
    expect(body).toEqual({ signedIn: true, managedGeneration: true });
  });

  test("managed false for a signed-in user not on the allowlist", async () => {
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
  });

  test("managed false when no server key is configured", async () => {
    process.env.SYNAPSE_API_KEY = "";
    const body = await (await probe(signedInAs("user-1"))).json();
    expect(body.managedGeneration).toBe(false);
  });
});
