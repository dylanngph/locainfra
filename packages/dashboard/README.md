# @locastack/dashboard

The LocaStack web dashboard (M3b): React 19 + Vite 8, Tailwind 4, shadcn (base-nova),
React Router 8 in Data Mode, TanStack Query, TanStack Form, nuqs, zustand, Eden Treaty.

```sh
bun run dev        # against a running LocaStack server (proxied to 127.0.0.1:4488)
bun run dev:mock   # standalone: MSW mocks the HTTP API and the /ws observer socket
bun run test       # Vitest + Testing Library + MSW
bun run typecheck
bun run build
bun run e2e        # live Playwright smoke against real Docker (see below)
```

Data loads once over REST (Refresh refetches; nothing polls). The observer WebSocket is opened only
while a project's **Live** switch or the Logs tab's **Follow** switch is on; actions are followed
with `GET /api/ops/:opId/events` (NDJSON). ⌘K opens the command palette.

M3b features: `features/data` (Data tab: object list, query runner, CSV export), `features/snapshots`
(Snapshots tab: create/restore/delete, Seed), `features/import` (Import docker-compose.yml modal:
paste or drop, preview, import), and in `features/config` the Regenerate secret button and the Seed
file field; Rotate secret sits on the Connect tab. None of them poll or open a socket.

### Live e2e (`e2e/m2-smoke.spec.ts`, `e2e/m3a-smoke.spec.ts`, `e2e/m3b-smoke.spec.ts`)

Skipped unless `LOCASTACK_E2E=1`. The global setup starts `dist/locastack` (or the CLI from
source) on port 4598 with `LOCASTACK_HOME` in a scratch folder and a fixed session token, then the
spec drives the real UI: create a project, add Postgres `main-db` (`port: auto` → 5433), Redis
`cache`, check Connect/Logs/Metrics, write `.env`, stop/start, add a second Postgres `events`, and
remove everything with volumes (asserting no `ls-m2-smoke*` containers, volumes or networks remain).
The M3a spec (project `m3a-smoke`) checks that no WebSocket opens until Live/Follow is on (ops,
log tail and metrics go over HTTP), that Live streams status and stats and closes the socket when
turned off, removes Redis through the typed-confirmation dialog (with its volume), drives the ⌘K
palette, and checks `locastack.db` (0600) plus `locastack env`. The M3b spec (project `m3b-smoke`)
pastes the sample compose into the Import modal (ports 5432/6379 are remapped when taken), runs
`select 1` and `PING` in the Data tab and exports CSV, creates, restores and deletes a Postgres
snapshot (checking the archive, the SQLite row and that no helper container is left), adds a second
Postgres with a regenerated password and a `seed.sql`, rotates the Redis password and checks that
rotating the Postgres one asks to wipe the volume. Screenshots go to the git-ignored
`e2e/.screenshots/{m2,m3a,m3b}/`.

```sh
bun run build                                             # from the repo root, optional
LOCASTACK_E2E=1 LOCASTACK_E2E_CHANNEL=chrome bun run e2e  # chrome = installed Google Chrome
```

Optional: `LOCASTACK_E2E_SCRATCH=<dir>` (scratch folder), `LOCASTACK_E2E_BIN=<path>` (binary to
test), `LOCASTACK_E2E_PORT=<port>` (default 4598).

Layout: `src/app` (router, layouts, providers), `src/features/<feature>/{components,hooks,api,lib,__tests__}`,
`src/shared/{ui (shadcn), components, lib, hooks}`, `src/test/msw` (mock API used by tests and `dev:mock`).
Add shadcn components with `bunx --bun shadcn@latest add <name> -y`.
