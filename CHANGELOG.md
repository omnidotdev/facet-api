# @omnidotdev/facet-api

## 0.5.0

### Minor Changes

- [#57](https://github.com/omnidotdev/facet-api/pull/57) [`ab8c7c1`](https://github.com/omnidotdev/facet-api/commit/ab8c7c135522f96f0a6bbc32c9ccf6f69ba59dd8) Thanks [@coopbri](https://github.com/coopbri)! - Managed AI generation can now run in the background. `POST /generations` runs the same checks as `/generate` and queues the generation as a job, so it keeps going and its result waits even if the panel is closed or the page is left. `GET /generations` lists your recent jobs, `GET /generations/:id` reads one, and `DELETE /generations/:id` dismisses one. You can have up to 3 generations queued or running at once. A job's prompt and result are deleted when you dismiss it or 24 hours after it was queued, whichever comes first. A generation cut short by a restart is marked as interrupted so you can try again; it is never re-run (and re-billed) on its own. Your own Synapse key still uses the synchronous `/generate`, and older clients keep working.

- [#54](https://github.com/omnidotdev/facet-api/pull/54) [`2b67223`](https://github.com/omnidotdev/facet-api/commit/2b67223843908872f9552bf96c75a4613a9169a8) Thanks [@coopbri](https://github.com/coopbri)! - feat(billing): bill managed AI to the user's personal workspace

  Managed AI generation and critique now bill the signed-in user's personal workspace instead of the user directly, matching how plans are bought in the Omni account hub. A Facet Pro plan purchased there now applies in Facet: its tier, its included credits, and its pooled balance. `GET /capabilities` reports that workspace's tier and credit balance and adds `workspace.slug` so the app can link to the workspace's plan and credits. A sign-in that does not carry the personal workspace (for example one made before Facet asked for workspace access) is asked to sign in again: managed AI returns `401` and `GET /capabilities` reports `reauthRequired: true`, and it is never billed elsewhere. Gateway refusals now map to clearer messages: a reached usage limit returns `429` and a plan that does not include managed AI returns `403`.

- [#59](https://github.com/omnidotdev/facet-api/pull/59) [`56218b2`](https://github.com/omnidotdev/facet-api/commit/56218b2887ff916bd306d218254bf7d852fd4075) Thanks [@coopbri](https://github.com/coopbri)! - Tell the app when free AI credits are offered

  `/capabilities` adds `cardOffer: { monthlyCredits }` to a refused (`paymentRequired`) answer while Aether offers card-verified free AI credits, so the app offers "Add a card" only while the offer is live. Read from Aether's public offer endpoint; any failure means no offer.

- [#58](https://github.com/omnidotdev/facet-api/pull/58) [`091fb6c`](https://github.com/omnidotdev/facet-api/commit/091fb6c08bb355f5de2c9adfef186fcd2421b638) Thanks [@coopbri](https://github.com/coopbri)! - Serve the card-verified free AI allowance

  A free workspace whose owner verified a card on the account hub (Aether funding `cardVerified`) may now use managed generation; the gateway holds it to the free model, and its spend counts toward the free-tier daily breaker. `/capabilities` reports it as `freeAllowance: true`. Workspaces without a paid tier, bought credits, or a verified card are refused as before.

- [#50](https://github.com/omnidotdev/facet-api/pull/50) [`88b8e34`](https://github.com/omnidotdev/facet-api/commit/88b8e34b086c02e4545308f8816ab750e4cb5f7c) Thanks [@coopbri](https://github.com/coopbri)! - feat(consent): unify AI-training consent onto the central platform ledger

  The in-app data-sharing toggle now forwards each decision to the Omni platform consent ledger (omni-api), so a user's opt-in is recorded fleet-wide and reflected on other surfaces such as the account hub. Facet also consumes `platform.consent.changed` at `/webhooks/consent` (signature-verified), so a withdrawal made on any surface erases this user's stored samples here too. The local user row stays the capture-gate projection; forwarding is best-effort and never blocks the user's own toggle.

- [#55](https://github.com/omnidotdev/facet-api/pull/55) [`013750a`](https://github.com/omnidotdev/facet-api/commit/013750afadf1507bbdd2359f0348c6462859ff30) Thanks [@coopbri](https://github.com/coopbri)! - feat(billing): make managed AI a paying-customer feature

  Managed AI generation and critique are now available only to paying customers: a workspace on a paid Facet plan, or one that has bought Omni credits. Free monthly credit grants alone no longer unlock managed AI. A workspace that has not paid gets `402` with `code: "payment_required"` and a message to buy credits, upgrade to Pro, or use its own key, and is never charged. Using your own Synapse key keeps working for everyone. `GET /capabilities` now reports `paymentRequired: true` (with the tier, workspace, and credit balance when known) for a signed-in user who has not paid, so the app can offer those options. Error bodies from `/generate` and `/critique` now include a stable `code` alongside the message, so the app can tell "not a paying customer" (`payment_required`) apart from "out of credits" (`out_of_credits`).

- [#63](https://github.com/omnidotdev/facet-api/pull/63) [`aca3ed3`](https://github.com/omnidotdev/facet-api/commit/aca3ed3f4bd055598799c145b081f130da2e48f2) Thanks [@coopbri](https://github.com/coopbri)! - Ask for a change to a model you already have open. `POST /generate` takes an optional `edit: { code, params }`: the prompt is the change ("make the ring thicker"), the code is the current model, `params` holds its current slider values, and the reply is the whole updated model with everything else kept and each slider's current value carried into its default. A repair of the edited model keeps the request in view. Edits are capped by `MAX_CODE_CHARS` (default 100000), run only on `/generate` (`POST /generations` refuses them with `bad_input`), are marked `edited` in the `facet.generation.completed` event, and are never captured as training samples.

### Patch Changes

- [#64](https://github.com/omnidotdev/facet-api/pull/64) [`8de633d`](https://github.com/omnidotdev/facet-api/commit/8de633d8647fc15b60da877af61a082a29f7e345) Thanks [@coopbri](https://github.com/coopbri)! - The production build now runs in production mode, so API errors no longer include internal details and GraphQL runs without development overhead

- [#56](https://github.com/omnidotdev/facet-api/pull/56) [`8911674`](https://github.com/omnidotdev/facet-api/commit/891167441a27eb8cc2c7820d90764f8da0a3efae) Thanks [@coopbri](https://github.com/coopbri)! - Fix AI generation failing with "Could not generate valid code" on more detailed parts. Current models think before answering, and that thinking counts toward the output limit, so 2,048 tokens could run out before the code finished. The output limit is now 8,192 tokens (the catalog's per-request maximum) with a 90 second timeout to match, and a generation that still runs out returns a clear `truncated` error asking for a simpler description instead of the generic one.

- [#53](https://github.com/omnidotdev/facet-api/pull/53) [`94bafdd`](https://github.com/omnidotdev/facet-api/commit/94bafdd76bbeaa45502fada10850d27b1af42541) Thanks [@coopbri](https://github.com/coopbri)! - Security: the GraphQL endpoint no longer exposes any data or write operations. Facet's features run entirely through its authenticated routes, so nothing changes for users.

- [#60](https://github.com/omnidotdev/facet-api/pull/60) [`875ae6d`](https://github.com/omnidotdev/facet-api/commit/875ae6ddc9c5fcacf9f97015d5672fcbaca45ae0) Thanks [@coopbri](https://github.com/coopbri)! - Generated models now label their sliders with units: lengths read in millimeters and angles in degrees.

- [#62](https://github.com/omnidotdev/facet-api/pull/62) [`ed8a359`](https://github.com/omnidotdev/facet-api/commit/ed8a3592acdac3d9bc046d505bd9d4ebeb496c56) Thanks [@coopbri](https://github.com/coopbri)! - Describe a part asks for colors when you want them: the AI can now color parts with `.color()`, and builds two-color inlays and labels as separate, touching parts that export to 3MF for multi-color printing.

- [#61](https://github.com/omnidotdev/facet-api/pull/61) [`4241afc`](https://github.com/omnidotdev/facet-api/commit/4241afcdefa98b5b1683e693f3e54f8bf90aa83c) Thanks [@coopbri](https://github.com/coopbri)! - Move to the `@omnidotdev/providers` v0.2.0 release.

## 0.4.0

### Minor Changes

- [#48](https://github.com/omnidotdev/facet-api/pull/48) [`1ca02b4`](https://github.com/omnidotdev/facet-api/commit/1ca02b4d3aaf784151871e616bf2f9d2aee01acf) Thanks [@coopbri](https://github.com/coopbri)! - Add the opt-in AI training-data dataset. A signed-in user can consent (default off) to Facet retaining their prompts and generated models to improve its AI, set through the new `POST /consent` route and reflected on `/capabilities`. Consent is recorded with the terms version it was given under and an immutable `facet.user.consent_changed` audit event, so a later change to what is collected requires fresh consent rather than relying on a stale grant. A generation retains its prompt and final code only for a user who has opted in under the current terms, and never the prompt or code of anyone else. Withdrawing consent stops collection and erases that user's stored samples.

## 0.3.0

### Minor Changes

- [#47](https://github.com/omnidotdev/facet-api/pull/47) [`d26a0cf`](https://github.com/omnidotdev/facet-api/commit/d26a0cfdf2661d6b16c17ce6b1583eb69abc3117) Thanks [@coopbri](https://github.com/coopbri)! - Capture a correlated, metadata-only trace of each generation so the AI loop's quality is measurable: the groundwork for choosing models and tuning the loop from evidence rather than guesses.
  - `/generate` mints a `generationId`, returns it, and emits it as the correlation id on `facet.generation.completed` (now also flagged `refined`). The client echoes the id on a refine or repair re-entry, so a whole loop threads into one chain.
  - `/critique` now emits `facet.generation.critiqued` with the verdict (`ok`, `score`, issue count) and usage, correlated to the same generation. The critique pass was previously invisible to telemetry.
  - New `POST /disposition` records the human-in-the-loop signal the server cannot see on its own (kept / discarded / regenerated) as `facet.generation.<disposition>`, correlated to the generation. It spends no money, stores nothing, is unauthenticated so a BYOK user's signal is not lost, and is bounded by the per-IP limiter.

  Every event is metadata only: a model id, token counts, real cents, a verdict, a disposition. The prompt and generated code are never emitted, and no credits (the gateway owns billing).

### Patch Changes

- [#43](https://github.com/omnidotdev/facet-api/pull/43) [`67d92a4`](https://github.com/omnidotdev/facet-api/commit/67d92a4c8a4065e8d59d4602353b0047446cfb94) Thanks [@coopbri](https://github.com/coopbri)! - Record the gateway-reported real cost on the free-tier spend breaker. The shared Synapse client now reads each call's pre-margin provider cost from the gateway (`x-synapse-provider-cost-usd`), so the breaker records what a generation or critique actually cost upstream instead of a list-rate estimate; the estimate remains the fallback when the gateway reports no cost

## 0.2.0

### Minor Changes

- [#41](https://github.com/omnidotdev/facet-api/pull/41) [`16388fd`](https://github.com/omnidotdev/facet-api/commit/16388fd7b84b9b93f9876c8f7d7bf715abf10fb2) Thanks [@coopbri](https://github.com/coopbri)! - Bill managed AI through product-scoped Synapse keys against the user's pooled Aether credit balance. Managed calls now provision a key for the `facet` app billed to the signed-in user, with no fallback to a shared key (`503` when provisioning fails). A gateway `402` surfaces as out of credits and is never retried on the backup model; a gateway `503` surfaces as unavailable. `/capabilities` reports the pooled balance in whole credits plus the user's tier, and `/generate` no longer returns locally computed credits. The local credit ledger (the `credit_ledger` table is dropped by migration `0004`), the entitlement cap resolver, and local cost-to-credit math are removed, guarded by a test. The free-tier daily spend breaker now records whole cents rounded up, fixing writes that the integer `spent_cents` column rejected, and gates by the Aether `tier` entitlement. New env: `BILLING_SERVICE_API_KEY`; removed: `SYNAPSE_API_KEY`, `FREE_MONTHLY_CREDITS`, `CREDIT_COGS_MARKUP`.

## 0.1.1

### Patch Changes

- [#39](https://github.com/omnidotdev/facet-api/pull/39) [`51082c7`](https://github.com/omnidotdev/facet-api/commit/51082c735b082bef91374c6267eda03c50ba579b) Thanks [@coopbri](https://github.com/coopbri)! - cost: convert model spend to credits through the shared `creditsFromCostCents` / `DEFAULT_CREDIT_COGS_MARKUP` from `@omnidotdev/providers` instead of a local `ceil(costCents * markup)` and a duplicate markup constant. One fleet definition of the cost-to-credit unit; behavior is unchanged (same formula, same default markup).

## 0.1.0

### Minor Changes

- [#35](https://github.com/omnidotdev/facet-api/pull/35) [`cf9c1da`](https://github.com/omnidotdev/facet-api/commit/cf9c1da22915600802cba1873ba3370bf245daf0) Thanks [@coopbri](https://github.com/coopbri)! - Add a render-critic refine path to `POST /generate`. A `refine` body (`{ code, suggestion }`) builds an "improve this model" turn from the prior code and the vision critic's visual suggestion, distinct from a kernel-error repair (no thrown error in the framing). This lets the client automatically refine a generation the critic judged off, instead of surfacing raw instructions to the user. Metering, gating, and money-safety are unchanged (a refine is an ordinary metered generate call).

- [#33](https://github.com/omnidotdev/facet-api/pull/33) [`2b0ea92`](https://github.com/omnidotdev/facet-api/commit/2b0ea92b14e3ac637fb2d3712ab79ed8120ada46) Thanks [@coopbri](https://github.com/coopbri)! - Add a metered, multimodal `POST /critique` route: hand a rendered image of a generated part to a vision model and get a structured verdict (`ok` / `score` / `issues` / `suggestedFix`) on whether it matches the request. It is the grounding step of the render-and-critique generation loop and mirrors `/generate`'s money-safety exactly (managed-identity gate, limited-preview allowlist, per-user monthly credit cap, free-tier daily breaker, per-IP limiter, metering; BYOK bypasses at zero cost). Bumps the `@omnidotdev/providers` pin to the multimodal Synapse client.

- [#36](https://github.com/omnidotdev/facet-api/pull/36) [`b5727bf`](https://github.com/omnidotdev/facet-api/commit/b5727bf605d49b6c45aa2e03b827febf532ce6af) Thanks [@coopbri](https://github.com/coopbri)! - Add a `POST /import` proxy route so the Studio can import SVG or image art by URL (the browser can't fetch cross-origin art itself). It spends no AI money and is SSRF-guarded: the target host is resolved and every resolved IP is checked against the blocked ranges (loopback, private, link-local/cloud-metadata, CGNAT, ULA, etc.), literal-IP hosts are rejected directly, each redirect hop is re-validated, and the response is bounded by a content-type whitelist (SVG and common raster types), a byte cap, and a timeout. The route is bounded by sign-in and the per-IP limiter. It returns SVG text (ready for `importSvg`) or base64 raster bytes for the client to vectorize. Guards live in `src/lib/import` with full unit coverage.

### Patch Changes

- [#32](https://github.com/omnidotdev/facet-api/pull/32) [`ee7109f`](https://github.com/omnidotdev/facet-api/commit/ee7109f235654b21ccaf6569c8579146be023538) Thanks [@coopbri](https://github.com/coopbri)! - The `/capabilities` endpoint now returns the signed-in user's monthly managed credit balance (`used` / `cap` / `remaining`) alongside the existing capability flags, so the Studio can show how many generations are left this month and give the per-generation credit cost meaning. Returned only for a user who can actually spend managed credits; a meter failure degrades to omitting the balance and never blocks the probe.

- [#12](https://github.com/omnidotdev/facet-api/pull/12) [`5b4e726`](https://github.com/omnidotdev/facet-api/commit/5b4e726dd79a782a3c1500ec30f73dbef4872831) Thanks [@coopbri](https://github.com/coopbri)! - Do not crash at boot when `CORS_ALLOWED_ORIGINS` is unset. The origin was read as `CORS_ALLOWED_ORIGINS!.split(",")`, so an absent value threw at startup. Parse it centrally in `env.config` as `corsAllowedOrigins`, warning and defaulting to the local app origin when unset, so optional config degrades gracefully.

- [#36](https://github.com/omnidotdev/facet-api/pull/36) [`b5727bf`](https://github.com/omnidotdev/facet-api/commit/b5727bf605d49b6c45aa2e03b827febf532ce6af) Thanks [@coopbri](https://github.com/coopbri)! - Update the `importSvg` guidance in the generation system prompt: it now documents that `importSvg` accepts a whole `<svg>` document (paths plus basic shapes and `transform` attributes), not only a bare path `d` string, and reminds the model to use it only for SVG the user actually provides and to `.scale(...)`/`.translate(...)` the result to size.

- [#31](https://github.com/omnidotdev/facet-api/pull/31) [`8d134c8`](https://github.com/omnidotdev/facet-api/commit/8d134c8b5e1cd1c7f6adbead11c30e453a17702a) Thanks [@coopbri](https://github.com/coopbri)! - Insulate paid managed-AI users from the free-tier spend breaker. The global daily spend breaker now gates the free allowance only: a user on a paid tier (a monthly credit cap above the free allowance) is bounded by their own revenue-backed per-user cap, and is neither blocked by nor recorded against the breaker. This keeps free-tier abuse (Sybil account farming) from exhausting the shared daily ceiling and denying service to paying customers, while leaving the absolute money-safety bound on free usage unchanged.

- [#34](https://github.com/omnidotdev/facet-api/pull/34) [`cdb2a3f`](https://github.com/omnidotdev/facet-api/commit/cdb2a3f2b060e5b8edf76c6e67fd6e4f5a2878d8) Thanks [@coopbri](https://github.com/coopbri)! - Fix the generation prompt's glyph guidance, which told the model to hand-author SVG paths for named glyphs/logos (a zodiac sign, a company mark) - something LLMs cannot do accurately, so "scorpio symbol" came out as a garbled path. Now: use `text()` for letters/digits/words (precise via the bundled font), reserve `importSvg` for an SVG path the user actually provides, and build geometric symbols from primitives + a 2D sketch. Improves first-try quality for the common "describe a symbol/letter" cases.

- [#30](https://github.com/omnidotdev/facet-api/pull/30) [`add1019`](https://github.com/omnidotdev/facet-api/commit/add1019d45c010a79240051f34db726d911790c9) Thanks [@coopbri](https://github.com/coopbri)! - Teach the code-generation prompt the modeling operations that shipped in the app: `cone` (cone, tapered cylinder, and frustum), `hull` (convex hull), `polyhedron` (a solid from explicit vertices and faces), and the 2D sketch transforms (`translate`/`move`/`rotate`/`scale`/`mirror`). The prompt now covers the full current authoring surface, including the symmetric-profile pattern of mirroring one half (`half.union(half.mirror([1, 0]))`), with new guidance and worked examples so generated models use these instead of working around them.
