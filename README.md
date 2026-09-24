# LocaStack

Local Docker dev services, managed from a dashboard.

Type `locastack`, a dashboard opens on `127.0.0.1`, and you add Postgres, Redis and friends from a catalog, start and stop them, read logs, and copy connection strings or write them into your project's `.env`. No hand-written compose files, no copied passwords.

> Status: 0.1.0. macOS and Linux; Windows is planned.

## Install

With npm (Node 20+; the package pulls the prebuilt binary for your platform):

```sh
npm i -g locastack
```

Or the standalone installer:

```sh
curl -fsSL https://raw.githubusercontent.com/dylanngph/locastack/main/install.sh | sh
```

Pin a version with `VERSION=0.1.0` before `sh`. A Homebrew tap (`brew install dylanngph/locastack/locastack`) is coming. Binaries for every release, with `SHA256SUMS` and build attestations, are on the [Releases](https://github.com/dylanngph/locastack/releases) page. The installer verifies the checksum and puts `locastack` in `~/.locastack/bin`.

**Requirements:** a Docker daemon plus the `docker` CLI with the Compose plugin 2.24+. On macOS that is Docker Desktop, or an alternative such as OrbStack or Colima (with the compose plugin installed); on Linux, Docker Engine 24+ with your user in the `docker` group. LocaStack finds the daemon through `DOCKER_HOST`, then the active `docker context`, then the default socket. Without a running daemon, `locastack` stops with the doctor checks and how to fix them. macOS (Apple Silicon and Intel) and Linux (x64 and arm64, glibc or musl).

**macOS note:** the binaries are not code-signed yet. Installs through `curl` or `brew` run without prompts. If you download a tarball in a browser, macOS quarantines it: right-click the binary and choose Open once, or run `xattr -d com.apple.quarantine locastack`.

## Quick start

```sh
locastack            # opens the dashboard at http://127.0.0.1:4488 with a session token
```

Create a project (a folder that gets a `locastack.yaml`), add PostgreSQL from the catalog, and copy `DATABASE_URL` from the Connect tab or write it into your project's `.env` from the Environment page. Everything binds to `127.0.0.1`.

## Usage

```sh
locastack                          # start (or reuse) the dashboard and open it; Ctrl+C stops it, services keep running
locastack --project . --no-open    # register this folder as a project; --port <n> picks the port (default: first free from 4488)
locastack up [--service main-db]   # start the services of the project in this folder (scripts/CI)
locastack down [--volumes] [--yes]
locastack env --format shell       # eval "$(locastack env --format shell)"
locastack doctor --json           # --json works on every command; locastack --version prints the version
```

A project is a folder with a `locastack.yaml` holding named service instances (`services: { main-db: { type: postgres, port: auto } }`, several per type allowed). Secrets live in `~/.locastack/secrets/` (mode 0600), never in the stack file. Machine-local state (registered projects, pinned ports) lives in `~/.locastack/locastack.db` (SQLite, mode 0600); an older `state.json` is imported once and renamed `state.json.migrated`. All services and the dashboard bind to `127.0.0.1`.

Each service page has a **Data** tab (run SQL or Redis commands in the running container, export CSV) and, for services with a data volume, a **Snapshots** tab (archive the volume, restore it later). A Postgres entry can name a `seed:` file in the project folder, which runs when the volume is first created. **Import docker-compose.yml** on the Projects page turns the databases and caches of an existing compose file into a project, moving ports that are already taken. Secrets can be regenerated when you add a service and rotated from the Connect tab. Snapshots live in `~/.locastack/snapshots/`, and each action is recorded in the database's `ops` table.

The dashboard loads data once and has a **Refresh** button; it never polls. Turn on **Live** (per project) to stream status and CPU/memory, or **Follow** on the Logs tab to stream logs; only then does it open a WebSocket.

Build the standalone binary with `bun run build`. It builds the dashboard, then runs Bun's native `bun build --compile` with `--asset` to embed the dashboard, the catalog and the migrations into `dist/locastack`. `bun run build:targets` compiles the six release targets into `dist/bun-<target>/locastack`.

## Development

Requires Bun and Docker Desktop (Compose ≥ 2.24). See [docs/architecture.md](docs/architecture.md), [docs/api.md](docs/api.md) and [docs/adr](docs/adr).

```sh
bun install          # once, at the root
bun run dev          # server (watch, :4488) + dashboard (HMR, :5173) — open http://127.0.0.1:5173/
bun run dev:ui       # dashboard only, against MSW mocks
bun run cli -- doctor
bun run test && bun run typecheck && bun run lint
bun run build        # vite build + bun build --compile → dist/locastack
bun run build:targets  # the six release targets → dist/bun-<target>/locastack
bun test npm         # installer + npm launcher tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md). Releases: [docs/release.md](docs/release.md).

## License

[MIT](LICENSE)
