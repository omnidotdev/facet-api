---
"@omnidotdev/facet-api": minor
---

Add the opt-in AI training-data dataset. A signed-in user can consent (default off) to Facet retaining their prompts and generated models to improve its AI, set through the new `POST /consent` route and reflected on `/capabilities`. Consent is recorded with the terms version it was given under and an immutable `facet.user.consent_changed` audit event, so a later change to what is collected requires fresh consent rather than relying on a stale grant. A generation retains its prompt and final code only for a user who has opted in under the current terms, and never the prompt or code of anyone else. Withdrawing consent stops collection and erases that user's stored samples.
