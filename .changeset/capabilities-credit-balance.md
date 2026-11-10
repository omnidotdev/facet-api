---
"@omnidotdev/facet-api": patch
---

The `/capabilities` endpoint now returns the signed-in user's monthly managed credit balance (`used` / `cap` / `remaining`) alongside the existing capability flags, so the Studio can show how many generations are left this month and give the per-generation credit cost meaning. Returned only for a user who can actually spend managed credits; a meter failure degrades to omitting the balance and never blocks the probe.
