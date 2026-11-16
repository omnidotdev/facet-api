// @ts-nocheck
import { makeGrafastSchema, rootValue } from "grafast";
export const typeDefs = /* GraphQL */`"""The root query type which gives access points into the data universe."""
type Query {
  """
  Exposes the root query type nested one level down. This is helpful for Relay 1
  which can only query top level fields if they are in a particular form.
  """
  query: Query!
}`;
export const objects = {
  Query: {
    assertStep() {
      return !0;
    },
    plans: {
      query() {
        return rootValue();
      }
    }
  }
};
export const schema = makeGrafastSchema({
  typeDefs: typeDefs,
  objects: objects
});