---
"@locastack/core": minor
"@locastack/engines": minor
"@locastack/server": minor
"@locastack/dashboard": minor
"@locastack/cli": minor
---

M2: the dashboard.

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
