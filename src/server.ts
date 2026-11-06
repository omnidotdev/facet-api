import { readFileSync } from "node:fs";

import { cors } from "@elysiajs/cors";
import { yoga } from "@elysiajs/graphql-yoga";
import { useOpenTelemetry } from "@envelop/opentelemetry";
import { useParserCache } from "@envelop/parser-cache";
import { useValidationCache } from "@envelop/validation-cache";
import { useDisableIntrospection } from "@graphql-yoga/plugin-disable-introspection";
import { createSynapseProvisioner } from "@omnidotdev/providers/ai";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { schema } from "generated/graphql/schema.executable";
import { useGrafast } from "grafast/envelop";
import webhooks from "webhooks";

import { authenticateUser } from "lib/auth/authenticateUser";
import { getAiConfig } from "lib/config/ai.config";
import appConfig from "lib/config/app.config";
import {
  BILLING_BASE_URL,
  PORT,
  corsAllowedOrigins,
  isDevEnv,
  isProdEnv,
} from "lib/config/env.config";
import { createDrizzleCreditStore } from "lib/cost/creditStore.drizzle";
import {
  createEntitlementCapResolver,
  createStaticCapResolver,
} from "lib/cost/entitlementCap";
import { createRateLimiter } from "lib/cost/rateLimit";
import { createDrizzleSpendBreaker } from "lib/cost/spendBreaker.drizzle";
import { dbPool, pgPool } from "lib/db";
import ensureDatabase from "lib/db/ensureDatabase";
import createGraphqlContext from "lib/graphql/createGraphqlContext";
import { armorPlugin, createAuthenticationPlugin } from "lib/graphql/plugins";
import { billing, events } from "lib/providers";
import { createCapabilitiesRoute } from "lib/routes/capabilities";
import { createGenerateRoute } from "lib/routes/generate";
import { callSynapse } from "lib/synapse/client";

const commit = (() => {
  try {
    return readFileSync("/app/.git-sha", "utf-8").trim();
  } catch {
    return "unknown";
  }
})();

// ensure database exists before starting
// Phase A has no DB-backed behavior, so a missing database must not block boot
// (the AI gateway and BYOK still work). The DB is wired for real in Phase C
try {
  await ensureDatabase();
} catch (err) {
  const reason = err instanceof Error ? err.message : "unknown";
  console.warn(
    `[startup] database unavailable, DB-backed features disabled: ${reason}`,
  );
}

// AI gateway singletons.
// The per-user credit meter and the global daily spend breaker are both
// DB-backed (durable across instances and restarts); the breaker's shared daily
// counter holds the ceiling even across a restart or multiple replicas. The
// per-IP rate limiter stays in-memory: a sliding window across instances needs
// a shared store, and the Synapse-key hard budget plus the per-user cap and the
// durable breaker already bound worst-case loss. Moving the limiter to a shared
// store is the remaining Phase C work (see the TODO in rateLimit.ts)
const aiConfig = getAiConfig();
if (!aiConfig.managedEnabled) {
  console.warn("SYNAPSE_API_KEY not set, managed AI generation disabled");
}
const spendBreaker = createDrizzleSpendBreaker(
  dbPool,
  aiConfig.dailySpendCeilingCents,
);
const aiRateLimiter = createRateLimiter({
  windowMs: aiConfig.rateLimitWindowMs,
  max: aiConfig.rateLimitMax,
});
// The per-user monthly cap is tier-aware: it is the user's included_credits
// entitlement for Facet from Aether, with the static free cap as a safe
// fallback. When billing is not configured, degrade to the static cap so the
// service still boots and enforces the free allowance (the billing webhook
// that invalidates the entitlement cache warns separately when its secret is
// unset)
if (!BILLING_BASE_URL) {
  console.warn(
    "BILLING_BASE_URL not set, tier-aware credit caps disabled (static free cap)",
  );
}
const capResolver = BILLING_BASE_URL
  ? createEntitlementCapResolver({
      billing,
      fallbackCredits: aiConfig.freeMonthlyCredits,
    })
  : createStaticCapResolver(aiConfig.freeMonthlyCredits);
const creditStore = createDrizzleCreditStore(dbPool, capResolver);
// Per-user managed keys: when the provisioning API URL + gateway secret are set,
// the managed path provisions a per-user Synapse key so Synapse attributes usage
// per user. The local credit ledger above still enforces the hard cap, so this
// is purely additive. Disabled (shared key) when either env is unset
const provisioner =
  aiConfig.perUserManagedEnabled &&
  aiConfig.synapseApiUrl &&
  aiConfig.synapseGatewaySecret
    ? createSynapseProvisioner({
        apiUrl: aiConfig.synapseApiUrl,
        gatewaySecret: aiConfig.synapseGatewaySecret,
        source: "Facet",
      })
    : undefined;

/**
 * Elysia server.
 */
const app = new Elysia({
  ...(isDevEnv && {
    serve: {
      // https://elysiajs.com/patterns/configuration#serve-tls
      // https://bun.sh/guides/http/tls
      // NB: Elysia (and Bun) trust the well-known CA list curated by Mozilla (https://wiki.mozilla.org/CA/Included_Certificates), but they can be customized here if needed (`tls.ca` option)
      tls: {
        certFile: "cert.pem",
        keyFile: "key.pem",
      },
    },
  }),
})
  // security headers
  .onAfterHandle(({ set }) => {
    set.headers["X-Content-Type-Options"] = "nosniff";
    set.headers["X-Frame-Options"] = "DENY";
    set.headers["X-XSS-Protection"] = "1; mode=block";
    set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
  })
  .use(
    cors({
      origin: corsAllowedOrigins,
      methods: ["GET", "POST"],
    }),
  )
  // rate limiting
  .use(
    rateLimit({
      max: 100,
      duration: 60_000,
    }),
  )
  // health check endpoint
  .get("/health", () => ({
    status: "ok",
    timestamp: Date.now(),
    service: appConfig.name,
    commit,
  }))
  // readiness endpoint
  .get("/ready", async ({ set }) => {
    try {
      await dbPool.execute(sql`SELECT 1`);

      return {
        status: "ready",
        database: "connected",
        timestamp: Date.now(),
      };
    } catch {
      set.status = 503;

      return {
        status: "not ready",
        database: "disconnected",
        timestamp: Date.now(),
      };
    }
  })
  // AI generation gateway (the money-spending route)
  .use(
    createGenerateRoute({
      callSynapse,
      breaker: spendBreaker,
      rateLimiter: aiRateLimiter,
      authenticate: authenticateUser,
      creditStore,
      events,
      provisioner,
    }),
  )
  // Client capability probe: lets the Studio show the AI panel only to users
  // who may actually use managed generation (env allowlist), never hardcoded
  .use(createCapabilitiesRoute({ authenticate: authenticateUser }))
  .use(webhooks)
  .use(
    yoga({
      schema,
      context: createGraphqlContext,
      graphiql: isDevEnv,
      plugins: [
        ...armorPlugin,
        createAuthenticationPlugin(),
        // disable GraphQL schema introspection in production to mitigate reverse engineering
        isProdEnv && useDisableIntrospection(),
        useOpenTelemetry({
          variables: true,
          result: true,
        }),
        // parser and validation caches recommended for Grafast (https://grafast.org/grafast/servers#envelop)
        useParserCache(),
        useValidationCache(),
        useGrafast(),
      ],
    }),
  )
  .listen(PORT);

// biome-ignore lint/suspicious/noConsole: root logging
console.log(
  `🦊 ${appConfig.name} Elysia server running at ${app.server?.url.toString().slice(0, -1)}`,
);

// biome-ignore lint/suspicious/noConsole: root logging
console.log(
  `🧘 ${appConfig.name} GraphQL Yoga API running at ${app.server?.url}graphql`,
);

/**
 * Graceful shutdown handler.
 */
const shutdown = async (signal: string) => {
  // biome-ignore lint/suspicious/noConsole: shutdown logging
  console.log(`[Server] Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  app.stop();

  // Close database pool
  await pgPool.end();

  // biome-ignore lint/suspicious/noConsole: shutdown logging
  console.log("[Server] Shutdown complete");
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
