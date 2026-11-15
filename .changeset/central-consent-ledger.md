---
"@omnidotdev/facet-api": minor
---

feat(consent): unify AI-training consent onto the central platform ledger

The in-app data-sharing toggle now forwards each decision to the Omni platform consent ledger (omni-api), so a user's opt-in is recorded fleet-wide and reflected on other surfaces such as the account hub. Facet also consumes `platform.consent.changed` at `/webhooks/consent` (signature-verified), so a withdrawal made on any surface erases this user's stored samples here too. The local user row stays the capture-gate projection; forwarding is best-effort and never blocks the user's own toggle.
