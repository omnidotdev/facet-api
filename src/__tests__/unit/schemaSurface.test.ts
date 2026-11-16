import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  assertSchemaSurface,
  findGeneratedCrudMutations,
  findTableReadFields,
  loadSchema,
} from "@omnidotdev/providers/graphql-surface";

import type { SchemaSurfacePolicy } from "@omnidotdev/providers/graphql-surface";

/**
 * Reviewed GraphQL surface.
 *
 * Facet serves every feature through authenticated REST routes; nothing reads
 * or writes through GraphQL, and the generated CRUD carries no authorization.
 * The preset fails closed (`defaultBehavior: "-*"`), so the surface is empty.
 * A field that appears here must be listed with the rule that authorizes it
 */
const POLICY: SchemaSurfacePolicy = {
  Query: {},
  Mutation: {},
  Subscription: {},
};

const schema = loadSchema(
  join(import.meta.dir, "../../generated/graphql/schema.graphql"),
);

describe("GraphQL schema surface", () => {
  test("matches the reviewed policy", () => {
    assertSchemaSurface(schema, POLICY);
  });

  test("exposes no generated CRUD or table reads", () => {
    expect(findGeneratedCrudMutations(schema)).toEqual([]);
    expect(findTableReadFields(schema)).toEqual([]);
  });
});
