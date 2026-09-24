import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOpError } from "@locastack/core";
import {
	EMBEDDED_MIGRATIONS_DIRS,
	resolveMigrationsFolder,
	sourceMigrationsFolder,
} from "../migrations";
import { SqliteSnapshotIndex } from "../snapshot-index";
import { SqliteStateStore } from "../sqlite-state-store";

interface Journal {
	entries: { tag: string; when: number }[];
}

let dir: string;
const source = sourceMigrationsFolder();
const journal = JSON.parse(
	readFileSync(join(source, "meta", "_journal.json"), "utf8"),
) as Journal;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ls-migrate-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Copies the first `count` source migrations (plus optional extra SQL) into a folder. */
function migrationsFolder(
	name: string,
	count: number,
	extra?: { tag: string; sql: string },
): string {
	const out = join(dir, name);
	mkdirSync(join(out, "meta"), { recursive: true });
	const entries = journal.entries.slice(0, count);
	for (const entry of entries) {
		copyFileSync(
			join(source, `${entry.tag}.sql`),
			join(out, `${entry.tag}.sql`),
		);
	}
	const all = extra
		? [
				...entries,
				{ ...entries[0], idx: count, tag: extra.tag, when: Date.now() + 1000 },
			]
		: entries;
	if (extra) writeFileSync(join(out, `${extra.tag}.sql`), extra.sql);
	writeFileSync(
		join(out, "meta", "_journal.json"),
		JSON.stringify({ version: "7", dialect: "sqlite", entries: all }),
	);
	return out;
}

describe("resolveMigrationsFolder", () => {
	test("falls back to the committed source folder", () => {
		expect(resolveMigrationsFolder(["/nope/drizzle"])).toBe(source);
		expect(existsSync(join(source, "meta", "_journal.json"))).toBe(true);
		expect(source.endsWith(join("packages", "engines", "drizzle"))).toBe(true);
	});

	test("prefers an embedded folder that has a journal", () => {
		const embedded = migrationsFolder("embedded", 1);
		expect(resolveMigrationsFolder(["/nope", embedded])).toBe(embedded);
	});

	test("knows Bun 1.4.2's basename layout (/$bunfs/root/drizzle) as well as the full path", () => {
		expect(EMBEDDED_MIGRATIONS_DIRS).toContain("/$bunfs/root/drizzle");
		expect(EMBEDDED_MIGRATIONS_DIRS).toContain(
			"/$bunfs/root/packages/engines/drizzle",
		);
		expect(
			EMBEDDED_MIGRATIONS_DIRS.indexOf("/$bunfs/root/drizzle"),
		).toBeGreaterThan(
			EMBEDDED_MIGRATIONS_DIRS.indexOf("/$bunfs/root/packages/engines/drizzle"),
		);
	});
});

describe("applyMigrations via SqliteStateStore", () => {
	test("upgrading an existing database writes a 0600 backup first", async () => {
		const stateDir = join(dir, "home");
		const v1 = new SqliteStateStore({
			stateDir,
			migrationsFolder: migrationsFolder("v1", 1),
		});
		await v1.update((s) => ({ ...s, projects: [{ name: "a", root: "/a" }] }));
		v1.close();

		const v2 = new SqliteStateStore({ stateDir, migrationsFolder: source });
		expect((await v2.read()).projects).toEqual([{ name: "a", root: "/a" }]);
		v2.close();
		const backup = `${v2.path}.backup`;
		expect(statSync(backup).mode & 0o777).toBe(0o600);
		const db = new Database(backup, { readonly: true });
		const triggers = db
			.query<{ n: number }, []>(
				"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'",
			)
			.get();
		db.close();
		expect(triggers?.n).toBe(0);
	});

	test("0002 keeps snapshot rows written before it (no type, version or sidecar)", async () => {
		const stateDir = join(dir, "home");
		const v1 = new SqliteStateStore({
			stateDir,
			migrationsFolder: migrationsFolder("v1", 2),
		});
		await v1.read();
		const path = v1.path;
		v1.close();
		const raw = new Database(path);
		raw.run(
			"INSERT INTO snapshots (id, project, service, name, path, size_bytes, created_at) VALUES ('legacy1', 'shop', 'db', 'old', '/s/legacy1.tgz', 5, '2026-09-01T00:00:00.000Z')",
		);
		raw.close();

		const v2 = new SqliteStateStore({ stateDir, migrationsFolder: source });
		const index = new SqliteSnapshotIndex(v2);
		expect(await index.get("legacy1")).toEqual({
			id: "legacy1",
			project: "shop",
			service: "db",
			name: "old",
			path: "/s/legacy1.tgz",
			sizeBytes: 5,
			createdAt: "2026-09-01T00:00:00.000Z",
		});
		v2.close();
	});

	test("a failing migration rolls back and fails loudly with the backup path", async () => {
		const stateDir = join(dir, "home");
		const v1 = new SqliteStateStore({ stateDir, migrationsFolder: source });
		await v1.update((s) => ({ ...s, projects: [{ name: "a", root: "/a" }] }));
		v1.close();

		const broken = migrationsFolder("broken", journal.entries.length, {
			tag: "9999_broken",
			sql: "CREATE TABLE `extra` (`x` text);\n--> statement-breakpoint\nSELECT * FROM missing_table;",
		});
		const v2 = new SqliteStateStore({ stateDir, migrationsFolder: broken });
		const error = await v2.read().catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("IO");
		expect(String((error as Error).message)).toContain("Could not migrate");
		expect(isOpError(error) && error.details.backupPath).toBe(
			`${v2.path}.backup`,
		);
		expect(isOpError(error) && String(error.details.fix)).toContain(
			"unchanged",
		);

		const ok = new SqliteStateStore({ stateDir, migrationsFolder: source });
		expect((await ok.read()).projects).toEqual([{ name: "a", root: "/a" }]);
		ok.close();
		const db = new Database(ok.path, { readonly: true });
		const extra = db
			.query("SELECT name FROM sqlite_master WHERE name = 'extra'")
			.get();
		db.close();
		expect(extra).toBeNull();
	});

	test("an older binary refuses a database a newer one migrated and leaves it untouched", async () => {
		const stateDir = join(dir, "home");
		const newer = new SqliteStateStore({ stateDir, migrationsFolder: source });
		await newer.update((s) => ({
			...s,
			projects: [{ name: "a", root: "/a" }],
		}));
		newer.close();

		const older = new SqliteStateStore({
			stateDir,
			migrationsFolder: migrationsFolder("old", 1),
		});
		const error = await older.read().catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("IO");
		expect(String((error as Error).message)).toContain(
			"was created by a newer LocaStack; update LocaStack",
		);
		expect(isOpError(error) && error.details.path).toBe(older.path);
		expect(isOpError(error) && typeof error.details.fix).toBe("string");

		const db = new Database(older.path, { readonly: true });
		const version = db
			.query<{ value: string }, []>(
				"SELECT value FROM meta WHERE key = 'schema_version'",
			)
			.get();
		db.close();
		expect(version?.value).toBe(journal.entries.at(-1)?.tag);
		expect(existsSync(`${older.path}.backup`)).toBe(false);
	});

	test("the schema_version marker never moves backwards", async () => {
		const stateDir = join(dir, "home");
		const s = new SqliteStateStore({ stateDir, migrationsFolder: source });
		await s.read();
		s.close();
		const newest = journal.entries.at(-1)?.tag ?? "";
		const future = `9${newest.slice(1)}`;
		const rw = new Database(s.path);
		rw.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
			future,
		);
		rw.close();

		const again = new SqliteStateStore({ stateDir, migrationsFolder: source });
		await again.read();
		again.close();
		const ro = new Database(s.path, { readonly: true });
		const version = ro
			.query<{ value: string }, []>(
				"SELECT value FROM meta WHERE key = 'schema_version'",
			)
			.get();
		ro.close();
		expect(version?.value).toBe(future);
	});

	test("processes opening a fresh database at once all succeed", async () => {
		const stateDir = join(dir, "race");
		const storeModule = join(import.meta.dir, "..", "sqlite-state-store.ts");
		const scriptPath = join(dir, "open.ts");
		writeFileSync(
			scriptPath,
			`import { SqliteStateStore } from ${JSON.stringify(storeModule)};
			const s = new SqliteStateStore({ stateDir: process.argv[2] });
			await s.update((st) => ({ ...st, projects: [...st.projects, { name: process.argv[3], root: "/r" }] }));
			s.close();`,
		);
		const children = ["a", "b", "c", "d", "e", "f"].map((id) =>
			Bun.spawn([process.execPath, scriptPath, stateDir, id], {
				stdout: "ignore",
				stderr: "inherit",
			}),
		);
		expect(await Promise.all(children.map((c) => c.exited))).toEqual([
			0, 0, 0, 0, 0, 0,
		]);
		const s = new SqliteStateStore({ stateDir });
		expect((await s.read()).projects).toHaveLength(6);
		s.close();
	});
});
