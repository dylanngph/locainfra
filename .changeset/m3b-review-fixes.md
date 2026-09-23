---
"@locainfra/core": patch
"@locainfra/engines": patch
"@locainfra/server": patch
"@locainfra/dashboard": patch
---

M3b review fixes: snapshots, the Data tab, seed files, rotation and the stack `.env` are safer.

- A snapshot records its catalog type and version. Restoring a snapshot of another type or major version is refused before anything is stopped. The Postgres password baked into the volume is saved next to the archive (mode 0600). Restoring puts it back into the secret store and `.env`, so `DATABASE_URL` works after "snapshot, rotate with Wipe volume, restore". This needs state database migration 0002.
- Removing a service together with its volumes also deletes its snapshots.
- A restore extracts into a staging folder and swaps it in only when extraction succeeds, so a corrupt archive, or one deleted during the restore, leaves the data untouched. Deleting a snapshot waits for any running operation on the project.
- Postgres Data tab queries and seeds are also time-limited in the database (`statement_timeout`). A statement that times out no longer keeps running and holding its locks.
- A seed file that is a symlink out of the project, a device, a FIFO or a folder is refused before it is read or mounted.
- `wipeVolume` needs `force` for every secret.
- The stack `.env` and `docker-compose.yml` are written atomically, so they are never seen empty.
- The Snapshots tab is shown only for services with exactly one data volume.
- Restore and seed refresh the Data tab's table list, and so does every successful Run.
- An import opens the new project only once its `locainfra.yaml` has been written.
