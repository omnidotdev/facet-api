/**
 * Per-user managed Synapse key provisioning.
 *
 * Mirrors the creator-api pattern: lazily provision and cache a per-user Synapse
 * API key via the Synapse provisioning API's internal endpoint, authorized by
 * the gateway secret. Using a per-user key lets Synapse attribute and meter
 * usage per user (rather than everything under one shared service key). The
 * facet-api credit ledger still enforces the hard monthly cap as a safety net,
 * so this never widens the money-loss surface
 */

/** Cache a provisioned key briefly so each generation does not re-provision. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  key: string;
  provisionedAt: number;
}

/** The subset of the provisioning response this reads. */
interface ProvisionResponse {
  apiKey: string;
}

export interface SynapseProvisionerOptions {
  /** Synapse provisioning API base URL (api.synapse), without a trailing slash. */
  apiUrl: string;
  /** Gateway secret authorizing the internal provisioning call. */
  gatewaySecret: string;
  /** Injectable fetch, defaults to the global (for tests). */
  fetchImpl?: typeof fetch;
  /** Injectable clock, defaults to Date.now (for tests). */
  now?: () => number;
}

/**
 * Resolves (and caches) a per-user managed Synapse key, provisioning on demand.
 * Throws on a provisioning failure so the caller can fall back to the shared key
 */
export class SynapseProvisioner {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly apiUrl: string;
  private readonly gatewaySecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: SynapseProvisionerOptions) {
    this.apiUrl = options.apiUrl;
    this.gatewaySecret = options.gatewaySecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Resolve a managed Synapse key for a user id, provisioning if not cached. */
  async resolveKey(identityProviderId: string): Promise<string> {
    const cached = this.cache.get(identityProviderId);
    if (cached && this.now() - cached.provisionedAt < CACHE_TTL_MS) {
      return cached.key;
    }

    const response = await this.fetchImpl(
      `${this.apiUrl}/internal/provision-managed-key`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-secret": this.gatewaySecret,
        },
        body: JSON.stringify({ identityProviderId, source: "Facet" }),
      },
    );

    if (!response.ok) {
      throw new Error(`provision-managed-key failed: ${response.status}`);
    }

    const data = (await response.json()) as ProvisionResponse;
    if (!data.apiKey) {
      throw new Error("provision-managed-key returned no apiKey");
    }

    this.cache.set(identityProviderId, {
      key: data.apiKey,
      provisionedAt: this.now(),
    });
    return data.apiKey;
  }
}
