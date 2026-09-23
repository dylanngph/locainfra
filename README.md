# LocaInfra

Local Docker dev services, managed from a dashboard.

Type `locainfra`, a dashboard opens on `127.0.0.1`, and you add Postgres, Redis and friends from a catalog, start and stop them, read logs, and copy connection strings or link them into your project's `.env.local`. No hand-written compose files, no copied passwords.

> Status: early development (M0/M1). Not yet published.

## Usage (planned)

```sh
locainfra                  # open the dashboard
locainfra up [--global]    # start the current project's stack (scripts/CI)
locainfra down [--global] [--volumes]
locainfra env --format shell   # eval "$(locainfra env --format shell)"
locainfra doctor
```

Stacks are either global (`~/.locainfra/global.yaml`) or per project (`locainfra.yaml`). Secrets live in `~/.locainfra/secrets/` (mode 0600), never in the stack file. All services bind to `127.0.0.1`.

## Development

Requires Bun and Docker Desktop (Compose ≥ 2.24).

```sh
bun install
bun run test
bun run typecheck
bun run lint
```

See [docs/architecture.md](docs/architecture.md) and [docs/adr](docs/adr).
