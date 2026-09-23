---
"@locainfra/core": minor
"@locainfra/engines": minor
"@locainfra/server": minor
"@locainfra/dashboard": minor
"@locainfra/cli": minor
---

M3 part 2: Data tab, snapshots, seed files, compose import and secret rotation.

- **Data tab** on Postgres and Redis services: lists tables or key patterns and runs a SQL query or Redis command inside the running container (`docker exec` with an argv array, never a shell). A run stops after 15 s, 2 MiB or 1000 rows, and the result can be exported as CSV. New routes: `GET …/services/:name/data` and `POST …/services/:name/data/query` (a timeout is `504 TIMEOUT`).
- **Snapshots tab** for services with a data volume: create, restore (with confirmation) and delete. The service is stopped, its volume is archived or restored by a `docker run --rm --network none` helper (`alpine:3.20`), and the service is started again. Archives are stored in `~/.locainfra/snapshots/<project>/<service>/` (0600) and indexed in the `snapshots` table of `locainfra.db`. A restore checks the archive first, so a damaged file never wipes the volume.
- **Seed files**: a Postgres entry can set `seed: db/seed.sql` (a path inside the project folder). The file is mounted read-only and runs when the volume is first created, and **Seed** on the Snapshots tab applies it again.
- **Import docker-compose.yml** on the Projects page: paste or drop a compose file, review how each service maps to the catalog (apps with `build:` and unknown images are skipped), with ports that are already taken on this machine remapped. The import then creates the project and can start it. New routes: `POST /api/import/preview` (writes nothing) and `POST /api/import`.
- **Secrets**: the add/config form has **Regenerate** for each secret. On the Connect tab, **Rotate** sets a new value and recreates the service. When the value is stored in the data volume (Postgres), rotating also requires wiping the volume, and the dialog suggests taking a snapshot first.
- Each background operation of a project (`202 { opId }`) is recorded in the `ops` table of `locainfra.db`, which keeps the newest 200 per project.
