import { PgSimplifyInflectionPreset } from "@graphile/simplify-inflection";
import { makePgService } from "postgraphile/adaptors/pg";
import { PostGraphileAmberPreset } from "postgraphile/presets/amber";
import { PostGraphileConnectionFilterPreset } from "postgraphile-plugin-connection-filter";

import { DATABASE_URL, isDevEnv } from "./env.config";

/**
 * Graphile preset.
 */
const graphilePreset: GraphileConfig.Preset = {
  extends: [
    PostGraphileAmberPreset,
    PgSimplifyInflectionPreset,
    PostGraphileConnectionFilterPreset,
  ],
  // Fail closed: no table, column or function is exposed over GraphQL unless
  // a smart tag opts it back in (none do). Every Facet feature runs through
  // the REST routes, which authenticate and scope per user, and the generated
  // CRUD carries no authorization of its own, so a new table must never become
  // readable or writable by default
  schema: { defaultBehavior: "-*" },
  // The Relay `node(id)` accessor reads any row by global id with no scoping
  disablePlugins: ["NodePlugin"],
  pgServices: [makePgService({ connectionString: DATABASE_URL })],
  grafast: { explain: isDevEnv },
};

export default graphilePreset;
