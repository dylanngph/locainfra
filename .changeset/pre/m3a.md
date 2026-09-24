---
"@locastack/core": patch
"@locastack/engines": minor
"@locastack/server": minor
"@locastack/dashboard": minor
"@locastack/cli": minor
---

M3 part 1: SQLite state, load-once dashboard with opt-in Live mode, Remove service and the ⌘K palette.

- State moves from `~/.locastack/state.json` to `~/.locastack/locastack.db` (SQLite in WAL mode via `bun:sqlite` + Drizzle, mode 0600). Migrations run on first use and are embedded in the binary. An existing `state.json` is imported once and renamed `state.json.migrated`. Concurrent `locastack` processes are serialized by the database, and two services can never pin the same host port (`PORT_CONFLICT`). Before a schema upgrade the database is copied to `locastack.db.backup`.
- The dashboard no longer polls. Pages load once and have a **Refresh** button; after an action only the affected data is refetched.
- **Live** (a per-project switch, off by default) streams status and CPU/memory over the WebSocket; the socket is opened only while Live, or **Follow** on the Logs tab, is on, and closes when they are turned off.
- Without Live, the Logs tab shows the last 200 lines (Reload fetches again) and the Metrics tab shows the last-known CPU/memory with a hint to turn Live on for charts.
- Actions (add, start, stop, restart, remove, up, down) are followed over HTTP, so they never open the WebSocket.
- New routes: `GET /api/projects/:project/services/:name/logs?tail=` (one-shot tail), `GET …/services/:name/stats` (one reading) and `GET /api/ops/:opId/events` (operation progress as NDJSON, ending after `done`/`error`).
- Remove service from the overview's ⋯ menu or the service page: type the name to confirm, and optionally delete its data volume.
- ⌘K / Ctrl+K opens a command palette: add a service to the current project, jump to a service or project, export `.env`.
