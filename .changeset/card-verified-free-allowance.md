---
"@omnidotdev/facet-api": minor
---

Serve the card-verified free AI allowance

A free workspace whose owner verified a card on the account hub (Aether funding `cardVerified`) may now use managed generation; the gateway holds it to the free model, and its spend counts toward the free-tier daily breaker. `/capabilities` reports it as `freeAllowance: true`. Workspaces without a paid tier, bought credits, or a verified card are refused as before.
