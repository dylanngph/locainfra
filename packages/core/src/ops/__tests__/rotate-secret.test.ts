// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose ${VAR} interpolation is the test data
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { collect } from "../../testing/collect";
import {
	BAKED_SECRET_FIX,
	rotateSecret,
	WIPE_NEEDS_FORCE_FIX,
} from "../rotate-secret.op";
import { createWorld, SHOP_COMPOSE, SHOP_SECRETS } from "./world";

const ENV_FILE = "/home/test/.locastack/stacks/shop/.env";

describe("rotateSecret", () => {
	test("redis: new value stored and rendered, service and dependents recreated", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const events = await collect(
			rotateSecret(world, {
				project: "shop",
				name: "cache",
				key: "REDIS_PASSWORD",
			}),
		);
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["step", "Rotating REDIS_PASSWORD"],
			["step", "Starting cache"],
			["done", "Rotated REDIS_PASSWORD of cache"],
		]);
		const stored = world.secrets.stacks.get("shop") ?? {};
		expect(stored.CACHE__REDIS_PASSWORD).toStartWith("secret-1-");
		expect(stored.MAIN_DB__POSTGRES_PASSWORD).toBe(
			SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD,
		);
		expect(world.files.files.get(ENV_FILE)).toContain(
			stored.CACHE__REDIS_PASSWORD ?? "?",
		);
		expect(JSON.stringify(events)).not.toContain(
			stored.CACHE__REDIS_PASSWORD ?? "?",
		);
		expect(world.lifecycle.upCalls).toEqual([
			{
				projectName: "ls-shop",
				composeFile: SHOP_COMPOSE,
				services: ["cache", "rest"],
				wait: true,
				waitTimeoutSec: 120,
			},
		]);
		expect(world.lifecycle.removeCalls).toEqual([]);
	});

	test("postgres with a volume: refused unless force + wipeVolume", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		for (const options of [{}, { force: true }, { wipeVolume: true }]) {
			const events = await collect(
				rotateSecret(world, {
					project: "shop",
					name: "main-db",
					key: "POSTGRES_PASSWORD",
					...options,
				}),
			);
			expect(events).toHaveLength(1);
			expect(events[0]?.error).toMatchObject({
				code: "INVALID_INPUT",
				details: { fix: BAKED_SECRET_FIX, reason: "baked-into-volume" },
			});
		}
		expect(world.secrets.stacks.get("shop")?.MAIN_DB__POSTGRES_PASSWORD).toBe(
			SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD,
		);
	});

	test("wipeVolume without force is refused for a secret that is not baked in", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const events = await collect(
			rotateSecret(world, {
				project: "shop",
				name: "cache",
				key: "REDIS_PASSWORD",
				wipeVolume: true,
			}),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.error).toMatchObject({
			code: "INVALID_INPUT",
			details: { fix: WIPE_NEEDS_FORCE_FIX, reason: "wipe-needs-force" },
		});
		expect(world.lifecycle.removeCalls).toEqual([]);
		expect(world.secrets.stacks.get("shop")?.CACHE__REDIS_PASSWORD).toBe(
			SHOP_SECRETS.CACHE__REDIS_PASSWORD,
		);
	});

	test("postgres forced with wipeVolume: remove, delete volume, rotate, start", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const events = await collect(
			rotateSecret(world, {
				project: "shop",
				name: "main-db",
				key: "POSTGRES_PASSWORD",
				force: true,
				wipeVolume: true,
			}),
		);
		expect(events.map((e) => e.message)).toEqual([
			"Removing main-db",
			"Deleting volume ls-shop-main-db-data",
			"Rotating POSTGRES_PASSWORD",
			"Starting main-db",
			"Rotated POSTGRES_PASSWORD of main-db",
		]);
		expect(world.lifecycle.removeCalls).toEqual([
			{
				projectName: "ls-shop",
				composeFile: SHOP_COMPOSE,
				services: ["main-db"],
				volumes: ["ls-shop-main-db-data"],
			},
		]);
		expect(
			world.secrets.stacks.get("shop")?.MAIN_DB__POSTGRES_PASSWORD,
		).toStartWith("secret-1-");
		const compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services["main-db"].environment.POSTGRES_PASSWORD).toBe(
			"${LI_SECRET_MAIN_DB__POSTGRES_PASSWORD}",
		);
	});

	test("ephemeral postgres rotates freely; a failed remove stops the op", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const events = await collect(
			rotateSecret(world, {
				project: "shop",
				name: "events",
				key: "POSTGRES_PASSWORD",
			}),
		);
		expect(events.at(-1)?.kind).toBe("done");

		const failing = createWorld({ provisioned: true, rendered: true });
		failing.lifecycle.removeScript = [
			{ kind: "error", message: "volume in use" },
		];
		const failed = await collect(
			rotateSecret(failing, {
				project: "shop",
				name: "main-db",
				key: "POSTGRES_PASSWORD",
				force: true,
				wipeVolume: true,
			}),
		);
		expect(failed.at(-1)).toMatchObject({
			kind: "error",
			message: "volume in use",
		});
		expect(failing.secrets.stacks.get("shop")?.MAIN_DB__POSTGRES_PASSWORD).toBe(
			SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD,
		);

		const neverStarted = createWorld({ provisioned: true });
		const fresh = await collect(
			rotateSecret(neverStarted, {
				project: "shop",
				name: "main-db",
				key: "POSTGRES_PASSWORD",
				force: true,
				wipeVolume: true,
			}),
		);
		expect(fresh.at(-1)?.kind).toBe("done");
		expect(neverStarted.lifecycle.removeCalls).toEqual([]);
	});

	test("errors: unknown key, service, project, compose, secret store, up", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ key: "NOPE" }, "INVALID_INPUT"],
			[{ name: "nope" }, "SERVICE_NOT_FOUND"],
			[{ project: "nope" }, "PROJECT_NOT_FOUND"],
		];
		for (const [fields, code] of cases) {
			const events = await collect(
				rotateSecret(world, {
					project: "shop",
					name: "cache",
					key: "REDIS_PASSWORD",
					...fields,
				}),
			);
			expect(events[0]?.error?.code).toBe(code);
		}
		world.compose.current = null;
		const noCompose = await collect(
			rotateSecret(world, {
				project: "shop",
				name: "cache",
				key: "REDIS_PASSWORD",
			}),
		);
		expect(noCompose[0]?.error?.code).toBe("COMPOSE_MISSING");

		const storeFails = createWorld({ provisioned: true, rendered: true });
		storeFails.secrets.update = async () => {
			throw new Error("EACCES");
		};
		const io = await collect(
			rotateSecret(storeFails, {
				project: "shop",
				name: "cache",
				key: "REDIS_PASSWORD",
			}),
		);
		expect(io.at(-1)?.error?.code).toBe("IO");

		const upFails = createWorld({ provisioned: true, rendered: true });
		upFails.lifecycle.upScript = [{ kind: "error", message: "unhealthy" }];
		const up = await collect(
			rotateSecret(upFails, {
				project: "shop",
				name: "cache",
				key: "REDIS_PASSWORD",
			}),
		);
		expect(up.at(-1)).toMatchObject({
			kind: "error",
			message: "unhealthy",
			service: "cache",
		});

		const badCatalog = createWorld({ provisioned: true, rendered: true });
		badCatalog.catalog.items = badCatalog.catalog.items.filter(
			(d) => d.id !== "upstash-redis",
		);
		const noDefinition = await collect(
			rotateSecret(badCatalog, {
				project: "shop",
				name: "rest",
				key: "SRH_TOKEN",
			}),
		);
		expect(noDefinition[0]?.error?.code).toBe("INVALID_INPUT");
		badCatalog.catalog.definitions = async () => {
			throw new Error("broken");
		};
		const broken = await collect(
			rotateSecret(badCatalog, {
				project: "shop",
				name: "cache",
				key: "REDIS_PASSWORD",
			}),
		);
		expect(broken[0]?.error?.code).toBe("INVALID_CATALOG");
	});
});
