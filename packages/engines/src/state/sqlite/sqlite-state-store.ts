import { Database } from "bun:sqlite";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
} from "node:fs";
import { join } from "node:path";
import {
	type Clock,
	OpError,
	type StateFile,
	type StateReader,
	type StateWriter,
} from "@locastack/core";
import { eq } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { parseStateFile } from "../state-parser";
import { applyMigrations, resolveMigrationsFolder } from "./migrations";
import * as schema from "./schema";
import {
	isStateEmpty,
	readState,
	type StateTx,
	writeState,
} from "./state-tables";

/** File name of the state database inside `stateDir`. */
export const STATE_DB_FILE = "locastack.db";

/** Legacy M1/M2 state file imported once by {@link SqliteStateStore}. */
export const LEGACY_STATE_FILE = "state.json";

/** Suffix given to the legacy state file after it has been imported. */
export const LEGACY_STATE_MIGRATED_SUFFIX = ".migrated";

/** `meta` key holding the tag of the newest migration the database knows. */
export const SCHEMA_VERSION_KEY = "schema_version";

/** SQLite `busy_timeout` in milliseconds. */
const BUSY_TIMEOUT_MS = 5000;

/** Options for {@link SqliteStateStore}. */
export interface SqliteStateStoreOptions {
	/** State root (`Paths.stateDir`); holds `locastack.db` (and maybe `state.json`). */
	readonly stateDir: string;
	/** Migrations folder (default {@link resolveMigrationsFolder}). */
	readonly migrationsFolder?: string;
	/** Time source for project registration stamps (default system time). */
	readonly clock?: Clock;
}

/** Drizzle handle over `locastack.db` (all tables of `schema.ts`). */
export type StateDatabase = BunSQLiteDatabase<typeof schema>;

interface OpenDatabase {
	readonly client: Database;
	readonly db: StateDatabase;
}

/**
 * @param error - A thrown value (walks up to five `cause` links).
 * @returns The SQLite extended result code (e.g. `SQLITE_CONSTRAINT_PRIMARYKEY`), if any.
 */
export function sqliteCode(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && code.startsWith("SQLITE_")) return code;
		current = current.cause;
	}
	return undefined;
}

function isPortUniqueViolation(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		if (current.message.includes("port_pins.port")) return true;
		current = current.cause;
	}
	return false;
}

/**
 * Switches the file to WAL. On a fresh file this needs an exclusive lock and
 * SQLite reports `SQLITE_BUSY` without waiting when another process is
 * opening the same file, so it is retried until {@link BUSY_TIMEOUT_MS}.
 */
function enableWal(client: Database): void {
	const deadline = Date.now() + BUSY_TIMEOUT_MS;
	const mode = client.query<{ journal_mode: string }, []>(
		"PRAGMA journal_mode",
	);
	for (;;) {
		try {
			if (mode.get()?.journal_mode === "wal") return;
			if (Date.now() >= deadline) {
				throw new Error("SQLite refused to switch to WAL journal mode");
			}
			client.run("PRAGMA journal_mode = WAL");
		} catch (error) {
			const busy = sqliteCode(error)?.startsWith("SQLITE_BUSY") ?? false;
			if (!busy || Date.now() >= deadline) throw error;
			Bun.sleepSync(5 + Math.floor(Math.random() * 20));
		}
	}
}

/**
 * Builds the `PORT_CONFLICT` for a state whose pins reuse a host port.
 *
 * @param state - The state that failed `UNIQUE(port)`.
 * @returns The error; details name the port and both owners when found.
 */
export function portConflictError(state: StateFile): OpError {
	const owners = new Map<number, { stack: string; service: string }>();
	for (const [stack, entry] of Object.entries(state.stacks)) {
		for (const [service, port] of Object.entries(entry.ports)) {
			const owner = owners.get(port);
			if (owner !== undefined) {
				return new OpError(
					"PORT_CONFLICT",
					`Port ${port} for "${service}" is already pinned by stack "${owner.stack}", service "${owner.service}"`,
					{
						details: {
							stack,
							service,
							port,
							reservedBy: owner,
							fix: "Another LocaStack process pinned this port first; run the command again.",
						},
					},
				);
			}
			owners.set(port, { stack, service });
		}
	}
	return new OpError("PORT_CONFLICT", "A host port is pinned twice", {
		details: {
			fix: "Another LocaStack process pinned this port first; run the command again.",
		},
	});
}

/**
 * {@link StateReader} + {@link StateWriter} over `<stateDir>/locastack.db`
 * (SQLite in WAL mode via `bun:sqlite` + Drizzle; ADR 0008).
 *
 * - Opening is lazy (first `read`/`update`): creates the folder (0700) and
 *   the file (0600), sets `journal_mode=WAL`, `busy_timeout=5000`,
 *   `foreign_keys=ON`, applies pending migrations, then imports a legacy
 *   `state.json` once and renames it to `state.json.migrated`.
 * - `update` runs read → `mutate` → validate → write inside one synchronous
 *   `BEGIN IMMEDIATE` transaction, which serialises writers across
 *   connections and processes (other processes wait up to `busy_timeout`).
 *   Nothing is awaited inside the transaction, so updates in one process
 *   never interleave.
 * - Two services pinning one host port violate `UNIQUE(port)` and reject
 *   with an {@link OpError} `PORT_CONFLICT`; other database failures reject
 *   with `IO`; errors thrown by `mutate` are rethrown unchanged.
 */
export class SqliteStateStore implements StateReader, StateWriter {
	readonly #stateDir: string;
	readonly #migrationsFolder: string | undefined;
	readonly #clock: Clock | undefined;
	#open: OpenDatabase | undefined;

	/** @param options - State folder, migrations folder and clock. */
	constructor(options: SqliteStateStoreOptions) {
		this.#stateDir = options.stateDir;
		this.#migrationsFolder = options.migrationsFolder;
		this.#clock = options.clock;
	}

	/** Absolute path of the database file. */
	get path(): string {
		return join(this.#stateDir, STATE_DB_FILE);
	}

	/**
	 * @returns The persisted state (empty for a fresh database).
	 * @throws {OpError} `IO` when the database cannot be opened, migrated or read.
	 */
	async read(): Promise<StateFile> {
		const { db } = this.#database();
		try {
			return db.transaction((tx) => readState(tx), { behavior: "deferred" });
		} catch (cause) {
			throw this.#ioError("Could not read the state database", cause);
		}
	}

	/**
	 * Applies `mutate` inside a `BEGIN IMMEDIATE` transaction and persists the
	 * validated result.
	 *
	 * @param mutate - Function from current state (a private copy) to new state.
	 * @returns The state as written.
	 * @throws {OpError} `PORT_CONFLICT` when the result pins one port twice;
	 *   `IO` for an invalid result or a database failure; rethrows errors from `mutate`.
	 */
	async update(mutate: (state: StateFile) => StateFile): Promise<StateFile> {
		const { db } = this.#database();
		let next: StateFile | undefined;
		let userError: { readonly error: unknown } | undefined;
		try {
			return db.transaction(
				(tx) => {
					const current = readState(tx);
					try {
						next = parseStateFile(mutate(structuredClone(current)));
					} catch (error) {
						userError = { error };
						throw error;
					}
					writeState(tx, current, next, { now: this.#now() });
					return next;
				},
				{ behavior: "immediate" },
			);
		} catch (cause) {
			if (userError !== undefined) throw userError.error;
			if (next !== undefined && isPortUniqueViolation(cause)) {
				throw portConflictError(next);
			}
			throw this.#ioError("Could not update the state database", cause);
		}
	}

	/**
	 * Runs `work` synchronously against the open (and migrated) database.
	 * Lets sibling adapters such as `SqliteSnapshotIndex` share
	 * `locastack.db` and its single connection.
	 *
	 * @param message - Prefix of the `IO` error on failure, e.g. "Could not list snapshots".
	 * @param work - Synchronous queries (do not await inside).
	 * @returns What `work` returns.
	 * @throws {OpError} Rethrows an `OpError` thrown by `work` unchanged; other failures become `IO`.
	 */
	withDatabase<T>(message: string, work: (db: StateDatabase) => T): T {
		const { db } = this.#database();
		try {
			return work(db);
		} catch (cause) {
			throw this.#ioError(message, cause);
		}
	}

	/** Closes the connection. The next `read`/`update` reopens it. */
	close(): void {
		this.#open?.client.close();
		this.#open = undefined;
	}

	#now(): string {
		return (this.#clock?.now() ?? new Date()).toISOString();
	}

	#ioError(message: string, cause: unknown): OpError {
		if (cause instanceof OpError) return cause;
		const code = sqliteCode(cause);
		const busy = code?.startsWith("SQLITE_BUSY") ?? false;
		return new OpError(
			"IO",
			busy
				? `${message}: it stayed locked by another LocaStack process for ${BUSY_TIMEOUT_MS / 1000}s`
				: `${message} ${this.path}`,
			{
				cause,
				details: {
					path: this.path,
					...(code === undefined ? {} : { sqlite: code }),
					...(busy ? { fix: "Run the command again." } : {}),
				},
			},
		);
	}

	#database(): OpenDatabase {
		if (this.#open !== undefined) return this.#open;
		const path = this.path;
		let client: Database | undefined;
		try {
			mkdirSync(this.#stateDir, { recursive: true, mode: 0o700 });
			closeSync(openSync(path, "a", 0o600));
			chmodSync(path, 0o600);
			client = new Database(path, { create: true, readwrite: true });
			client.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			enableWal(client);
			client.run("PRAGMA foreign_keys = ON");
		} catch (cause) {
			client?.close();
			throw this.#ioError("Could not open the state database", cause);
		}
		const db = drizzle({ client, schema });
		try {
			const migrationsFolder =
				this.#migrationsFolder ?? resolveMigrationsFolder();
			applyMigrations({ client, db, dbPath: path, migrationsFolder });
			this.#recordSchemaVersion(db, migrationsFolder);
			this.#importLegacyState(db);
		} catch (cause) {
			client.close();
			throw this.#ioError("Could not open the state database", cause);
		}
		this.#open = { client, db };
		return this.#open;
	}

	#recordSchemaVersion(db: StateTx, migrationsFolder: string): void {
		const journal = JSON.parse(
			readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
		) as { entries?: { tag?: unknown }[] };
		const tag = journal.entries?.at(-1)?.tag;
		if (typeof tag !== "string") return;
		const row = db
			.select()
			.from(schema.meta)
			.where(eq(schema.meta.key, SCHEMA_VERSION_KEY))
			.get();
		// Tags start with a zero-padded index, so string order is migration
		// order. Never move the marker backwards.
		if (row !== undefined && row.value >= tag) return;
		db.insert(schema.meta)
			.values({ key: SCHEMA_VERSION_KEY, value: tag })
			.onConflictDoUpdate({ target: schema.meta.key, set: { value: tag } })
			.run();
	}

	/**
	 * Imports `<stateDir>/state.json` into an empty database (one
	 * transaction), then renames it to `state.json.migrated`. When the
	 * database already has data it is authoritative and the file is only
	 * renamed. A file that disappears before it is read was imported by another
	 * process and is skipped. Conflicting duplicate port pins in a hand-edited file are dropped
	 * (they are re-allocated on the next `up`).
	 */
	#importLegacyState(db: BunSQLiteDatabase<typeof schema>): void {
		const legacyPath = join(this.#stateDir, LEGACY_STATE_FILE);
		if (!existsSync(legacyPath)) return;
		let text: string;
		try {
			text = readFileSync(legacyPath, "utf8");
		} catch (error) {
			// Another process imported and renamed it between the check and the read.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		let legacy: StateFile;
		try {
			legacy =
				text.trim() === ""
					? { projects: [], stacks: {} }
					: parseStateFile(JSON.parse(text));
		} catch (cause) {
			throw new OpError(
				"IO",
				`Could not import ${legacyPath}: ${cause instanceof Error ? cause.message : "invalid file"}`,
				{
					cause,
					details: {
						path: legacyPath,
						fix: `Fix the file, or rename it to ${LEGACY_STATE_FILE}${LEGACY_STATE_MIGRATED_SUFFIX} to skip the import.`,
					},
				},
			);
		}
		db.transaction(
			(tx) => {
				if (!isStateEmpty(tx)) return;
				writeState(tx, readState(tx), legacy, {
					now: this.#now(),
					skipConflictingPins: true,
				});
			},
			{ behavior: "immediate" },
		);
		try {
			renameSync(legacyPath, `${legacyPath}${LEGACY_STATE_MIGRATED_SUFFIX}`);
		} catch (error) {
			// Another process renamed it first.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
