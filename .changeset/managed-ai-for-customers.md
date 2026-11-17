---
"@omnidotdev/facet-api": minor
---

feat(billing): make managed AI a paying-customer feature

Managed AI generation and critique are now available only to paying customers: a workspace on a paid Facet plan, or one that has bought Omni credits. Free monthly credit grants alone no longer unlock managed AI. A workspace that has not paid gets `402` with `code: "payment_required"` and a message to buy credits, upgrade to Pro, or use its own key, and is never charged. Using your own Synapse key keeps working for everyone. `GET /capabilities` now reports `paymentRequired: true` (with the tier, workspace, and credit balance when known) for a signed-in user who has not paid, so the app can offer those options. Error bodies from `/generate` and `/critique` now include a stable `code` alongside the message, so the app can tell "not a paying customer" (`payment_required`) apart from "out of credits" (`out_of_credits`).
