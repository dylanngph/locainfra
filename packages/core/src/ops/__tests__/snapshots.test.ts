import { describe, expect, test } from "bun:test";
import type { SnapshotRecord } from "../../ports/snapshot.port";
import { collect } from "../../testing/collect";
import {
	FakeSnapshotIndex,
	FakeVolumeArchiver,
} from "../../testing/data-fakes";
import { SequentialSecretGenerator } from "../../testing/fakes";
import { createSnapshot } from "../create-snapshot.op";
import { deleteSnapshot } from "../delete-snapshot.op";
import { listSnapshots } from "../list-snapshots.op";
import { restoreSnapshot } from "../restore-snapshot.op";
import { createWorld, SHOP_COMPOSE, SHOP_SECRETS } from "./world";

const ARCHIVES = "/home/test/.locainfra/snapshots/shop/main-db";
const VOLUME = "li-shop-main-db-data";
const MAIN_DB = { project: "shop", name: "main-db" };

function row(fields: Partial<SnapshotRecord> & { id: string }): SnapshotRecord {
	return {
		project: "shop",
		service: "main-db",
		name: `name-${fields.id}`,
		path: `${ARCHIVES}/${fields.id}.tgz`,
		sizeBytes: 10,
		createdAt: "2026-09-01T00:00:00.000Z",
		...fields,
	};
}

function snapshotWorld(
	options: { running?: boolean; rows?: SnapshotRecord[] } = {},
) {
	const world = {
		...createWorld({ provisioned: true, rendered: true }),
		gen: new SequentialSecretGenerator("id"),
		archiver: new FakeVolumeArchiver(),
		snapshots: new FakeSnapshotIndex(options.rows ?? []),
	};
	for (const record of options.rows ?? [])
		world.archiver.archives.set(record.path, record.sizeBytes);
	if (options.running !== false) {
		world.lifecycle.psRows = [
			{
				service: "main-db",
				name: "li-shop-main-db",
				state: "running",
				image: "postgres",
				publishers: [],
			},
		];
	}
	return world;
}

describe("listSnapshots", () => {
	test("newest first, without paths", async () => {
		const world = snapshotWorld({
			rows: [
				row({ id: "a", createdAt: "2026-09-01T00:00:00.000Z" }),
				row({ id: "b", createdAt: "2026-09-02T00:00:00.000Z" }),
				row({ id: "c", service: "events" }),
			],
		});
		const result = await listSnapshots(world, MAIN_DB);
		expect(result).toEqual({
			ok: true,
			value: [
				{
					id: "b",
					service: "main-db",
					name: "name-b",
					sizeBytes: 10,
					createdAt: "2026-09-02T00:00:00.000Z",
				},
				{
					id: "a",
					service: "main-db",
					name: "name-a",
					sizeBytes: 10,
					createdAt: "2026-09-01T00:00:00.000Z",
				},
			],
		});
	});

	test("errors: unknown service or project, unreadable index", async () => {
		const world = snapshotWorld();
		const missing = await listSnapshots(world, {
			project: "shop",
			name: "nope",
		});
		expect(!missing.ok && missing.error.code).toBe("SERVICE_NOT_FOUND");
		const noProject = await listSnapshots(world, {
			project: "nope",
			name: "x",
		});
		expect(!noProject.ok && noProject.error.code).toBe("PROJECT_NOT_FOUND");
		world.snapshots.list = async () => {
			throw new Error("SQLITE_BUSY");
		};
		const io = await listSnapshots(world, MAIN_DB);
		expect(!io.ok && io.error.code).toBe("IO");
	});
});

describe("createSnapshot", () => {
	test("running service: stop, archive, index, start", async () => {
		const world = snapshotWorld({ rows: [row({ id: "old" })] });
		world.archiver.archiveScript = [
			{ kind: "log", message: "tar: ok" },
			{ kind: "done", message: "Archived" },
		];
		const events = await collect(
			createSnapshot(world, { ...MAIN_DB, snapshotName: "before-migration" }),
		);
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["step", "Stopping main-db"],
			["step", `Archiving ${VOLUME}`],
			["log", "tar: ok"],
			["step", "Starting main-db"],
			["done", "Snapshot “before-migration” created"],
		]);
		expect(events.every((e) => e.service === "main-db")).toBe(true);
		const id = "id-1-xxxxxxx";
		expect(world.gen.sizes).toEqual([9]);
		expect(world.snapshots.rows.get(id)).toEqual({
			id,
			project: "shop",
			service: "main-db",
			name: "before-migration",
			path: `${ARCHIVES}/${id}.tgz`,
			sizeBytes: 1024,
			createdAt: "2026-09-23T08:00:00.000Z",
			type: "postgres",
			version: "17",
			hasSecrets: true,
		});
		// The baked-in password goes to a 0600 sidecar, never to the index
		// or to an event.
		const sidecar = `${ARCHIVES}/${id}.secrets.json`;
		expect(JSON.parse(world.files.files.get(sidecar) ?? "null")).toEqual({
			POSTGRES_PASSWORD: SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD,
		});
		expect(world.files.modes.get(sidecar)).toBe(0o600);
		expect(JSON.stringify(events)).not.toContain(
			SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD,
		);
		expect(world.archiver.archiveCalls).toEqual([
			{ volume: VOLUME, path: `${ARCHIVES}/${id}.tgz` },
		]);
		const target = {
			projectName: "li-shop",
			composeFile: SHOP_COMPOSE,
			services: ["main-db"],
		};
		expect(world.lifecycle.stopCalls).toEqual([target]);
		expect(world.lifecycle.startCalls).toEqual([]);
		expect(world.lifecycle.upCalls).toEqual([
			{ ...target, wait: true, waitTimeoutSec: 120 },
		]);
	});

	test("stopped service: no stop/start; default name snap-<n>", async () => {
		const world = snapshotWorld({
			running: false,
			rows: [row({ id: "a" }), row({ id: "b" })],
		});
		const events = await collect(createSnapshot(world, MAIN_DB));
		expect(events.map((e) => e.message)).toEqual([
			`Archiving ${VOLUME}`,
			"Snapshot “snap-3” created",
		]);
		expect(world.lifecycle.stopCalls).toEqual([]);
		expect(world.lifecycle.startCalls).toEqual([]);
		expect(world.lifecycle.upCalls).toEqual([]);
	});

	test("a failed archive still restarts the service and records nothing", async () => {
		const world = snapshotWorld();
		world.archiver.archiveScript = [
			{ kind: "error", message: "no space left on device" },
		];
		const events = await collect(createSnapshot(world, MAIN_DB));
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["step", "Stopping main-db"],
			["step", `Archiving ${VOLUME}`],
			["step", "Starting main-db"],
			["error", "no space left on device"],
		]);
		expect(events.at(-1)?.service).toBe("main-db");
		expect(world.snapshots.rows.size).toBe(0);
		const archive = world.archiver.archiveCalls[0]?.path ?? "";
		expect(world.archiver.removed).toEqual([
			archive,
			archive.replace(/\.tgz$/, ".secrets.json"),
		]);
	});

	test("an index failure removes the archive; a failed start is reported", async () => {
		const world = snapshotWorld();
		world.snapshots.insert = async () => {
			throw new Error("SQLITE_FULL");
		};
		const events = await collect(createSnapshot(world, MAIN_DB));
		expect(events.at(-1)).toMatchObject({
			kind: "error",
			error: { code: "IO" },
		});
		expect(world.archiver.removed).toHaveLength(2);
		expect(world.archiver.archives.size).toBe(0);

		const restartFails = snapshotWorld();
		restartFails.lifecycle.upScript = [
			{ kind: "error", message: "port is already allocated" },
		];
		const failed = await collect(createSnapshot(restartFails, MAIN_DB));
		expect(failed.at(-1)).toMatchObject({
			kind: "error",
			message: "port is already allocated",
		});
		expect(restartFails.snapshots.rows.size).toBe(1);
	});

	test("a failed stop aborts before archiving", async () => {
		const world = snapshotWorld();
		world.lifecycle.stopScript = new Error("compose exploded");
		const events = await collect(createSnapshot(world, MAIN_DB));
		expect(events.map((e) => e.kind)).toEqual(["step", "error"]);
		expect(world.archiver.archiveCalls).toEqual([]);
	});

	test("refusals: bad name, ephemeral, no volume, never started, unknown ids", async () => {
		const world = snapshotWorld();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ snapshotName: "../evil" }, "INVALID_INPUT"],
			[{ name: "events" }, "INVALID_INPUT"],
			[{ name: "rest" }, "INVALID_INPUT"],
			[{ name: "nope" }, "SERVICE_NOT_FOUND"],
			[{ project: "nope" }, "PROJECT_NOT_FOUND"],
		];
		for (const [fields, code] of cases) {
			const events = await collect(
				createSnapshot(world, { ...MAIN_DB, ...fields }),
			);
			expect(events).toHaveLength(1);
			expect(events[0]?.error?.code).toBe(code);
		}
		const fresh = snapshotWorld();
		fresh.files.files.delete(SHOP_COMPOSE);
		const never = await collect(createSnapshot(fresh, MAIN_DB));
		expect(never[0]?.error?.message).toBe(
			"main-db has never been started, so it has no data yet",
		);

		const oldCompose = snapshotWorld();
		oldCompose.compose.current = "2.10.0";
		const tooOld = await collect(createSnapshot(oldCompose, MAIN_DB));
		expect(tooOld[0]?.error?.code).toBe("COMPOSE_TOO_OLD");
	});

	test("errors reading state: index, ids, ps", async () => {
		const listFails = snapshotWorld();
		listFails.snapshots.list = async () => {
			throw new Error("SQLITE_BUSY");
		};
		expect(
			(await collect(createSnapshot(listFails, MAIN_DB)))[0]?.error?.code,
		).toBe("IO");

		const badIds = snapshotWorld();
		badIds.gen.generate = () => "not/a/valid/id";
		expect(
			(await collect(createSnapshot(badIds, MAIN_DB)))[0]?.error?.code,
		).toBe("IO");

		const getFails = snapshotWorld();
		getFails.snapshots.get = async () => {
			throw new Error("SQLITE_BUSY");
		};
		expect(
			(await collect(createSnapshot(getFails, MAIN_DB)))[0]?.error?.code,
		).toBe("IO");

		const psFails = snapshotWorld();
		psFails.lifecycle.ps = async () => {
			throw new Error("Cannot connect to the Docker daemon");
		};
		expect(
			(await collect(createSnapshot(psFails, MAIN_DB)))[0]?.error?.code,
		).toBe("DOCKER_UNREACHABLE");
	});

	test("a definition with several volumes is refused", async () => {
		const world = snapshotWorld();
		const [postgres, ...rest] = world.catalog.items;
		if (postgres === undefined) throw new Error("fixture");
		world.catalog.items = [
			{
				...postgres,
				volumes: [...postgres.volumes, { name: "wal", path: "/wal" }],
			},
			...rest,
		];
		const events = await collect(createSnapshot(world, MAIN_DB));
		expect(events[0]?.error?.message).toBe(
			"PostgreSQL has 2 volumes; snapshots support one",
		);
	});
});

describe("restoreSnapshot", () => {
	const ref = { ...MAIN_DB, snapshotId: "snap1" };

	test("stop, restore, up --wait, done", async () => {
		const world = snapshotWorld({
			rows: [row({ id: "snap1", name: "clean-seed" })],
		});
		const events = await collect(restoreSnapshot(world, ref));
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["step", "Stopping main-db"],
			["step", "Restoring “clean-seed”"],
			["step", "Starting main-db"],
			["done", "Restored “clean-seed” into main-db"],
		]);
		expect(world.archiver.restoreCalls).toEqual([
			{ volume: VOLUME, path: `${ARCHIVES}/snap1.tgz` },
		]);
		expect(world.lifecycle.upCalls).toEqual([
			{
				projectName: "li-shop",
				composeFile: SHOP_COMPOSE,
				services: ["main-db"],
				wait: true,
				waitTimeoutSec: 120,
			},
		]);
	});

	test("puts back the password baked into the snapshot after a wipe-and-rotate (scenario A)", async () => {
		const OLD = SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD;
		const NEW = "rotated-password-0000009";
		const world = snapshotWorld({
			rows: [
				row({
					id: "snap1",
					name: "before-rotate",
					type: "postgres",
					version: "17",
					hasSecrets: true,
				}),
			],
		});
		world.files.files.set(
			`${ARCHIVES}/snap1.secrets.json`,
			JSON.stringify({ POSTGRES_PASSWORD: OLD }),
		);
		world.secrets.stacks.set("shop", {
			...SHOP_SECRETS,
			MAIN_DB__POSTGRES_PASSWORD: NEW,
		});
		const events = await collect(restoreSnapshot(world, ref));
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["step", "Stopping main-db"],
			["step", "Restoring “before-rotate”"],
			["step", "Restoring POSTGRES_PASSWORD saved with the snapshot"],
			["step", "Starting main-db"],
			["done", "Restored “before-rotate” into main-db"],
		]);
		expect(world.secrets.stacks.get("shop")?.MAIN_DB__POSTGRES_PASSWORD).toBe(
			OLD,
		);
		// The compose `.env` (and so DATABASE_URL) matches the restored data.
		const env = world.files.files.get("/home/test/.locainfra/stacks/shop/.env");
		expect(env).toContain(OLD);
		expect(env).not.toContain(NEW);
		const text = JSON.stringify(events);
		expect(text).not.toContain(OLD);
		expect(text).not.toContain(NEW);
		expect(world.lifecycle.upCalls.at(-1)?.services).toEqual(["main-db"]);
	});

	test("matching secrets: no secret step; a failed restore never touches them", async () => {
		const rows = [row({ id: "snap1", type: "postgres", hasSecrets: true })];
		const same = snapshotWorld({ rows });
		same.files.files.set(
			`${ARCHIVES}/snap1.secrets.json`,
			JSON.stringify({
				POSTGRES_PASSWORD: SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD,
			}),
		);
		const events = await collect(restoreSnapshot(same, ref));
		expect(events.map((e) => e.message)).not.toContain(
			"Restoring POSTGRES_PASSWORD saved with the snapshot",
		);
		expect(events.at(-1)?.kind).toBe("done");

		const failing = snapshotWorld({ rows });
		failing.files.files.set(
			`${ARCHIVES}/snap1.secrets.json`,
			JSON.stringify({ POSTGRES_PASSWORD: "old-password-00000001" }),
		);
		failing.archiver.restoreScript = new Error("tar: corrupt archive");
		const failed = await collect(restoreSnapshot(failing, ref));
		expect(failed.at(-1)?.kind).toBe("error");
		expect(failing.secrets.stacks.get("shop")?.MAIN_DB__POSTGRES_PASSWORD).toBe(
			SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD,
		);

		const noSidecar = snapshotWorld({ rows });
		const gone = await collect(restoreSnapshot(noSidecar, ref));
		expect(gone).toHaveLength(1);
		expect(gone[0]?.error).toMatchObject({
			code: "SNAPSHOT_NOT_FOUND",
			message: 'main-db has no snapshot "snap1" (its secrets file is gone)',
		});
		expect(noSidecar.lifecycle.stopCalls).toEqual([]);
	});

	test("refuses another catalog type or major version before stopping anything (scenario B)", async () => {
		const world = snapshotWorld({
			rows: [
				row({ id: "redis1", name: "cache-data", type: "redis", version: "7" }),
				row({ id: "pg16", name: "old-major", type: "postgres", version: "16" }),
				row({
					id: "pg17",
					name: "same-major",
					type: "postgres",
					version: "17.2",
				}),
			],
		});
		const typed = await collect(
			restoreSnapshot(world, { ...ref, snapshotId: "redis1" }),
		);
		expect(typed).toHaveLength(1);
		expect(typed[0]?.error).toMatchObject({
			code: "INVALID_INPUT",
			message:
				"Snapshot “cache-data” holds redis data, but main-db is now PostgreSQL",
			details: { reason: "type-mismatch" },
		});
		const versioned = await collect(
			restoreSnapshot(world, { ...ref, snapshotId: "pg16" }),
		);
		expect(versioned[0]?.error).toMatchObject({
			code: "INVALID_INPUT",
			message:
				"Snapshot “old-major” was taken on PostgreSQL 16, but main-db now runs 17",
			details: { reason: "version-mismatch" },
		});
		expect(world.lifecycle.stopCalls).toEqual([]);
		expect(world.archiver.restoreCalls).toEqual([]);
		const minor = await collect(
			restoreSnapshot(world, { ...ref, snapshotId: "pg17" }),
		);
		expect(minor.at(-1)?.kind).toBe("done");
	});

	test("a failed restore still starts the service, then reports the error", async () => {
		const world = snapshotWorld({ rows: [row({ id: "snap1" })] });
		world.archiver.restoreScript = new Error("tar: corrupt archive");
		const events = await collect(restoreSnapshot(world, ref));
		expect(events.map((e) => e.kind)).toEqual([
			"step",
			"step",
			"step",
			"error",
		]);
		expect(events.at(-1)?.message).toBe("tar: corrupt archive");
		expect(world.lifecycle.upCalls).toHaveLength(1);

		const stopFails = snapshotWorld({ rows: [row({ id: "snap1" })] });
		stopFails.lifecycle.stopScript = [
			{ kind: "error", message: "stop failed" },
		];
		const stopped = await collect(restoreSnapshot(stopFails, ref));
		expect(stopped.map((e) => e.kind)).toEqual(["step", "error"]);
		expect(stopFails.archiver.restoreCalls).toEqual([]);
	});

	test("SNAPSHOT_NOT_FOUND: unknown, other service, bad id, file gone", async () => {
		const world = snapshotWorld({
			rows: [
				row({ id: "snap1" }),
				row({ id: "other", service: "events" }),
				row({ id: "gone" }),
			],
		});
		world.archiver.archives.delete(`${ARCHIVES}/gone.tgz`);
		for (const snapshotId of ["nope", "other", "../../etc", "gone"]) {
			const events = await collect(
				restoreSnapshot(world, { ...ref, snapshotId }),
			);
			expect(events).toHaveLength(1);
			expect(events[0]?.error?.code).toBe("SNAPSHOT_NOT_FOUND");
		}
		const noService = await collect(
			restoreSnapshot(world, { ...ref, name: "nope" }),
		);
		expect(noService[0]?.error?.code).toBe("SERVICE_NOT_FOUND");
		world.snapshots.get = async () => {
			throw new Error("SQLITE_BUSY");
		};
		expect((await collect(restoreSnapshot(world, ref)))[0]?.error?.code).toBe(
			"IO",
		);
	});
});

describe("deleteSnapshot", () => {
	test("removes the file and the row, returns the snapshot", async () => {
		const world = snapshotWorld({
			rows: [row({ id: "snap1", name: "clean" })],
		});
		const result = await deleteSnapshot(world, {
			...MAIN_DB,
			snapshotId: "snap1",
		});
		expect(result).toEqual({
			ok: true,
			value: {
				id: "snap1",
				service: "main-db",
				name: "clean",
				sizeBytes: 10,
				createdAt: "2026-09-01T00:00:00.000Z",
			},
		});
		expect(world.archiver.removed).toEqual([
			`${ARCHIVES}/snap1.tgz`,
			`${ARCHIVES}/snap1.secrets.json`,
		]);
		expect(world.snapshots.rows.size).toBe(0);
	});

	test("works for a removed service; refuses other services and unknown ids", async () => {
		const world = snapshotWorld({
			rows: [row({ id: "old", service: "gone-db" })],
		});
		const orphan = await deleteSnapshot(world, {
			project: "shop",
			name: "gone-db",
			snapshotId: "old",
		});
		expect(orphan.ok).toBe(true);
		const other = await deleteSnapshot(world, {
			...MAIN_DB,
			snapshotId: "old",
		});
		expect(!other.ok && other.error.code).toBe("SNAPSHOT_NOT_FOUND");
		const noProject = await deleteSnapshot(world, {
			project: "nope",
			name: "x",
			snapshotId: "old",
		});
		expect(!noProject.ok && noProject.error.code).toBe("PROJECT_NOT_FOUND");

		const failing = snapshotWorld({ rows: [row({ id: "snap1" })] });
		failing.archiver.removeArchive = async () => {
			throw new Error("EACCES");
		};
		const io = await deleteSnapshot(failing, {
			...MAIN_DB,
			snapshotId: "snap1",
		});
		expect(!io.ok && io.error.code).toBe("IO");
		expect(failing.snapshots.rows.size).toBe(1);
	});
});
