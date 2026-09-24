import { describe, expect, it } from "bun:test";
import type { Progress } from "@locastack/core";
import { InMemoryOpJournal } from "@locastack/core/testing";
import { OpRegistry } from "../op-registry";

/** A controllable progress stream: push events, then end it. */
function manual() {
	const queue: Progress[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	return {
		push(event: Progress) {
			queue.push(event);
			wake?.();
		},
		end() {
			ended = true;
			wake?.();
		},
		async *run(): AsyncIterable<Progress> {
			while (true) {
				const next = queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (ended) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("OpRegistry", () => {
	it("replays the backlog to a late subscriber, then streams live events", async () => {
		const registry = new OpRegistry({ newId: () => "op1" });
		const op = manual();
		const id = registry.start({
			kind: "project.up",
			project: "shop",
			run: () => op.run(),
		});
		expect(id).toBe("op1");
		op.push({ kind: "step", message: "Pulling" });
		op.push({ kind: "log", message: "layer 1/3" });
		await tick();

		const seen: Progress[] = [];
		registry.subscribe(id, (e) => seen.push(e));
		expect(seen.map((e) => e.message)).toEqual(["Pulling", "layer 1/3"]);

		op.push({ kind: "done", message: "Started" });
		await registry.settled(id);
		expect(seen.map((e) => e.kind)).toEqual(["step", "log", "done"]);
		expect(
			seen.every((e) => e.opId === "op1" && typeof e.at === "string"),
		).toBe(true);

		const after: Progress[] = [];
		registry.subscribe(id, (e) => after.push(e));
		expect(after).toEqual(seen);
		expect(registry.get(id)?.state).toBe("done");
	});

	it("appends done when an op ends without a terminal event, and ignores events after it", async () => {
		const registry = new OpRegistry();
		const id = registry.start({
			kind: "x",
			run: async function* () {
				yield { kind: "step", message: "one" };
			},
		});
		await registry.settled(id);
		const seen: Progress[] = [];
		registry.subscribe(id, (e) => seen.push(e));
		expect(seen.map((e) => e.kind)).toEqual(["step", "done"]);

		const twice = registry.start({
			kind: "y",
			run: async function* () {
				yield {
					kind: "error",
					message: "bad",
					error: { code: "IO", message: "bad" },
				};
				yield { kind: "done", message: "late" };
			},
		});
		await registry.settled(twice);
		const events: Progress[] = [];
		registry.subscribe(twice, (e) => events.push(e));
		expect(events.map((e) => e.kind)).toEqual(["error"]);
	});

	it("turns a thrown non-OpError into a generic UNKNOWN error event", async () => {
		const registry = new OpRegistry();
		const id = registry.start({
			kind: "x",
			run: () => {
				throw new Error("password=hunter2");
			},
		});
		await registry.settled(id);
		const events: Progress[] = [];
		registry.subscribe(id, (e) => events.push(e));
		expect(events).toHaveLength(1);
		expect(events[0]?.error?.code).toBe("UNKNOWN");
		expect(JSON.stringify(events)).not.toContain("hunter2");
	});

	it("keeps at most `capacity` ops, evicting the oldest finished ones", async () => {
		let n = 0;
		const registry = new OpRegistry({ capacity: 3, newId: () => `op${++n}` });
		const running = manual();
		registry.start({ kind: "long", run: () => running.run() });
		for (let i = 0; i < 4; i++) {
			const id = registry.start({ kind: "quick", run: async function* () {} });
			await registry.settled(id);
		}
		const ids = registry.list().map((o) => o.id);
		expect(ids).toEqual(["op1", "op4", "op5"]);
		expect(registry.subscribe("op2", () => {})).toBeUndefined();
		running.end();
	});

	it("expires finished ops after the retention window", async () => {
		let now = 1_000;
		const registry = new OpRegistry({ retentionMs: 60_000, now: () => now });
		const id = registry.start({ kind: "x", run: async function* () {} });
		await registry.settled(id);
		now += 59_000;
		expect(registry.get(id)).toBeDefined();
		now += 2_000;
		expect(registry.get(id)).toBeUndefined();
	});

	it("notifies settled listeners with the op's project", async () => {
		const registry = new OpRegistry();
		const settled: string[] = [];
		registry.onSettled((op) => settled.push(`${op.project}:${op.state}`));
		const id = registry.start({
			kind: "x",
			project: "shop",
			run: async function* () {},
		});
		await registry.settled(id);
		expect(settled).toEqual(["shop:done"]);
	});

	it("a throwing subscriber does not break the op", async () => {
		const registry = new OpRegistry();
		const op = manual();
		const id = registry.start({ kind: "x", run: () => op.run() });
		registry.subscribe(id, () => {
			throw new Error("boom");
		});
		const ok: Progress[] = [];
		registry.subscribe(id, (e) => ok.push(e));
		op.push({ kind: "done", message: "fine" });
		await registry.settled(id);
		expect(ok.map((e) => e.kind)).toEqual(["done"]);
	});

	it("runs ops on the same project one at a time, in start order", async () => {
		let n = 0;
		const registry = new OpRegistry({ newId: () => `op${++n}` });
		const first = manual();
		const second = manual();
		const started: string[] = [];
		registry.start({
			kind: "service.remove",
			project: "shop",
			service: "a",
			run: () => {
				started.push("a");
				return first.run();
			},
		});
		const secondId = registry.start({
			kind: "service.remove",
			project: "shop",
			service: "b",
			run: () => {
				started.push("b");
				return second.run();
			},
		});
		await tick();
		expect(started).toEqual(["a"]);
		const seen: Progress[] = [];
		registry.subscribe(secondId, (e) => seen.push(e));
		expect(seen.map((e) => e.message)).toEqual([
			"Waiting for the previous operation on shop to finish",
		]);

		first.push({ kind: "done", message: "Removed a" });
		first.end();
		await tick();
		await tick();
		expect(started).toEqual(["a", "b"]);
		second.push({ kind: "done", message: "Removed b" });
		second.end();
		expect((await registry.settled(secondId))?.state).toBe("done");
	});

	it("keeps the queue moving after a failed or throwing op", async () => {
		let n = 0;
		const registry = new OpRegistry({ newId: () => `op${++n}` });
		registry.start({
			kind: "project.up",
			project: "shop",
			run: () => {
				throw new Error("boom");
			},
		});
		const next = registry.start({
			kind: "project.down",
			project: "shop",
			run: async function* () {},
		});
		expect((await registry.settled(next))?.state).toBe("done");
	});

	it("exclusive work waits for the project's running op and holds later ones", async () => {
		let n = 0;
		const registry = new OpRegistry({ newId: () => `op${++n}` });
		const restore = manual();
		const order: string[] = [];
		registry.start({
			kind: "snapshot.restore",
			project: "shop",
			run: () => {
				order.push("restore:start");
				return restore.run();
			},
		});
		const deleted = registry.exclusive("shop", async () => {
			order.push("delete");
			return "deleted";
		});
		const later = registry.start({
			kind: "snapshot.create",
			project: "shop",
			run: async function* () {
				order.push("create");
				yield { kind: "done", message: "Created" };
			},
		});
		await tick();
		expect(order).toEqual(["restore:start"]);
		restore.push({ kind: "done", message: "Restored" });
		restore.end();
		expect(await deleted).toBe("deleted");
		await registry.settled(later);
		expect(order).toEqual(["restore:start", "delete", "create"]);

		const failing = registry.exclusive("shop", async () => {
			throw new Error("io");
		});
		await expect(failing).rejects.toThrow("io");
		expect(await registry.exclusive("shop", async () => 1)).toBe(1);
	});

	it("does not serialize ops of different projects", async () => {
		let n = 0;
		const registry = new OpRegistry({ newId: () => `op${++n}` });
		const blocked = manual();
		const started: string[] = [];
		registry.start({
			kind: "project.up",
			project: "shop",
			run: () => {
				started.push("shop");
				return blocked.run();
			},
		});
		registry.start({
			kind: "project.up",
			project: "blog",
			run: () => {
				started.push("blog");
				return manual().run();
			},
		});
		await tick();
		expect(started).toEqual(["shop", "blog"]);
		blocked.end();
	});

	it("journals project ops: running on start, then the terminal outcome", async () => {
		const journal = new InMemoryOpJournal();
		let n = 0;
		const registry = new OpRegistry({
			journal,
			newId: () => `op${++n}`,
			now: () => Date.parse("2026-09-23T10:00:00.000Z"),
		});
		const ok = registry.start({
			kind: "snapshot.create",
			project: "shop",
			service: "db",
			run: async function* () {
				yield { kind: "done", message: "Snapshot created" };
			},
		});
		const failed = registry.start({
			kind: "service.seed",
			project: "shop",
			service: "db",
			run: async function* () {
				yield {
					kind: "error",
					message: "psql failed",
					error: { code: "SEED_FAILED", message: "psql failed" },
				};
			},
		});
		const thrown = registry.start({
			kind: "project.import",
			project: "blog",
			run: () => ({
				[Symbol.asyncIterator]: () => ({
					next: () => Promise.reject(new Error("boom")),
				}),
			}),
		});
		const unscoped = registry.start({
			kind: "catalog.refresh",
			run: async function* () {
				yield { kind: "done", message: "ok" };
			},
		});
		for (const id of [ok, failed, thrown, unscoped]) await registry.settled(id);
		await tick();
		expect(journal.rows.get(ok)).toEqual({
			id: ok,
			project: "shop",
			service: "db",
			kind: "snapshot.create",
			startedAt: "2026-09-23T10:00:00.000Z",
			status: "succeeded",
			finishedAt: "2026-09-23T10:00:00.000Z",
		});
		expect(journal.rows.get(failed)).toMatchObject({
			status: "failed",
			error: { code: "SEED_FAILED", message: "psql failed" },
		});
		expect(journal.rows.get(thrown)).toMatchObject({
			project: "blog",
			status: "failed",
			error: { code: "UNKNOWN" },
		});
		expect(journal.rows.has(unscoped)).toBe(false);
	});

	it("a failing journal never affects the op", async () => {
		const journal = new InMemoryOpJournal();
		journal.failWith = new Error("database is locked");
		const registry = new OpRegistry({ journal });
		const seen: Progress[] = [];
		const id = registry.start({
			kind: "project.up",
			project: "shop",
			run: async function* () {
				yield { kind: "step", message: "Starting" };
				yield { kind: "done", message: "Started" };
			},
		});
		registry.subscribe(id, (e) => seen.push(e));
		expect((await registry.settled(id))?.state).toBe("done");
		await tick();
		expect(seen.at(-1)?.kind).toBe("done");
		expect(journal.rows.size).toBe(0);
	});
});
