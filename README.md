# 📐 Facet API

The Facet AI generation gateway. A thin [Elysia](https://elysiajs.com) service whose entire job is to call the [Synapse](https://synapse.omni.dev) AI router **safely**, so natural-language prompts become parametric CAD code without ever exposing our model keys or letting anyone run up a bill against them.

Facet itself stays a static SPA for local modeling. This gateway owns what the browser must never hold: the gateway secret that provisions a product-scoped Synapse key for each signed-in user. It builds a grounded prompt from the Facet authoring API, calls Synapse's Anthropic-compatible `POST /v1/messages` with that key, extracts the fenced TypeScript block, and returns it.

Billing is the Synapse gateway's job, not this service's. A managed call carries a key scoped to the `facet` Aether app and billed to the user, so the gateway checks the user's credit balance (refusing with `402` before any spend when it is empty), meters the call, and debits the balance. That balance is one pooled Aether balance per billing account, shared across every Omni product (1 credit = $0.01). Facet keeps no credit ledger and computes no credits of its own.

## What it exposes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/generate` | Turn a prompt into Facet TypeScript. Managed (product-scoped key, billed to the user's credits) or BYOK (caller's key). |
| `POST` | `/critique` | Score a render of a generated part against the request (vision). Same gating as `/generate`. |
| `GET` | `/capabilities` | Whether the caller may use managed generation, plus their tier and pooled credit balance. |
| `GET` | `/health` | Liveness. |
| `GET` | `/ready` | Readiness (DB connectivity, used from Phase C on). |

### `POST /generate`

Request:

```jsonc
{
  "prompt": "a 20mm cube with a 6mm hole through it",
  "byokKey": "sk-ant-...",          // optional, bring-your-own-key
  "previous": {                      // optional, repair turn
    "code": "<prior code>",
    "error": "<kernel error text>"
  }
}
```

The managed path (no `byokKey`) requires a signed-in Omni user: send the user's access token as `Authorization: Bearer <token>` (the same Better Auth / Gatekeeper token the rest of the fleet uses). A missing or invalid token returns `401`; a user whose credit balance is empty gets `402` (out of credits: buy more credits in the Omni account hub); a temporarily unavailable gateway or a failed key provisioning returns `503`. BYOK requests need no auth and never touch Facet credits.

Response:

```jsonc
{
  "code": "const part = cube(20).subtract(cylinder(3, 24));\nreturn part;"
}
```

- No credit figure is returned: the gateway debits the balance, and the app shows the refreshed balance from `GET /capabilities`.
- The `previous` field drives the client-side repair loop: on a kernel throw the app re-calls `/generate` with the failing code plus the error so the model can fix it.

## Money-safety model

Defense-in-depth. Each layer is independent, so a bug in one does not defeat the others:

1. **No shared managed key.** Every managed call uses a per-user key provisioned via `SYNAPSE_API_URL` + `SYNAPSE_GATEWAY_SECRET` and scoped to the `facet` Aether app. If provisioning is not configured or fails, managed AI returns `503`; there is no fallback to an unbilled shared key. The gateway secret lives only here, never `VITE_`-prefixed, never in a response body or a log.
2. **Gateway-enforced credits.** The Synapse gateway checks the user's pooled Aether balance before spending (`402` when empty, surfaced as "out of credits") and debits it after. A `402` is never retried on the backup model.
3. **Free-tier daily spend breaker.** Aggregate free-tier managed spend is tracked per UTC day in real cents (whole cents, rounded up) in the `daily_spend` table; free users get `503` once `DAILY_SPEND_CEILING_CENTS` is hit. The user's tier comes from the Aether `tier` entitlement, so paid users are never blocked by free-tier abuse. Spend is the gateway's reported cost when present, else an estimate from list prices; the estimate feeds only this backstop, never billing.
4. **Auth-gated managed path.** The managed path requires a valid signed-in Omni identity (bearer token verified via Gatekeeper); no anonymous access to paid inference, `401` otherwise.
5. **Per-request caps.** `MAX_PROMPT_CHARS`, `MAX_OUTPUT_TOKENS`, a request timeout, and `MAX_REPAIR_ATTEMPTS`, all enforced server-side.
6. **Per-IP rate limit.** Sliding-window limiter on `/generate`; `429` on exceed.
7. **BYOK escape hatch.** A caller may send their own key per-request over TLS. It is never persisted, bills to them, and bypasses auth, the breaker, and provisioning entirely.

> A guard test (`src/__tests__/unit/billingGuard.test.ts`) fails the build if a local credit ledger, a cost-to-credit conversion, or a billing rate table reappears. The per-IP rate limiter stays in-memory (see the `TODO` in `rateLimit.ts`).

## Environment

The service boots with nothing set. Every variable is optional; the managed path is the only feature that needs configuration, and it degrades to a clean `503` (with a startup warning) when provisioning is not configured.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SYNAPSE_BASE_URL` | `http://localhost:6000` | Synapse AI router base URL. |
| `SYNAPSE_API_URL` | _(unset)_ | Synapse provisioning API (api.synapse, not the gateway). Required, with `SYNAPSE_GATEWAY_SECRET`, for managed generation. |
| `SYNAPSE_GATEWAY_SECRET` | _(unset)_ | Gateway secret for the internal provisioning call. Required, with `SYNAPSE_API_URL`, for managed generation. Never shipped to the browser. |
| `FACET_AI_MODEL` | `auto` | Model passed through to Synapse (a virtual routed model or a provider-prefixed id). |
| `FACET_AI_FALLBACK_MODEL` | `anthropic/claude-sonnet-4-5-20250929` | Concrete model used if the gateway refuses a virtual model (never on a `402`). |
| `MAX_PROMPT_CHARS` | `2000` | Maximum accepted prompt length. |
| `MAX_OUTPUT_TOKENS` | `2048` | Output token ceiling per call. |
| `AI_REQUEST_TIMEOUT_MS` | `30000` | Synapse request timeout. |
| `MAX_REPAIR_ATTEMPTS` | `2` | Repair-attempt ceiling per generation. |
| `DAILY_SPEND_CEILING_CENTS` | `500` | Free-tier managed spend breaker, real cents per UTC day. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Per-IP rate-limit window. |
| `RATE_LIMIT_MAX` | `20` | Max requests per IP per window. |
| `AUTH_BASE_URL` | `https://localhost:8000` | Gatekeeper base URL used to verify the managed path's bearer token. |
| `DATABASE_URL` | _(unset)_ | Postgres connection for the daily spend breaker. The free-tier managed path needs it; BYOK does not. |
| `BILLING_BASE_URL` | _(unset)_ | Aether base URL, for the user's tier and pooled credit balance. Unset: everyone reads as free tier and no balance is shown. |
| `BILLING_SERVICE_API_KEY` | _(unset)_ | Aether service API key (`x-service-api-key`), required for the credit balance read. |
| `BILLING_WEBHOOK_SECRET` | _(unset)_ | Verifies Aether entitlement webhooks, which invalidate the cached tier. |

The managed path depends on `SYNAPSE_API_URL`, `SYNAPSE_GATEWAY_SECRET`, `AUTH_BASE_URL`, `DATABASE_URL`, and (for the tier and balance) `BILLING_BASE_URL` + `BILLING_SERVICE_API_KEY`; BYOK needs none of them. GraphQL and Vortex variables remain scaffolding. See [`.env.local.template`](.env.local.template) for the full list.

## Local development

```sh
cp .env.local.template .env.local   # optional, the service boots with no env set
bun install
bun dev
```

The service boots with **no env configured**: if `SYNAPSE_API_URL` or `SYNAPSE_GATEWAY_SECRET` is unset it logs a warning and the managed path returns a clean `503`, while BYOK requests still work. See [`.env.local.template`](.env.local.template) for required vs optional variables.

## Testing

```sh
bun test            # the breaker integration test needs Docker or TEST_DATABASE_URL, and skips otherwise
bun run check       # Biome lint + format
bunx tsc --noEmit   # type check
bun run knip        # dead code + unused deps
bun run build       # bundle
```

## License

The code in this repository is licensed under Apache 2.0, &copy; [Omni LLC](https://omni.dev). See [LICENSE.md](LICENSE.md) for more information.
