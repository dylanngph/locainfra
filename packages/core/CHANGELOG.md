# @locastack/core

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
- bd59542: M3 part 2: Data tab, snapshots, seed files, compose import and secret rotation.
  
  - **Data tab** on Postgres and Redis services: lists tables or key patterns and runs a SQL query or Redis command inside the running container (`docker exec` with an argv array, never a shell). A run stops after 15 s, 2 MiB or 1000 rows, and the result can be exported as CSV. New routes: `GET …/services/:name/data` and `POST …/services/:name/data/query` (a timeout is `504 TIMEOUT`).
  - **Snapshots tab** for services with a data volume: create, restore (with confirmation) and delete. The service is stopped, its volume is archived or restored by a `docker run --rm --network none` helper (`alpine:3.20`), and the service is started again. Archives are stored in `~/.locastack/snapshots/<project>/<service>/` (0600) and indexed in the `snapshots` table of `locastack.db`. A restore checks the archive first, so a damaged file never wipes the volume.
  - **Seed files**: a Postgres entry can set `seed: db/seed.sql` (a path inside the project folder). The file is mounted read-only and runs when the volume is first created, and **Seed** on the Snapshots tab applies it again.
  - **Import docker-compose.yml** on the Projects page: paste or drop a compose file, review how each service maps to the catalog (apps with `build:` and unknown images are skipped), with ports that are already taken on this machine remapped. The import then creates the project and can start it. New routes: `POST /api/import/preview` (writes nothing) and `POST /api/import`.
  - **Secrets**: the add/config form has **Regenerate** for each secret. On the Connect tab, **Rotate** sets a new value and recreates the service. When the value is stored in the data volume (Postgres), rotating also requires wiping the volume, and the dialog suggests taking a snapshot first.
  - Each background operation of a project (`202 { opId }`) is recorded in the `ops` table of `locastack.db`, which keeps the newest 200 per project.
- b16adc5: Hardening from review:
  
  - `up` now requires docker compose 2.24 or newer and fails early with `COMPOSE_MISSING` or `COMPOSE_TOO_OLD`, each with a fix hint.
  - A project stack's name is bound to its folder on the first `up` (`state.projects`). If a second folder uses the same `name:`, `up`, `env` and `down` in that folder fail with `INVALID_STACK` and a hint to rename it, so the second folder can no longer reuse or delete the first project's containers, volumes, secrets or ports.
  - Two `up` runs at the same time can no longer pin the same host port or generate two different passwords for one stack.
  - The state and secrets lock records its owner. A lock held by a live process is never broken, and releasing a lock never deletes one held by another process.
  - `link.names` and catalog exports cannot use reserved shell, loader or runtime variables such as `PATH`, `PROMPT_COMMAND`, `NODE_OPTIONS` or `LD_*`.
  - The postgres healthcheck uses the exec form. `POSTGRES_USER` and `POSTGRES_DB` must match a safe pattern, set through the new catalog `config.<key>.pattern`.
  - Compose `error` progress events carry a JSON-safe error, and `ComposeProgress` is removed.

### Patch Changes

- bd59542: M3a review fixes: Live is never switched on by itself, nothing polls, and state errors are clearer.
  
  - **Live** is kept for the current page only. A reload, a bookmark or a new tab always starts with Live off and no WebSocket until you turn it on.
  - On the Logs tab, **Follow** is switched on and off with Live, so turning Live off always closes the socket.
  - Adding a service no longer polls the server while the add waits for other operations. The dashboard opens the new service's page when the operation reports that it wrote `locastack.yaml`.
  - CPU and memory show `—` instead of a made-up `0.0%` / `0 MB` when there is no reading because Live is off. This applies to service rows and project cards. `ProjectSummary.cpuPercent`/`memBytes` are now optional and are only sent while the project is being watched.
  - An older LocaStack refuses a state database that a newer release has migrated ("…was created by a newer LocaStack; update LocaStack") and leaves the file unchanged. The schema version marker never moves backwards.
  - Two `locastack` processes that start together on the first run after an upgrade no longer fail when both try to import `state.json`.
  - The ⌘K palette highlights the first row every time it opens.
- bd59542: M3 part 1: SQLite state, load-once dashboard with opt-in Live mode, Remove service and the ⌘K palette.
  
  - State moves from `~/.locastack/state.json` to `~/.locastack/locastack.db` (SQLite in WAL mode via `bun:sqlite` + Drizzle, mode 0600). Migrations run on first use and are embedded in the binary. An existing `state.json` is imported once and renamed `state.json.migrated`. Concurrent `locastack` processes are serialized by the database, and two services can never pin the same host port (`PORT_CONFLICT`). Before a schema upgrade the database is copied to `locastack.db.backup`.
  - The dashboard no longer polls. Pages load once and have a **Refresh** button; after an action only the affected data is refetched.
  - **Live** (a per-project switch, off by default) streams status and CPU/memory over the WebSocket; the socket is opened only while Live, or **Follow** on the Logs tab, is on, and closes when they are turned off.
  - Without Live, the Logs tab shows the last 200 lines (Reload fetches again) and the Metrics tab shows the last-known CPU/memory with a hint to turn Live on for charts.
  - Actions (add, start, stop, restart, remove, up, down) are followed over HTTP, so they never open the WebSocket.
  - New routes: `GET /api/projects/:project/services/:name/logs?tail=` (one-shot tail), `GET …/services/:name/stats` (one reading) and `GET /api/ops/:opId/events` (operation progress as NDJSON, ending after `done`/`error`).
  - Remove service from the overview's ⋯ menu or the service page: type the name to confirm, and optionally delete its data volume.
  - ⌘K / Ctrl+K opens a command palette: add a service to the current project, jump to a service or project, export `.env`.
- bd59542: M3b review fixes: snapshots, the Data tab, seed files, rotation and the stack `.env` are safer.
  
  - A snapshot records its catalog type and version. Restoring a snapshot of another type or major version is refused before anything is stopped. The Postgres password baked into the volume is saved next to the archive (mode 0600). Restoring puts it back into the secret store and `.env`, so `DATABASE_URL` works after "snapshot, rotate with Wipe volume, restore". This needs state database migration 0002.
  - Removing a service together with its volumes also deletes its snapshots.
  - A restore extracts into a staging folder and swaps it in only when extraction succeeds, so a corrupt archive, or one deleted during the restore, leaves the data untouched. Deleting a snapshot waits for any running operation on the project.
  - Postgres Data tab queries and seeds are also time-limited in the database (`statement_timeout`). A statement that times out no longer keeps running and holding its locks.
  - A seed file that is a symlink out of the project, a device, a FIFO or a folder is refused before it is read or mounted.
  - `wipeVolume` needs `force` for every secret.
  - The stack `.env` and `docker-compose.yml` are written atomically, so they are never seen empty.
  - The Snapshots tab is shown only for services with exactly one data volume.
  - Restore and seed refresh the Data tab's table list, and so does every successful Run.
  - An import opens the new project only once its `locastack.yaml` has been written.
