---
"@omnidotdev/facet-api": patch
---

Do not crash at boot when `CORS_ALLOWED_ORIGINS` is unset. The origin was read as `CORS_ALLOWED_ORIGINS!.split(",")`, so an absent value threw at startup. Parse it centrally in `env.config` as `corsAllowedOrigins`, warning and defaulting to the local app origin when unset, so optional config degrades gracefully.
