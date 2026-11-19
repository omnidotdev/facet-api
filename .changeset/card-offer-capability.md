---
"@omnidotdev/facet-api": minor
---

Tell the app when free AI credits are offered

`/capabilities` adds `cardOffer: { monthlyCredits }` to a refused (`paymentRequired`) answer while Aether offers card-verified free AI credits, so the app offers "Add a card" only while the offer is live. Read from Aether's public offer endpoint; any failure means no offer.
