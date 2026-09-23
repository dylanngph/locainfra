import { describe, expect, test } from "bun:test";
import { collect } from "../../testing/collect";
import { InMemoryOpJournal } from "../../testing/data-fakes";
import { FixedClock } from "../../testing/fakes";
import { OpError } from "../op-error";
import { journalProgress, journalResult } from "../op-journal";
import type { Progress } from "../progress.model";
import { err, ok } from "../result";
import { subStep } from "../sub-progress";

const clock = new FixedClock("2026-09-23T08:00:00.000Z");
const entry = {
	id: "op1",
	project: "shop",
	service: "main-db",
	kind: "snapshot.create",
};

async function* stream(
	events: Progress[],
	thrown?: Error,
): AsyncIterable<Progress> {
	for (const event of events) yield event;
	if (thrown !== undefined) throw thrown;
}

describe("journalProgress", () => {
	test("records start and success, forwarding events", async () => {
		const journal = new InMemoryOpJournal();
		const events = await collect(
			journalProgress(
				stream([
					{ kind: "step", message: "a" },
					{ kind: "done", message: "ok" },
					{ kind: "log", message: "after the end" },
				]),
				journal,
				entry,
				clock,
			),
		);
		expect(events.map((e) => e.message)).toEqual(["a", "ok"]);
		expect(journal.rows.get("op1")).toEqual({
			...entry,
			startedAt: "2026-09-23T08:00:00.000Z",
			status: "succeeded",
			finishedAt: "2026-09-23T08:00:00.000Z",
		});
	});

	test("records failures, throws and early stops", async () => {
		const journal = new InMemoryOpJournal();
		await collect(
			journalProgress(
				stream([
					{
						kind: "error",
						message: "boom",
						error: { code: "IO", message: "boom" },
					},
				]),
				journal,
				entry,
				clock,
			),
		);
		expect(journal.rows.get("op1")).toMatchObject({
			status: "failed",
			error: { code: "IO" },
		});

		await collect(
			journalProgress(
				stream([{ kind: "error", message: "bare" }]),
				journal,
				{ ...entry, id: "op2" },
				clock,
			),
		);
		expect(journal.rows.get("op2")?.error).toEqual({
			code: "UNKNOWN",
			message: "bare",
		});

		const thrown = collect(
			journalProgress(
				stream([], new OpError("IO", "disk")),
				journal,
				{ ...entry, id: "op3" },
				clock,
			),
		);
		await expect(thrown).rejects.toThrow("disk");
		expect(journal.rows.get("op3")).toMatchObject({
			status: "failed",
			error: { code: "IO", message: "disk" },
		});

		await expect(
			collect(
				journalProgress(
					stream([], new Error("x")),
					journal,
					{ ...entry, id: "op4" },
					clock,
				),
			),
		).rejects.toThrow("x");
		expect(journal.rows.get("op4")?.error?.code).toBe("UNKNOWN");

		for await (const _ of journalProgress(
			stream([
				{ kind: "step", message: "a" },
				{ kind: "step", message: "b" },
			]),
			journal,
			{ ...entry, id: "op5" },
			clock,
		)) {
			break;
		}
		expect(journal.rows.get("op5")?.status).toBe("cancelled");
	});

	test("a failing journal never fails the op", async () => {
		const journal = new InMemoryOpJournal();
		journal.failWith = new Error("SQLITE_BUSY");
		const events = await collect(
			journalProgress(
				stream([{ kind: "done", message: "ok" }]),
				journal,
				entry,
				clock,
			),
		);
		expect(events).toHaveLength(1);
		expect(journal.rows.size).toBe(0);
	});
});

describe("journalResult", () => {
	test("records the result of a Result op", async () => {
		const journal = new InMemoryOpJournal();
		expect(
			await journalResult(async () => ok(1), journal, entry, clock),
		).toEqual(ok(1));
		expect(journal.rows.get("op1")?.status).toBe("succeeded");
		const failure = new OpError("SNAPSHOT_NOT_FOUND", "gone");
		expect(
			await journalResult(
				async () => err(failure),
				journal,
				{ ...entry, id: "op2" },
				clock,
			),
		).toEqual(err(failure));
		expect(journal.rows.get("op2")).toMatchObject({
			status: "failed",
			error: { code: "SNAPSHOT_NOT_FOUND", message: "gone" },
		});
		await expect(
			journalResult(
				async () => Promise.reject(new Error("x")),
				journal,
				{ ...entry, id: "op3" },
				clock,
			),
		).rejects.toThrow("x");
		expect(journal.rows.get("op3")?.status).toBe("failed");
	});
});

describe("subStep", () => {
	test("forwards logs with the service, swallows done, returns error", async () => {
		const forwarded: Progress[] = [];
		const run = async (events: Progress[]) => {
			const gen = subStep(() => stream(events), "db", clock);
			for (;;) {
				const next = await gen.next();
				if (next.done) return next.value;
				forwarded.push(next.value);
			}
		};
		expect(
			await run([
				{ kind: "log", message: "l" },
				{ kind: "done", message: "d" },
			]),
		).toBeUndefined();
		expect(forwarded).toEqual([{ kind: "log", message: "l", service: "db" }]);
		expect(await run([{ kind: "error", message: "e" }])).toMatchObject({
			kind: "error",
			service: "db",
		});
		// A stream that ends without a terminal event is a success.
		expect(await run([])).toBeUndefined();
	});
});
