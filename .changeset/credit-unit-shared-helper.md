---
"@omnidotdev/facet-api": patch
---

cost: convert model spend to credits through the shared `creditsFromCostCents` / `DEFAULT_CREDIT_COGS_MARKUP` from `@omnidotdev/providers` instead of a local `ceil(costCents * markup)` and a duplicate markup constant. One fleet definition of the cost-to-credit unit; behavior is unchanged (same formula, same default markup).
