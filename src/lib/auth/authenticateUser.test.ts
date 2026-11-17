import { describe, expect, test } from "bun:test";

import { OMNI_CLAIMS_NAMESPACE } from "@omnidotdev/providers";

import { authenticateUser, resolvePersonalWorkspace } from "./authenticateUser";

import type { UserInfoClaims } from "@omnidotdev/providers";

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

/** Userinfo claims carrying the given organizations claim */
const userinfo = (organizations?: unknown): UserInfoClaims =>
  ({
    sub: "user-1",
    ...(organizations !== undefined
      ? { [OMNI_CLAIMS_NAMESPACE]: organizations }
      : {}),
  }) as UserInfoClaims;

const PERSONAL = {
  id: "0b6f3c1e-8f0a-4d7e-9a51-2c4d6e8f0a1b",
  name: "Ada",
  slug: "ada",
  type: "personal",
  roles: ["owner"],
  teams: [],
};

const TEAM = {
  id: "9d2e4f6a-1b3c-4d5e-8f7a-0b1c2d3e4f5a",
  name: "Acme",
  slug: "acme",
  type: "team",
  roles: ["member"],
  teams: [],
};

describe("resolvePersonalWorkspace", () => {
  test("reads the namespaced organizations claim key", () => {
    expect(OMNI_CLAIMS_NAMESPACE).toBe(
      "https://manifold.omni.dev/@omni/claims/organizations",
    );
  });

  test("picks the personal organization, not a team one", () => {
    expect(resolvePersonalWorkspace(userinfo([TEAM, PERSONAL]))).toEqual({
      id: PERSONAL.id,
      slug: PERSONAL.slug,
    });
  });

  test("null when the claim is absent (token without the organization scope)", () => {
    expect(resolvePersonalWorkspace(userinfo())).toBeNull();
  });

  test("null when the user only has team organizations", () => {
    expect(resolvePersonalWorkspace(userinfo([TEAM]))).toBeNull();
  });

  test("null for a slim (id-only) personal entry, never a partial workspace", () => {
    expect(
      resolvePersonalWorkspace(userinfo([{ id: PERSONAL.id }])),
    ).toBeNull();
    expect(
      resolvePersonalWorkspace(
        userinfo([{ id: PERSONAL.id, type: "personal" }]),
      ),
    ).toBeNull();
  });

  test("ignores malformed entries and a non-array claim", () => {
    expect(resolvePersonalWorkspace(userinfo("nope"))).toBeNull();
    expect(
      resolvePersonalWorkspace(userinfo([null, 7, { ...PERSONAL, id: "" }])),
    ).toBeNull();
  });
});
