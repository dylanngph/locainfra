---
status: implemented
date: 2026-09-23
---

# SQLite (bun:sqlite) with Drizzle for machine-local state, from M3

## Context

M1 keeps machine-local state in `~/.locastack/state.json` behind a hand-rolled file lock. Concurrent writers (CLI and dashboard) were the largest source of review findings. M3 adds snapshots, an operations log and possibly metrics history, all relational and growing over time. `bun:sqlite` ships inside Bun, so a database engine adds no runtime dependency or binary size.

## Decision

- Add `~/.locastack/locastack.db` (SQLite, WAL mode) accessed through Drizzle ORM with the `bun-sqlite` driver. Drizzle Kit is a dev dependency; migrations are embedded in the compiled binary and applied on startup.
- It **replaces `state.json`** and holds machine-local index data only: registered projects and their roots, pinned ports per instance, snapshot index, operation history, optional rolling metrics with a retention cap.
- It **does not** hold project definitions or secrets. `locastack.yaml` stays the committed source of truth for a project; `~/.locastack/secrets/<project>.env` (0600) stays the secret store; rendered compose files stay on disk for inspection.
- Core keeps talking to the `StateReader`/`StateWriter` ports; engines swaps the file implementation for a SQLite one. Transactions replace the file lock.

## Consequences

- One more runtime dependency (`drizzle-orm`) on the allowlist; `bun:sqlite` is built in.
- Startup runs migrations; a failed migration must fail loudly with a fix hint (backup path printed).
- `state.json` is imported once on first run of the new version, then renamed to `state.json.migrated`.
- Users lose `cat state.json`; `locastack doctor --json` exposes the same data instead.

## Implemented (M3)

- `packages/engines/src/state/sqlite/`: `schema.ts` (Drizzle sqlite-core), `sqlite-state-store.ts` (`SqliteStateStore`, returned by `createEngines().state`), `state-tables.ts` (StateFile ↔ rows), `migrations.ts` (folder lookup + `migrate` from `drizzle-orm/bun-sqlite/migrator`).
- Tables: `projects(name PK, root, env_file, created_at)`, `stacks(name PK, created_at)`, `port_pins(project → stacks.name ON DELETE CASCADE, service, port; PK(project, service), UNIQUE(port))`, `registry(id PK CHECK id = 1, etag, updated_at)`, `snapshots(id PK, project, service, name, path, size_bytes, created_at)` (empty until M3 snapshots), `ops(id PK, project, service, kind, status, started_at, finished_at, error_json)` with an `AFTER INSERT` trigger keeping the newest 200 rows per project, `meta(key PK, value)` (`schema_version` = newest migration tag). `stacks` exists because a stack can hold pins and `createdAt` without being a registered project.
- Migrations are generated with `bunx drizzle-kit generate` into `packages/engines/drizzle/` (committed; `0001_ops_retention.sql` is a custom migration for the trigger) and embedded with `--asset packages/engines/drizzle`; the store reads the embedded copy when present (Bun 1.4.2 places it at `/$bunfs/root/drizzle`, under the folder's basename; `/$bunfs/root/packages/engines/drizzle` is also accepted), else the source folder.
- Opening is lazy: folder 0700, file 0600, `busy_timeout=5000`, `journal_mode=WAL`, `foreign_keys=ON`, then migrations. Upgrading a database that already has migrations first writes `locastack.db.backup` (`VACUUM INTO`, 0600); a failed migration is rolled back and raises `IO` with the database path, the backup path and a fix hint. Concurrent first opens from several processes retry the WAL switch and the migration.
- The core ports did not change. `update(mutate)` runs read → `mutate` → validate → diff-write synchronously inside one `BEGIN IMMEDIATE` transaction, which replaces the `state.json` lock. A duplicate host port violates `UNIQUE(port)` and rejects with `OpError("PORT_CONFLICT")` (details `port`, `stack`, `service`, `reservedBy`).
- `state.json` is imported in one transaction when the database has no projects and no stacks (duplicate port pins in a hand-edited file are dropped and re-allocated later), then renamed to `state.json.migrated`. If the database already has data, the file is only renamed. An unreadable `state.json` fails loudly and stays in place.
- `FileStateStore` is removed. `file-lock.ts` stays for `FileSecretStore`.
