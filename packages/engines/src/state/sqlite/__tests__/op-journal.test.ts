import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock } from "@locastack/core/testing";
import { SqliteOpJournal } from "../op-journal";
import { ops } from "../schema";
import { SqliteStateStore } from "../sqlite-state-store";

let dir: string;
let store: SqliteStateStore;
let journal: SqliteOpJournal;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ls-opjournal-"));
	store = new SqliteStateStore({
		stateDir: join(dir, "home"),
		clock: new FixedClock(),
	});
	journal = new SqliteOpJournal(store);
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function rows() {
	return store.withDatabase("read", (db) => db.select().from(ops).all());
}

describe("SqliteOpJournal", () => {
	test("start inserts a running row; finish records the outcome", async () => {
		await journal.start({
			id: "op1",
			project: "shop",
			service: "db",
			kind: "snapshot.create",
			startedAt: "2026-09-23T10:00:00.000Z",
		});
		expect(rows()).toEqual([
			{
				id: "op1",
				project: "shop",
				service: "db",
				kind: "snapshot.create",
				status: "running",
				startedAt: "2026-09-23T10:00:00.000Z",
				finishedAt: null,
				errorJson: null,
			},
		]);
		await journal.finish("op1", {
			status: "failed",
			finishedAt: "2026-09-23T10:00:05.000Z",
			error: { code: "IO", message: "disk full" },
		});
		const [row] = rows();
		expect(row?.status).toBe("failed");
		expect(row?.finishedAt).toBe("2026-09-23T10:00:05.000Z");
		expect(JSON.parse(row?.errorJson ?? "null")).toEqual({
			code: "IO",
			message: "disk full",
		});
	});

	test("a project-level op has no service; success stores no error", async () => {
		await journal.start({
			id: "op2",
			project: "shop",
			kind: "project.import",
			startedAt: "2026-09-23T10:00:00.000Z",
		});
		await journal.finish("op2", {
			status: "succeeded",
			finishedAt: "2026-09-23T10:00:01.000Z",
		});
		expect(rows()[0]).toMatchObject({
			service: null,
			status: "succeeded",
			errorJson: null,
		});
	});

	test("finishing an unknown id is a no-op; restarting an id replaces the row", async () => {
		await journal.finish("ghost", {
			status: "cancelled",
			finishedAt: "2026-09-23T10:00:00.000Z",
		});
		expect(rows()).toEqual([]);
		const start = {
			id: "op3",
			project: "shop",
			kind: "service.seed",
			startedAt: "2026-09-23T10:00:00.000Z",
		};
		await journal.start(start);
		await journal.finish("op3", {
			status: "succeeded",
			finishedAt: "2026-09-23T10:00:01.000Z",
		});
		await journal.start({ ...start, startedAt: "2026-09-23T11:00:00.000Z" });
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({ status: "running", finishedAt: null });
	});

	test("the retention trigger keeps the newest 200 rows per project", async () => {
		for (let i = 0; i < 205; i += 1) {
			await journal.start({
				id: `op-${i}`,
				project: "shop",
				kind: "project.up",
				startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			});
		}
		await journal.start({
			id: "other",
			project: "blog",
			kind: "project.up",
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		const all = rows();
		expect(all.filter((r) => r.project === "shop")).toHaveLength(200);
		expect(all.some((r) => r.id === "op-0")).toBe(false);
		expect(all.some((r) => r.id === "other")).toBe(true);
	});
});
