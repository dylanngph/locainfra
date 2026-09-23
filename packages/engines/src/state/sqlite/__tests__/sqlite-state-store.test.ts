import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
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
import {
	allocatePorts,
	isOpError,
	planStack,
	type StateFile,
} from "@locainfra/core";
import {
	builtinTestDefinitions,
	createProjectStack,
	FakePortProbe,
	FixedClock,
} from "@locainfra/core/testing";
import { OPS_RETENTION_PER_PROJECT } from "../schema";
import {
	SCHEMA_VERSION_KEY,
	SqliteStateStore,
	STATE_DB_FILE,
} from "../sqlite-state-store";

let dir: string;
let stateDir: string;
const opened: SqliteStateStore[] = [];

function store(): SqliteStateStore {
	const s = new SqliteStateStore({ stateDir, clock: new FixedClock() });
	opened.push(s);
	return s;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "li-sqlite-"));
	stateDir = join(dir, "home");
});
afterEach(() => {
	for (const s of opened.splice(0)) s.close();
	rmSync(dir, { recursive: true, force: true });
});

const addProject =
	(name: string) =>
	(state: StateFile): StateFile => ({
		...state,
		projects: [...state.projects, { name, root: `/p/${name}` }],
	});

const pin =
	(stack: string, ports: Record<string, number>) =>
	(state: StateFile): StateFile => ({
		...state,
		stacks: {
			...state.stacks,
			[stack]: {
				ports,
				createdAt: state.stacks[stack]?.createdAt ?? "2026-09-23T00:00:00Z",
			},
		},
	});

function tables(path: string): string[] {
	const db = new Database(path, { readonly: true });
	try {
		return db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all()
			.map((r) => r.name);
	} finally {
		db.close();
	}
}

describe("SqliteStateStore", () => {
	test("is lazy: constructing touches nothing", () => {
		store();
		expect(existsSync(stateDir)).toBe(false);
	});

	test("migrates a fresh folder: tables, meta version, 0600 file, 0700 dir", async () => {
		const s = store();
		expect(await s.read()).toEqual({ projects: [], stacks: {} });
		const path = join(stateDir, STATE_DB_FILE);
		expect(s.path).toBe(path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
		expect(tables(path)).toEqual([
			"__drizzle_migrations",
			"meta",
			"ops",
			"port_pins",
			"projects",
			"registry",
			"snapshots",
			"stacks",
		]);
		s.close();
		const db = new Database(path, { readonly: true });
		const version = db
			.query<{ value: string }, [string]>(
				"SELECT value FROM meta WHERE key = ?",
			)
			.get(SCHEMA_VERSION_KEY);
		const mode = db
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
			.get();
		db.close();
		expect(version?.value).toMatch(/^\d{4}_/);
		expect(mode?.journal_mode).toBe("wal");
	});

	test("reopening an up-to-date database applies nothing and keeps data", async () => {
		await store().update(addProject("a"));
		for (const s of opened.splice(0)) s.close();
		expect((await store().read()).projects.map((p) => p.name)).toEqual(["a"]);
		expect(existsSync(join(stateDir, `${STATE_DB_FILE}.backup`))).toBe(false);
	});

	test("read/update round trip keeps the StateFile shape and project order", async () => {
		const s = store();
		const written = await s.update((state) => ({
			projects: [
				{ name: "b", root: "/p/b", envFile: ".env.local" },
				{ name: "a", root: "/p/a" },
			],
			stacks: {
				b: { ports: { postgres: 5433, redis: 6380 }, createdAt: "t1" },
				solo: { ports: {}, createdAt: "t2" },
			},
			registry: { etag: 'W/"1"', updatedAt: "t3" },
			...{ ignored: state.projects.length },
		}));
		expect(written).toEqual({
			projects: [
				{ name: "b", root: "/p/b", envFile: ".env.local" },
				{ name: "a", root: "/p/a" },
			],
			stacks: {
				b: { ports: { postgres: 5433, redis: 6380 }, createdAt: "t1" },
				solo: { ports: {}, createdAt: "t2" },
			},
			registry: { etag: 'W/"1"', updatedAt: "t3" },
		});
		expect(await store().read()).toEqual(written);

		const next = await s.update((state) => {
			const { b: _removed, ...rest } = state.stacks;
			return {
				projects: [...state.projects].reverse(),
				stacks: { ...rest, c: { ports: { postgres: 5433 }, createdAt: "t4" } },
			};
		});
		expect(await store().read()).toEqual(next);
		expect(next.projects.map((p) => p.name)).toEqual(["a", "b"]);
		expect(next.registry).toBeUndefined();
	});

	test("a port can move between stacks in one mutation", async () => {
		const s = store();
		await s.update(pin("a", { pg: 5433 }));
		await s.update((state) =>
			pin("b", { pg: 5433 })(pin("a", { pg: 5434 })(state)),
		);
		const state = await s.read();
		expect(state.stacks.a?.ports.pg).toBe(5434);
		expect(state.stacks.b?.ports.pg).toBe(5433);
	});

	test("UNIQUE(port) violation rejects with PORT_CONFLICT and writes nothing", async () => {
		const s = store();
		await s.update(pin("a", { pg: 5433 }));
		const error = await s
			.update(pin("b", { pg: 5433 }))
			.catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("PORT_CONFLICT");
		expect(isOpError(error) && error.details).toMatchObject({
			port: 5433,
			stack: "b",
			service: "pg",
			reservedBy: { stack: "a", service: "pg" },
		});
		expect(Object.keys((await s.read()).stacks)).toEqual(["a"]);
		// Two services of one stack cannot share a port either.
		const same = await s
			.update(pin("a", { pg: 5433, other: 5433 }))
			.catch((e: unknown) => e);
		expect(isOpError(same) && same.code).toBe("PORT_CONFLICT");
	});

	test("an invalid resulting state is an IO error and rolls back", async () => {
		const s = store();
		await s.update(addProject("a"));
		const bad = await s
			.update(
				(st) => ({ ...st, projects: [{ name: 1 }] }) as unknown as StateFile,
			)
			.catch((e: unknown) => e);
		expect(isOpError(bad) && bad.code).toBe("IO");
		expect((await s.read()).projects).toHaveLength(1);
	});

	test("errors thrown by mutate are rethrown unchanged and roll back", async () => {
		const s = store();
		const boom = new Error("boom");
		await expect(
			s.update((st) => {
				addProject("x")(st);
				throw boom;
			}),
		).rejects.toBe(boom);
		await s.update(addProject("after"));
		expect((await s.read()).projects.map((p) => p.name)).toEqual(["after"]);
	});

	test("concurrent updates from two store instances on one file never lose a write", async () => {
		const [a, b] = [store(), store()];
		await Promise.all(
			Array.from({ length: 40 }, (_, i) =>
				(i % 2 === 0 ? a : b).update(addProject(`p${i}`)),
			),
		);
		const names = (await a.read()).projects.map((p) => p.name);
		expect(names).toHaveLength(40);
		expect(new Set(names).size).toBe(40);
	});

	test("concurrent updates from separate processes never lose writes", async () => {
		const storeModule = join(import.meta.dir, "..", "sqlite-state-store.ts");
		const script = `
			import { SqliteStateStore } from ${JSON.stringify(storeModule)};
			const store = new SqliteStateStore({ stateDir: process.argv[2] });
			const id = process.argv[3];
			for (let i = 0; i < 10; i++) {
				await store.update((s) => ({ ...s, projects: [...s.projects, { name: id + "-" + i, root: "/x" }] }));
			}
			store.close();
		`;
		const scriptPath = join(dir, "worker.ts");
		writeFileSync(scriptPath, script);
		const children = ["a", "b", "c"].map((id) =>
			Bun.spawn([process.execPath, scriptPath, stateDir, id], {
				stdout: "ignore",
				stderr: "inherit",
			}),
		);
		expect(await Promise.all(children.map((c) => c.exited))).toEqual([0, 0, 0]);
		const names = (await store().read()).projects.map((p) => p.name);
		expect(names).toHaveLength(30);
		expect(new Set(names).size).toBe(30);
	});

	test("stamps created_at on newly registered projects only", async () => {
		const s = store();
		await s.update(addProject("a"));
		await s.update(addProject("b"));
		s.close();
		const db = new Database(s.path, { readonly: true });
		const rows = db
			.query<{ name: string; created_at: string }, []>(
				"SELECT name, created_at FROM projects ORDER BY rowid",
			)
			.all();
		db.close();
		expect(rows).toEqual([
			{ name: "a", created_at: "2026-09-23T00:00:00.000Z" },
			{ name: "b", created_at: "2026-09-23T00:00:00.000Z" },
		]);
	});

	test("ops keep only the newest rows per project", async () => {
		const s = store();
		await s.read();
		s.close();
		const db = new Database(s.path);
		const insert = db.query(
			"INSERT INTO ops (id, project, kind, status, started_at) VALUES (?, ?, 'up', 'succeeded', ?)",
		);
		for (let i = 0; i < OPS_RETENTION_PER_PROJECT + 5; i++) {
			insert.run(
				`a${i}`,
				"a",
				new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			);
		}
		insert.run("b0", "b", "2026-01-01T00:00:00.000Z");
		const count = (project: string) =>
			db
				.query<{ n: number }, [string]>(
					"SELECT COUNT(*) AS n FROM ops WHERE project = ?",
				)
				.get(project)?.n;
		expect(count("a")).toBe(OPS_RETENTION_PER_PROJECT);
		expect(count("b")).toBe(1);
		const oldest = db
			.query<{ id: string }, []>(
				"SELECT id FROM ops WHERE project = 'a' ORDER BY started_at LIMIT 1",
			)
			.get();
		db.close();
		expect(oldest?.id).toBe("a5");
	});
});

describe("state.json import", () => {
	const legacy: StateFile = {
		projects: [{ name: "shop", root: "/p/shop", envFile: ".env" }],
		stacks: {
			shop: { ports: { postgres: 5433 }, createdAt: "2026-01-01T00:00:00Z" },
			old: { ports: { postgres: 5433, redis: 6380 }, createdAt: "t" },
		},
		registry: { updatedAt: "2026-02-02T00:00:00Z" },
	};

	test("imports into an empty database once and renames the file", async () => {
		mkdirSync(stateDir, { recursive: true });
		const file = join(stateDir, "state.json");
		writeFileSync(file, JSON.stringify(legacy));
		const state = await store().read();
		expect(state.projects).toEqual(legacy.projects);
		expect(state.registry).toEqual(legacy.registry);
		expect(state.stacks.shop).toEqual(legacy.stacks.shop);
		// The duplicate 5433 pin of "old" is dropped; its other pins survive.
		expect(state.stacks.old).toEqual({
			ports: { redis: 6380 },
			createdAt: "t",
		});
		expect(existsSync(file)).toBe(false);
		expect(JSON.parse(readFileSync(`${file}.migrated`, "utf8"))).toEqual(
			legacy,
		);
	});

	test("does not import over existing data but still retires the file", async () => {
		await store().update(addProject("kept"));
		for (const s of opened.splice(0)) s.close();
		const file = join(stateDir, "state.json");
		writeFileSync(file, JSON.stringify(legacy));
		const state = await store().read();
		expect(state.projects.map((p) => p.name)).toEqual(["kept"]);
		expect(existsSync(file)).toBe(false);
		expect(existsSync(`${file}.migrated`)).toBe(true);
	});

	test("a state.json another process renames between the check and the read is skipped", async () => {
		mkdirSync(stateDir, { recursive: true });
		const file = join(stateDir, "state.json");
		writeFileSync(file, JSON.stringify(legacy));
		const realRead = fs.readFileSync;
		const spy = spyOn(fs, "readFileSync").mockImplementation(((
			path: fs.PathOrFileDescriptor,
			options?: unknown,
		) => {
			if (path === file) {
				throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
			}
			return realRead(path, options as BufferEncoding);
		}) as typeof fs.readFileSync);
		try {
			const state = await store().read();
			expect(state.projects).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	test("an invalid state.json fails loudly and is left in place", async () => {
		mkdirSync(stateDir, { recursive: true });
		const file = join(stateDir, "state.json");
		writeFileSync(file, "{ nope");
		const error = await store()
			.read()
			.catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("IO");
		expect(String((error as Error).message)).toContain("state.json");
		expect(existsSync(file)).toBe(true);
	});
});

describe("allocatePorts over SqliteStateStore", () => {
	test("concurrent allocations from two store instances never pin one port twice", async () => {
		const stores = [store(), store()];
		const probe = new FakePortProbe();
		const clock = new FixedClock();
		const results = await Promise.all(
			["alpha", "beta"].map((name, index) => {
				const stack = createProjectStack(name, {
					postgres: { type: "postgres" },
				});
				const plan = planStack(stack, builtinTestDefinitions);
				if (!plan.ok) throw plan.error;
				const state = stores[index] ?? stores[0];
				if (!state) throw new Error("no store");
				return allocatePorts(
					{ probe, state, clock },
					{ stack, services: plan.value },
				);
			}),
		);
		const ports = results.map((r) => (r.ok ? r.value.postgres : undefined));
		expect(new Set(ports).size).toBe(2);
		const persisted = await stores[0]?.read();
		expect(persisted?.stacks.alpha?.ports.postgres).not.toBe(
			persisted?.stacks.beta?.ports.postgres,
		);
	});
});
