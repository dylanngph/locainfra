---
"@locainfra/core": patch
"@locainfra/engines": patch
"@locainfra/server": patch
"@locainfra/dashboard": patch
---

M3a review fixes: Live is never switched on by itself, nothing polls, and state errors are clearer.

- **Live** is kept for the current page only. A reload, a bookmark or a new tab always starts with Live off and no WebSocket until you turn it on.
- On the Logs tab, **Follow** is switched on and off with Live, so turning Live off always closes the socket.
- Adding a service no longer polls the server while the add waits for other operations. The dashboard opens the new service's page when the operation reports that it wrote `locainfra.yaml`.
- CPU and memory show `—` instead of a made-up `0.0%` / `0 MB` when there is no reading because Live is off. This applies to service rows and project cards. `ProjectSummary.cpuPercent`/`memBytes` are now optional and are only sent while the project is being watched.
- An older LocaInfra refuses a state database that a newer release has migrated ("…was created by a newer LocaInfra; update LocaInfra") and leaves the file unchanged. The schema version marker never moves backwards.
- Two `locainfra` processes that start together on the first run after an upgrade no longer fail when both try to import `state.json`.
- The ⌘K palette highlights the first row every time it opens.
