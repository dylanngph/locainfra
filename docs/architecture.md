# Architecture

LocaInfra is a dashboard-first tool for local Docker dev services. Running `locainfra` starts a localhost dashboard; a tiny CLI (`up`, `down`, `env`, `doctor`) serves scripts and CI. Both are clients of the same **Operations** layer.

## Layers

```
┌───────────────────────────────────────────────────────────────────┐
│  Dashboard SPA (React + Vite, Eden client)        Minimal CLI      │
├───────────────────────────────────────────────────────────────────┤
│  Server: Elysia on Bun.serve — REST (+ NDJSON op progress),        │
│  opt-in WebSocket observer (Live mode),                            │
│  op registry, embedded SPA                                         │
├───────────────────────────────────────────────────────────────────┤
│  Operations (use-cases): addService, upProject, statusForProject,  │
│  envPreview, linkEnv, getConnection, upStack, doctor, runQuery,    │
│  createSnapshot, restoreSnapshot, seedService, rotateSecret,       │
│  previewImport, importProject …                                    │
├───────────────────────────────────────────────────────────────────┤
│  Core (pure TS, no I/O): catalog, stack, resolve, render, env,     │
│  ports (interfaces)                                                │
├───────────────────────────────────────────────────────────────────┤
│  Engines (adapters implementing ports): state (SQLite: registry,   │
│  snapshots index, op journal), compose, docker (Engine API,        │
│  streams, exec, volume archiver), desktop, port probe, files       │
└───────────────────────────────────────────────────────────────────┘
```

Data flow: `Catalog (YAML) → Stack (<project>/locainfra.yaml) → ResolvedStack → ~/.locainfra/stacks/<project>/docker-compose.yml → containers`.

There is no global stack: everything is a **project**, a folder containing `locainfra.yaml`, registered in the machine-local state database `~/.locainfra/locainfra.db` (`projects: [{ name, root, envFile? }]`, see [State store](#state-store)). A project holds **named service instances**, several per catalog type if needed:

```yaml
name: shop
services:
  main-db: { type: postgres, version: "17", port: auto, persist: volume, config: { POSTGRES_DB: shop } }
  events:  { type: postgres, persist: ephemeral }
  cache:   { type: redis }
```

Docker names: compose project and network `li-<project>`, container `li-<project>-<instance>`, volume `li-<project>-<instance>-<catalog volume>`. Env exports get an `<INSTANCE>_` prefix only when a key would collide with an earlier instance's. `port: auto` never picks the catalog's canonical port (5432, 6379, …), so a separately run local stack on those ports keeps working.

## Packages

| Package | Path | Role | Test runner |
|---|---|---|---|
| `@locainfra/core` | `packages/core` | Models (TypeBox), ports, ops (use-cases), pure logic. No engine imports. | `bun test` |
| `@locainfra/engines` | `packages/engines` | Adapters implementing core ports: SqliteStateStore, SqliteSnapshotIndex and SqliteOpJournal (`bun:sqlite` + Drizzle, one shared connection), ComposeRunner, DockerClient + DockerContainerStreams + DockerContainerExec (Engine API over the socket; exec stdin over a hijacked connection), DockerVolumeArchiver (`docker run --rm` helper), NativeFolderPicker, SystemBrowserOpener, port probe, built-in catalog folder. | `bun test` |
| `@locainfra/server` | `packages/server` | Elysia app: feature modules (MVC), WebSocket observer, op registry, auth guard, static SPA, `startServer`. Exports `App` for Eden. | `bun test` |
| `@locainfra/dashboard` | `packages/dashboard` | React 19 + Vite SPA: React Router 8 **Data Mode** (`createBrowserRouter`, loaders seed TanStack Query), nuqs (`nuqs/adapters/react-router/v8`) for URL filter/tab state, TanStack Form, zustand store fed by REST reads and, in Live mode, the observer socket, shadcn (Base UI), virtua + anser for logs. Build-time deps only. | Vitest (+ Playwright e2e) |
| `@locainfra/cli` | `packages/cli` | commander entry + `composition.ts`; bare `locainfra` starts the server and opens the browser. | `bun test` |

## Ports (hexagonal interfaces)

Defined in `packages/core/src/ports/`, each narrow (ISP). Ops declare only the slices they need.

| Port | File | Purpose |
|---|---|---|
| `DockerInfoPort`, `ContainerReader`, `ContainerInspector`, `SocketLocator` | `docker.port.ts` | Engine API read side and socket discovery |
| `ContainerStreams` | `docker.port.ts` | Long-lived `logs` / `stats` / `events` streams (observer) |
| `ComposeInfoPort`, `LifecycleRunner` | `compose.port.ts` | `docker compose` version, up/down/ps, per-service start/stop/restart/remove (remove can also delete volumes and the project network) |
| `StateReader`, `StateWriter` | `state.port.ts` | `~/.locainfra/locainfra.db` (project registry, pinned ports) |
| `SecretStore` | `secrets.port.ts` | `~/.locainfra/secrets/<project>.env` (0600) |
| `FileStore`, `DirectoryLister`, `PortProbe`, `Clock`, `SecretGenerator` | `files.port.ts` | Small I/O and determinism seams (`writeText` is atomic: temp file, fsync, rename, so the compose `.env` is never seen empty; `fileInfo` canonicalises paths for the seed checks) |
| `FolderPicker`, `BrowserOpener` | `desktop.port.ts` | Native folder dialog (New project) and default browser |
| `ContainerExec` | `exec.port.ts` | `docker exec` of an argv (no shell) with optional stdin, timeout and stdout cap (Data tab, seeding) |
| `VolumeArchiver`, `SnapshotIndex` | `snapshot.port.ts` | tar/untar one volume with a throw-away helper container; the SQLite `snapshots` index |
| `OpJournal` | `op-journal.port.ts` | Operation history (SQLite `ops` table); a journal failure never fails an op |
| `Paths` | `paths.port.ts` | Resolved directory layout |
| `CatalogSource` | `catalog/catalog.source.ts` | Merged catalog (built-ins → registry → overrides) |

Op signatures live in `packages/core/src/ops/ops.contract.ts`. Long-running ops return `AsyncIterable<Progress>` (an `error` event carries a serializable `ProgressError`: code, message, details such as a `fix` hint or `suggestedPort`); others return `Result<T, OpError>`.

## Server

`createApp(deps)` (`packages/server/src/app.ts`) is pure: it wires feature modules (`system`, `doctor`, `catalog`, `projects`, `services`, `data`, `snapshots`, `env`, `import`, `ops`, `observer`) behind the auth guard and returns the Elysia app whose type the dashboard's Eden client imports. `ServerDeps` = `{ token, allowedHosts, ops: ServerOps, ports: ServerPorts, staticDir?, docs? }`; the composition root (`packages/cli/src/composition.ts`) fills `ops` with core's op functions and `ports` with engine adapters plus the merged catalog.

- **Auth:** every route except `GET /api/health` needs the session token (`x-locainfra-token` header, or `?t=` for the WebSocket). `Host` must be one of the allowed `127.0.0.1:<port>` / `localhost:<port>` values and a present `Origin` must match (DNS-rebinding guard).
- **Errors:** services throw `OpError`; the global error handler maps its code to an HTTP status (`OP_ERROR_STATUS`) with `{ code, message, details? }`. Anything else is a generic 500 without the original message.
- **Pre-checks before `202`:** project/service exist, catalog type/version/config keys valid, an explicit port is free on 127.0.0.1 and not pinned by another project (else `409 PORT_CONFLICT` with `details.port` = busy port, `details.suggestedPort`). `GET /api/catalog/:type/free-port` gives the Config screen the same port `auto` would pick.

### Op registry

Every action that touches containers answers `202 { opId }` and runs in the background through `OpRegistry` (`modules/observer/op-registry.ts`):

- keeps the last 50 operations; a finished one stays replayable for 60 s, so a client that follows it right after the `202` loses nothing;
- is readable two ways: `GET /api/ops/:opId/events` (`modules/ops/`) streams the op's `Progress` as NDJSON (replay, then live, ending after the terminal event, with a blank keep-alive line every 5 s), and `op:<opId>` on `/ws` does the same over the socket. The dashboard uses the HTTP stream, so actions never open the WebSocket;
- stamps every event with `opId` and `at`, and guarantees exactly one terminal `done` or `error`, even when the op throws;
- runs ops on the same project one at a time, in start order;
- records every op that names a project in the `OpJournal` (`ports.journal`, the SQLite `ops` table): `running` when it starts, then `succeeded` or `failed` with the terminal event's secret-free error. Journal writes are best effort and never affect the op;
- when an op settles, the observer refreshes that project's status.

### Load once, Live on demand

The dashboard is cheap by default: every page loads its data once over REST (TanStack Query, `staleTime` 5 min, no `refetchInterval`, no refetch on focus/reconnect) and a **Refresh** button refetches it. Nothing polls. The WebSocket exists only while something streams:

- **Live** (a per-project switch in the tab bar, kept in memory only: it survives in-app navigation but every reload, bookmark or new tab starts with it off) subscribes `status:<project>` and `stats:<containerId>` for running rows and the open service;
- **Follow** on the Logs tab subscribes `logs:<containerId>`. It is switched on and off with Live (and can be toggled by hand in between), so turning Live off always releases every channel of the project.

Without them, the Logs tab reads `GET …/services/:name/logs?tail=200` once (Reload reads again), the Metrics tab reads `GET …/services/:name/stats` once for its last-known numbers, and actions are followed with `GET /api/ops/:opId/events`. The socket (`shared/lib/observer/socket.ts`) connects on the first subscription and closes about a second after the last one is released, without reconnecting. After an op settles, only the queries in its scope are refetched (`track-op.tsx`).

### Observer (`/ws`)

One WebSocket per tab while Live or Follow is on, JSON messages `{ type: "subscribe" | "unsubscribe", channel, tail? }`. Channels (`modules/observer/channels/`):

| Channel | Behaviour |
|---|---|
| `status:<project>` | Snapshot on subscribe, then deltas (changed rows, removed names). Reloads every 2 s and on Docker events (100 ms debounce). One Docker events subscription is shared by all projects. Rows carry live CPU/MEM from the stats channel. |
| `stats:<containerId>` | One upstream stats stream per container while anyone listens; 5 min history, the last 24 samples sent first, then at most one sample per second. |
| `logs:<containerId>` | One following upstream per container, batched every 75 ms, 200 lines of tail by default, `ended: true` when the container stops. Backpressure: a socket's logs pause when `send()` returns -1/0 or more than 1 MB is buffered, and resume on `drain` with one `{ lines: [], skipped: n }` marker; Bun's `backpressureLimit` is 4 MB. |
| `op:<opId>` | Replays buffered events, then live `Progress` until the terminal event. |

Upstream streams are closed when their last subscriber leaves, and all of them on `app.stop()`.

### Startup (`locainfra`)

`startServer({ port, token, deps, staticDir?, extraHosts, dashboardFile })` (`runtime/start-server.ts`) binds **127.0.0.1 only**, then writes `~/.locainfra/dashboard.json` (`{ pid, port, token, startedAt }`, mode 0600) and removes it on `stop()` if it still holds this pid.

Bare `locainfra` (`packages/cli/src/commands/dashboard/dashboard.command.ts`):

1. runs the doctor checks and prints a one-line summary (failing checks with their fix);
2. `--project <dir>`: registers the folder (or creates `locainfra.yaml` named after it) and adds `?project=<name>` to the URL, which the SPA redirects to `/p/<name>`;
3. if `dashboard.json` names a live pid that answers `GET /api/health`, prints its URL and opens the browser (a second `locainfra` never starts a second server);
4. otherwise starts the server on `--port` or the first free port ≥ 4488 with a random 24-byte session token (`LOCAINFRA_SESSION_TOKEN` fixes it for automation), prints `http://127.0.0.1:<port>/?t=<token>`, opens the browser unless `--no-open`, and stays in the foreground. Ctrl+C / SIGTERM stops only the server; containers keep running.

`@locainfra/server` (Elysia) is imported dynamically only by this path, so `up`/`down`/`env`/`doctor` never load it. In a source checkout the SPA comes from `packages/dashboard/dist` (or `LOCAINFRA_DASHBOARD_DIR`); without a build, the Vite dev server (`bun run dev` in the dashboard, proxying `/api` and `/ws`) is accepted as an extra host.

### Binary and embedded files

`bun run build` = `vite build` of the dashboard, then Bun's own compiler (no build script):

```sh
bun build packages/cli/src/index.ts --compile \
  --asset packages/dashboard/dist --asset catalog --asset packages/engines/drizzle \
  --minify-whitespace --minify-syntax --define process.env.NODE_ENV='"production"' \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile=dist/locainfra
```

`NODE_ENV` is fixed to `production` at compile time, so the binary does not serve the OpenAPI page (`/docs`); `bun run dev` does.

`bun run build:targets` cross-compiles the same line for darwin/linux (glibc and musl)/windows. Bun 1.4.2 places each `--asset` folder under its **basename** in the binary's virtual filesystem (`/$bunfs/root/dist`, `/$bunfs/root/catalog`, `/$bunfs/root/drizzle`; `B:\~BUN\root\…` on Windows), readable through `node:fs`. The resolvers also accept the full relative path in case a later Bun keeps it:

- `resolveDashboardAssets` (cli `composition.ts`): `LOCAINFRA_DASHBOARD_DIR`, else the embedded SPA, else `packages/dashboard/dist`; served by `staticAssets({ dir })` with an `index.html` fallback and immutable caching for `/assets/*`;
- `resolveCatalogDir`: `LOCAINFRA_CATALOG_DIR`, else the embedded `catalog/` read in place, else the repo `catalog/`;
- `resolveMigrationsFolder` (engines): the embedded `drizzle/` when it has `meta/_journal.json`, else `packages/engines/drizzle`.

A missing `--asset` folder fails the build, so `packages/engines/drizzle` must exist (it is committed).

## State store

`SqliteStateStore` (`packages/engines/src/state/sqlite/`, ADR 0008) implements `StateReader`/`StateWriter` over `~/.locainfra/locainfra.db` with `bun:sqlite` and Drizzle; both composition roots get it from `createEngines` (the CLI's `composeDeps` and the server's ports via `serverPorts`).

- Opened lazily on the first read/update: folder 0700, file 0600, `busy_timeout=5000`, WAL, `foreign_keys=ON`, then pending migrations (`drizzle/`, generated with `bunx drizzle-kit generate`). Upgrading an existing database first writes `locainfra.db.backup`; a failed migration rolls back and reports the backup.
- A legacy `state.json` is imported once into an empty database and renamed `state.json.migrated`.
- `update` runs read → mutate → validate → write in one `BEGIN IMMEDIATE` transaction, so writers in any process are serialized. `UNIQUE(port)` on pinned ports turns a double pin into `PORT_CONFLICT`.
- Tables: `projects`, `stacks`, `port_pins`, `registry`, `meta` (schema version), `snapshots` (the snapshot index, `SqliteSnapshotIndex`; migration 0002 adds `type`, `version`, `has_secrets`) and `ops` (the op journal, `SqliteOpJournal`; newest 200 per project, trimmed by a trigger). `SqliteSnapshotIndex` and `SqliteOpJournal` share the state store's connection through `withDatabase`.

## Data tab, snapshots, seed files, import (M3 part 2)

All of it is one-shot REST plus the op-events stream for progress; nothing polls or opens a socket on its own.

- **Data tab** (`listDataObjects`, `runQuery`): the catalog's `data` block gives argv arrays run with `ContainerExec` inside the running container (Postgres over the local socket, Redis with `REDISCLI_AUTH`). Nothing goes through a shell: `{{query}}` is one argv item for `sql` and redis-cli words for `redis` (a first word starting with `-` is refused). Output is CSV (`psql --csv`, `redis-cli --csv`), capped at 15 s, 2 MiB and 1000 rows; a timed-out exec is killed through a per-exec env tag, and Postgres statements are also bounded on the server (`statement_timeout` 14 s via conninfo `options`), since killing psql leaves its backend running. Tool errors are returned with every stack secret masked.
- **Snapshots** (`createSnapshot`, `restoreSnapshot`, `deleteSnapshot`, `listSnapshots`): stop the service, tar or untar its one volume with a `docker run --rm --network none` helper (`alpine:3.20`, label `io.locainfra.helper`), then `up --wait` it again. Archives are `<stateDir>/snapshots/<project>/<service>/<id>.tgz` (0600, folder 0700), written to a temp name and renamed on success; a restore extracts into a staging folder inside the volume and swaps only after a complete extraction, so a corrupt or vanished archive never empties the volume. The index is the SQLite `snapshots` table; each row records the catalog `type` and `version` (restore refuses another type or major version), and the values of `bakedIntoVolume` secrets go to a 0600 `<id>.secrets.json` sidecar that restore puts back into the secret store (and `.env`) when they differ. Deleting a snapshot runs in the project's op lane. Removing a service with its volumes deletes its snapshots; unregistering a project keeps them, like its volumes and secrets.
- **Seed files** (`seed` on a stack entry, `seedService`): the renderer bind-mounts `<root>/<seed>` read-only at the catalog's `seed.mountPath`, so Postgres runs it when the volume is first created; **Seed** pipes the file to `seed.run` over exec stdin. A seed path outside the project root is `INVALID_STACK`; on disk the seed is canonicalised (symlinks resolved) and must stay inside the project folder and be a regular file, checked before it is read (≤ 64 MiB) or bind-mounted (the mount gets the canonical path).
- **Secrets** (`secrets` on Add, `rotateSecret`): the Config page's Regenerate sends a client-generated value; rotation rewrites the secret and recreates the container. A `bakedIntoVolume` secret (Postgres password) needs `force` + `wipeVolume`, and `wipeVolume` always needs `force`.
- **Import** (`previewImport`, `importProject`): the pasted or dropped compose text is parsed with `yaml` (merge keys, alias cap), mapped to catalog types through each definition's `import` block, and its ports are remapped away from anything bound on 127.0.0.1 or pinned by another project. The preview writes nothing; the import creates the folder, registers the project, stores secrets, writes `locainfra.yaml` and optionally starts the services, undoing the registration if a later write fails (so the dashboard opens the project only on the event after "Writing locainfra.yaml").

## Dashboard

Route objects live in `src/app/router.tsx` (root shell → `/p/:project` shell → pages); heavy pages (Config, Service detail, Logs tab) load lazily. Loaders call `queryClient.ensureQueryData` with Eden-backed query options; a 404 from the API becomes the route's "Not found" boundary. Data loads once per page (and on Refresh); live data comes from the observer store only in Live/Follow mode (see [Load once, Live on demand](#load-once-live-on-demand)), never from polling. ⌘K opens a command palette (add a service, jump to a service or project, export .env). Filters and tabs (`q`, `cat`, `tab`, `f`, `fmt`, `lang`) are nuqs query states. Forms (New project, Config) use TanStack Form; server-side errors are shown through the field's `onServer` error slot. After Add & start the Config page waits until the service exists (the op writes `locainfra.yaml` shortly after the `202`) before opening its detail page, and follows the op in a toast.

Tests: Vitest + Testing Library + MSW (HTTP and WebSocket mocks with an in-memory backend, also used by `bun run dev:mock`). `bun run e2e` (Playwright, `e2e/`) is a live smoke against real Docker, skipped unless `LOCAINFRA_E2E=1`: `m2-smoke`, `m3a-smoke` (Live mode, logs, remove) and `m3b-smoke` (import, Data tab, snapshots, seed file, secret rotation).

## Rules

1. **Core never imports engines.** Ops depend on ports; concrete engines are wired only in the composition root (`packages/cli/src/composition.ts`); the server receives ops and ports through `ServerDeps`.
2. **One op per file** in `packages/core/src/ops/` (`add-service.op.ts`, …). Server routes and CLI commands are thin wrappers over ops, so every feature exists once.
3. **Feature-scoped folders** in every package, tests in `__tests__/` next to the code.
4. **Server MVC** per feature: `modules/<feature>/{index.ts (controller), <feature>.service.ts, <feature>.model.ts}`. Controllers route only; services are plain classes without Elysia imports; models are TypeBox schemas plus custom errors. Named plugins for cross-cutting concerns.
5. **TypeBox everywhere** (API models, stack files, catalog YAML, state). No zod.
6. **Result-style returns** at op boundaries; typed error classes live in the owning model file (`OpError`, `CatalogError`, `StackError`).
7. **No default exports** (except where a framework requires one: Vite and Playwright config, Playwright global setup), **no `any`**, **TSDoc on every exported symbol**.
8. **Safety:** all ports and the dashboard bind `127.0.0.1`; the dashboard requires a per-session token and validates `Host`/`Origin`; secrets are 0600 and never logged; destructive actions need explicit confirmation.
9. **Weight:** runtime deps allowlist (core/CLI: `commander`, `@clack/prompts`, `ansis`, `yaml`, `@sinclair/typebox`; server: `elysia`, `@elysiajs/eden`). Plain CLI commands never load Elysia or the SPA.
10. **SOLID** in practice: single-purpose files; new services are YAML (open/closed); fakes are substitutable behind ports (shared contract tests); narrow ports; dependency inversion via the composition root.

## Decisions

See [`adr/`](./adr) for the recorded decisions.
