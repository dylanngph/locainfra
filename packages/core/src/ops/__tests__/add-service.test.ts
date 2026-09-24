import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { collect } from "../../testing/collect";
import { addService } from "../add-service.op";
import { createWorld, SHOP_COMPOSE, SHOP_FILE } from "./world";

const EMPTY = "# my project\nversion: 1\nname: shop\nservices: {}\n";

describe("addService", () => {
	test("writes the entry, pins its port, renders compose and ups the service", async () => {
		const world = createWorld({ yaml: EMPTY });
		const events = await collect(
			addService(world, {
				project: "shop",
				name: "main-db",
				type: "postgres",
				version: "16",
				config: { POSTGRES_DB: "shop" },
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["step", "step", "step", "done"]);
		expect(events.every((e) => e.service === "main-db")).toBe(true);
		const text = world.files.files.get(SHOP_FILE) ?? "";
		expect(text).toContain("# my project");
		expect(text).toContain(
			'  main-db: { type: postgres, version: "16", config: { POSTGRES_DB: shop } }\n',
		);
		expect(world.state.state.stacks.shop?.ports).toEqual({ "main-db": 5433 });
		expect(Object.keys(world.secrets.stacks.get("shop") ?? {})).toEqual([
			"MAIN_DB__POSTGRES_PASSWORD",
		]);
		const compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services["main-db"].container_name).toBe("ls-shop-main-db");
		expect(world.lifecycle.upCalls).toEqual([
			{
				projectName: "ls-shop",
				composeFile: SHOP_COMPOSE,
				services: ["main-db"],
				wait: true,
				waitTimeoutSec: 120,
			},
		]);
	});

	test("a second instance of the same type is independent", async () => {
		const world = createWorld({ provisioned: true });
		const events = await collect(
			addService(world, {
				project: "shop",
				name: "audit",
				type: "postgres",
				persist: "ephemeral",
				port: "auto",
			}),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(world.state.state.stacks.shop?.ports.audit).toBe(5435);
		expect(
			world.secrets.stacks.get("shop")?.AUDIT__POSTGRES_PASSWORD,
		).toStartWith("secret-1-");
		expect(world.gen.count).toBe(1);
		const compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services.audit.volumes).toBeUndefined();
	});

	test("validates before writing: name, duplicates, type, version, config, dependsOn", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ name: "Bad_Name", type: "postgres" }, "INVALID_INPUT"],
			[{ name: "cache", type: "redis" }, "SERVICE_EXISTS"],
			[{ name: "x", type: "mysql" }, "INVALID_INPUT"],
			[{ name: "x", type: "postgres", version: "9" }, "INVALID_INPUT"],
			[{ name: "x", type: "postgres", config: { NOPE: "1" } }, "INVALID_INPUT"],
			[
				{ name: "x", type: "postgres", config: { POSTGRES_DB: "a b" } },
				"INVALID_INPUT",
			],
			[{ name: "x", type: "postgres", port: 70000 }, "INVALID_INPUT"],
			[{ project: "nope", name: "x", type: "postgres" }, "PROJECT_NOT_FOUND"],
		];
		for (const [input, code] of cases) {
			const world = createWorld();
			const before = world.files.files.get(SHOP_FILE);
			const events = await collect(
				addService(world, {
					project: "shop",
					...(input as { name: string; type: string }),
				}),
			);
			expect(events.at(-1)?.error?.code).toBe(code);
			expect(world.files.files.get(SHOP_FILE)).toBe(before);
			expect(world.lifecycle.upCalls).toHaveLength(0);
		}

		const noRedis = createWorld({ yaml: EMPTY });
		const events = await collect(
			addService(noRedis, {
				project: "shop",
				name: "rest",
				type: "upstash-redis",
			}),
		);
		expect(events.at(-1)?.error).toMatchObject({
			code: "INVALID_INPUT",
			details: { dependency: "redis" },
		});
	});

	test("a container name used by another project is SERVICE_EXISTS", async () => {
		const world = createWorld();
		world.state.state.projects.push({ name: "shop-api", root: "/work/api" });
		world.files.files.set(
			"/work/api/locastack.yaml",
			"version: 1\nname: shop-api\nservices:\n  db: { type: postgres }\n",
		);
		const events = await collect(
			addService(world, { project: "shop", name: "api-db", type: "postgres" }),
		);
		expect(events.at(-1)?.error).toMatchObject({
			code: "SERVICE_EXISTS",
			details: { containerName: "ls-shop-api-db", otherProject: "shop-api" },
		});
	});

	test("an explicit busy port is PORT_CONFLICT with a suggested port; the entry stays", async () => {
		const world = createWorld({ yaml: EMPTY, busy: [5440] });
		const events = await collect(
			addService(world, {
				project: "shop",
				name: "main-db",
				type: "postgres",
				port: 5440,
			}),
		);
		const last = events.at(-1);
		expect(last?.kind).toBe("error");
		expect(last?.service).toBe("main-db");
		expect(last?.error).toMatchObject({
			code: "PORT_CONFLICT",
			details: { port: 5440, suggestedPort: 5433 },
		});
		expect(String(last?.error?.details?.fix)).toContain("Use port 5433");
		expect(world.files.files.get(SHOP_FILE)).toContain("main-db:");
		expect(world.lifecycle.upCalls).toHaveLength(0);
	});

	test("compose missing fails before writing", async () => {
		const world = createWorld({ yaml: EMPTY });
		world.compose.current = null;
		const events = await collect(
			addService(world, { project: "shop", name: "db", type: "postgres" }),
		);
		expect(events.at(-1)?.error?.code).toBe("COMPOSE_MISSING");
		expect(world.files.files.get(SHOP_FILE)).toBe(EMPTY);
	});

	test("catalog and registry failures end with one error", async () => {
		const world = createWorld({ yaml: EMPTY });
		world.catalog.definitions = async () => {
			throw new Error("bad");
		};
		const catalog = await collect(
			addService(world, { project: "shop", name: "db", type: "postgres" }),
		);
		expect(catalog.at(-1)?.error?.code).toBe("INVALID_CATALOG");

		const registry = createWorld({ yaml: EMPTY });
		let reads = 0;
		const read = registry.state.read.bind(registry.state);
		registry.state.read = async () => {
			if (++reads > 1) throw new Error("EACCES");
			return read();
		};
		const io = await collect(
			addService(registry, { project: "shop", name: "db", type: "postgres" }),
		);
		expect(io.at(-1)?.error?.code).toBe("IO");
	});

	test("a failing compose up is the terminal error, tagged with the service", async () => {
		const world = createWorld({ yaml: EMPTY });
		world.lifecycle.upScript = new Error("image pull failed");
		const events = await collect(
			addService(world, { project: "shop", name: "db", type: "postgres" }),
		);
		expect(events.at(-1)).toMatchObject({
			kind: "error",
			message: "image pull failed",
			service: "db",
		});
	});
});
