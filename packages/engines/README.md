# @locastack/engines

Concrete adapters for the ports declared in `@locastack/core` (`packages/core/src/ports`).
Only composition roots (`packages/cli/src/composition.ts`, `packages/server/src/app.ts`) import this package.

```ts
import { createEngines } from "@locastack/engines";

const engines = createEngines(); // honours LOCASTACK_HOME
await runDoctor(engines); // field names match core's *Deps interfaces
```

## Adapters

| Folder | Adapter | Port(s) |
|---|---|---|
| `docker/` | `DockerSocketLocator` (`DOCKER_HOST` → `docker context inspect` → platform default) | `SocketLocator` |
| `docker/` | `UnixSocketTransport` (Bun `fetch({ unix })`, `/v1.44` with downgrade to older daemons) | `DockerTransport` |
| `docker/` | `DockerClient` (`GET /version`, `GET /containers/json`, `GET /containers/{id}/json`) | `DockerInfoPort`, `ContainerReader`, `ContainerInspector` |
| `docker/` | `DockerContainerStreams`: logs (demuxed, per line, timestamp parsed), stats (`docker stats` math), events (JSON lines, `type=container`, label filter) | `ContainerStreams` |
| `docker/` | `LogDemuxer`, `demuxLogChunks` (8-byte-header multiplexed log frames) | — |
| `docker/` | `DockerContainerExec` (`POST /containers/{id}/exec` + `POST /exec/{id}/start`, demuxed; `GET /exec/{id}/json` for the exit code; stdin through `UnixSocketHijacker`) | `ContainerExec` |
| `docker/` | `DockerVolumeArchiver` (`docker run --rm` alpine helper, `--network none`; tar/untar a named volume) | `VolumeArchiver` |
| `state/sqlite/` | `SqliteSnapshotIndex` (`snapshots` table), `SqliteOpJournal` (`ops` table, newest 200 per project) | `SnapshotIndex`, `OpJournal` |
| `compose/` | `ComposeRunner` (`docker compose` up/down/start/stop/restart/rm/ps via `Bun.spawn`, then `docker volume rm` for `remove`; typed errors such as `PORT_CONFLICT`) | `ComposeInfoPort`, `LifecycleRunner` |
| `compose/` | `parseComposePs` (NDJSON or JSON array; comma-joined `Labels`) | — |
| `state/sqlite/` | `SqliteStateStore` (`locastack.db`, SQLite WAL via `bun:sqlite` + Drizzle; `BEGIN IMMEDIATE` per update; migrations in `drizzle/`, applied on open; imports a legacy `state.json` once; mode 0600) | `StateReader`, `StateWriter` |
| `state/` | `FileSecretStore` (`secrets/<stack>.env`, lock file + temp file + rename, mode 0600, dir 0700) | `SecretStore` |
| `fs/` | `BunFileStore` | `FileStore` |
| `net/` | `BindPortProbe` (bind 127.0.0.1, then loopback connect check) | `PortProbe` |
| `util/` | `SystemClock`, `CryptoSecretGenerator` (base64url) | `Clock`, `SecretGenerator` |
| `paths/` | `resolveDefaultPaths` (`LOCASTACK_HOME` override) | `Paths` |
| `desktop/` | `NativeFolderPicker` (`osascript` on macOS, `zenity`/`kdialog` on Linux, `null` on Windows or cancel) | `FolderPicker` |
| `desktop/` | `SystemBrowserOpener` (`open` / `xdg-open` / `cmd /c start`; http(s) URLs only) | `BrowserOpener` |
| `catalog/` | `resolveBuiltinCatalogDir` (see below) | — |

`DockerClient` and `DockerContainerStreams` are read-only. `ComposeRunner` changes containers;
`DockerContainerExec` runs commands inside running ones; `DockerVolumeArchiver` creates only
short-lived `ls-snapshot-helper-*` containers.

## Exec and snapshots

- `DockerContainerExec.run` passes argv verbatim (never a shell). `timeoutMs` and the caller's signal abort the
  stream; stdout past `maxBytes` ends the run with `truncated: true`; stderr is capped at 64 KiB. The Engine API
  cannot kill an exec, so each exec carries a random `LOCASTACK_EXEC_TAG` env var and a timed-out or capped process
  is SIGKILLed by a second exec (`EXEC_KILL_SCRIPT`), best effort; `exitCode` is then `-1`. A `404` is
  `SERVICE_NOT_FOUND`, a `409` `SERVICE_NOT_RUNNING`.
- `DockerVolumeArchiver` pulls `alpine:3.20` when missing (pull output becomes `log` events), then runs a
  `--rm` helper labelled `io.locastack.helper=snapshot`. `archive` mounts the volume read-only and writes a temp file
  renamed into place on success; `restore` checks the archive reads, empties the volume (dotfiles included) and
  extracts with owners preserved. The helper is `docker rm -f`-ed after any failure, abort or early break. Volume names
  must be plain Docker volume names, so a host path is never mounted.

## Streams

`DockerContainerStreams` opens one HTTP connection per call. Aborting the
signal, breaking out of the `for await`, or the daemon closing the stream all
close the connection; an abort ends the iterator without throwing. An
unreachable daemon rejects with `DOCKER_UNREACHABLE`, a missing container with
`SERVICE_NOT_FOUND`. The server's observer should share one upstream per
container/channel. Events: `{ labels: { k: "v" } }` matches exact values,
`{ k: "" }` matches label presence, and no labels means
`label=locastack.stack` (every LocaStack container).

## Built-in catalog folder (contract for composition roots)

`resolveBuiltinCatalogDir({ env, embeddedDir })` returns `{ dir, source }`:

1. `$LOCASTACK_CATALOG_DIR`, when set;
2. `embeddedDir`, when passed. A compiled CLI embeds `catalog/*.yaml`
   (`import … with { type: "file" }`), copies them once to a real, versioned
   folder (e.g. `~/.locastack/catalog-builtin/<version>/`, because the loader
   lists a directory), and passes that folder;
3. the repo `catalog/` folder, resolved from this package's source (`source: "repo"`).
   It only exists when running from source.

## State database (ADR 0008)

`SqliteStateStore` keeps machine-local state in `<stateDir>/locastack.db`. The schema lives in
`src/state/sqlite/schema.ts`; migrations are generated into `drizzle/` and committed:

```sh
bunx drizzle-kit generate --name <change>   # after editing schema.ts (from packages/engines)
bunx drizzle-kit check
```

At runtime the store uses the embedded copy when the binary was built with `--asset packages/engines/drizzle`
(Bun 1.4.2 puts it at `/$bunfs/root/drizzle`), else the source folder. Upgrading an existing database first writes
`locastack.db.backup` (0600). A failed migration rolls back and fails with an `IO` error naming the backup.

## Tests

```sh
bun test          # unit tests plus live tests (skipped when Docker is unavailable)
bunx tsc --noEmit
```

- Parsers are tested against recorded fixtures in `__tests__/fixtures/`: `docker compose ps --format json` output and real multiplexed log frames.
- `DockerTransport` contract tests run against `UnixSocketTransport` (a fake daemon on a real unix socket) and `FakeTransport`.
- Stream tests use `FakeTransport` + `streamingResponse` (open bodies, abort) with recorded stats NDJSON and encoded log frames.
- `DockerContainerExec` is tested against `FakeTransport` with encoded exec frames split across chunks;
  `DockerVolumeArchiver` against a fake `CommandRunner` (argv, cleanup, abort, errors).
- `data.live.test.ts` creates its own scratch `alpine` container (`--rm`, internal network) and volume, all named
  `ls-test-*`, and removes them. It never touches other containers.
- The other live tests are read-only. They call `GET /version`, list containers, inspect one, read one stats frame, tail 5 log lines, open and abort an events stream, and run `docker compose version`. They never start or stop anything.
