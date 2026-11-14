import { SynapseRequestError } from "@omnidotdev/providers/ai";

import { isPaidTier, userBillingEntity } from "lib/billing/facetBilling";
import { getAiConfig } from "lib/config/ai.config";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { TierResolver } from "lib/billing/facetBilling";
import type { ManagedKeyProvisioner } from "lib/synapse/provisioner";

/**
 * Managed-path gating shared by the money-spending routes (/generate and
 * /critique), so both stay in lockstep.
 *
 * Billing is the gateway's job: a managed call uses a product-scoped Synapse key
 * billed to the user's pooled Aether balance, and the gateway refuses with 402
 * before any spend when that balance is empty. This module only decides whether
 * the call may go out at all and with which key:
 * - managed generation requires provisioning to be configured (no shared key)
 * - a signed-in Omni identity, and the limited-preview allowlist when set
 * - the free-tier daily spend breaker, which gates free users only (a paid tier
 *   is bounded by its own balance), so free-tier abuse cannot block payers
 * - a product-scoped key provisioned for the user; a provisioning failure makes
 *   managed AI unavailable (503), never an unbilled call on a shared key
 */

export interface ManagedDeps {
  /** Free-tier daily spend breaker (real cents, the backstop) */
  breaker: SpendBreaker;
  /** Resolve the signed-in Omni identity for a request, or null when absent/invalid */
  authenticate: (request: Request) => Promise<{ userId: string } | null>;
  /**
   * Product-scoped managed-key provisioner. Absent when provisioning is not
   * configured, in which case the managed path is unavailable
   */
  provisioner?: ManagedKeyProvisioner;
  /** Resolve the user's Facet tier from Aether (free on any failure) */
  resolveTier: TierResolver;
}

/** Why the managed path was refused before any call */
type ManagedDenial = "unauthorized" | "notAllowed" | "unavailable";

/** A granted managed call: who pays, the scoped key, and whether the breaker applies */
interface ManagedGrant {
  ok: true;
  userId: string;
  apiKey: string;
  isPaid: boolean;
}

type ManagedAccess =
  | ManagedGrant
  | { ok: false; status: 401 | 403 | 503; reason: ManagedDenial };

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "unknown error";

/**
 * Gate a managed (non-BYOK) request and resolve its product-scoped key. Never
 * reaches the gateway itself; the caller makes the call with the returned key
 */
export const resolveManagedAccess = async (
  deps: ManagedDeps,
  request: Request,
  logFailure: (reason: string) => void,
): Promise<ManagedAccess> => {
  const cfg = getAiConfig();

  if (!cfg.managedEnabled || !deps.provisioner) {
    return { ok: false, status: 503, reason: "unavailable" };
  }

  const identity = await deps.authenticate(request);
  if (!identity) return { ok: false, status: 401, reason: "unauthorized" };
  const { userId } = identity;

  // limited-preview gate: when an allowlist is configured, only listed users
  // may use managed generation; everyone else must use their own key (BYOK).
  // The ids live only in env (FACET_MANAGED_ALLOWLIST), never in code
  if (
    cfg.managedAllowlist.length > 0 &&
    !cfg.managedAllowlist.includes(userId)
  ) {
    return { ok: false, status: 403, reason: "notAllowed" };
  }

  // the global daily breaker gates the FREE tier only, so free-tier abuse
  // (Sybil farming) can exhaust the ceiling without ever blocking a payer
  const isPaid = isPaidTier(await deps.resolveTier(userId));
  if (!isPaid && (await deps.breaker.isTripped())) {
    return { ok: false, status: 503, reason: "unavailable" };
  }

  // Facet is a personal product, so the user pays from their own pooled balance
  try {
    const apiKey = await deps.provisioner.resolveKey(
      userId,
      undefined,
      userBillingEntity(userId),
    );
    return { ok: true, userId, apiKey, isPaid };
  } catch (err) {
    logFailure(`managed key provisioning failed: ${errorText(err)}`);
    return { ok: false, status: 503, reason: "unavailable" };
  }
};

/** How a failed managed gateway call surfaces to the client */
type UpstreamFailure =
  | { status: 402; reason: "outOfCredits" }
  | { status: 503; reason: "unavailable" }
  | { status: 502; reason: "failed" };

/**
 * Map a failed managed gateway call from the gateway's HTTP status: 402 is an
 * empty balance (out of credits, buy more), 503 is temporarily unavailable, and
 * anything else is a generic failure
 */
export const classifyUpstreamFailure = (err: unknown): UpstreamFailure => {
  const status = err instanceof SynapseRequestError ? err.status : undefined;
  if (status === 402) return { status: 402, reason: "outOfCredits" };
  if (status === 503) return { status: 503, reason: "unavailable" };
  return { status: 502, reason: "failed" };
};

/**
 * Record a managed call's real spend against the free-tier breaker. Paid spend
 * is never recorded (it never counts toward, or trips, the free ceiling). The
 * spend already happened upstream, so a write failure is logged, never raised
 */
export const recordFreeSpend = async (
  breaker: SpendBreaker,
  grant: ManagedGrant,
  costCents: number,
  logFailure: (reason: string) => void,
): Promise<void> => {
  if (grant.isPaid) return;
  try {
    await breaker.record(costCents);
  } catch (err) {
    logFailure(`breaker record failed: ${errorText(err)}`);
  }
};
