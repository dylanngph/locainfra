# LocaInfra

Local Docker dev services, managed from a dashboard.

Type `locainfra`, a dashboard opens on `127.0.0.1`, and you add Postgres, Redis and friends from a catalog, start and stop them, read logs, and copy connection strings or link them into your project's `.env.local`. No hand-written compose files, no copied passwords.

> Status: early development (M3b: Data tab, snapshots, seed files, compose import, secret rotation). Not yet published.

## Usage

```sh
locainfra                          # start (or reuse) the dashboard and open it; Ctrl+C stops it, services keep running
locainfra --project . --no-open    # register this folder as a project; --port <n> picks the port (default: first free from 4488)
locainfra up [--service main-db]   # start the services of the project in this folder (scripts/CI)
locainfra down [--volumes] [--yes]
locainfra env --format shell       # eval "$(locainfra env --format shell)"
locainfra doctor
```

A project is a folder with a `locainfra.yaml` holding named service instances (`services: { main-db: { type: postgres, port: auto } }`, several per type allowed). Secrets live in `~/.locainfra/secrets/` (mode 0600), never in the stack file. Machine-local state (registered projects, pinned ports) lives in `~/.locainfra/locainfra.db` (SQLite, mode 0600); an older `state.json` is imported once and renamed `state.json.migrated`. All services and the dashboard bind to `127.0.0.1`.

Each service page has a **Data** tab (run SQL or Redis commands in the running container, export CSV) and, for services with a data volume, a **Snapshots** tab (archive the volume, restore it later). A Postgres entry can name a `seed:` file in the project folder, which runs when the volume is first created. **Import docker-compose.yml** on the Projects page turns the databases and caches of an existing compose file into a project, moving ports that are already taken. Secrets can be regenerated when you add a service and rotated from the Connect tab. Snapshots live in `~/.locainfra/snapshots/`, and each action is recorded in the database's `ops` table.

The dashboard loads data once and has a **Refresh** button; it never polls. Turn on **Live** (per project) to stream status and CPU/memory, or **Follow** on the Logs tab to stream logs; only then does it open a WebSocket.

Build the standalone binary with `bun run build`. It builds the dashboard, then runs Bun's native `bun build --compile` with `--asset` to embed the dashboard, the catalog and the migrations into `dist/locainfra`. `bun run build:targets` compiles all seven release targets into `dist/<target>/locainfra`.

## Development

Requires Bun and Docker Desktop (Compose ≥ 2.24). See [docs/architecture.md](docs/architecture.md), [docs/api.md](docs/api.md) and [docs/adr](docs/adr).

```sh
bun install          # once, at the root
bun run dev          # server (watch, :4488) + dashboard (HMR, :5173) — open http://127.0.0.1:5173/
bun run dev:ui       # dashboard only, against MSW mocks
bun run cli -- doctor
bun run test && bun run typecheck && bun run lint
bun run build        # vite build + bun build --compile → dist/locainfra
bun run build:targets  # every release target → dist/<target>/locainfra
```
