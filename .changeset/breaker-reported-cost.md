---
"@omnidotdev/facet-api": patch
---

Record the gateway-reported real cost on the free-tier spend breaker. The shared Synapse client now reads each call's pre-margin provider cost from the gateway (`x-synapse-provider-cost-usd`), so the breaker records what a generation or critique actually cost upstream instead of a list-rate estimate; the estimate remains the fallback when the gateway reports no cost
