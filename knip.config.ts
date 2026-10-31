import type { KnipConfig } from "knip";

/**
 * Knip configuration.
 * @see https://knip.dev/overview/configuration
 *
 * NOTE: Many lib files are the Drizzle/Postgraphile scaffolding carried from
 * the Elysia template, retained for Phase C (per-user usage + credit tables).
 * They are intentionally unused by the Phase A AI gateway.
 */
const knipConfig: KnipConfig = {
  ignore: [
    "**/generated/**",
    "src/lib/config/drizzle.config.ts",
    "src/scripts/**",
    "src/lib/db/db.ts",
    "src/lib/config/env.config.ts",
    "src/test/**",
    "src/__tests__/**",
    // Reference patterns carried from the template, unused in Phase A
    "src/lib/auth/**",
    "src/lib/cache/**",
    "src/lib/crypto/**",
    "src/lib/db/scoped.ts",
    "src/lib/db/createDbClient.ts",
    "src/lib/db/dbClient.ts",
    "src/lib/db/pgClient.ts",
    "src/lib/idp/**",
    "src/lib/logging/**",
    "src/lib/middleware/**",
    "src/lib/providers/**",
  ],
  ignoreDependencies: [
    // GitHub dependency not resolvable by knip
    "@omnidotdev/providers",
    "@changesets/changelog-github",
    "@changesets/cli",
    "drizzle-kit",
    // TODO switch to testcontainers (unstable behavior with Bun/Docker), then remove below
    "@testcontainers/postgresql",
    "testcontainers",
    "@faker-js/faker",
    // used only by the test harness (src/test/**), which knip ignores
    "jose",
    "msw",
  ],
  ignoreBinaries: [
    "tsc", // Bun provides TypeScript compilation
  ],
  tags: ["-knipignore"],
};

export default knipConfig;
