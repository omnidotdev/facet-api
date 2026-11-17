---
"@omnidotdev/facet-api": minor
---

feat(billing): bill managed AI to the user's personal workspace

Managed AI generation and critique now bill the signed-in user's personal workspace instead of the user directly, matching how plans are bought in the Omni account hub. A Facet Pro plan purchased there now applies in Facet: its tier, its included credits, and its pooled balance. `GET /capabilities` reports that workspace's tier and credit balance and adds `workspace.slug` so the app can link to the workspace's plan and credits. A sign-in that does not carry the personal workspace (for example one made before Facet asked for workspace access) is asked to sign in again: managed AI returns `401` and `GET /capabilities` reports `reauthRequired: true`, and it is never billed elsewhere. Gateway refusals now map to clearer messages: a reached usage limit returns `429` and a plan that does not include managed AI returns `403`.
