---
"@omnidotdev/facet-api": patch
---

Fix the generation prompt's glyph guidance, which told the model to hand-author SVG paths for named glyphs/logos (a zodiac sign, a company mark) - something LLMs cannot do accurately, so "scorpio symbol" came out as a garbled path. Now: use `text()` for letters/digits/words (precise via the bundled font), reserve `importSvg` for an SVG path the user actually provides, and build geometric symbols from primitives + a 2D sketch. Improves first-try quality for the common "describe a symbol/letter" cases.
