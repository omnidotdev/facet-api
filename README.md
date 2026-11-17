# 📐 Facet API

The Facet AI generation gateway. A thin [Elysia](https://elysiajs.com) service whose entire job is to call the [Synapse](https://synapse.omni.dev) AI router **safely**, so natural-language prompts become parametric CAD code without ever exposing our model keys or letting anyone run up a bill against them.

Facet itself stays a static SPA for local modeling. This gateway owns what the browser must never hold: the gateway secret that provisions a product-scoped Synapse key for each signed-in user. It builds a grounded prompt from the Facet authoring API, calls Synapse's Anthropic-compatible `POST /v1/messages` with that key, extracts the fenced TypeScript block, and returns it.

Billing is the Synapse gateway's job, not this service's. A managed call carries a key scoped to the `facet` Aether app and billed to the signed-in user's **personal workspace** (the Omni organization Gatekeeper creates for every user), so the gateway checks that workspace's plan and credit balance (refusing with `402` before any spend when it is empty), meters the call, and debits the balance. This is the same billing account the Omni account hub puts a paid plan, its `tier` entitlement, and its included credits on, so a plan bought there applies in Facet. That balance is one pooled Aether balance per billing account, shared across every Omni product (1 credit = $0.01). Facet keeps no credit ledger and computes no credits of its own. Identity concerns (the managed whitelist, rate limiting, telemetry, and AI-training consent) stay per user.

## What it exposes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/generate` | Turn a prompt into Facet TypeScript. Managed (product-scoped key, billed to the personal workspace's credits) or BYOK (caller's key). |
| `POST` | `/generations` | Queue a managed generation as a background job (same gates as `/generate`), `202 { job }`. Managed only. |
| `GET` | `/generations` | The caller's own recent jobs (up to 20), newest first. |
| `GET` | `/generations/:id` | One of the caller's jobs (`404` otherwise). |
| `DELETE` | `/generations/:id` | Dismiss one of the caller's jobs, deleting its prompt and result (`204`). |
| `POST` | `/critique` | Score a render of a generated part against the request (vision). Same gating as `/generate`. |
| `GET` | `/capabilities` | Whether the caller may use managed generation, plus their personal workspace's tier, pooled credit balance, and slug (`workspace.slug`, for account-hub links). A signed-in user whose workspace has no paid tier and never bought credits gets `managedGeneration: false` with `paymentRequired: true` (plus `tier`, `workspace`, and `credits` when known) so the app can offer buy credits, upgrade, or BYOK. |
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

The managed path (no `byokKey`) requires a signed-in Omni user: send the user's access token as `Authorization: Bearer <token>` (the same Better Auth / Gatekeeper token the rest of the fleet uses). The token must carry the `organization` scope, since the personal workspace is read from the Gatekeeper userinfo organizations claim (`https://manifold.omni.dev/@omni/claims/organizations`, the entry with `type: "personal"`). A missing or invalid token returns `401`; a workspace that is not a paying customer (no paid Facet tier and no Omni credit purchase; free grants alone do not count) gets `402` with `code: "payment_required"` (buy credits, upgrade to Pro, or use your own key); a paying workspace whose credit balance is empty gets `402` with `code: "out_of_credits"` (buy more credits in the Omni account hub); a plan that does not grant managed AI gets `403`; a workspace that has reached its usage limit gets `429`; a signed-in token with no personal workspace in its claims (e.g. issued without the `organization` scope) returns `401` asking the user to sign in again, never a fallback to billing the user, and `GET /capabilities` reports `reauthRequired: true`; a temporarily unavailable gateway or a failed key provisioning returns `503`. BYOK requests need no auth and never touch Facet credits. Every error body carries a human `error` message and a stable `code` (e.g. `payment_required`, `out_of_credits`, `plan_required`, `usage_limited`, `reauth_required`, `unavailable`) for the client to branch on.

Response:

```jsonc
{
  "code": "const part = cube(20).subtract(cylinder(3, 24));\nreturn part;"
}
```

- No credit figure is returned: the gateway debits the balance, and the app shows the refreshed balance from `GET /capabilities`.
- The `previous` field drives the client-side repair loop: on a kernel throw the app re-calls `/generate` with the failing code plus the error so the model can fix it.

### Background generation (`/generations`)

A managed generation takes a minute or two, so the app queues it as a job instead of holding a request open: it keeps running, and its result waits, if the user closes the panel or leaves the page.

- `POST /generations` takes the same body as `/generate` without `byokKey` (a caller's own key is never stored, so BYOK is refused with `400` `bad_input` and stays on `/generate`). It runs every `/generate` gate first, in the same order and with the same status codes and `code`s (`bad_prompt`, `rate_limited`, `repair_limited`, `unauthorized`, `reauth_required`, `not_allowed`, `payment_required`, `plan_required`, `unavailable`), then refuses a user who already has `MAX_ACTIVE_GENERATION_JOBS` queued or running with `429` `too_many_jobs`. On acceptance it answers `202 { job }`.
- A job is `{ id, kind, status, prompt, generationId, code?, error?, createdAt, startedAt, finishedAt, expiresAt }`: `kind` is `draft`, `repair`, or `refine`; `status` is `queued`, `running`, `succeeded` (with `code`), or `failed` (with `error: { code, message, status }`, the same code, user-safe message, and HTTP status `/generate` would have answered, e.g. `out_of_credits`, `no_code`, `truncated`, or `interrupted`).
- An in-process worker runs queued jobs, at most `GENERATION_WORKER_CONCURRENCY` per instance, doing exactly what `/generate` does (the shared `generationCore.ts`). Claims use `FOR UPDATE SKIP LOCKED`, so replicas never run the same job. The managed key is provisioned again when the job runs, never stored. A job is never retried automatically, since its Synapse call may already have been billed: a running job whose process stops (a crash or a redeploy) is failed with `code: "interrupted"` ("Generation was interrupted. Try again."), at once on a graceful shutdown, or within about two minutes when its heartbeat goes stale.
- Retention: a job's row, including its prompt and result code, is deleted when the user dismisses it or 24 hours after it was queued, whichever comes first (`expires_at`; expired jobs are hidden immediately and deleted by the worker's sweep about once a minute). Jobs are not the AI-training dataset; that stays the opt-in `generation_sample` table.

## Money-safety model

Defense-in-depth. Each layer is independent, so a bug in one does not defeat the others:

1. **No shared managed key.** Every managed call uses a per-user key billed to the user's personal workspace, provisioned via `SYNAPSE_API_URL` + `SYNAPSE_GATEWAY_SECRET` and scoped to the `facet` Aether app. If provisioning is not configured or fails, managed AI returns `503`; there is no fallback to an unbilled shared key. The gateway secret lives only here, never `VITE_`-prefixed, never in a response body or a log.
2. **Gateway-enforced credits.** The Synapse gateway checks the personal workspace's pooled Aether balance before spending (`402` when empty, surfaced as "out of credits") and debits it after. A `402` is never retried on the backup model.
3. **Paying customers only.** Facet Free includes no managed AI. Managed AI requires a paid Facet tier (the personal workspace's Aether `tier` entitlement) or a workspace that has bought Omni credits (Aether's `GET /credits/facet/organization/:id/funding`, lifetime purchases net of refunds above zero). Free monthly credit grants alone never qualify, so farmed free accounts cannot spend the managed budget. A non-payer gets `402` with `code: "payment_required"` before any key is provisioned or spend happens, and can still buy credits, upgrade, or use their own key. Funding is read only for a free tier and fails closed: an Aether outage, timeout, or malformed answer reads as not paying.
4. **Non-paying daily spend breaker (belt-and-braces).** Non-paying managed spend is tracked per UTC day in real cents (whole cents, rounded up) in the `daily_spend` table and returns `503` once `DAILY_SPEND_CEILING_CENTS` is hit. Non-payers are already refused by layer 3, so the breaker never blocks or counts a paying customer and only engages if eligibility is ever widened. Spend is the gateway's reported cost when present, else an estimate from list prices; the estimate feeds only this backstop, never billing.
5. **Auth-gated managed path.** The managed path requires a valid signed-in Omni identity (bearer token verified via Gatekeeper); no anonymous access to paid inference, `401` otherwise.
6. **Per-request caps.** `MAX_PROMPT_CHARS`, `MAX_OUTPUT_TOKENS`, a request timeout, and `MAX_REPAIR_ATTEMPTS`, all enforced server-side.
7. **Per-IP rate limit.** Sliding-window limiter on `/generate` and `POST /generations`; `429` on exceed. A user may also have at most `MAX_ACTIVE_GENERATION_JOBS` background jobs queued or running at once.
8. **BYOK escape hatch.** A caller may send their own key per-request over TLS. It is never persisted, bills to them, and bypasses auth, the payment gate, the breaker, and provisioning entirely.

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
| `MAX_OUTPUT_TOKENS` | `8192` | Output token ceiling per call, including the model's hidden thinking. |
| `AI_REQUEST_TIMEOUT_MS` | `90000` | Synapse request timeout. |
| `MAX_REPAIR_ATTEMPTS` | `2` | Repair-attempt ceiling per generation. |
| `DAILY_SPEND_CEILING_CENTS` | `500` | Non-paying managed spend breaker, real cents per UTC day. Must be a positive integer: `0` or an invalid value falls back to `500` (it cannot disable the breaker); `1` trips on the first cent. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Per-IP rate-limit window. |
| `RATE_LIMIT_MAX` | `20` | Max requests per IP per window. |
| `MAX_ACTIVE_GENERATION_JOBS` | `3` | Most background generation jobs one user may have queued or running at once. |
| `GENERATION_WORKER_CONCURRENCY` | `4` | Most background generation jobs one instance runs at once. |
| `AUTH_BASE_URL` | `https://localhost:8000` | Gatekeeper base URL used to verify the managed path's bearer token. |
| `DATABASE_URL` | _(unset)_ | Postgres connection for the daily spend breaker. The managed path needs it; BYOK does not. |
| `BILLING_BASE_URL` | _(unset)_ | Aether base URL, for the personal workspace's tier, funding (whether it bought credits), and pooled credit balance. Unset: everyone reads as a free non-payer, managed AI is refused, and no balance is shown. |
| `BILLING_SERVICE_API_KEY` | _(unset)_ | Aether service API key (`x-service-api-key`), required for the credit balance and funding reads. Unset: only a paid tier gets managed AI. |
| `BILLING_WEBHOOK_SECRET` | _(unset)_ | Verifies Aether entitlement webhooks, which invalidate the cached tier. |

The managed path depends on `SYNAPSE_API_URL`, `SYNAPSE_GATEWAY_SECRET`, `AUTH_BASE_URL`, `DATABASE_URL`, and (for the tier, funding, and balance) `BILLING_BASE_URL` + `BILLING_SERVICE_API_KEY`; BYOK needs none of them. GraphQL and Vortex variables remain scaffolding. See [`.env.local.template`](.env.local.template) for the full list.

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
