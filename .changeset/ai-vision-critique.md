---
"@omnidotdev/facet-api": minor
---

Add a metered, multimodal `POST /critique` route: hand a rendered image of a generated part to a vision model and get a structured verdict (`ok` / `score` / `issues` / `suggestedFix`) on whether it matches the request. It is the grounding step of the render-and-critique generation loop and mirrors `/generate`'s money-safety exactly (managed-identity gate, limited-preview allowlist, per-user monthly credit cap, free-tier daily breaker, per-IP limiter, metering; BYOK bypasses at zero cost). Bumps the `@omnidotdev/providers` pin to the multimodal Synapse client.
