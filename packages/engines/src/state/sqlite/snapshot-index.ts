import { OpError, type SnapshotIndex, SnapshotRecord } from "@locainfra/core";
import { Value } from "@sinclair/typebox/value";
import { and, desc, eq, sql } from "drizzle-orm";
import { snapshots } from "./schema";
import { type SqliteStateStore, sqliteCode } from "./sqlite-state-store";

type SnapshotRow = typeof snapshots.$inferSelect;

function toRecord(row: SnapshotRow): SnapshotRecord {
	return {
		id: row.id,
		project: row.project,
		service: row.service,
		name: row.name,
		path: row.path,
		sizeBytes: row.sizeBytes,
		createdAt: row.createdAt,
		...(row.type === null ? {} : { type: row.type }),
		...(row.version === null ? {} : { version: row.version }),
		...(row.hasSecrets ? { hasSecrets: true } : {}),
	};
}

function toRow(record: SnapshotRecord): typeof snapshots.$inferInsert {
	return {
		id: record.id,
		project: record.project,
		service: record.service,
		name: record.name,
		path: record.path,
		sizeBytes: record.sizeBytes,
		createdAt: record.createdAt,
		type: record.type ?? null,
		version: record.version ?? null,
		hasSecrets: record.hasSecrets === true,
	};
}

/**
 * {@link SnapshotIndex} on the `snapshots` table of `locainfra.db`, sharing
 * the {@link SqliteStateStore}'s connection (opened and migrated lazily).
 * Rows are validated against `SnapshotRecord` on insert; the archive files
 * themselves are the archiver's concern.
 */
export class SqliteSnapshotIndex implements SnapshotIndex {
	readonly #store: SqliteStateStore;

	/** @param store - The state store owning `locainfra.db`. */
	constructor(store: SqliteStateStore) {
		this.#store = store;
	}

	/**
	 * @param project - Project name.
	 * @param service - Service instance name.
	 * @returns Its snapshots, newest `createdAt` first (insertion order breaks ties).
	 * @throws {OpError} `IO` on a database failure.
	 */
	async list(project: string, service: string): Promise<SnapshotRecord[]> {
		return this.#store.withDatabase("Could not list snapshots", (db) =>
			db
				.select()
				.from(snapshots)
				.where(
					and(eq(snapshots.project, project), eq(snapshots.service, service)),
				)
				.orderBy(desc(snapshots.createdAt), desc(sql`rowid`))
				.all()
				.map(toRecord),
		);
	}

	/**
	 * @param id - Snapshot id.
	 * @returns The row, or `null`.
	 * @throws {OpError} `IO` on a database failure.
	 */
	async get(id: string): Promise<SnapshotRecord | null> {
		return this.#store.withDatabase("Could not read the snapshot", (db) => {
			const row = db.select().from(snapshots).where(eq(snapshots.id, id)).get();
			return row === undefined ? null : toRecord(row);
		});
	}

	/**
	 * @param record - Row to insert.
	 * @throws {OpError} `INVALID_INPUT` for an invalid record or a reused id; `IO` otherwise.
	 */
	async insert(record: SnapshotRecord): Promise<void> {
		if (!Value.Check(SnapshotRecord, record)) {
			const first = Value.Errors(SnapshotRecord, record).First();
			throw new OpError("INVALID_INPUT", "Invalid snapshot record", {
				details: {
					...(first === undefined
						? {}
						: { path: first.path, reason: first.message }),
				},
			});
		}
		this.#store.withDatabase("Could not save the snapshot", (db) => {
			try {
				db.insert(snapshots).values(toRow(record)).run();
			} catch (cause) {
				if (sqliteCode(cause)?.startsWith("SQLITE_CONSTRAINT") ?? false) {
					throw new OpError(
						"INVALID_INPUT",
						`Snapshot id ${record.id} already exists`,
						{ cause, details: { id: record.id } },
					);
				}
				throw cause;
			}
		});
	}

	/**
	 * @param id - Snapshot id.
	 * @returns Whether a row was deleted.
	 * @throws {OpError} `IO` on a database failure.
	 */
	async delete(id: string): Promise<boolean> {
		return this.#store.withDatabase(
			"Could not delete the snapshot",
			(db) =>
				db
					.delete(snapshots)
					.where(eq(snapshots.id, id))
					.returning({ id: snapshots.id })
					.all().length > 0,
		);
	}
}
