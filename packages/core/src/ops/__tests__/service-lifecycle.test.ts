import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { collect } from "../../testing/collect";
import { restartService } from "../restart-service.op";
import { startService } from "../start-service.op";
import { stopService } from "../stop-service.op";
import { applyServicePatch, updateService } from "../update-service.op";
import { createWorld, SHOP_COMPOSE, SHOP_FILE } from "./world";

const target = { projectName: "ls-shop", composeFile: SHOP_COMPOSE };

describe("updateService", () => {
	test("the Use port N fix rewrites the port, re-renders and recreates the service", async () => {
		const world = createWorld({ provisioned: true });
		const events = await collect(
			updateService(world, {
				project: "shop",
				name: "main-db",
				patch: { port: 5450 },
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["step", "step", "step", "done"]);
		expect(events.every((e) => e.service === "main-db")).toBe(true);
		const text = world.files.files.get(SHOP_FILE) ?? "";
		expect(text).toContain(
			"  main-db: { type: postgres, port: 5450, config: { POSTGRES_DB: shop } } # primary\n",
		);
		expect(world.state.state.stacks.shop?.ports["main-db"]).toBe(5450);
		const compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services["main-db"].ports).toEqual(["127.0.0.1:5450:5432"]);
		expect(world.lifecycle.upCalls[0]).toMatchObject({
			...target,
			services: ["main-db"],
			wait: true,
		});
	});

	test("version, persist and config patches; empty config removes the map", async () => {
		const world = createWorld({ provisioned: true });
		await collect(
			updateService(world, {
				project: "shop",
				name: "main-db",
				patch: { version: "16", persist: "ephemeral", config: {} },
			}),
		);
		expect(world.files.files.get(SHOP_FILE)).toContain(
			'  main-db: { type: postgres, version: "16", persist: ephemeral } # primary\n',
		);
		expect(world.lifecycle.removeCalls).toHaveLength(0);
	});

	test("invalid patches and unknown services fail before writing", async () => {
		for (const [name, patch, code] of [
			["main-db", { version: "9" }, "INVALID_INPUT"],
			["main-db", { config: { NOPE: "x" } }, "INVALID_INPUT"],
			["nope", { port: 5450 }, "SERVICE_NOT_FOUND"],
		] as const) {
			const world = createWorld({ provisioned: true });
			const before = world.files.files.get(SHOP_FILE);
			const events = await collect(
				updateService(world, { project: "shop", name, patch }),
			);
			expect(events.at(-1)?.error?.code).toBe(code);
			expect(world.files.files.get(SHOP_FILE)).toBe(before);
		}
	});

	test("a busy port is PORT_CONFLICT with a suggestion; compose too old stops early", async () => {
		const world = createWorld({ provisioned: true, busy: [5450] });
		const events = await collect(
			updateService(world, {
				project: "shop",
				name: "main-db",
				patch: { port: 5450 },
			}),
		);
		expect(events.at(-1)?.error).toMatchObject({
			code: "PORT_CONFLICT",
			details: { suggestedPort: 5435 },
		});

		const old = createWorld({ provisioned: true });
		old.compose.current = "2.10.0";
		const tooOld = await collect(
			updateService(old, {
				project: "shop",
				name: "cache",
				patch: { port: 6390 },
			}),
		);
		expect(tooOld.at(-1)?.error?.code).toBe("COMPOSE_TOO_OLD");
	});

	test("applyServicePatch keeps untouched fields", () => {
		expect(
			applyServicePatch(
				{ type: "redis", uses: { x: "y" }, config: { A: "1" } },
				{ port: "auto" },
			),
		).toEqual({
			type: "redis",
			uses: { x: "y" },
			config: { A: "1" },
			port: "auto",
		});
	});
});

describe("startService", () => {
	test("provisions, renders and ups one service", async () => {
		const world = createWorld();
		const events = await collect(
			startService(world, { project: "shop", name: "cache" }),
		);
		expect(events.map((e) => e.kind)).toEqual(["step", "done"]);
		expect(events.every((e) => e.service === "cache")).toBe(true);
		expect(world.lifecycle.upCalls[0]).toMatchObject({
			...target,
			services: ["cache"],
		});
		expect(world.files.files.has(SHOP_COMPOSE)).toBe(true);
	});

	test("errors: unknown project, unknown service, compose, catalog, port conflict", async () => {
		const unknown = await collect(
			startService(createWorld(), { project: "nope", name: "x" }),
		);
		expect(unknown.at(-1)?.error?.code).toBe("PROJECT_NOT_FOUND");
		const missing = await collect(
			startService(createWorld(), { project: "shop", name: "nope" }),
		);
		expect(missing.at(-1)?.error?.code).toBe("SERVICE_NOT_FOUND");
		const noCompose = createWorld();
		noCompose.compose.current = null;
		expect(
			(
				await collect(
					startService(noCompose, { project: "shop", name: "cache" }),
				)
			).at(-1)?.error?.code,
		).toBe("COMPOSE_MISSING");
		const badCatalog = createWorld();
		badCatalog.catalog.definitions = async () => {
			throw new Error("x");
		};
		expect(
			(
				await collect(
					startService(badCatalog, { project: "shop", name: "cache" }),
				)
			).at(-1)?.error?.code,
		).toBe("INVALID_CATALOG");
		const fixed = createWorld({
			yaml: "version: 1\nname: shop\nservices:\n  cache: { type: redis, port: 6390 }\n",
			busy: [6390],
		});
		const conflict = await collect(
			startService(fixed, { project: "shop", name: "cache" }),
		);
		expect(conflict.at(-1)?.error).toMatchObject({
			code: "PORT_CONFLICT",
			details: { port: 6390, suggestedPort: 6380 },
		});
		expect(fixed.lifecycle.upCalls).toHaveLength(0);
	});
});

describe("stopService and restartService", () => {
	test("run compose stop / restart on the one service", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const stopped = await collect(
			stopService(world, { project: "shop", name: "cache" }),
		);
		expect(stopped.map((e) => [e.kind, e.service])).toEqual([
			["step", "cache"],
			["done", "cache"],
		]);
		expect(world.lifecycle.stopCalls).toEqual([
			{ ...target, services: ["cache"] },
		]);
		const restarted = await collect(
			restartService(world, { project: "shop", name: "cache" }),
		);
		expect(restarted.at(-1)?.kind).toBe("done");
		expect(world.lifecycle.restartCalls).toEqual([
			{ ...target, services: ["cache"] },
		]);
	});

	test("a never-rendered project: stop is done, restart is INVALID_INPUT", async () => {
		const world = createWorld();
		const stopped = await collect(
			stopService(world, { project: "shop", name: "cache" }),
		);
		expect(stopped.at(-1)).toMatchObject({
			kind: "done",
			message: "cache is not running",
		});
		const restarted = await collect(
			restartService(world, { project: "shop", name: "cache" }),
		);
		expect(restarted.at(-1)?.error?.code).toBe("INVALID_INPUT");
		expect(world.lifecycle.stopCalls).toHaveLength(0);
		expect(world.lifecycle.restartCalls).toHaveLength(0);
	});

	test("unknown service or project, and runner failures", async () => {
		const world = createWorld({ rendered: true });
		expect(
			(await collect(stopService(world, { project: "shop", name: "nope" }))).at(
				-1,
			)?.error?.code,
		).toBe("SERVICE_NOT_FOUND");
		expect(
			(await collect(restartService(world, { project: "nope", name: "x" }))).at(
				-1,
			)?.error?.code,
		).toBe("PROJECT_NOT_FOUND");
		world.lifecycle.stopScript = new Error("daemon down");
		const failed = await collect(
			stopService(world, { project: "shop", name: "cache" }),
		);
		expect(failed.at(-1)).toMatchObject({
			kind: "error",
			message: "daemon down",
			service: "cache",
		});
		world.files.exists = async () => {
			throw new Error("EACCES");
		};
		world.lifecycle.stopScript = [{ kind: "done", message: "Stopped" }];
		const assumed = await collect(
			stopService(world, { project: "shop", name: "cache" }),
		);
		expect(assumed.at(-1)?.kind).toBe("done");
	});
});
