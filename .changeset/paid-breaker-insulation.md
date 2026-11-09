---
"@omnidotdev/facet-api": patch
---

Insulate paid managed-AI users from the free-tier spend breaker. The global daily spend breaker now gates the free allowance only: a user on a paid tier (a monthly credit cap above the free allowance) is bounded by their own revenue-backed per-user cap, and is neither blocked by nor recorded against the breaker. This keeps free-tier abuse (Sybil account farming) from exhausting the shared daily ceiling and denying service to paying customers, while leaving the absolute money-safety bound on free usage unchanged.
