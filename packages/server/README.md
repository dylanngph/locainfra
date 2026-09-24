# @locastack/server

The dashboard's HTTP + WebSocket server (Elysia on Bun). Localhost only.

## Public surface (`src/index.ts`)

- `startServer({ port, token, deps, staticDir?, extraHosts?, dashboardFile?, handleSignals? })`
  listens on `127.0.0.1`, serves `/api/*`, `/ws` and (with `staticDir`, a real folder or the compiled binary's embedded `/$bunfs/root/dist`) the built SPA with an
  `index.html` fallback. Writes `~/.locastack/dashboard.json` (`{ pid, port, token, startedAt }`,
  mode 0600) and removes it on `stop()` or SIGINT/SIGTERM.
- `probeDashboard(path)`: the CLI's check for an already running instance (pid alive +
  `GET /api/health`).
- `createApp(deps)` / `App`: the Elysia app (no `listen`), for tests and the Eden Treaty client.
- `ServerDeps = { token, allowedHosts, ops: ServerOps, ports: ServerPorts, … }`: core ops and
  ports are injected by the composition root; nothing here imports engines.

## Layout

`src/modules/<feature>/{index.ts (controller), <feature>.service.ts, <feature>.model.ts, __tests__/}`
for `system`, `doctor`, `catalog`, `projects`, `services` (including the one-shot `logs` and
`stats` reads and `PATCH …/secrets/:key/rotate`), `data` (Data tab objects and queries, answered
directly with 200, 504 on timeout), `snapshots` (list/create/restore/delete and `POST …/seed`),
`import` (`POST /api/import/preview`, `POST /api/import`), `env`, `ops` (`GET /api/ops/:opId/events`, NDJSON progress) and `observer` (the
`/ws` hub used for Live mode: `status`/`stats`/`logs`/`op` channels, `OpRegistry`, log backpressure). Cross-cutting plugins
live in `src/plugins` (auth guard, error handler, static assets). Every `202 { opId }` op with a
project is recorded in the `OpJournal` port (SQLite `ops` table) by `OpRegistry`; a journal
failure never fails the op. The API contract is described
in `docs/api.md`.

## Test

```sh
bun test && bunx tsc --noEmit && bunx biome check .
```
