# @locastack/cli

## 0.1.0-rc.0

### Minor Changes

- b16adc5: M1: `locastack up`, `down`, `env` and `doctor` work end to end. Built-in catalog (postgres, redis, upstash-redis), stack files with auto port allocation, generated secrets, compose rendering bound to 127.0.0.1, and connection variables in dotenv, shell or JSON. Error events now carry a structured `error` (code, details, fix hint) that the CLI prints.
- bd59542: M2: the dashboard.
  
  - Running `locastack` with no command now starts the dashboard on 127.0.0.1, using the first free port from 4488 and a random session token. It prints the URL, opens the browser and keeps running until Ctrl+C, which stops only the dashboard: containers keep running. If a dashboard is already running, the command opens that one instead.
    - New flags: `--port <n>`, `--no-open` and `--project <dir>`. The last one registers the folder as a project, or creates its `locastack.yaml`, and opens that project in the dashboard.
  - Projects replace the global stack. A project is any folder with a `locastack.yaml`, listed in `~/.locastack/state.json`. `--global` and `global.yaml` are gone. `up`, `down` and `env` use the project in the current folder.
  - Services are named instances: `services: { main-db: { type: postgres, port: auto } }`. A project can hold several instances of one type.
    - Env variable names get an `<INSTANCE>_` prefix only when two instances would export the same name.
    - `port: auto` never takes the standard port (5432, 6379, …).
  - The dashboard has these screens: Projects, project overview, catalog, service config (with a YAML editor that stays in sync with the form), service detail (Connect, Logs and Metrics tabs) and Environment (Write to `./.env`). Status, logs, metrics and progress update live over a WebSocket.
  - Server: a REST API and a `/ws` observer for status, stats, logs and progress, all protected by the session token. New route: `GET /api/catalog/:type/free-port`. When an explicit port is taken on this machine or reserved by another project, adding a service returns `409 PORT_CONFLICT` with the busy port in `details.port` and a free one in `details.suggestedPort`.
  - Removing a project's last service also deletes its `ls-<project>` Docker network.
  - `dist/locastack` now includes the dashboard and the built-in catalog.
- bd59542: M3 part 1: SQLite state, load-once dashboard with opt-in Live mode, Remove service and the ⌘K palette.
  
  - State moves from `~/.locastack/state.json` to `~/.locastack/locastack.db` (SQLite in WAL mode via `bun:sqlite` + Drizzle, mode 0600). Migrations run on first use and are embedded in the binary. An existing `state.json` is imported once and renamed `state.json.migrated`. Concurrent `locastack` processes are serialized by the database, and two services can never pin the same host port (`PORT_CONFLICT`). Before a schema upgrade the database is copied to `locastack.db.backup`.
  - The dashboard no longer polls. Pages load once and have a **Refresh** button; after an action only the affected data is refetched.
  - **Live** (a per-project switch, off by default) streams status and CPU/memory over the WebSocket; the socket is opened only while Live, or **Follow** on the Logs tab, is on, and closes when they are turned off.
  - Without Live, the Logs tab shows the last 200 lines (Reload fetches again) and the Metrics tab shows the last-known CPU/memory with a hint to turn Live on for charts.
  - Actions (add, start, stop, restart, remove, up, down) are followed over HTTP, so they never open the WebSocket.
  - New routes: `GET /api/projects/:project/services/:name/logs?tail=` (one-shot tail), `GET …/services/:name/stats` (one reading) and `GET /api/ops/:opId/events` (operation progress as NDJSON, ending after `done`/`error`).
  - Remove service from the overview's ⋯ menu or the service page: type the name to confirm, and optionally delete its data volume.
  - ⌘K / Ctrl+K opens a command palette: add a service to the current project, jump to a service or project, export `.env`.
- bd59542: M3 part 2: Data tab, snapshots, seed files, compose import and secret rotation.
  
  - **Data tab** on Postgres and Redis services: lists tables or key patterns and runs a SQL query or Redis command inside the running container (`docker exec` with an argv array, never a shell). A run stops after 15 s, 2 MiB or 1000 rows, and the result can be exported as CSV. New routes: `GET …/services/:name/data` and `POST …/services/:name/data/query` (a timeout is `504 TIMEOUT`).
  - **Snapshots tab** for services with a data volume: create, restore (with confirmation) and delete. The service is stopped, its volume is archived or restored by a `docker run --rm --network none` helper (`alpine:3.20`), and the service is started again. Archives are stored in `~/.locastack/snapshots/<project>/<service>/` (0600) and indexed in the `snapshots` table of `locastack.db`. A restore checks the archive first, so a damaged file never wipes the volume.
  - **Seed files**: a Postgres entry can set `seed: db/seed.sql` (a path inside the project folder). The file is mounted read-only and runs when the volume is first created, and **Seed** on the Snapshots tab applies it again.
  - **Import docker-compose.yml** on the Projects page: paste or drop a compose file, review how each service maps to the catalog (apps with `build:` and unknown images are skipped), with ports that are already taken on this machine remapped. The import then creates the project and can start it. New routes: `POST /api/import/preview` (writes nothing) and `POST /api/import`.
  - **Secrets**: the add/config form has **Regenerate** for each secret. On the Connect tab, **Rotate** sets a new value and recreates the service. When the value is stored in the data volume (Postgres), rotating also requires wiping the volume, and the dialog suggests taking a snapshot first.
  - Each background operation of a project (`202 { opId }`) is recorded in the `ops` table of `locastack.db`, which keeps the newest 200 per project.

### Patch Changes

- bd59542: The standalone binary is built with Bun's own `bun build --compile --asset` instead of a hand-written script.
  
  - `bun run build` builds the dashboard, then compiles `dist/locastack` with the dashboard, the built-in catalog and the database migrations embedded. The binary never loads a `.env` or `bunfig.toml` from the folder it runs in.
  - `bun run build:targets` compiles all seven release targets into `dist/<target>/locastack`.
  - The binary reads its catalog directly from the embedded files. It no longer copies them to `~/.locastack/catalog-builtin/` (you can delete that folder).
  - `scripts/build.ts`, the generated `.build/` entry and `setEmbeddedAssets` are gone. The server serves the dashboard only from a folder (`staticDir`); the `staticFiles` option is removed.
- b16adc5: Hardening from review:
  
  - `up` now requires docker compose 2.24 or newer and fails early with `COMPOSE_MISSING` or `COMPOSE_TOO_OLD`, each with a fix hint.
  - A project stack's name is bound to its folder on the first `up` (`state.projects`). If a second folder uses the same `name:`, `up`, `env` and `down` in that folder fail with `INVALID_STACK` and a hint to rename it, so the second folder can no longer reuse or delete the first project's containers, volumes, secrets or ports.
  - Two `up` runs at the same time can no longer pin the same host port or generate two different passwords for one stack.
  - The state and secrets lock records its owner. A lock held by a live process is never broken, and releasing a lock never deletes one held by another process.
  - `link.names` and catalog exports cannot use reserved shell, loader or runtime variables such as `PATH`, `PROMPT_COMMAND`, `NODE_OPTIONS` or `LD_*`.
  - The postgres healthcheck uses the exec form. `POSTGRES_USER` and `POSTGRES_DB` must match a safe pattern, set through the new catalog `config.<key>.pattern`.
  - Compose `error` progress events carry a JSON-safe error, and `ComposeProgress` is removed.
- Updated dependencies [b16adc5]
- Updated dependencies [bd59542]
- Updated dependencies [bd59542]
- Updated dependencies [bd59542]
- Updated dependencies [bd59542]
- Updated dependencies [bd59542]
- Updated dependencies [bd59542]
- Updated dependencies [b16adc5]
  - @locastack/core@0.1.0-rc.0
  - @locastack/engines@0.1.0-rc.0
  - @locastack/server@0.1.0-rc.0
