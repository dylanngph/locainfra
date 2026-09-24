# @locastack/server

## 0.1.0

### Minor Changes

- 8f11bea: Initial release.
  
  **Features**
  
  - `locastack` opens a local dashboard on 127.0.0.1 where you create projects, add services from the catalog (PostgreSQL, Redis, Upstash-compatible Redis REST), start and stop them, read logs and metrics, and copy connection strings or write them into your project's `.env`.
  - A project is a folder with a `locastack.yaml`. Services are named instances (`services: { main-db: { type: postgres, port: auto } }`), so a project can run several databases of one type. `port: auto` picks a free port and never takes a port another project or process already uses.
  - CLI for scripts and CI: `locastack up`, `down`, `env` (dotenv, shell or JSON) and `doctor`, all with `--json`.
  - Data tab: run SQL or Redis commands inside the running container and export the result as CSV.
  - Snapshots: archive a service's data volume and restore it later.
  - Seed files for PostgreSQL, applied when the data volume is first created.
  - Import an existing `docker-compose.yml`: databases and caches become managed services, ports that are taken are moved.
  - Secrets are generated for you, can be regenerated before a service is created and rotated later.
  - Live mode is opt-in: the dashboard loads data once and streams status, metrics and logs only while you turn Live or Follow on.
  
  **Security**
  
  - Everything binds to 127.0.0.1. The dashboard API and WebSocket require a per-run session token and reject foreign origins.
  - Generated secrets are stored with mode 0600 under `~/.locastack/secrets/` and never in `locastack.yaml`.
  
  **Platforms**
  
  - Single self-contained binary for macOS (Apple Silicon and Intel) and Linux (x64 and arm64, glibc and musl). Windows is planned.
  - Requires Docker Desktop or Docker Engine 24+ with Compose 2.24+.

### Patch Changes

- Updated dependencies [8f11bea]
  - @locastack/core@0.1.0
