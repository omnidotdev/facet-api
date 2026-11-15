---
"@omnidotdev/facet-api": minor
---

Capture a correlated, metadata-only trace of each generation so the AI loop's quality is measurable: the groundwork for choosing models and tuning the loop from evidence rather than guesses.

- `/generate` mints a `generationId`, returns it, and emits it as the correlation id on `facet.generation.completed` (now also flagged `refined`). The client echoes the id on a refine or repair re-entry, so a whole loop threads into one chain.
- `/critique` now emits `facet.generation.critiqued` with the verdict (`ok`, `score`, issue count) and usage, correlated to the same generation. The critique pass was previously invisible to telemetry.
- New `POST /disposition` records the human-in-the-loop signal the server cannot see on its own (kept / discarded / regenerated) as `facet.generation.<disposition>`, correlated to the generation. It spends no money, stores nothing, is unauthenticated so a BYOK user's signal is not lost, and is bounded by the per-IP limiter.

Every event is metadata only: a model id, token counts, real cents, a verdict, a disposition. The prompt and generated code are never emitted, and no credits (the gateway owns billing).
