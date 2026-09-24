import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { collect } from "../../testing/collect";
import { addService } from "../add-service.op";
import { applyServicePatch, updateService } from "../update-service.op";
import { createWorld, SHOP_COMPOSE, SHOP_FILE } from "./world";

const EMPTY = "version: 1\nname: shop\nservices: {}\n";
const CHOSEN = "Chosen.Password_0123456789-abc~";

describe("addService: client-chosen secrets and seed", () => {
	test("stores chosen secrets, writes seed, mounts it read-only", async () => {
		const world = createWorld({ yaml: EMPTY });
		const events = await collect(
			addService(world, {
				project: "shop",
				name: "main-db",
				type: "postgres",
				secrets: { POSTGRES_PASSWORD: CHOSEN },
				seed: "db/seed.sql",
			}),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(JSON.stringify(events)).not.toContain(CHOSEN);
		expect(world.secrets.stacks.get("shop")).toEqual({
			MAIN_DB__POSTGRES_PASSWORD: CHOSEN,
		});
		expect(world.gen.count).toBe(0);
		expect(world.files.files.get(SHOP_FILE)).toContain("seed: db/seed.sql");
		const compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services["main-db"].volumes).toEqual([
			"ls-shop-main-db-data:/var/lib/postgresql/data",
			{
				type: "bind",
				source: "/work/shop/db/seed.sql",
				target: "/docker-entrypoint-initdb.d/seed.sql",
				read_only: true,
				bind: { create_host_path: false },
			},
		]);
	});

	test("keeps a stored baked secret of a previous instance (volume kept)", async () => {
		const world = createWorld({ yaml: EMPTY });
		world.secrets.stacks.set("shop", {
			MAIN_DB__POSTGRES_PASSWORD: "old-password-0123456789",
		});
		const events = await collect(
			addService(world, {
				project: "shop",
				name: "main-db",
				type: "postgres",
				secrets: { POSTGRES_PASSWORD: CHOSEN },
			}),
		);
		expect(events.find((e) => e.kind === "log")?.message).toBe(
			"Kept the stored POSTGRES_PASSWORD of main-db: its data volume was initialised with it",
		);
		expect(world.secrets.stacks.get("shop")?.MAIN_DB__POSTGRES_PASSWORD).toBe(
			"old-password-0123456789",
		);

		const ephemeral = createWorld({ yaml: EMPTY });
		ephemeral.secrets.stacks.set("shop", {
			MAIN_DB__POSTGRES_PASSWORD: "old-password-0123456789",
		});
		await collect(
			addService(ephemeral, {
				project: "shop",
				name: "main-db",
				type: "postgres",
				persist: "ephemeral",
				secrets: { POSTGRES_PASSWORD: CHOSEN },
			}),
		);
		expect(
			ephemeral.secrets.stacks.get("shop")?.MAIN_DB__POSTGRES_PASSWORD,
		).toBe(CHOSEN);
	});

	test("refuses bad secrets and seeds before writing anything", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ secrets: { NOPE: CHOSEN } }, 'Unknown secret "NOPE" for PostgreSQL'],
			[
				{ secrets: { POSTGRES_PASSWORD: "short" } },
				"The value of POSTGRES_PASSWORD is not a valid secret",
			],
			[
				{ secrets: { POSTGRES_PASSWORD: `${"a".repeat(20)} x` } },
				"The value of POSTGRES_PASSWORD is not a valid secret",
			],
			[
				{ seed: "../etc/passwd" },
				'Seed file "../etc/passwd" must be a path inside the project folder',
			],
			[
				{ seed: "/etc/passwd" },
				'Seed file "/etc/passwd" must be a path inside the project folder',
			],
			[
				{ seed: "~/x.sql" },
				'Seed file "~/x.sql" must be a path inside the project folder',
			],
			[
				{ seed: "C:/x.sql" },
				'Seed file "C:/x.sql" must be a path inside the project folder',
			],
			[{ type: "redis", seed: "x.sql" }, "Redis does not support seed files"],
		];
		for (const [fields, message] of cases) {
			const world = createWorld({ yaml: EMPTY });
			const events = await collect(
				addService(world, {
					project: "shop",
					name: "x",
					type: "postgres",
					...fields,
				}),
			);
			expect(events.at(-1)?.error).toMatchObject({
				code: "INVALID_INPUT",
				message,
			});
			expect(JSON.stringify(events)).not.toContain("short");
			expect(world.files.files.get(SHOP_FILE)).toBe(EMPTY);
			expect(world.secrets.stacks.size).toBe(0);
		}
	});

	test("a secret store failure is IO", async () => {
		const world = createWorld({ yaml: EMPTY });
		world.secrets.update = async () => {
			throw new Error("EACCES");
		};
		const events = await collect(
			addService(world, {
				project: "shop",
				name: "main-db",
				type: "postgres",
				secrets: { POSTGRES_PASSWORD: CHOSEN },
			}),
		);
		expect(events.at(-1)?.error?.code).toBe("IO");
	});
});

describe("updateService: seed", () => {
	test("applyServicePatch sets and removes seed", () => {
		expect(
			applyServicePatch({ type: "postgres" }, { seed: "db/a.sql" }),
		).toEqual({
			type: "postgres",
			seed: "db/a.sql",
		});
		expect(
			applyServicePatch({ type: "postgres", seed: "db/a.sql" }, { seed: "" }),
		).toEqual({
			type: "postgres",
		});
	});

	test("PATCH seed rewrites the entry and the mount; empty string removes both", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		const set = await collect(
			updateService(world, {
				project: "shop",
				name: "main-db",
				patch: { seed: "seeds/dev.sql" },
			}),
		);
		expect(set.at(-1)?.kind).toBe("done");
		expect(world.files.files.get(SHOP_FILE)).toContain("seed: seeds/dev.sql");
		let compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services["main-db"].volumes[1].source).toBe(
			"/work/shop/seeds/dev.sql",
		);

		await collect(
			updateService(world, {
				project: "shop",
				name: "main-db",
				patch: { seed: "" },
			}),
		);
		expect(world.files.files.get(SHOP_FILE)).not.toContain("seed:");
		compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services["main-db"].volumes).toEqual([
			"ls-shop-main-db-data:/var/lib/postgresql/data",
		]);

		const refused = await collect(
			updateService(world, {
				project: "shop",
				name: "cache",
				patch: { seed: "x.sql" },
			}),
		);
		expect(refused.at(-1)?.error?.code).toBe("INVALID_INPUT");
	});

	test("the compose seed mount follows no symlink out of the project; inside ones are canonicalised", async () => {
		const outside = createWorld({ provisioned: true, rendered: true });
		outside.files.links.set(
			"/work/shop/db/seed.sql",
			"/Users/dev/.aws/credentials",
		);
		outside.files.files.set("/Users/dev/.aws/credentials", "[default]\n");
		const before = outside.files.files.get(SHOP_COMPOSE);
		const refused = await collect(
			updateService(outside, {
				project: "shop",
				name: "events",
				patch: { seed: "db/seed.sql" },
			}),
		);
		expect(refused.at(-1)?.error).toMatchObject({
			code: "INVALID_INPUT",
			message:
				"Seed file ./db/seed.sql links to a file outside the project folder",
			details: { field: "seed", service: "events" },
		});
		expect(outside.files.files.get(SHOP_COMPOSE)).toBe(before);

		const inside = createWorld({ provisioned: true, rendered: true });
		inside.files.links.set("/work/shop/db/seed.sql", "/work/shop/sql/real.sql");
		inside.files.files.set("/work/shop/sql/real.sql", "SELECT 1;\n");
		await collect(
			updateService(inside, {
				project: "shop",
				name: "events",
				patch: { seed: "db/seed.sql" },
			}),
		);
		const compose = parse(inside.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services.events.volumes[0].source).toBe(
			"/work/shop/sql/real.sql",
		);
	});

	test("an ephemeral service still gets its seed mount", async () => {
		const world = createWorld({ provisioned: true, rendered: true });
		await collect(
			updateService(world, {
				project: "shop",
				name: "events",
				patch: { seed: "e.sql" },
			}),
		);
		const compose = parse(world.files.files.get(SHOP_COMPOSE) ?? "");
		expect(compose.services.events.volumes).toEqual([
			{
				type: "bind",
				source: "/work/shop/e.sql",
				target: "/docker-entrypoint-initdb.d/seed.sql",
				read_only: true,
				bind: { create_host_path: false },
			},
		]);
	});
});
