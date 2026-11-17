/**
 * Stable machine-readable codes for the AI routes' error bodies. The `error`
 * text is for people and may be reworded; `code` is the contract the client
 * branches on (e.g. `payment_required`, a non-payer who should buy credits or
 * upgrade, versus `out_of_credits`, a payer whose balance ran out)
 */
export const ERROR_CODES = {
  badInput: "bad_input",
  badPrompt: "bad_prompt",
  rateLimited: "rate_limited",
  repairLimited: "repair_limited",
  unauthorized: "unauthorized",
  reauth: "reauth_required",
  notAllowed: "not_allowed",
  paymentRequired: "payment_required",
  planRequired: "plan_required",
  usageLimited: "usage_limited",
  outOfCredits: "out_of_credits",
  unavailable: "unavailable",
  noCode: "no_code",
  failed: "failed",
} as const;

/** Every reason an AI route can refuse or fail with */
export type ErrorReason = keyof typeof ERROR_CODES;
