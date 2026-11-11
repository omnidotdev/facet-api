---
"@omnidotdev/facet-api": minor
---

Add a `POST /import` proxy route so the Studio can import SVG or image art by URL (the browser can't fetch cross-origin art itself). It spends no AI money and is SSRF-guarded: the target host is resolved and every resolved IP is checked against the blocked ranges (loopback, private, link-local/cloud-metadata, CGNAT, ULA, etc.), literal-IP hosts are rejected directly, each redirect hop is re-validated, and the response is bounded by a content-type whitelist (SVG and common raster types), a byte cap, and a timeout. The route is bounded by sign-in and the per-IP limiter. It returns SVG text (ready for `importSvg`) or base64 raster bytes for the client to vectorize. Guards live in `src/lib/import` with full unit coverage.
