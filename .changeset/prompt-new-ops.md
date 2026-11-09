---
"@omnidotdev/facet-api": patch
---

Teach the code-generation prompt the modeling operations that shipped in the app: `cone` (cone, tapered cylinder, and frustum), `hull` (convex hull), `polyhedron` (a solid from explicit vertices and faces), and the 2D sketch transforms (`translate`/`move`/`rotate`/`scale`/`mirror`). The prompt now covers the full current authoring surface, including the symmetric-profile pattern of mirroring one half (`half.union(half.mirror([1, 0]))`), with new guidance and worked examples so generated models use these instead of working around them.
