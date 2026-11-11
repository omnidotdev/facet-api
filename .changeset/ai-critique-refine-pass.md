---
"@omnidotdev/facet-api": minor
---

Add a render-critic refine path to `POST /generate`. A `refine` body (`{ code, suggestion }`) builds an "improve this model" turn from the prior code and the vision critic's visual suggestion, distinct from a kernel-error repair (no thrown error in the framing). This lets the client automatically refine a generation the critic judged off, instead of surfacing raw instructions to the user. Metering, gating, and money-safety are unchanged (a refine is an ordinary metered generate call).
