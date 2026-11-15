import { readFileSync } from "node:fs";

import { cors } from "@elysiajs/cors";
import { yoga } from "@elysiajs/graphql-yoga";
import { useOpenTelemetry } from "@envelop/opentelemetry";
import { useParserCache } from "@envelop/parser-cache";
import { useValidationCache } from "@envelop/validation-cache";
import { useDisableIntrospection } from "@graphql-yoga/plugin-disable-introspection";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { schema } from "generated/graphql/schema.executable";
import { useGrafast } from "grafast/envelop";
import webhooks from "webhooks";

import { authenticateUser } from "lib/auth/authenticateUser";
import { createTierResolver } from "lib/billing/facetBilling";
import { getAiConfig } from "lib/config/ai.config";
import appConfig from "lib/config/app.config";
import {
  BILLING_BASE_URL,
  BILLING_SERVICE_API_KEY,
  CONSENT_WEBHOOK_SECRET,
  OMNI_API_URL,
  PORT,
  corsAllowedOrigins,
  isDevEnv,
  isProdEnv,
} from "lib/config/env.config";
import { createRateLimiter } from "lib/cost/rateLimit";
import { createDrizzleSpendBreaker } from "lib/cost/spendBreaker.drizzle";
import { dbPool, pgPool } from "lib/db";
import ensureDatabase from "lib/db/ensureDatabase";
import createGraphqlContext from "lib/graphql/createGraphqlContext";
import { armorPlugin, createAuthenticationPlugin } from "lib/graphql/plugins";
import { createPlatformConsentClient } from "lib/platform/consentClient";
import { billing, events } from "lib/providers";
import { createCapabilitiesRoute } from "lib/routes/capabilities";
import { createConsentRoute } from "lib/routes/consent";
import { createCritiqueRoute } from "lib/routes/critique";
import { createDispositionRoute } from "lib/routes/disposition";
import { createGenerateRoute } from "lib/routes/generate";
import { createImportRoute } from "lib/routes/import";
import { createSampleStore } from "lib/routes/sampleStore";
import { callSynapse } from "lib/synapse/client";
import { createFacetProvisioner } from "lib/synapse/provisioner";

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
// Managed AI is billed by the Synapse gateway: each managed call uses a
// product-scoped key for the facet Aether app, billed to the user's pooled
// credit balance (the gateway refuses with 402 before spend when it is empty).
// There is no shared managed key: without provisioning configured, the managed
// path answers 503 and BYOK keeps working. The global daily spend breaker is
// DB-backed (durable across instances and restarts) and gates the free tier
// only. The per-IP rate limiter stays in-memory: a sliding window across
// instances needs a shared store, and the gateway's credit check plus the
// durable breaker already bound worst-case loss (see the TODO in rateLimit.ts)
const aiConfig = getAiConfig();
if (!aiConfig.managedEnabled) {
  console.warn(
    "SYNAPSE_API_URL or SYNAPSE_GATEWAY_SECRET not set, managed AI generation disabled",
  );
}
const spendBreaker = createDrizzleSpendBreaker(
  dbPool,
  aiConfig.dailySpendCeilingCents,
);
const aiRateLimiter = createRateLimiter({
  windowMs: aiConfig.rateLimitWindowMs,
  max: aiConfig.rateLimitMax,
});
// The tier decides whether the free-tier breaker applies, and the balance is
// what /capabilities reports. Both come from Aether; without it every user
// reads as free with no known balance
if (!BILLING_BASE_URL) {
  console.warn(
    "BILLING_BASE_URL not set, tier and credit balance disabled (everyone is free tier)",
  );
} else if (!BILLING_SERVICE_API_KEY) {
  console.warn(
    "BILLING_SERVICE_API_KEY not set, Aether credit balance reads will be refused",
  );
}
const resolveTier = createTierResolver(billing);
// Consented AI training/eval store: the only place the service persists a
// user's prompt or code, and only ever for a signed-in user who has opted in
// (the store enforces the consent gate and erases a user's samples when they
// withdraw). Shares the DB pool; if the database is unavailable the
// fire-and-forget capture simply errors and is swallowed, never blocking a
// generation
const sampleStore = createSampleStore(dbPool);
// Forward each in-app consent toggle to the central ledger (omni-api), the
// authoritative fleet-wide record other surfaces read. Without OMNI_API_URL the
// client is a no-op and the local capture-gate still works; a central-origin
// withdrawal still reaches Facet through the /webhooks/consent receiver
if (!OMNI_API_URL) {
  console.warn(
    "OMNI_API_URL not set, in-app consent changes will not be forwarded to the central ledger",
  );
}
if (!CONSENT_WEBHOOK_SECRET) {
  console.warn(
    "CONSENT_WEBHOOK_SECRET not set, central consent-withdrawal deliveries cannot be verified (erasure on withdrawal from other surfaces disabled)",
  );
}
const platformConsent = createPlatformConsentClient(OMNI_API_URL);
const provisioner =
  aiConfig.managedEnabled &&
  aiConfig.synapseApiUrl &&
  aiConfig.synapseGatewaySecret
    ? createFacetProvisioner({
        apiUrl: aiConfig.synapseApiUrl,
        gatewaySecret: aiConfig.synapseGatewaySecret,
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
      events,
      samples: sampleStore,
      provisioner,
      resolveTier,
    }),
  )
  // AI vision critique (a money-spending route; same gating as /generate). Grounds
  // the generation loop by scoring a render of the result against the request
  .use(
    createCritiqueRoute({
      callSynapse,
      breaker: spendBreaker,
      rateLimiter: aiRateLimiter,
      authenticate: authenticateUser,
      events,
      provisioner,
      resolveTier,
    }),
  )
  // Generation disposition: the human-in-the-loop signal (kept / discarded /
  // regenerated) the server cannot see on its own. Spends no money, stores
  // nothing, emits one metadata-only event correlated to the generation
  .use(
    createDispositionRoute({
      rateLimiter: aiRateLimiter,
      authenticate: authenticateUser,
      events,
    }),
  )
  // AI training-data consent: the per-user opt-in behind the generation-sample
  // dataset. Authenticated (unlike disposition), spends no money. Turning it off
  // erases the user's stored samples
  .use(
    createConsentRoute({
      authenticate: authenticateUser,
      store: sampleStore,
      events,
      forwardConsent: (accessToken, granted) =>
        platformConsent.setConsent(accessToken, granted),
    }),
  )
  // SVG/image import proxy: fetches user-supplied art by URL server-side (the
  // browser can't, cross-origin), SSRF-guarded. Spends no AI money; bounded by
  // sign-in and the per-IP limiter
  .use(
    createImportRoute({
      rateLimiter: aiRateLimiter,
      authenticate: authenticateUser,
    }),
  )
  // Client capability probe: lets the Studio show the AI panel only to users
  // who may actually use managed generation (env allowlist), never hardcoded,
  // with their tier and pooled credit balance
  .use(
    createCapabilitiesRoute({
      authenticate: authenticateUser,
      billing,
      resolveTier,
      store: sampleStore,
    }),
  )
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
