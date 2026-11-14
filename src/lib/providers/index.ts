/**
 * Shared provider instances.
 *
 * Instantiates authorization and billing providers from @omnidotdev/providers
 * with app-specific configuration from environment variables.
 */

import {
  createApiKeyProvider,
  createAuthzProvider,
  createBillingProvider,
  createEventsProvider,
} from "@omnidotdev/providers";

import { FACET_APP_ID } from "lib/billing/facetBilling";
import {
  AUTHZ_API_URL,
  AUTH_BASE_URL,
  BILLING_BASE_URL,
  BILLING_SERVICE_API_KEY,
  VORTEX_API_KEY,
  VORTEX_API_URL,
} from "lib/config/env.config";

export const authz = createAuthzProvider({
  apiUrl: AUTHZ_API_URL,
});

// Aether for the facet app: the user's tier entitlement and their pooled
// credit balance. Without BILLING_BASE_URL this degrades to the noop provider
// (every user reads as free with no known balance)
export const billing = createBillingProvider(
  BILLING_BASE_URL
    ? {
        provider: "aether",
        baseUrl: BILLING_BASE_URL,
        serviceApiKey: BILLING_SERVICE_API_KEY,
        appId: FACET_APP_ID,
      }
    : {},
);

export const events = createEventsProvider(
  VORTEX_API_URL && VORTEX_API_KEY
    ? {
        provider: "http",
        baseUrl: VORTEX_API_URL,
        apiKey: VORTEX_API_KEY,
        // CloudEvents source identifies the product (omni.<product>), not the
        // deployment unit; event types are facet.<entity>.<action>
        source: "omni.facet",
      }
    : {},
);

export const apiKeys = createApiKeyProvider(
  AUTH_BASE_URL
    ? {
        provider: "gatekeeper",
        authBaseUrl: AUTH_BASE_URL,
      }
    : {},
);
