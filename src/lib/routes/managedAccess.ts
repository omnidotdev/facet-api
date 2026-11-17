import {
  SynapseProvisionError,
  SynapseRequestError,
} from "@omnidotdev/providers/ai";

import { isPaidTier, workspaceBillingEntity } from "lib/billing/facetBilling";
import { getAiConfig } from "lib/config/ai.config";

import type { SpendBreaker } from "@omnidotdev/providers";
import type { Authenticate } from "lib/auth/authenticateUser";
import type { TierResolver } from "lib/billing/facetBilling";
import type { ManagedKeyProvisioner } from "lib/synapse/provisioner";

/**
 * Managed-path gating shared by the money-spending routes (/generate and
 * /critique), so both stay in lockstep.
 *
 * Billing is the gateway's job: a managed call uses a product-scoped Synapse key
 * billed to the pooled Aether balance of the user's PERSONAL WORKSPACE (where
 * the account hub puts a paid plan and its credits), and the gateway refuses
 * with 402 before any spend when that balance is empty. This module only
 * decides whether the call may go out at all and with which key:
 * - managed generation requires provisioning to be configured (no shared key)
 * - a signed-in Omni identity, and the limited-preview allowlist when set (per
 *   user, since it gates a person, not a billing account)
 * - a personal workspace to bill; a token without one (e.g. issued before
 *   Facet requested the `organization` scope) is a re-auth (401), never a
 *   fallback to billing the user entity (that would split the plan)
 * - the free-tier daily spend breaker, which gates free workspaces only (a paid
 *   tier is bounded by its own balance), so free-tier abuse cannot block payers
 * - a product-scoped key provisioned for the user and billed to the workspace;
 *   a provisioning failure makes managed AI unavailable (503), never an
 *   unbilled call on a shared key
 */

export interface ManagedDeps {
  /** Free-tier daily spend breaker (real cents, the backstop) */
  breaker: SpendBreaker;
  /** Resolve the signed-in Omni identity for a request, or null when absent/invalid */
  authenticate: Authenticate;
  /**
   * Product-scoped managed-key provisioner. Absent when provisioning is not
   * configured, in which case the managed path is unavailable
   */
  provisioner?: ManagedKeyProvisioner;
  /** Resolve the workspace's Facet tier from Aether (free on any failure) */
  resolveTier: TierResolver;
}

/** Why the managed path was refused before any call */
type ManagedDenial =
  | "unauthorized"
  | "reauth"
  | "notAllowed"
  | "planRequired"
  | "unavailable";

/**
 * A granted managed call: who made it (identity), which workspace pays, the
 * scoped key, and whether the breaker applies
 */
interface ManagedGrant {
  ok: true;
  userId: string;
  workspaceId: string;
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
  const { userId, personalWorkspace } = identity;

  // limited-preview gate: when a whitelist is configured, only listed users
  // may use managed generation; everyone else must use their own key (BYOK).
  // The ids live only in env (FACET_MANAGED_ALLOWLIST), never in code
  if (
    cfg.managedAllowlist.length > 0 &&
    !cfg.managedAllowlist.includes(userId)
  ) {
    return { ok: false, status: 403, reason: "notAllowed" };
  }

  // the personal workspace is the billing scope; a token without it (e.g.
  // issued before the `organization` scope was requested) must re-authenticate.
  // Fail closed and never bill the user entity instead (the plan split)
  if (!personalWorkspace) {
    logFailure("signed-in user has no personal workspace in their claims");
    return { ok: false, status: 401, reason: "reauth" };
  }
  const workspaceId = personalWorkspace.id;

  // the global daily breaker gates the FREE tier only, so free-tier abuse
  // (Sybil farming) can exhaust the ceiling without ever blocking a payer
  const isPaid = isPaidTier(await deps.resolveTier(workspaceId));
  if (!isPaid && (await deps.breaker.isTripped())) {
    return { ok: false, status: 503, reason: "unavailable" };
  }

  // the key is the user's (identity) but bills their personal workspace. The
  // provisioner and Synapse key each key by billing entity, so a key minted
  // for another entity is never reused here
  try {
    const apiKey = await deps.provisioner.resolveKey(
      userId,
      undefined,
      workspaceBillingEntity(workspaceId),
    );
    return { ok: true, userId, workspaceId, apiKey, isPaid };
  } catch (err) {
    logFailure(`managed key provisioning failed: ${errorText(err)}`);
    // Synapse refuses provisioning with 403 when the workspace's plan does not
    // grant API access; anything else is an outage
    if (err instanceof SynapseProvisionError && err.status === 403) {
      return { ok: false, status: 403, reason: "planRequired" };
    }
    return { ok: false, status: 503, reason: "unavailable" };
  }
};

/** How a failed managed gateway call surfaces to the client */
type UpstreamFailure =
  | { status: 402; reason: "outOfCredits" }
  | { status: 403; reason: "planRequired" }
  | { status: 429; reason: "usageLimited" }
  | { status: 503; reason: "unavailable" }
  | { status: 502; reason: "failed" };

/**
 * Map a failed managed gateway call from the gateway's HTTP status onto the
 * user's next step: 402 is an empty balance (buy credits), 403 is an
 * entitlement the plan does not grant (upgrade), 429 is a usage limit reached
 * (wait or upgrade), 503 is temporarily unavailable, and anything else is a
 * generic failure
 */
export const classifyUpstreamFailure = (err: unknown): UpstreamFailure => {
  const status = err instanceof SynapseRequestError ? err.status : undefined;
  if (status === 402) return { status: 402, reason: "outOfCredits" };
  if (status === 403) return { status: 403, reason: "planRequired" };
  if (status === 429) return { status: 429, reason: "usageLimited" };
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
