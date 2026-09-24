import type { OpFinish, OpJournal, OpStart } from "@locastack/core";
import { eq } from "drizzle-orm";
import { ops } from "./schema";
import type { SqliteStateStore } from "./sqlite-state-store";

/**
 * {@link OpJournal} on the `ops` table of `locastack.db`, sharing the
 * {@link SqliteStateStore}'s connection. The `ops_retention` trigger keeps the
 * newest 200 rows per project. `error_json` holds the secret-free
 * `ProgressError` of the op's terminal event. Starting an id twice replaces
 * the earlier row (ids are unique per server run, so this only happens in tests).
 */
export class SqliteOpJournal implements OpJournal {
	readonly #store: SqliteStateStore;

	/** @param store - The state store owning `locastack.db`. */
	constructor(store: SqliteStateStore) {
		this.#store = store;
	}

	/**
	 * @param start - Id, project, service, kind and start time.
	 * @throws {OpError} `IO` on a database failure.
	 */
	async start(start: OpStart): Promise<void> {
		this.#store.withDatabase("Could not record the operation", (db) => {
			const row = {
				id: start.id,
				project: start.project,
				service: start.service ?? null,
				kind: start.kind,
				status: "running",
				startedAt: start.startedAt,
				finishedAt: null,
				errorJson: null,
			};
			db.insert(ops)
				.values(row)
				.onConflictDoUpdate({ target: ops.id, set: row })
				.run();
		});
	}

	/**
	 * @param id - Operation id.
	 * @param finish - Status, end time and error.
	 * @throws {OpError} `IO` on a database failure.
	 */
	async finish(id: string, finish: OpFinish): Promise<void> {
		this.#store.withDatabase("Could not record the operation", (db) => {
			db.update(ops)
				.set({
					status: finish.status,
					finishedAt: finish.finishedAt,
					errorJson:
						finish.error === undefined ? null : JSON.stringify(finish.error),
				})
				.where(eq(ops.id, id))
				.run();
		});
	}
}
