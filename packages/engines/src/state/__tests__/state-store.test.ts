import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
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
import { FileStateStore } from "../state-store";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "li-state-"));
	file = join(dir, "home", "state.json");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const addProject =
	(name: string) =>
	(state: StateFile): StateFile => ({
		...state,
		projects: [...state.projects, { name, root: `/p/${name}` }],
	});

describe("FileStateStore", () => {
	test("a missing file reads as empty state", async () => {
		expect(await new FileStateStore({ filePath: file }).read()).toEqual({
			projects: [],
			stacks: {},
		});
	});

	test("update persists JSON with mode 0600 and leaves no temp or lock files", async () => {
		const store = new FileStateStore({ filePath: file });
		const written = await store.update((s) => ({
			...s,
			stacks: {
				demo: { ports: { postgres: 5433 }, createdAt: "2026-09-23T00:00:00Z" },
			},
		}));
		expect(await store.read()).toEqual(written);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(dir, "home"))).toEqual(["state.json"]);
	});

	test("defaults missing collections when reading a partial file", async () => {
		await Bun.write(file, JSON.stringify({ registry: { updatedAt: "x" } }));
		expect(await new FileStateStore({ filePath: file }).read()).toEqual({
			projects: [],
			stacks: {},
			registry: { updatedAt: "x" },
		});
	});

	test("invalid JSON and invalid shapes are IO errors", async () => {
		await Bun.write(file, "{ nope");
		const store = new FileStateStore({ filePath: file });
		const e1 = await store.read().catch((e: unknown) => e);
		expect(isOpError(e1) && e1.code).toBe("IO");
		await Bun.write(
			file,
			JSON.stringify({ stacks: { a: { ports: { x: "1" }, createdAt: "t" } } }),
		);
		const e2 = await store.read().catch((e: unknown) => e);
		expect(isOpError(e2) && e2.message).toContain("stacks.a.ports.x");
	});

	test("rejects a mutation that produces an invalid state and keeps the old file", async () => {
		const store = new FileStateStore({ filePath: file });
		await store.update(addProject("a"));
		const bad = await store
			.update(
				(s) => ({ ...s, projects: [{ name: 1 }] }) as unknown as StateFile,
			)
			.catch((e: unknown) => e);
		expect(isOpError(bad)).toBe(true);
		expect((await store.read()).projects).toHaveLength(1);
		// Lock was released: another update succeeds.
		await store.update(addProject("b"));
		expect((await store.read()).projects).toHaveLength(2);
	});

	test("a throwing mutation releases the lock", async () => {
		const store = new FileStateStore({
			filePath: file,
			lock: { timeoutMs: 200 },
		});
		await expect(
			store.update(() => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await store.update(addProject("after"));
		expect((await store.read()).projects[0]?.name).toBe("after");
	});

	test("concurrent updates from independent store instances never lose writes", async () => {
		const stores = Array.from(
			{ length: 4 },
			() => new FileStateStore({ filePath: file }),
		);
		await Promise.all(
			Array.from({ length: 40 }, (_, i) =>
				stores[i % 4]?.update(addProject(`p${i}`)),
			),
		);
		const names = (await stores[0]?.read())?.projects.map((p) => p.name) ?? [];
		expect(names).toHaveLength(40);
		expect(new Set(names).size).toBe(40);
	});

	test("concurrent updates from separate processes never lose writes", async () => {
		const storeModule = join(import.meta.dir, "..", "state-store.ts");
		const script = `
			import { FileStateStore } from ${JSON.stringify(storeModule)};
			const store = new FileStateStore({ filePath: process.argv[2], lock: { retryDelayMs: 5 } });
			const id = process.argv[3];
			for (let i = 0; i < 10; i++) {
				await store.update((s) => ({ ...s, projects: [...s.projects, { name: id + "-" + i, root: "/x" }] }));
			}
		`;
		const scriptPath = join(dir, "worker.ts");
		writeFileSync(scriptPath, script);
		const children = ["a", "b", "c"].map((id) =>
			Bun.spawn([process.execPath, scriptPath, file, id], {
				stdout: "ignore",
				stderr: "inherit",
			}),
		);
		expect(await Promise.all(children.map((c) => c.exited))).toEqual([0, 0, 0]);
		const names = (
			await new FileStateStore({ filePath: file }).read()
		).projects.map((p) => p.name);
		expect(names).toHaveLength(30);
		expect(new Set(names).size).toBe(30);
	});

	test("readers never observe a partially written file", async () => {
		const store = new FileStateStore({ filePath: file });
		await store.update(addProject("seed"));
		const big = "x".repeat(64 * 1024);
		let writing = true;
		const writer = (async () => {
			try {
				for (let i = 0; i < 20; i++) {
					await store.update((s) => ({
						...s,
						projects: [{ name: `${big}${i}`, root: "/r" }],
					}));
				}
			} finally {
				writing = false;
			}
		})();
		const reader = new FileStateStore({ filePath: file });
		let reads = 0;
		try {
			while (writing) {
				const state = await reader.read();
				expect(state.projects).toHaveLength(1);
				reads++;
				await Bun.sleep(0);
			}
		} finally {
			writing = false;
			await writer;
		}
		expect(reads).toBeGreaterThan(0);
	});

	test("times out on a held lock", async () => {
		const store = new FileStateStore({
			filePath: file,
			lock: { timeoutMs: 100, retryDelayMs: 10 },
		});
		await store.update(addProject("a"));
		writeFileSync(`${file}.lock`, "99999\n");
		const error = await store.update(addProject("b")).catch((e: unknown) => e);
		expect(isOpError(error) && error.code).toBe("IO");
		expect(String((error as Error).message)).toContain("lock");
	});

	test("breaks a stale lock", async () => {
		const store = new FileStateStore({
			filePath: file,
			lock: { timeoutMs: 100, staleMs: 1000 },
		});
		await store.update(addProject("a"));
		writeFileSync(`${file}.lock`, "99999\n");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${file}.lock`, old, old);
		await store.update(addProject("b"));
		expect((await store.read()).projects).toHaveLength(2);
	});
});

describe("allocatePorts over FileStateStore (two processes' view)", () => {
	test("concurrent allocations from two store instances never pin one port twice", async () => {
		const stores = [
			new FileStateStore({ filePath: file, lock: { retryDelayMs: 1 } }),
			new FileStateStore({ filePath: file, lock: { retryDelayMs: 1 } }),
		];
		const probe = new FakePortProbe();
		const clock = new FixedClock();
		const results = await Promise.all(
			["alpha", "beta"].map((name, index) => {
				const stack = createProjectStack(name, { postgres: {} });
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
