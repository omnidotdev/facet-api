/**
 * Facet's billing scope.
 *
 * Managed AI is billed by the Synapse gateway, never here: a managed call uses a
 * product-scoped Synapse key, and the gateway checks the entitlement, refuses
 * with 402 before any spend when the balance is empty, meters the call, and
 * debits the pooled Aether credit balance. Facet only names WHO pays (the
 * Aether app and the billing entity) and decides WHETHER managed AI is offered
 * at all: only to a paying customer (a paid Facet tier, or a workspace that has
 * bought Omni credits). Free accounts cost nothing to create and the pooled
 * wallet carries free monthly grants, so managed AI on a free, never-paid
 * workspace would let farmed accounts spend the managed budget.
 *
 * Facet bills the signed-in user's PERSONAL WORKSPACE (the Omni organization
 * Gatekeeper auto-creates for every user), never the user entity. The whole
 * fleet bills paid plans on a workspace: the account hub's plan checkout puts
 * the subscription, its `tier` entitlement, and its included credits on the
 * organization's billing account. Billing the user entity would split a Pro
 * subscriber into a free user with a separate balance inside Facet
 */

import type { BillingProvider } from "@omnidotdev/providers";
import type { SynapseBillingEntity } from "@omnidotdev/providers/ai";

/** Facet's Aether app id (the catalog product slug) */
export const FACET_APP_ID = "facet";

/** Entitlement feature key carrying the subscribed tier */
const TIER_FEATURE_KEY = "tier";

/** Tier every user has without a subscription */
const FREE_TIER = "free";

/** Aether entity type Facet bills: a workspace (Omni organization) */
const BILLING_ENTITY_TYPE = "organization";

/**
 * The billing entity for a workspace: Facet bills the user's personal
 * workspace, so a plan bought in the account hub applies here
 */
export const workspaceBillingEntity = (
  workspaceId: string,
): SynapseBillingEntity => ({
  entityType: BILLING_ENTITY_TYPE,
  entityId: workspaceId,
});

/** Resolve a workspace's Facet tier (e.g. "free", "pro") */
export type TierResolver = (workspaceId: string) => Promise<string>;

/** Read a workspace's pooled credit balance (retail USD), null when unknown */
export const getWorkspaceCreditBalance = async (
  billing: Pick<BillingProvider, "getCreditBalance">,
  workspaceId: string,
): Promise<number | null> => {
  const result = await billing.getCreditBalance(
    BILLING_ENTITY_TYPE,
    workspaceId,
  );
  return result ? result.balance : null;
};

/**
 * Build a tier resolver over the Aether `tier` entitlement for the facet app.
 * The entitlement is read on the workspace billing entity. Any absence or
 * Aether failure resolves to free, so an outage can only send a Pro user
 * through the funding check (and withhold managed AI if they never bought
 * credits), never grant managed AI to a non-payer. Entitlements are cached in
 * the billing provider and invalidated by the billing webhook
 */
export const createTierResolver =
  (billing: Pick<BillingProvider, "checkEntitlement">): TierResolver =>
  async (workspaceId) => {
    try {
      const value = await billing.checkEntitlement(
        BILLING_ENTITY_TYPE,
        workspaceId,
        FACET_APP_ID,
        TIER_FEATURE_KEY,
      );
      const tier = value?.trim().toLowerCase();
      return tier ? tier : FREE_TIER;
    } catch {
      return FREE_TIER;
    }
  };

/** Whether a tier is a paid subscription (managed AI without a credit purchase) */
export const isPaidTier = (tier: string): boolean => tier !== FREE_TIER;

/** Whether a workspace's billing account has ever paid for Omni credits */
export interface WorkspaceFunding {
  /** The billing account the workspace bills to, null when it has none */
  billingAccountId: string | null;
  /** Lifetime credit purchases net of refunds, retail USD */
  paidCreditsUsd: number;
  /** Whether the account has bought credits (net paid credits above zero) */
  isPayingCustomer: boolean;
  /**
   * Whether the account holds the card-verified free AI allowance (its owner
   * saved a card on the account hub). Never paying: the gateway serves it the
   * product's free model only, and the free-tier breaker counts it
   */
  cardVerified: boolean;
}

/** Resolve a workspace's funding; never throws, not funded on any doubt */
export type FundingResolver = (
  workspaceId: string,
) => Promise<WorkspaceFunding>;

/** The answer whenever funding is absent, unknown, or unreadable */
const NOT_FUNDED: WorkspaceFunding = {
  billingAccountId: null,
  paidCreditsUsd: 0,
  isPayingCustomer: false,
  cardVerified: false,
};

/** Upper bound on one funding lookup, so a slow Aether cannot stall a request */
const FUNDING_TIMEOUT_MS = 5_000;

interface FundingResolverConfig {
  /** Aether base URL (`BILLING_BASE_URL`); unset means nobody is funded */
  baseUrl: string | undefined;
  /** Aether service key (`BILLING_SERVICE_API_KEY`); unset means nobody is funded */
  serviceApiKey: string | undefined;
  /** Injected for tests; defaults to the global fetch */
  fetch?: typeof fetch;
  /** Per-lookup timeout in milliseconds */
  timeoutMs?: number;
  /** Server-side report of a failed lookup (never carries the service key) */
  onError?: (reason: string) => void;
}

/**
 * Parse Aether's funding body strictly. Anything off-contract is NOT funded:
 * the flag must be a real boolean `true` AND agree with a positive paid amount,
 * so a malformed or partial body can never grant managed AI
 */
const parseFunding = (body: unknown): WorkspaceFunding | null => {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const paidCreditsUsd =
    typeof raw.paidCreditsUsd === "number" &&
    Number.isFinite(raw.paidCreditsUsd)
      ? raw.paidCreditsUsd
      : 0;
  return {
    billingAccountId:
      typeof raw.billingAccountId === "string" ? raw.billingAccountId : null,
    paidCreditsUsd,
    isPayingCustomer: raw.isPayingCustomer === true && paidCreditsUsd > 0,
    cardVerified: raw.cardVerified === true,
  };
};

/**
 * Build a funding resolver over Aether's
 * `GET /credits/:appId/:entityType/:entityId/funding` (credits:read), read on
 * the workspace billing entity with the same base URL and service key the
 * shared billing provider uses. The provider has no funding read, so this is
 * a small typed fetch with a timeout.
 *
 * Fails CLOSED: missing config, a non-2xx, a timeout, a network error, or a
 * malformed body all resolve to not funded, so an Aether outage can only
 * withhold managed AI from a free-tier buyer, never grant it to a non-payer.
 * Purchases are read live (no cache), so a refund takes effect on the next call
 */
export const createFundingResolver = (
  config: FundingResolverConfig,
): FundingResolver => {
  const baseUrl = config.baseUrl?.replace(/\/+$/, "");
  const { serviceApiKey } = config;
  const fetchImpl = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? FUNDING_TIMEOUT_MS;
  const report = config.onError ?? (() => {});

  return async (workspaceId) => {
    if (!baseUrl || !serviceApiKey) return NOT_FUNDED;

    const url = `${baseUrl}/credits/${FACET_APP_ID}/${BILLING_ENTITY_TYPE}/${encodeURIComponent(workspaceId)}/funding`;
    try {
      const response = await fetchImpl(url, {
        headers: { "x-service-api-key": serviceApiKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        report(`funding lookup refused: status ${response.status}`);
        return NOT_FUNDED;
      }
      const funding = parseFunding(await response.json());
      if (!funding) {
        report("funding lookup returned an unexpected body");
        return NOT_FUNDED;
      }
      return funding;
    } catch (err) {
      report(
        `funding lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      return NOT_FUNDED;
    }
  };
};

/** A workspace's tier and whether it may use managed AI */
interface ManagedEligibility {
  tier: string;
  /** A paid tier, or a free tier whose billing account bought credits */
  isPayingCustomer: boolean;
  /**
   * A free tier that never paid but holds the card-verified free allowance:
   * eligible for managed AI on the free model, under the free-tier breaker
   */
  freeAllowance: boolean;
}

/**
 * Decide whether a workspace may use managed AI: a paid Facet tier, OR a
 * workspace that has bought Omni credits, OR (as the free allowance) one
 * whose owner verified a card. Free grants alone never qualify.
 * Funding is read only for a free tier (a paid tier needs no second lookup),
 * and a resolver that throws fails closed
 */
export const resolveManagedEligibility = async (
  deps: { resolveTier: TierResolver; resolveFunding: FundingResolver },
  workspaceId: string,
): Promise<ManagedEligibility> => {
  const tier = await deps.resolveTier(workspaceId);
  if (isPaidTier(tier))
    return { tier, isPayingCustomer: true, freeAllowance: false };

  const funding = await deps
    .resolveFunding(workspaceId)
    .catch(() => NOT_FUNDED);
  const isPayingCustomer = funding.isPayingCustomer === true;
  return {
    tier,
    isPayingCustomer,
    freeAllowance: !isPayingCustomer && funding.cardVerified === true,
  };
};

/** Whether Aether offers card-verified free AI credits, and their size */
export type CardOfferResolver = () => Promise<{
  monthlyCredits: number;
} | null>;

/**
 * Build a resolver over Aether's public `GET /card-verification/offer`. Null
 * (no offer) when unconfigured, off, unreachable, or off-contract, so Facet
 * never advertises an offer that is switched off
 */
export const createCardOfferResolver = (config: {
  baseUrl: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): CardOfferResolver => {
  const baseUrl = config.baseUrl?.replace(/\/+$/, "");
  const fetchImpl = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? FUNDING_TIMEOUT_MS;

  return async () => {
    if (!baseUrl) return null;
    try {
      const response = await fetchImpl(`${baseUrl}/card-verification/offer`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, unknown> | null;
      const credits = body?.monthlyCredits;
      return body?.enabled === true &&
        typeof credits === "number" &&
        Number.isFinite(credits) &&
        credits > 0
        ? { monthlyCredits: credits }
        : null;
    } catch {
      return null;
    }
  };
};
