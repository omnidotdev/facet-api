import { createSynapseProvisioner } from "@omnidotdev/providers/ai";

import { FACET_APP_ID } from "lib/billing/facetBilling";

import type { SynapseProvisioner } from "@omnidotdev/providers/ai";

/** The provisioner surface the money-spending routes use */
export type ManagedKeyProvisioner = Pick<SynapseProvisioner, "resolveKey">;

interface FacetProvisionerConfig {
  /** Synapse provisioning API base URL (api.synapse, not the gateway) */
  apiUrl: string;
  /** Gateway secret authorizing the internal provisioning call */
  gatewaySecret: string;
  /** Injectable fetch (for tests) */
  fetchImpl?: typeof fetch;
}

/**
 * Create Facet's managed-key provisioner. Every key it resolves is
 * product-scoped to the facet Aether app, so the gateway checks the user's
 * entitlement and credits, meters the call, and debits the pooled balance. The
 * caller passes the billing entity per call (see `userBillingEntity`)
 */
export const createFacetProvisioner = ({
  apiUrl,
  gatewaySecret,
  fetchImpl,
}: FacetProvisionerConfig): ManagedKeyProvisioner =>
  createSynapseProvisioner({
    apiUrl,
    gatewaySecret,
    source: "Facet",
    appId: FACET_APP_ID,
    fetchImpl,
  });
