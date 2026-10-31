// Set env vars before importing modules that read them at load time
process.env.PROTECT_ROUTES = "true";

import { mswServer } from "./setup/mswServer";

import type { TestDatabase } from "./setup/createTestDatabase";

// TODO Phase C: start the Postgres testcontainer here once per-user usage and
// credit tables are wired. Phase A has no database-backed behavior, so the
// suite runs without a live database and without Docker

declare global {
  // retained for the Phase C database test harness (set once the container starts)
  var __TEST_DATABASE__: TestDatabase;
  var __TEST_CONTAINER_CONNECTION_STRING__: string;
  var __TEST_CLEANUP_IN_PROGRESS__: boolean;
}

/**
 * Cleanup handler for test environment teardown.
 */
const cleanup = () => {
  if (globalThis.__TEST_CLEANUP_IN_PROGRESS__) return;
  globalThis.__TEST_CLEANUP_IN_PROGRESS__ = true;

  mswServer.close();
};

/**
 * Global test preload - runs once before all test files.
 *
 * Phase A starts only MSW (for mocked HTTP), no database
 */
mswServer.listen({ onUnhandledRequest: "bypass" });

/**
 * Register cleanup handlers for various exit scenarios.
 */
process.on("beforeExit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
