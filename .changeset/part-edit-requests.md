---
"@omnidotdev/facet-api": minor
---

Ask for a change to a model you already have open. `POST /generate` takes an optional `edit: { code, params }`: the prompt is the change ("make the ring thicker"), the code is the current model, `params` holds its current slider values, and the reply is the whole updated model with everything else kept and each slider's current value carried into its default. A repair of the edited model keeps the request in view. Edits are capped by `MAX_CODE_CHARS` (default 100000), run only on `/generate` (`POST /generations` refuses them with `bad_input`), are marked `edited` in the `facet.generation.completed` event, and are never captured as training samples.
