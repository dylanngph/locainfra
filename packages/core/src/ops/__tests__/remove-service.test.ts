import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import type { SnapshotRecord } from "../../ports/snapshot.port";
import { collect } from "../../testing/collect";
import { removeService } from "../remove-service.op";
import { createWorld, SHOP_COMPOSE, SHOP_FILE, SHOP_SECRETS } from "./world";

const target = { projectName: "li-shop", composeFile: SHOP_COMPOSE };

describe("removeService", () => {
	test("removes the container, the entry and the pin; keeps secrets and volumes", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const events = await collect(
			removeService(world, { project: "shop", name: "main-db" }),
		);
		expect(events.at(-1)).toMatchObject({ kind: "done", service: "main-db" });
		expect(
			events.filter((e) => e.kind === "done" || e.kind === "error"),
		).toHaveLength(1);
		expect(world.lifecycle.removeCalls).toEqual([
			{ ...target, services: ["main-db"] },
		]);
		const text = world.files.files.get(SHOP_FILE) ?? "";
		expect(text).not.toContain("main-db");
		expect(text).toContain("# shop services");
		expect(world.state.state.stacks.shop?.ports).toEqual({
			events: 5434,
			cache: 6380,
			rest: 8080,
		});
		expect(world.secrets.stacks.get("shop")).toEqual(SHOP_SECRETS);
		const compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(Object.keys(compose.services)).toEqual(["events", "cache", "rest"]);
	});

	test("volumes: true deletes its named volumes and forgets its secrets", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		await collect(
			removeService(world, { project: "shop", name: "main-db", volumes: true }),
		);
		expect(world.lifecycle.removeCalls[0]?.volumes).toEqual([
			"li-shop-main-db-data",
		]);
		expect(
			world.secrets.stacks.get("shop")?.MAIN_DB__POSTGRES_PASSWORD,
		).toBeUndefined();
		expect(world.secrets.stacks.get("shop")?.EVENTS__POSTGRES_PASSWORD).toBe(
			SHOP_SECRETS.EVENTS__POSTGRES_PASSWORD,
		);
	});

	test("volumes: true deletes the service's snapshots (archives, sidecars, rows); without it they stay", async () => {
		const dir = "/home/test/.locainfra/snapshots/shop/main-db";
		const rows: SnapshotRecord[] = ["s1", "s2", "e1"].map((id) => ({
			id,
			project: "shop",
			service: id === "e1" ? "events" : "main-db",
			name: id,
			path: `${dir}/${id}.tgz`,
			sizeBytes: 1,
			createdAt: "2026-09-01T00:00:00.000Z",
			type: "postgres",
			hasSecrets: true,
		}));
		const kept = createWorld({ provisioned: true, rendered: true });
		for (const row of rows) await kept.snapshots.insert(row);
		await collect(removeService(kept, { project: "shop", name: "main-db" }));
		expect(kept.snapshots.rows.size).toBe(3);

		const world = createWorld({ provisioned: true, rendered: true });
		for (const row of rows) await world.snapshots.insert(row);
		const events = await collect(
			removeService(world, { project: "shop", name: "main-db", volumes: true }),
		);
		expect(events.map((e) => e.message)).toContain(
			"Deleting 2 snapshots of main-db",
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect([...world.snapshots.rows.keys()]).toEqual(["e1"]);
		expect(world.archiver.removed.sort()).toEqual([
			`${dir}/s1.secrets.json`,
			`${dir}/s1.tgz`,
			`${dir}/s2.secrets.json`,
			`${dir}/s2.tgz`,
		]);
	});

	test("removing the last instance also deletes the project network", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		for (const name of ["rest", "events", "cache"])
			await collect(removeService(world, { project: "shop", name }));
		expect(world.lifecycle.removeCalls.map((c) => c.networks ?? [])).toEqual([
			[],
			[],
			[],
		]);
		const events = await collect(
			removeService(world, { project: "shop", name: "main-db", volumes: true }),
		);
		expect(events.at(-1)).toMatchObject({ kind: "done" });
		expect(world.lifecycle.removeCalls.at(-1)).toMatchObject({
			services: ["main-db"],
			volumes: ["li-shop-main-db-data"],
			networks: ["li-shop"],
		});
	});

	test("refuses while another service depends on it", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const events = await collect(
			removeService(world, { project: "shop", name: "cache" }),
		);
		expect(events.at(-1)?.error).toMatchObject({
			code: "INVALID_INPUT",
			details: { dependents: ["rest"] },
		});
		expect(world.lifecycle.removeCalls).toHaveLength(0);
		expect(world.files.files.get(SHOP_FILE)).toContain("cache:");
	});

	test("a never-rendered project skips compose and still edits the file", async () => {
		const world = createWorld();
		const events = await collect(
			removeService(world, { project: "shop", name: "events" }),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(world.lifecycle.removeCalls).toHaveLength(0);
		expect(world.files.files.get(SHOP_FILE)).not.toContain("events:");
	});

	test("a failing compose rm stops before the file is touched", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		world.lifecycle.removeScript = new Error("daemon down");
		const before = world.files.files.get(SHOP_FILE);
		const events = await collect(
			removeService(world, { project: "shop", name: "events" }),
		);
		expect(events.at(-1)).toMatchObject({ kind: "error", service: "events" });
		expect(world.files.files.get(SHOP_FILE)).toBe(before);
	});

	test("a re-render failure is logged, the removal still completes", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const write = world.files.writeText.bind(world.files);
		world.files.writeText = async (path, content, options) => {
			if (path === SHOP_COMPOSE) throw new Error("EROFS");
			return write(path, content, options);
		};
		const events = await collect(
			removeService(world, { project: "shop", name: "events" }),
		);
		expect(events.map((e) => e.kind).slice(-2)).toEqual(["log", "done"]);
		expect(events.at(-2)?.message).toContain("not re-rendered");
	});

	test("unknown project or service, catalog and state failures", async () => {
		const world = createWorld({ provisioned: true });
		expect(
			(await collect(removeService(world, { project: "nope", name: "x" }))).at(
				-1,
			)?.error?.code,
		).toBe("PROJECT_NOT_FOUND");
		expect(
			(await collect(removeService(world, { project: "shop", name: "x" }))).at(
				-1,
			)?.error?.code,
		).toBe("SERVICE_NOT_FOUND");

		const catalog = createWorld({ provisioned: true });
		catalog.catalog.definitions = async () => {
			throw new Error("bad");
		};
		expect(
			(
				await collect(
					removeService(catalog, { project: "shop", name: "events" }),
				)
			).at(-1)?.error?.code,
		).toBe("INVALID_CATALOG");

		const state = createWorld({ provisioned: true });
		state.state.update = async () => {
			throw new Error("EACCES");
		};
		expect(
			(
				await collect(removeService(state, { project: "shop", name: "events" }))
			).at(-1)?.error?.code,
		).toBe("IO");

		const file = createWorld({ provisioned: true });
		const write = file.files.writeText.bind(file.files);
		file.files.writeText = async (path, content, options) => {
			if (path === SHOP_FILE) throw new Error("EROFS");
			return write(path, content, options);
		};
		expect(
			(
				await collect(removeService(file, { project: "shop", name: "events" }))
			).at(-1)?.error?.code,
		).toBe("IO");
	});
});
