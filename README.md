# 📐 Facet API

The Facet AI generation gateway. A thin [Elysia](https://elysiajs.com) service whose entire job is to call the [Synapse](https://synapse.omni.dev) AI router **safely**, so natural-language prompts become parametric CAD code without ever exposing our model keys or letting anyone run up a bill against them.

Facet itself stays a static SPA for local modeling. This gateway owns the one thing the browser must never hold: the server-side Synapse key. It builds a grounded prompt from the Facet authoring API, calls Synapse's Anthropic-compatible `POST /v1/messages`, extracts the fenced TypeScript block, and returns it with a usage estimate. Every layer of the money-safety model lives here.

## What it exposes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/generate` | Turn a prompt into Facet TypeScript. Managed (our key) or BYOK (caller's key). |
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

Response:

```jsonc
{
  "code": "const part = cube(20).subtract(cylinder(3, 24));\nreturn part;",
  "usage": { "credits": 2, "costCents": 1.4 }
}
```

- `credits` is `ceil(costCents)` (1 credit ~= $0.01 of model spend).
- The `previous` field drives the client-side repair loop: on a kernel throw the app re-calls `/generate` with the failing code plus the error so the model can fix it.

## Money-safety model

Defense-in-depth. Each layer is independent, so a bug in one does not defeat the others:

1. **Server-only key.** `SYNAPSE_API_KEY` lives only here, never `VITE_`-prefixed, never shipped to the browser, never written to a response body or a log.
2. **Synapse-key hard budget.** The provisioned key carries a hard monthly ceiling set in Synapse (Phase D), bounding worst-case total loss.
3. **Global daily spend breaker.** Aggregate managed spend is tracked per UTC day; `/generate` returns `503` once `DAILY_SPEND_CEILING_CENTS` is hit.
4. **Per-request caps.** `MAX_PROMPT_CHARS`, `MAX_OUTPUT_TOKENS`, a request timeout, and `MAX_REPAIR_ATTEMPTS`, all enforced server-side.
5. **Per-IP rate limit.** Sliding-window limiter on `/generate`; `429` on exceed.
6. **BYOK escape hatch.** A caller may send their own key per-request over TLS. It is never persisted, bills to them, and bypasses the managed breaker and credit meter entirely.

> Per-user auth gating and hard-capped credits (money-safety layers 4-5 of the plan) land in Phase C, backed by the Drizzle tables this service carries from the template. Phase A keeps the breaker and rate limiter in-memory.

## Local development

```sh
cp .env.local.template .env.local   # optional, the service boots with no env set
bun install
bun dev
```

The service boots with **no env configured**: if `SYNAPSE_API_KEY` is unset it logs a warning and the managed path returns a clean `503`, while BYOK requests still work. See [`.env.local.template`](.env.local.template) for required vs optional variables.

## Testing

```sh
bun test            # no database required for Phase A
bun run check       # Biome lint + format
bunx tsc --noEmit   # type check
bun run knip        # dead code + unused deps
bun run build       # bundle
```

## License

The code in this repository is licensed under Apache 2.0, &copy; [Omni LLC](https://omni.dev). See [LICENSE.md](LICENSE.md) for more information.
