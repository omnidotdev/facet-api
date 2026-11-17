---
"@omnidotdev/facet-api": minor
---

Managed AI generation can now run in the background. `POST /generations` runs the same checks as `/generate` and queues the generation as a job, so it keeps going and its result waits even if the panel is closed or the page is left. `GET /generations` lists your recent jobs, `GET /generations/:id` reads one, and `DELETE /generations/:id` dismisses one. You can have up to 3 generations queued or running at once. A job's prompt and result are deleted when you dismiss it or 24 hours after it was queued, whichever comes first. A generation cut short by a restart is marked as interrupted so you can try again; it is never re-run (and re-billed) on its own. Your own Synapse key still uses the synchronous `/generate`, and older clients keep working.
