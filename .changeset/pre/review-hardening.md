---
"@locastack/core": minor
"@locastack/engines": minor
"@locastack/cli": patch
---

Hardening from review:

- `up` now requires docker compose 2.24 or newer and fails early with `COMPOSE_MISSING` or `COMPOSE_TOO_OLD`, each with a fix hint.
- A project stack's name is bound to its folder on the first `up` (`state.projects`). If a second folder uses the same `name:`, `up`, `env` and `down` in that folder fail with `INVALID_STACK` and a hint to rename it, so the second folder can no longer reuse or delete the first project's containers, volumes, secrets or ports.
- Two `up` runs at the same time can no longer pin the same host port or generate two different passwords for one stack.
- The state and secrets lock records its owner. A lock held by a live process is never broken, and releasing a lock never deletes one held by another process.
- `link.names` and catalog exports cannot use reserved shell, loader or runtime variables such as `PATH`, `PROMPT_COMMAND`, `NODE_OPTIONS` or `LD_*`.
- The postgres healthcheck uses the exec form. `POSTGRES_USER` and `POSTGRES_DB` must match a safe pattern, set through the new catalog `config.<key>.pattern`.
- Compose `error` progress events carry a JSON-safe error, and `ComposeProgress` is removed.
