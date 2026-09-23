import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOpError, type SnapshotRecord } from "@locainfra/core";
import { FixedClock } from "@locainfra/core/testing";
import { SqliteSnapshotIndex } from "../snapshot-index";
import { SqliteStateStore } from "../sqlite-state-store";

let dir: string;
let store: SqliteStateStore;
let index: SqliteSnapshotIndex;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "li-snapidx-"));
	store = new SqliteStateStore({
		stateDir: join(dir, "home"),
		clock: new FixedClock(),
	});
	index = new SqliteSnapshotIndex(store);
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
	return {
		id: "abc123",
		project: "shop",
		service: "db",
		name: "Before migration",
		path: "/home/u/.locainfra/snapshots/shop/db/abc123.tgz",
		sizeBytes: 2048,
		createdAt: "2026-09-23T10:00:00.000Z",
		...overrides,
	};
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("SqliteSnapshotIndex", () => {
	test("insert then get round-trips a row", async () => {
		await index.insert(record());
		expect(await index.get("abc123")).toEqual(record());
		expect(await index.get("nope")).toBeNull();
	});

	test("round-trips the provenance: type, version and the secrets-sidecar flag", async () => {
		const full = record({
			id: "prov1",
			type: "postgres",
			version: "17",
			hasSecrets: true,
		});
		await index.insert(full);
		expect(await index.get("prov1")).toEqual(full);
		expect((await index.list("shop", "db"))[0]).toEqual(full);
	});

	test("list filters by project and service, newest first, ties by insertion", async () => {
		await index.insert(
			record({ id: "old", createdAt: "2026-09-20T00:00:00.000Z" }),
		);
		await index.insert(
			record({ id: "new", createdAt: "2026-09-23T00:00:00.000Z" }),
		);
		await index.insert(
			record({ id: "tie1", createdAt: "2026-09-21T00:00:00.000Z" }),
		);
		await index.insert(
			record({ id: "tie2", createdAt: "2026-09-21T00:00:00.000Z" }),
		);
		await index.insert(record({ id: "other-svc", service: "cache" }));
		await index.insert(record({ id: "other-proj", project: "blog" }));
		const ids = (await index.list("shop", "db")).map((r) => r.id);
		expect(ids).toEqual(["new", "tie2", "tie1", "old"]);
		expect((await index.list("shop", "cache")).map((r) => r.id)).toEqual([
			"other-svc",
		]);
		expect(await index.list("none", "db")).toEqual([]);
	});

	test("delete reports whether a row went away", async () => {
		await index.insert(record());
		expect(await index.delete("abc123")).toBe(true);
		expect(await index.delete("abc123")).toBe(false);
		expect(await index.get("abc123")).toBeNull();
	});

	test("a reused id is INVALID_INPUT", async () => {
		await index.insert(record());
		const error = await rejection(index.insert(record({ name: "again" })));
		expect(isOpError(error) && error.code).toBe("INVALID_INPUT");
		expect(isOpError(error) && error.details.id).toBe("abc123");
	});

	test("an invalid record is INVALID_INPUT and nothing is written", async () => {
		for (const bad of [
			record({ id: "../x" }),
			record({ name: " leading space" }),
			record({ sizeBytes: -1 }),
		]) {
			const error = await rejection(index.insert(bad));
			expect(isOpError(error) && error.code).toBe("INVALID_INPUT");
		}
		expect(await index.list("shop", "db")).toEqual([]);
	});

	test("shares locainfra.db with the state store and survives reopening", async () => {
		await store.update((s) => ({
			...s,
			projects: [{ name: "shop", root: "/p/shop" }],
		}));
		await index.insert(record());
		store.close();
		const reopened = new SqliteStateStore({ stateDir: join(dir, "home") });
		try {
			const again = new SqliteSnapshotIndex(reopened);
			expect(await again.get("abc123")).toEqual(record());
			expect((await reopened.read()).projects).toHaveLength(1);
		} finally {
			reopened.close();
		}
	});
});
