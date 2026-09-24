import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpError } from "@locastack/core";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

/**
 * Where `bun build --compile --asset packages/engines/drizzle` may place the
 * migrations inside a compiled binary (POSIX and Windows virtual roots).
 * Bun 1.4.2 embeds an `--asset` folder under its basename
 * (`/$bunfs/root/drizzle`); the full relative path is tried first in case a
 * later Bun release preserves it.
 */
export const EMBEDDED_MIGRATIONS_DIRS = [
	"/$bunfs/root/packages/engines/drizzle",
	"/$bunfs/root/drizzle",
	"B:/~BUN/root/packages/engines/drizzle",
	"B:/~BUN/root/drizzle",
] as const;

/** Drizzle's bookkeeping table. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** Attempts before a migration that keeps racing another process fails. */
const MIGRATION_ATTEMPTS = 3;

/**
 * The `packages/engines/drizzle` folder next to this source file
 * (`src/state/sqlite` → `../../../drizzle`). Only meaningful from source.
 *
 * @returns Absolute path of the source migrations folder.
 */
export function sourceMigrationsFolder(): string {
	return fileURLToPath(new URL("../../../drizzle", import.meta.url));
}

/**
 * Chooses the migrations folder: the first embedded candidate that holds a
 * `meta/_journal.json`, else {@link sourceMigrationsFolder}.
 *
 * @param candidates - Embedded locations to try (default {@link EMBEDDED_MIGRATIONS_DIRS}).
 * @returns Absolute migrations folder.
 */
export function resolveMigrationsFolder(
	candidates: readonly string[] = EMBEDDED_MIGRATIONS_DIRS,
): string {
	const embedded = candidates.find((dir) =>
		existsSync(join(dir, "meta", "_journal.json")),
	);
	return embedded ?? sourceMigrationsFolder();
}

/** Result of {@link applyMigrations}. */
export interface AppliedMigrations {
	/** Migrations applied by this call. */
	readonly applied: number;
	/** Backup written before upgrading an existing database, if any. */
	readonly backupPath?: string;
}

/** Inputs of {@link applyMigrations}. */
export interface ApplyMigrationsInput {
	/** Raw connection (used for bookkeeping queries and the backup). */
	readonly client: Database;
	/** Drizzle handle over {@link ApplyMigrationsInput.client}. */
	readonly db: BunSQLiteDatabase<Record<string, unknown>>;
	/** Database file path (for the backup name and messages). */
	readonly dbPath: string;
	/** Migrations folder (see {@link resolveMigrationsFolder}). */
	readonly migrationsFolder: string;
}

function lastAppliedMillis(client: Database): number | undefined {
	const table = client
		.query<{ name: string }, [string]>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		)
		.get(MIGRATIONS_TABLE);
	if (table === null) return undefined;
	const row = client
		.query<{ created_at: number | string | null }, []>(
			`SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`,
		)
		.get();
	return row?.created_at == null ? undefined : Number(row.created_at);
}

/**
 * The `OpError` for a database whose newest applied migration is newer than
 * every migration this binary ships (an older LocaStack opening a file that a
 * newer one already upgraded).
 *
 * @param dbPath - Database file path.
 * @returns An `IO` error naming the file and the fix.
 */
function newerDatabaseError(dbPath: string): OpError {
	return new OpError(
		"IO",
		`${dbPath} was created by a newer LocaStack; update LocaStack`,
		{
			details: {
				path: dbPath,
				fix: `Install the newer LocaStack that last opened ${dbPath}, or move the file aside to start from an empty state.`,
			},
		},
	);
}

function backupBeforeUpgrade(client: Database, dbPath: string): string {
	const backupPath = `${dbPath}.backup`;
	rmSync(backupPath, { force: true });
	client.query("VACUUM INTO ?").run(backupPath);
	chmodSync(backupPath, 0o600);
	return backupPath;
}

/**
 * Applies pending Drizzle migrations with `drizzle-orm/bun-sqlite/migrator`.
 *
 * - Before upgrading a database that already has applied migrations, a copy
 *   is written to `<db>.backup` (0600) with `VACUUM INTO`.
 * - A database whose newest applied migration is newer than every migration
 *   in `migrationsFolder` was written by a newer LocaStack; it is refused
 *   untouched instead of being written with an older schema.
 * - Drizzle checks the applied version outside its transaction, so two
 *   processes opening a fresh database can race; the loser's transaction is
 *   rolled back and the migration is retried against the committed schema.
 *
 * @param input - Connection, path and migrations folder.
 * @returns How many migrations ran and the backup path, if one was written.
 * @throws {OpError} `IO` naming the database, the backup and a fix hint;
 *   `IO` "created by a newer LocaStack" for a database from a newer release.
 */
export function applyMigrations(
	input: ApplyMigrationsInput,
): AppliedMigrations {
	const { client, db, dbPath, migrationsFolder } = input;
	let backupPath: string | undefined;
	let lastError: unknown;
	for (let attempt = 1; attempt <= MIGRATION_ATTEMPTS; attempt++) {
		try {
			const migrations = readMigrationFiles({ migrationsFolder });
			const last = lastAppliedMillis(client);
			const newest = Math.max(...migrations.map((m) => m.folderMillis));
			if (last !== undefined && migrations.length > 0 && last > newest) {
				throw newerDatabaseError(dbPath);
			}
			const pending = migrations.filter(
				(m) => last === undefined || m.folderMillis > last,
			);
			if (pending.length === 0) return { applied: 0 };
			if (last !== undefined && backupPath === undefined) {
				backupPath = backupBeforeUpgrade(client, dbPath);
			}
			migrate(db, { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
			return backupPath === undefined
				? { applied: pending.length }
				: { applied: pending.length, backupPath };
		} catch (error) {
			if (error instanceof OpError) throw error;
			lastError = error;
			if (attempt < MIGRATION_ATTEMPTS) Bun.sleepSync(25 * attempt);
		}
	}
	const reason =
		lastError instanceof Error ? lastError.message.split("\n")[0] : "unknown";
	const copy =
		backupPath === undefined
			? ""
			: ` A copy taken before the upgrade is at ${backupPath}.`;
	const fix = `The migration was rolled back and ${dbPath} is unchanged.${copy} Update LocaStack, or move ${dbPath} aside to start from an empty state.`;
	throw new OpError(
		"IO",
		`Could not migrate the state database ${dbPath}: ${reason}`,
		{
			cause: lastError,
			details: {
				path: dbPath,
				migrationsFolder,
				...(backupPath === undefined ? {} : { backupPath }),
				fix,
			},
		},
	);
}
