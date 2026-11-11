---
"@omnidotdev/facet-api": patch
---

Update the `importSvg` guidance in the generation system prompt: it now documents that `importSvg` accepts a whole `<svg>` document (paths plus basic shapes and `transform` attributes), not only a bare path `d` string, and reminds the model to use it only for SVG the user actually provides and to `.scale(...)`/`.translate(...)` the result to size.
