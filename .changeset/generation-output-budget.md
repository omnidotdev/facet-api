---
"@omnidotdev/facet-api": patch
---

Fix AI generation failing with "Could not generate valid code" on more detailed parts. Current models think before answering, and that thinking counts toward the output limit, so 2,048 tokens could run out before the code finished. The output limit is now 8,192 tokens (the catalog's per-request maximum) with a 90 second timeout to match, and a generation that still runs out returns a clear `truncated` error asking for a simpler description instead of the generic one.
