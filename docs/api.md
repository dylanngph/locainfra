# Dashboard API (M3)

The dashboard's contract with the server. The source of truth is the exported
`App` type (`packages/server/src/app.ts`) consumed through Eden Treaty; this page
explains it. Schemas live in:

- `packages/core/src/ops/ops.model.ts`: op results reused as API models
  (`ProjectSummary`, `ProjectStatus`, `ServiceStatus`, `ServiceDetail`,
  `ConnectionInfo`, `EnvPreview`, `CatalogListing`, `SystemInfo`, …).
- `packages/core/src/stack/stack.model.ts`, `catalog/catalog.model.ts`,
  `ports/docker.port.ts` (`LogLine`, `StatsSample`), `shared/progress.model.ts`.
- `packages/server/src/modules/<feature>/<feature>.model.ts`: request bodies,
  queries and wrappers, registered as reference models (`Projects.List`,
  `Services.Connection`, …). `packages/server/src/models/common.model.ts`:
  `Common.Error`, `Common.OpAccepted`, params.

The OpenAPI reference is served at `/docs` (spec: `/docs/json`) when running
from source (`bun run dev`); it is off when `NODE_ENV=production`, which the
compiled binary always is.

> **Status:** every route below is implemented (`packages/server/src/modules/*`)
> over the core ops, including M3 part 2 (Data tab, Snapshots and seed, secret
> rotation, Import). Request validation runs first, so a `422` with a
> validation body means the request shape is wrong.

> **Load once, Live on demand (M3a).** The dashboard reads everything over
> plain HTTP and never polls: data loads once per page and on Refresh, and
> actions are followed with `GET /api/ops/:opId/events`. The WebSocket `/ws`
> is opened only while a project's **Live** switch is on (status + stats) or
> the Logs tab's **Follow** switch is on, and it closes about a second after
> its last channel is released.

## Conventions

| Topic | Rule |
|---|---|
| Bind | `127.0.0.1` only. |
| Auth | Every route except `GET /api/health` needs the session token: header `x-locastack-token: <t>` or query `?t=<t>` (the WebSocket must use `?t=`). `Host` must be an allowed `127.0.0.1:<port>`; a present `Origin` must be `http://<allowed host>`. Failures: `401 "Unauthorized"`, `403 "Forbidden host"` / `"Forbidden origin"`. |
| Names | Project and service instance names match `^[a-z][a-z0-9-]*$` (validated on params and bodies). |
| Errors | Expected failures return `Common.Error` `{ code, message, details? }` where `code` is an `OpErrorCode`; `details.fix` is a human hint. For `PORT_CONFLICT`, `details.port` is the busy port and `details.suggestedPort` a free one to offer ("Use port N"). Never contains secrets. |
| Long actions | Anything that touches containers answers `202 { opId }`. Progress is available as NDJSON from `GET /api/ops/:opId/events` (what the dashboard uses) and on WebSocket channel `op:<opId>`: `Progress` events ending with one `done` or `error`. The server buffers an op's events and replays them until 60 s after the terminal event, so following right after the `202` loses nothing. |
| Secrets | Masked as `••••••••` (`MASKED_SECRET`) unless the route takes `reveal=true`. |
| Booleans in queries | `?volumes=true`, `?reveal=false` (coerced). |

### Error code → HTTP status (`OP_ERROR_STATUS`)

| Code | Status |
|---|---|
| `PROJECT_NOT_FOUND`, `SERVICE_NOT_FOUND`, `STACK_NOT_FOUND` | 404 |
| `SNAPSHOT_NOT_FOUND` | 404 |
| `PROJECT_EXISTS`, `SERVICE_EXISTS`, `PORT_CONFLICT`, `SERVICE_NOT_RUNNING` | 409 |
| `INVALID_INPUT`, `INVALID_STACK`, `INVALID_CATALOG` | 422 |
| `DOCKER_UNREACHABLE`, `COMPOSE_MISSING`, `COMPOSE_TOO_OLD` | 503 |
| `IO`, `UNKNOWN` | 500 |
| any code with `details.timedOut: true` (e.g. a Data tab query past 15 s) | 504 `{ code: "TIMEOUT", message, details: { ...details, opCode } }` (`TIMEOUT_CODE`) |

Errors that happen *during* a `202` action arrive as the `error` `Progress`
event on `op:<opId>`, not as an HTTP status.

## Naming on the Docker side

| Thing | Name |
|---|---|
| Compose project and network | `ls-<project>` |
| Container | `ls-<project>-<service>` (registration rejects a pair that collides with another project's, e.g. `shop`+`api-db` vs `shop-api`+`db`) |
| Volume (persist `volume`) | `ls-<project>-<service>-<catalog volume>` e.g. `ls-shop-api-main-db-data`; none for `ephemeral` |
| Secret key (secrets file and compose `.env`) | `<SERVICE_UPPER>__<SECRET>`, e.g. `MAIN_DB__POSTGRES_PASSWORD` (`instanceSecretKey`) |
| Labels | `locastack.stack=<project>`, `locastack.service=<service>`, `locastack.instance=<service>`, `locastack.catalog-id=<type>`, `locastack.type=<type>`, `locastack.version=<version>` |
| Network removal | Removing a project's last service also deletes `ls-<project>` (compose `down` cannot find it once no service is left). |

## Routes

### System and diagnostics

| Method | Path | Request | 200 response |
|---|---|---|---|
| GET | `/api/health` | — (public) | `{ ok: true }` |
| GET | `/api/system` | — | `System.Status` = `{ docker: { version, apiVersion, platformName? } \| null, compose: string \| null, dashboardVersion }` |
| GET | `/api/doctor` | — | `Doctor.Report` = `{ ok, checks: [{ id, label, status: ok\|warn\|fail, detail?, fix? }], generatedAt }` |

### Catalog

| Method | Path | 200 response |
|---|---|---|
| GET | `/api/catalog` | `Catalog.Listing` = `{ definitions: ServiceDefinition[], categories: [{ id, label, category, count }] }` |
| GET | `/api/catalog/:type/free-port` | `Catalog.FreePort` = `{ port: number \| null }`: the port `port: auto` would pick for a new instance (definition range, never the canonical default, skips every project's pinned ports, bind-probed). `422` for an unknown type. The Config screen's default. |

`ServiceDefinition` (catalog YAML) fields the dashboard uses: `id`, `name`,
`description`, `category`, `categoryLabel?` (filter label, e.g. `Redis` for
`redis` and `upstash-redis`), `icon`, `image` (template: replace `{{version}}`),
`versions`, `defaultVersion`, `port.{container,default,range}`, `secrets` (names),
`config` (`{ KEY: { default, description?, pattern? } }`, drives the Config form),
`volumes`, `primaryExport` (Copy URL variable), `snippets.{node,python,go}` (raw,
with a `KEY` placeholder), `studio.panel`. Category `id` is the slug of
`categoryLabel ?? category` and is the value of the `cat` search param.

M3 part 2 adds optional blocks (`ServiceData`, `ServiceSeed`,
`ServiceSecretOptions`, `ServiceImport` in `catalog/catalog.model.ts`):

| Field | Meaning | Built-ins |
|---|---|---|
| `data` | Data tab: `{ kind: sql\|redis\|none, label?, listObjects?: argv, objects?: string[], runQuery?: argv, defaultQuery? }`. Commands run with `docker exec` in the running container, never through a shell. In `runQuery` one argv item is exactly `{{query}}` (kind `sql`: the query as ONE item; `redis`: its words, quotes group); `defaultQuery` uses `{{object}}`. Exactly one of `listObjects` (one object per stdout line) / `objects` (static list). The dashboard shows the Data tab when `data.kind` is `sql` or `redis`. | postgres: `sql`, "Tables" (public tables via `psql -A -t`), `psql --csv -v ON_ERROR_STOP=1 -c {{query}}`, `SELECT * FROM "{{object}}" LIMIT 100;`. redis: `redis`, "Key patterns", `objects: ["*"]`, `redis-cli --csv {{query}}` (auth from the container's `REDISCLI_AUTH`, so no `-a` in argv), `SCAN 0 MATCH {{object}} COUNT 100`. upstash-redis: `none`. |
| `seed` | `{ mountPath, fileName, run: argv }`: a stack entry's `seed` file is bind-mounted read-only at `<mountPath>/<fileName>`; `run` re-applies it from stdin. The Config form shows "Seed file" when set. | postgres: `/docker-entrypoint-initdb.d`, `seed.sql`, `psql … -v ON_ERROR_STOP=1 -f -` |
| `secretOptions` | `{ <SECRET>: { bakedIntoVolume? } }`: a baked secret is written into the data volume on first init, so rotating it needs a wipe. | postgres: `POSTGRES_PASSWORD` baked |
| `import` | `{ images: string[], env?: { COMPOSE_VAR: "config.X" \| "secrets.Y" } }`: compose image repositories (no tag) this definition imports; env vars named like a config key or secret map by name. | postgres: `postgres`, `postgis/postgis`, `pgvector/pgvector`; redis: `redis`, `valkey/valkey`; upstash-redis: `hiett/serverless-redis-http`, `upstash/redis-http` |

### Projects

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/projects` | — | 200 `Projects.List` = `ProjectSummary[]` | |
| POST | `/api/projects` | body `Projects.Create` `{ name, root }` | 201 `Projects.Summary` | 404, 409 (`PROJECT_EXISTS`), 422 |
| POST | `/api/projects/pick-folder` | body `Projects.PickFolder` `{ name? }` | 200 `{ root: string \| null }` | |
| GET | `/api/projects/:project` | — | 200 `Projects.Detail` = `{ stack: Stack, status: ProjectStatus }` | 404, 422 (invalid file) |
| DELETE | `/api/projects/:project` | — | 200 `Projects.Entry` = `{ name, root, envFile? }` | 404 |
| POST | `/api/projects/:project/up` | — | 202 `{ opId }` | 404, 422 |
| POST | `/api/projects/:project/down` | query `volumes?` | 202 `{ opId }` | 404 |

- `POST /api/projects`: when `<root>/locastack.yaml` does not exist the server
  creates the folder and a fresh file (`createProject`); when it exists it is
  registered as-is (`registerProject`, its `name` must match). `root` is absolute.
- `pick-folder` opens the native dialog on the server machine, starting at
  `~/Developer` with title "Choose a folder for <name>"; the UI then fills the
  folder input (default suggestion `~/Developer/<name>`).
- `DELETE` only unregisters: containers, volumes, secrets and files stay.
- `ProjectSummary` = `{ name, root, envFile?, serviceCount, running, errors,
  types: string[], cpuPercent?, memBytes?, issue? }`; `errors` counts services in
  `port-conflict`/`error`; `issue` is set (and counts are 0) when the folder or
  file is missing/invalid. CPU/MEM are sums of the latest observer samples and
  are left out when there is none (nobody has the project on Live); the
  dashboard then shows `—`, never a made-up 0.

### Services (instances of one project)

Base: `/api/projects/:project/services`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/` | — | 200 `Services.List` = `ServiceView[]` (core `listServices` / per-service `getService`, plus `data`) | 404, 422 |
| POST | `/` | body `Services.Add` `{ name, type, version?, port?: number\|'auto', persist?: 'volume'\|'ephemeral', config?, secrets?, seed? }` | 202 `{ opId }` | 404, 409 (`SERVICE_EXISTS`, `PORT_CONFLICT`), 422 |
| GET | `/:name` | — | 200 `Services.Detail` = `ServiceView` | 404 |
| PATCH | `/:name` | body `Services.Patch` `{ version?, port?, persist?, config?, seed? }` (at least one) | 202 `{ opId }` | 404, 409, 422 |
| DELETE | `/:name` | query `volumes?` | 202 `{ opId }` | 404, 422 |
| POST | `/:name/start` | — | 202 `{ opId }` | 404 |
| POST | `/:name/stop` | — | 202 `{ opId }` | 404 |
| POST | `/:name/restart` | — | 202 `{ opId }` | 404 |
| GET | `/:name/connection` | query `reveal?` (default false) | 200 `Services.Connection` = `ConnectionInfo` | 404 |
| GET | `/:name/logs` | query `tail?` (0–5000, default 200) | 200 `Services.LogTail` = `{ lines: LogLine[] }`, oldest first, read once (`follow=false`, 5 s cap); empty when there is no container | 404, 422 |
| GET | `/:name/stats` | — | 200 `Services.StatsReading` = `{ samples: StatsSample[] }` with at most one sample (the second Docker frame, which has a CPU delta; ≤ 2.5 s); empty unless running | 404 |
| PATCH | `/:name/secrets/:key/rotate` | body `Services.RotateSecret` `{ force?, wipeVolume? }` | 202 `{ opId }` | 404, 422 (see [Secret rotation](#secret-rotation)) |

`ServiceView` = `ServiceDetail` + `data: { kind: "sql" | "redis" | "none", label? }`
(`DataCapability`): the Data tab's capability from the catalog definition's
`data` block (`none` when it has none, or the type is missing from the
catalog). `label` is the object list heading ("Tables", "Key patterns").

- Add writes the entry to `locastack.yaml` (comments kept), resolves (port
  pinned, secrets generated), renders compose and `up --wait`s that service.
  Validation that needs the catalog (unknown type/version/config key) is a `422`
  before the `202` when cheap, otherwise an `error` event. An explicit port that
  is bound on 127.0.0.1 or pinned by another project is a `409 PORT_CONFLICT`
  before the `202`. The entry is written to `locastack.yaml` shortly *after*
  the `202`, so a client that opens the service right away polls
  `GET …/services/:name` until it answers (the dashboard does) or follows
  `op:<opId>`.
- Add `secrets`: initial values chosen by the
  Config page's **Regenerate**, by catalog secret name, e.g.
  `{ POSTGRES_PASSWORD: "…" }`. Each value matches `SECRET_VALUE_PATTERN`
  `^[A-Za-z0-9._~-]{16,256}$` (stricter than printable ASCII: values go
  unencoded into `DATABASE_URL`-style URLs, compose `.env` and argv); names
  must be the definition's `secrets` (`422` otherwise). Omitted secrets are
  generated as before. The client generates 32 random bytes as base64url. If
  a `bakedIntoVolume` secret is already stored for that instance name (a
  volume left from an earlier service of the same name), the stored value is
  kept so the volume still accepts it, and a `log` event says so (without the
  value).
- `seed` (Add and PATCH): seed file relative to the project root
  (`SeedPath`: no absolute path, `~`, drive letter or `..` segment), only for
  definitions with a `seed` block. PATCH `seed: ""` removes it. The renderer
  mounts `<root>/<seed>` read-only at `seed.mountPath/seed.fileName`; Postgres
  runs it only when the data volume is initialised, so a later change needs
  **Seed** (below) or a wipe. The server checks before the `202` that the
  type supports seeds and the file exists under the project root (`422`
  otherwise); a path that resolves outside the root is `INVALID_STACK`.
- PATCH `config` replaces the entry's whole `config` map. The "Use port N" fix is
  `PATCH { port: N }` with `N = status.problem.suggestedPort`; the op rewrites
  the entry and re-ups (recreates) the service, so no separate restart is needed.
- DELETE with `volumes=true` deletes the service's named volumes, forgets its
  secrets and deletes its snapshots (archives, secret sidecars, index rows;
  typed confirmation in the UI). Without it all three are kept.
- `logs` and `stats` are the one-shot reads behind the Logs and Metrics tabs
  when Live/Follow are off; the streaming equivalents are `logs:<containerId>`
  and `stats:<containerId>` on `/ws`.


### Data tab (query runner)

Base: `/api/projects/:project/services/:name/data`. One-shot REST: nothing
streams or polls. CSV export of a result is client-side.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/` | — | 200 `Data.Objects` = `DataObjects` | 404, 409 `SERVICE_NOT_RUNNING`, 422 (no Data tab, listing failed), 504 `TIMEOUT` |
| POST | `/query` | body `Data.QueryBody` `{ query, limit? }` | 200 `Data.Result` = `DataQueryResult` | 404, 409 `SERVICE_NOT_RUNNING`, 422 (empty query, query rejected), 504 `TIMEOUT` |

```ts
DataObjects = {
  kind: "sql" | "redis",
  label: string,                          // "Tables" | "Key patterns"
  objects: [{ name, defaultQuery }],      // ≤ 1000; defaultQuery has {{object}} filled in
  truncated: boolean,                     // more than 1000 objects existed
}
DataQueryBody = { query: string /* 1..100000 chars */, limit?: 1..1000 /* default 1000 */ }
DataQueryResult = {
  columns: string[],                      // CSV header (redis: one synthetic column)
  rows: string[][],                       // cells as text, NULL = ""; statements without a
                                          // result set give one `status` row per command tag
                                          // (e.g. ["CREATE TABLE"], ["INSERT 0 2"])
  rowCount: number,                       // rows.length
  truncated: boolean,                     // > limit rows or > 2 MB output
  durationMs: number,
}
```

- Hard limits (core constants): `DATA_QUERY_TIMEOUT_MS` 15 000,
  `DATA_QUERY_MAX_BYTES` 2 MiB of stdout, `DATA_QUERY_MAX_ROWS` 1000,
  `DATA_QUERY_MAX_LENGTH` 100 000 characters.
- A blank query (whitespace only) is `422 INVALID_INPUT` "Query is empty.". A
  stopped service is `409 SERVICE_NOT_RUNNING` "<name> is not running. Start
  it to run queries.". A query the engine rejects (e.g. `ERROR: relation "x"
  does not exist`) is `422 INVALID_INPUT` whose message is the tool's first
  error line(s), secrets masked, with `details.exitCode`. A timeout is `504`
  `{ code: "TIMEOUT", message: "Query timed out after 15 s.", details: {
  timedOut: true, exitCode: -1, fix, opCode: "INVALID_INPUT" } }`; the
  timed-out process is killed inside the container. Killing psql does not
  stop its backend, so the Postgres catalog also bounds every statement on
  the server (conninfo `options`: `statement_timeout=14000`,
  `idle_in_transaction_session_timeout=14000`,
  `client_connection_check_interval=1000`): a long statement is cancelled by
  Postgres first (`422` "canceling statement due to statement timeout") and
  never keeps its locks or CPU after the request ended.
- Redis: the query is split into words like redis-cli does; a first word
  starting with `-` is refused (`422`), since redis-cli would read it as an
  option. Nothing goes through a shell.
- The server re-caps rows at `limit` and objects at 1000 and sets `truncated`
  when it cuts.
- Queries run as the service's configured user (Postgres over the local
  socket, Redis with `REDISCLI_AUTH`): writes are allowed; it is a local dev
  database.
- Ops: `listDataObjects(deps: DataDeps, { project, name })`,
  `runQuery(deps, { project, name, query, limit? })`; ports `ContainerExec`
  (`ports/exec.port.ts`) + `ContainerInspector`.

### Snapshots and seed

Base: `/api/projects/:project/services/:name`. Archives live at
`<stateDir>/snapshots/<project>/<service>/<id>.tgz` (`snapshotArchivePath`),
indexed in the SQLite `snapshots` table (with the catalog `type` and
`version` at archive time). The values of the secrets the catalog marks
`bakedIntoVolume` (the Postgres password) are kept in a mode-0600 sidecar
`<id>.secrets.json` next to the archive (`snapshotSecretsPath`), never in the
index or in any event.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/snapshots` | — | 200 `Snapshots.List` = `Snapshot[]`, newest first | 404 |
| POST | `/snapshots` | body `Snapshots.Create` `{ name? }` | 202 `{ opId }` | 404, 422 (ephemeral service, no volume, bad name) |
| POST | `/snapshots/:id/restore` | — | 202 `{ opId }` | 404 (`SNAPSHOT_NOT_FOUND`: unknown id or another service's snapshot), 422 (another catalog type or major version: `details.reason` `type-mismatch` / `version-mismatch`) |
| DELETE | `/snapshots/:id` | — | 200 `Snapshots.Snapshot` (the deleted one) | 404 (`SNAPSHOT_NOT_FOUND`) |
| POST | `/seed` | — | 202 `{ opId }` | 404, 409 `SERVICE_NOT_RUNNING`, 422 (no seed file set) |

```ts
Snapshot = { id, service, name, sizeBytes, createdAt }   // id: ^[A-Za-z0-9_-]{1,64}$
CreateSnapshotBody = { name?: string }                    // ^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$, default "snap-<n>"
```

- **Create** (`createSnapshot`): needs `persist: volume` and a definition
  with exactly one volume. Steps: "Stopping <name>" (only if it was running:
  a tar of a live Postgres volume is inconsistent), "Archiving <volume>"
  (helper `docker run --rm --network none --mount
  type=volume,src=<vol>,dst=/from,readonly --mount type=bind,src=<dir>,dst=/to
  alpine:3.20 sh -c …`, labelled `io.locastack.helper`; the archive is written
  to a temp name and renamed on success, mode 0600), "Starting <name>" (only
  if it was running; `up --wait`, so the op settles once it is healthy), `done`
  "Snapshot “<name>” created". The dashboard refetches the list when the op
  settles.
- **Restore** (`restoreSnapshot`): refused (`422`, nothing stopped) when the
  snapshot was taken from another catalog type or major version. Then
  "Stopping <name>", "Restoring “<snapshot>”" (`tar xzpf --numeric-owner`
  into a staging folder inside the volume; only after a complete extraction
  are the old contents deleted and the staged ones moved in, so a corrupt or
  vanished archive leaves the data as it was), "Restoring <KEY…> saved with
  the snapshot" (only when the sidecar's baked-in secrets differ from the
  stored ones, e.g. after "snapshot, rotate with Wipe volume, restore": the
  snapshot's values are stored again and compose re-rendered, so `.env` and
  `DATABASE_URL` match the restored data), "Starting <name>" (`up --wait`,
  with its dependents when secrets changed; also after a failed restore,
  whose error is reported afterwards), `done` "Restored “<snapshot>” into
  <name>". The UI confirms first (destructive).
- **Delete** (`deleteSnapshot`) removes the archive, its secrets sidecar and
  the row; it touches no container, so it answers `200` directly (no op), but
  it runs in the project's op lane: it waits for a create / restore / seed in
  flight and ops started meanwhile wait for it. It only needs the project, so
  snapshots of a removed service can still be deleted.
- **Seed** (`seedService`): pipes `<root>/<seed>` (≤ 64 MiB; symlinks are
  resolved and must stay inside the project folder, and it must be a regular
  file, all checked before reading; the compose bind mount gets the same
  check and the canonical path) to the catalog's
  `seed.run` over exec stdin in the running container (120 s cap). `done`
  "Seeded <name> from ./<seed>"; a failing statement is the `error` event
  with the tool's first error line (seed files are not idempotent: re-running
  a `CREATE TABLE` fails with "already exists"). The Snapshots tab shows
  **Seed** only when the definition has a `seed` block and the entry sets one.
- Ports: `VolumeArchiver`, `SnapshotIndex` (`ports/snapshot.port.ts`).

### Secret rotation

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| PATCH | `/api/projects/:project/services/:name/secrets/:key/rotate` | params `Services.SecretKeyParams`, body `Services.RotateSecret` `{ force?, wipeVolume? }` | 202 `{ opId }` | 404, 422 (unknown key, baked into the volume) |

- `rotateSecret` generates a new value for `:key` (a catalog secret name,
  e.g. `POSTGRES_PASSWORD`), rewrites the secrets file and compose `.env`,
  and recreates the container (and dependents that use the value). No event
  carries the value; read it from `GET …/connection?reveal=true`.
- A secret marked `bakedIntoVolume` (Postgres password) on a service with
  `persist: volume` is refused with `422 INVALID_INPUT` and a `details.fix`
  ("The password is stored in the data volume on first start; rotating it
  needs the volume wiped. Take a snapshot first, then rotate with Wipe
  volume.") unless `force: true` **and** `wipeVolume: true`, which removes the
  container, deletes its volumes, then starts it fresh (typed confirmation in
  the UI). Redis and Upstash secrets rotate freely. `wipeVolume: true`
  without `force: true` is refused (`422`, `details.field: "force"`) for every
  secret: deleting a volume always needs the confirmation.
- Mounted by the services controller (`modules/services`), op kind
  `service.rotate-secret`.

### Import docker-compose.yml

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| POST | `/api/import/preview` | body `Import.PreviewBody` `{ yaml, projectName? }` | 200 `Import.Preview` = `ImportPreview` | 422 (invalid YAML, no services, too large) |
| POST | `/api/import` | body `Import.Body` `{ name, root, items, start }` | 202 `{ opId }` | 404, 409 (`PROJECT_EXISTS`, `PORT_CONFLICT`), 422 |

```ts
ImportPreview = { suggestedName: string, items: ImportItem[] }
ImportItem = {
  composeName: string,          // compose key as written
  name: string,                 // instance name derived from it (^[a-z][a-z0-9-]*$, unique)
  image?: string,               // absent for build-only services
  type?: string,                // matched catalog id
  version?: string,             // from the tag when it is a catalog version (16-alpine → 16)
  supported: boolean,
  skipReason?: "build" | "no-match",
  include: boolean,             // checked in the preview; false when unsupported
  hostPort?: number,            // what will be pinned
  wantedPort?: number,          // what the file asked for (else the definition default)
  remapNote?: string,           // "5432 is used by shop-api/main-db" | "5432 is in use on this machine" | "5432 is used by another service in this file"
  config: Record<string, string>,   // POSTGRES_DB, POSTGRES_USER…
  secrets: Record<string, string>,  // POSTGRES_PASSWORD… (^[A-Za-z0-9._~-]{1,256}$; others dropped and generated)
}
ImportBody = { name, root /* absolute */, items: ImportItem[] /* ≥ 1 */, start: boolean }
```

- The dashboard sends the pasted or dropped file text (≤ 512 KiB,
  ≤ 100 services); the server never reads compose files from disk. The
  folder comes from `POST /api/projects/pick-folder`.
- Parsing uses the `yaml` package (`parseComposeForImport`): list and map
  `environment`, short and long `ports` syntax; ranges and interpolated ports
  are skipped. Mapping (`mapComposeToCatalog`) uses each definition's
  `import` block, then checks every wanted port against other projects' pins,
  earlier items and a 127.0.0.1 probe (a separately run stack on
  5432/6379/8079 is detected) and picks the next free port in the
  definition's range.
- The preview writes nothing (its op only gets read-only state, the catalog
  and the port probe). `projectName` is turned into a valid name (a `.yml`
  extension is dropped) before checking that it is free.
- The preview is echoed back in `items` (only `supported && include` ones are
  imported) and re-validated. Before the `202` the server applies the New
  project folder rules and answers `409 PROJECT_EXISTS` for a registered name
  or a folder that already has `locastack.yaml`, `422` for no importable item
  or duplicate instance names. `importProject` steps: "Creating <root>",
  "Registering <name>", "Storing secrets", "Writing locastack.yaml",
  optionally "Starting N services", then `done` "Imported N services into
  <name>[, M ports remapped]". If storing secrets or writing the file fails,
  the registration is undone, so nothing is left behind. A failure while
  starting leaves the project registered (start it again from the project
  page). The dashboard opens the project once `locastack.yaml` is written:
  on the first event after "Writing locastack.yaml" ("Starting N services"
  or `done`), confirmed with one `GET /api/projects/:name`.

### Operations

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/ops/:opId/events` | — | 200 `application/x-ndjson`: one `Progress` JSON object per line (buffered events first, then live ones); the response ends after the terminal `done`/`error`. A blank line is sent every 5 s while the op is quiet (keep-alive; skip it) | 404 `{ code: "OP_NOT_FOUND", message }` (unknown, or settled more than 60 s ago) |

Operations that name a project are also recorded in the SQLite `ops` table
(`OpJournal`): id, project, service, kind (`project.up`, `service.add`,
`snapshot.create`, `snapshot.restore`, `service.seed`,
`service.rotate-secret`, `project.import`, …), status (`running`,
`succeeded`, `failed`), start and end time, and the terminal event's
secret-free error. The newest 200 rows per project are kept. There is no
route for it yet.

`ServiceStatus` (overview row, WS status payloads):

```ts
{
  name, type, version, image,            // image e.g. "postgres:17-alpine"
  hostPort, containerPort, containerName, containerId?,
  persist: "volume" | "ephemeral",
  state: "running" | "starting" | "stopped" | "port-conflict" | "error",
  health: "healthy" | "unhealthy" | "starting" | "none",
  startedAt?,                            // ISO, for "Up 3h"
  problem?: { code, message, suggestedPort? },
  cpuPercent?, memBytes?,                // latest observer sample
}
```

Badge mapping: `running` → Running, `starting` → Starting…, `stopped` → Stopped,
`port-conflict` → Port conflict (show "Use port N"), `error` → error message.

`ServiceDetail` = `ServiceStatus` + `{ network, config (effective, non-secret),
secretNames, volumes: [{ name, source, path }] }` (Metrics info table: Image,
Container, Network, Volume, Port mapping `127.0.0.1:<hostPort> → <containerPort>`).

`ConnectionInfo`:

```ts
{
  primary: { key, value },          // definition.primaryExport under its final name
  exports: [{ key, value }],        // every export of the service, final names
  details: [{ k, v }],              // Host, Port, User, Database, Secret, Container…
  snippets: { env, node?, python?, go? }, // KEY already replaced by primary.key
}
```

Copy URL on the overview = `GET …/connection?reveal=true` → `primary.value`.

### Environment

| Method | Path | Request | 200 response | Errors |
|---|---|---|---|---|
| GET | `/api/projects/:project/env` | query `format?: dotenv\|shell\|json` (default dotenv), `reveal?` | `Env.Preview` | 404, 422 |
| POST | `/api/projects/:project/env/write` | body `{ file? }` | `Env.Written` = `{ path, count }` | 404, 422 |

`EnvPreview` = `{ format, lines: [{ key, value, service, type }], text,
serviceCount, file }`. `text` groups lines under `# <service> (<type>)` comments
(dotenv/shell). `file` is the "Write to ./<file>" target: `link.file`, else
`.env`. Key naming: the primary export may be renamed by `link.names.<service>`;
otherwise every key of a service gets a `<SERVICE_NAME>_` prefix (upper case,
dashes → `_`) only when one of its keys collides with an earlier service's key.
Write always writes revealed values between `# locastack:start` /
`# locastack:end` markers, leaving the rest of the file alone.

## WebSocket `/ws`

Connect to `ws://127.0.0.1:<port>/ws?t=<token>`. JSON messages, validated by
`Observer.Client` / `Observer.Server`. The dashboard connects only for Live
mode and Follow (see above); everything else has an HTTP route.

Client → server:

```ts
{ type: "subscribe" | "unsubscribe", channel: Channel, tail?: number /* logs, default 200 */ }
```

`Channel` is one of `status:<project>`, `stats:<containerId>`,
`logs:<containerId>`, `op:<opId>`.

Server → client, discriminated by `type`:

| type | channel | payload |
|---|---|---|
| `snapshot` | `status:<project>` | `ProjectStatus` `{ project, network, services: ServiceStatus[] }`: sent on subscribe |
| `delta` | `status:<project>` | `{ services: ServiceStatus[] /* changed */, removed: string[] }`: only rows that changed; the server reloads every 2 s and on Docker events (100 ms debounce) |
| `stats` | `stats:<containerId>` | `{ samples: StatsSample[] }`: first message carries the last 24 samples of the 5 min history, then at most one new sample per second; `StatsSample` = `{ cpuPercent, memBytes, memLimitBytes, netRx, netTx, at }` |
| `log` | `logs:<containerId>` | `{ lines: LogLine[], skipped?, ended? }`: first message = last `tail` lines, then batches every 75 ms; `LogLine` = `{ stream: stdout\|stderr, text, at? }` (ANSI kept, render with anser); `skipped` = lines dropped under backpressure |
| `progress` | `op:<opId>` | `Progress` `{ kind: step\|log\|done\|error, message, service?, opId?, percent?, at?, error?: { code, message, details? } }` |
| `error` | any | `{ code, message }` (bad channel, unknown project/container, daemon down) |

One upstream Docker stream per container is shared by all subscribers and
closed when the last one leaves. Unsubscribe when a tab/page unmounts.

## Screen → routes

| Screen | Load | Live | Actions |
|---|---|---|---|
| Header (all pages) | `GET /api/system`, `GET /api/projects` (switcher) | — | — |
| Projects `/` | `GET /api/projects` (Refresh refetches) | — (cards never subscribe) | New project: `POST /api/projects/pick-folder`, `POST /api/projects`; Start all / Stop all: `POST …/:project/up\|down` → `GET /api/ops/:id/events` |
| Project overview `/p/:project` | `GET /api/projects/:project` (Refresh refetches) | Live on: `status:<project>` + `stats:<containerId>` per running row | Start/Stop all: `up`/`down`; row: `POST …/services/:name/start\|stop\|restart`; ⋯ → Remove: `DELETE …/:name?volumes=`; Copy URL: `GET …/:name/connection?reveal=true`; Use port N: `PATCH …/:name { port }` |
| Catalog `/p/:project/add?q=&cat=` | `GET /api/catalog` (filter client-side) | — | Quick add opens the ⌘K palette |
| Config `/p/:project/add/:type` | `GET /api/catalog`, `GET /api/projects/:project` (taken names/ports), `GET /api/catalog/:type/free-port` (default port) | — | Add & start: `POST …/services` → wait for `GET …/services/:name`, navigate to detail, follow `GET /api/ops/:id/events` |
| Service detail `/p/:project/s/:service?tab=` | `GET …/services/:name` | Live on: `status:<project>`, `stats:<containerId>` | Restart/Start/Stop, Use port N (as above), Remove |
| — Connect tab | `GET …/:name/connection?reveal=` | — | Copy (reveal=true) |
| — Logs tab | `GET …/:name/logs?tail=200` (Reload refetches) | Follow on: `logs:<containerId>` (`tail` 200) | Clear is client-side |
| — Metrics tab | `GET …/services/:name` (info table), `GET …/:name/stats` (last-known numbers) | Live on: `stats:<containerId>` (charts, last 24 samples) | — |
| — Data tab (catalog `data.kind` ≠ `none`) | `GET …/:name/data` (object list; Refresh refetches) | — | Run (⌘↩): `POST …/:name/data/query`; Export CSV is client-side |
| — Snapshots tab (`persist: volume`, or the type has a `seed` block) | `GET …/:name/snapshots` | — | Create: `POST …/:name/snapshots { name? }`; Restore: `POST …/snapshots/:id/restore` (confirm); Delete: `DELETE …/snapshots/:id`; Seed (definition has `seed`): `POST …/:name/seed`; all 202 ones followed with `GET /api/ops/:id/events` |
| Config form: Regenerate / Seed file | — | — | Regenerate fills the password client-side and sends it as `secrets` on Add; on an existing service it is `PATCH …/secrets/:key/rotate`. Seed file is `seed` on Add / PATCH |
| Import modal (Projects) | — | — | Parse: `POST /api/import/preview { yaml, projectName? }`; Folder: `POST /api/projects/pick-folder`; Import: `POST /api/import` → `GET /api/ops/:id/events` |
| Environment `/p/:project/env?fmt=` | `GET …/env?format=&reveal=` | — | Write: `POST …/env/write`; Copy/Download: `text` |
| ⌘K palette | cached `GET /api/projects`, `GET /api/catalog`, the current project | — | Add to project, go to a service or project, Export .env |
| Toasts | — | — | `GET /api/ops/:opId/events` |

CLI hint bar commands that exist: `locastack up`, `locastack down`,
`locastack env`, `locastack doctor` (run from the project folder).
