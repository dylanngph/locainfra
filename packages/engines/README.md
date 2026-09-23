# @locainfra/engines

Concrete adapters for the ports declared in `@locainfra/core` (`packages/core/src/ports`).
Only composition roots (`packages/cli/src/composition.ts`, `packages/server/src/app.ts`) import this package.

```ts
import { createEngines } from "@locainfra/engines";

const engines = createEngines(); // honours LOCAINFRA_HOME
await runDoctor(engines); // field names match core's *Deps interfaces
```

## Adapters

| Folder | Adapter | Port(s) |
|---|---|---|
| `docker/` | `DockerSocketLocator` (`DOCKER_HOST` → `docker context inspect` → platform default) | `SocketLocator` |
| `docker/` | `UnixSocketTransport` (Bun `fetch({ unix })`, `/v1.44` with downgrade to older daemons) | `DockerTransport` |
| `docker/` | `DockerClient` (`GET /version`, `GET /containers/json`) | `DockerInfoPort`, `ContainerReader` |
| `docker/` | `LogDemuxer`, `demuxLogChunks` (8-byte-header multiplexed log frames) | — |
| `compose/` | `ComposeRunner` (`docker compose` via `Bun.spawn`; typed errors such as `PORT_CONFLICT`) | `ComposeInfoPort`, `LifecycleRunner` |
| `compose/` | `parseComposePs` (NDJSON or JSON array; comma-joined `Labels`) | — |
| `state/` | `FileStateStore` (`state.json`, lock file + temp file + rename, mode 0600) | `StateReader`, `StateWriter` |
| `state/` | `FileSecretStore` (`secrets/<stack>.env`, mode 0600, dir 0700) | `SecretStore` |
| `fs/` | `BunFileStore` | `FileStore` |
| `net/` | `BindPortProbe` (bind 127.0.0.1, then loopback connect check) | `PortProbe` |
| `util/` | `SystemClock`, `CryptoSecretGenerator` (base64url) | `Clock`, `SecretGenerator` |
| `paths/` | `resolveDefaultPaths` (`LOCAINFRA_HOME` override) | `Paths` |

The Engine API client is read-only. Only `ComposeRunner` changes containers.

## Tests

```sh
bun test          # unit tests plus live tests (skipped when Docker is unavailable)
bunx tsc --noEmit
```

- Parsers are tested against recorded fixtures in `__tests__/fixtures/`: `docker compose ps --format json` output and real multiplexed log frames.
- `DockerTransport` contract tests run against `UnixSocketTransport` (a fake daemon on a real unix socket) and `FakeTransport`.
- Live tests only call `GET /version`, `GET /containers/json` and `docker compose version`. They never start or stop anything.
