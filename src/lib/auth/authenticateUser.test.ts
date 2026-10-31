import { describe, expect, test } from "bun:test";

import { authenticateUser } from "./authenticateUser";

/**
 * Only the credential-guard paths are exercised here. They short-circuit before
 * any network call, so they run without live Gatekeeper infra. The happy path
 * (a real token resolved against the Gatekeeper JWKS/userinfo) requires live
 * infra and is covered at the route level with an injected fake authenticate
 */
const requestWith = (headers: Record<string, string> = {}): Request =>
  new Request("http://test/generate", { method: "POST", headers });

describe("authenticateUser credential guards", () => {
  test("returns null when no Authorization header is present", async () => {
    expect(await authenticateUser(requestWith())).toBeNull();
  });

  test("returns null for a non-bearer scheme", async () => {
    expect(
      await authenticateUser(requestWith({ authorization: "Basic abc123" })),
    ).toBeNull();
  });

  test("returns null for a bearer scheme with an empty token", async () => {
    expect(
      await authenticateUser(requestWith({ authorization: "Bearer   " })),
    ).toBeNull();
  });
});
