import { describe, expect, test } from "bun:test";
import { collect } from "../../testing/collect";
import { FakeContainerExec } from "../../testing/data-fakes";
import { MASKED_SECRET, SEED_MAX_BYTES, SEED_TIMEOUT_MS } from "../ops.model";
import { seedService } from "../seed-service.op";
import {
	addContainer,
	createWorld,
	SHOP_FILE,
	SHOP_ROOT,
	SHOP_SECRETS,
} from "./world";

const SEEDED_YAML = `version: 1
name: shop
services:
  main-db: { type: postgres, seed: db/seed.sql }
  plain: { type: postgres }
  cache: { type: redis }
`;

const MAIN_DB = { project: "shop", name: "main-db" };

function seedWorld(yaml = SEEDED_YAML) {
	const world = {
		...createWorld({ yaml, rendered: true }),
		exec: new FakeContainerExec(),
	};
	world.state.state.stacks.shop = {
		ports: { "main-db": 5433, plain: 5434, cache: 6380 },
		createdAt: "2026-01-01T00:00:00Z",
	};
	world.secrets.stacks.set("shop", {
		MAIN_DB__POSTGRES_PASSWORD: SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD,
		PLAIN__POSTGRES_PASSWORD: "plain-password-000005",
		CACHE__REDIS_PASSWORD: SHOP_SECRETS.CACHE__REDIS_PASSWORD,
	});
	world.files.files.set(
		`${SHOP_ROOT}/db/seed.sql`,
		"INSERT INTO t VALUES (1);\n",
	);
	for (const service of ["main-db", "plain", "cache"])
		addContainer(world, service);
	return world;
}

describe("seedService", () => {
	test("pipes the seed file to seed.run in the running container", async () => {
		const world = seedWorld();
		const events = await collect(seedService(world, MAIN_DB));
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["step", "Seeding main-db from ./db/seed.sql"],
			["done", "Seeded main-db from ./db/seed.sql"],
		]);
		expect(events.every((e) => e.service === "main-db")).toBe(true);
		const [call] = world.exec.calls;
		expect(call?.containerId).toBe("ls-shop-main-db");
		expect(call?.argv).toEqual([
			"psql",
			"-X",
			"-q",
			"-U",
			"postgres",
			"-d",
			"shop",
			"-v",
			"ON_ERROR_STOP=1",
			"-f",
			"-",
		]);
		expect(call?.options.stdin).toBe("INSERT INTO t VALUES (1);\n");
		expect(call?.options.timeoutMs).toBe(SEED_TIMEOUT_MS);
	});

	test("a failing or slow seed is INVALID_INPUT with a masked excerpt", async () => {
		const world = seedWorld();
		world.exec.defaultScript = {
			exitCode: 3,
			stderr: `psql:<stdin>:1: ERROR:  relation "t" does not exist (${SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD})\n`,
		};
		const failed = await collect(seedService(world, MAIN_DB));
		expect(failed.at(-1)).toMatchObject({
			kind: "error",
			message: `psql:<stdin>:1: ERROR:  relation "t" does not exist (${MASKED_SECRET})`,
			error: {
				code: "INVALID_INPUT",
				details: { exitCode: 3, timedOut: false },
			},
		});
		world.exec.defaultScript = { exitCode: -1, timedOut: true };
		const slow = await collect(seedService(world, MAIN_DB));
		expect(slow.at(-1)?.message).toBe("Seeding timed out after 120 s.");
		world.exec.defaultScript = { exitCode: -1, truncated: true };
		const noisy = await collect(seedService(world, MAIN_DB));
		expect(noisy.at(-1)?.message).toBe(
			"Seeding printed more than 64 KB of output and was stopped.",
		);
		world.exec.defaultScript = new Error("gone");
		const down = await collect(seedService(world, MAIN_DB));
		expect(down.at(-1)?.error?.code).toBe("DOCKER_UNREACHABLE");
	});

	test("refusals before exec", async () => {
		const world = seedWorld();
		const plain = await collect(
			seedService(world, { project: "shop", name: "plain" }),
		);
		expect(plain).toHaveLength(1);
		expect(plain[0]?.error).toMatchObject({
			code: "INVALID_INPUT",
			message: "No seed file is set",
		});
		const cache = await collect(
			seedService(world, { project: "shop", name: "cache" }),
		);
		expect(cache[0]?.error?.message).toBe("Redis does not support seed files");

		world.files.files.delete(`${SHOP_ROOT}/db/seed.sql`);
		const missing = await collect(seedService(world, MAIN_DB));
		expect(missing.at(-1)?.error).toMatchObject({
			code: "IO",
			message: "Seed file ./db/seed.sql was not found in the project folder",
		});

		const unreadable = seedWorld();
		unreadable.files.readText = async (path: string) => {
			if (path.endsWith("seed.sql")) throw new Error("EACCES");
			return unreadable.files.files.get(path) ?? null;
		};
		expect(
			(await collect(seedService(unreadable, MAIN_DB))).at(-1)?.error?.code,
		).toBe("IO");

		const huge = seedWorld();
		huge.files.files.set(
			`${SHOP_ROOT}/db/seed.sql`,
			"x".repeat(SEED_MAX_BYTES + 1),
		);
		expect(
			(await collect(seedService(huge, MAIN_DB))).at(-1)?.error?.code,
		).toBe("INVALID_INPUT");

		const stopped = seedWorld();
		stopped.inspector.containers = [];
		const notRunning = await collect(seedService(stopped, MAIN_DB));
		expect(notRunning[0]?.error).toMatchObject({
			code: "SERVICE_NOT_RUNNING",
			message: "main-db is not running. Start it to seed it.",
		});
		expect(world.exec.calls).toEqual([]);
	});

	test("a symlink out of the project, a device or a folder is refused before reading", async () => {
		const seed = `${SHOP_ROOT}/db/seed.sql`;
		const cases: Array<[string, (w: ReturnType<typeof seedWorld>) => void]> = [
			[
				"Seed file ./db/seed.sql links to a file outside the project folder",
				(w) => {
					w.files.files.delete(seed);
					w.files.links.set(seed, "/Users/dev/.aws/credentials");
					w.files.files.set("/Users/dev/.aws/credentials", "[default]\n");
				},
			],
			[
				"Seed file ./db/seed.sql links to a file outside the project folder",
				(w) => {
					w.files.files.delete(seed);
					w.files.links.set(seed, "/dev/zero");
				},
			],
			[
				"Seed file ./db/seed.sql is not a regular file",
				(w) => {
					w.files.files.delete(seed);
					w.files.links.set(seed, `${SHOP_ROOT}/db/fifo`);
				},
			],
			[
				"Seed file ./db/seed.sql is not a regular file",
				(w) => {
					w.files.files.delete(seed);
					w.files.dirs.add(seed);
				},
			],
			[
				"Seed file ./db/seed.sql is larger than 64 MB",
				(w) => {
					w.files.sizes.set(seed, SEED_MAX_BYTES + 1);
				},
			],
		];
		for (const [message, arrange] of cases) {
			const world = seedWorld();
			arrange(world);
			const reads: string[] = [];
			const read = world.files.readText.bind(world.files);
			world.files.readText = async (path: string) => {
				reads.push(path);
				return read(path);
			};
			const events = await collect(seedService(world, MAIN_DB));
			expect(events.at(-1)?.error).toMatchObject({
				code: "INVALID_INPUT",
				message,
				details: { field: "seed" },
			});
			expect(reads.filter((p) => p !== SHOP_FILE)).toEqual([]);
			expect(world.exec.calls).toEqual([]);
		}
	});

	test("a hand-edited seed path outside the project is refused", async () => {
		const world = seedWorld();
		// The stack schema rejects it on load, so it never reaches the exec.
		world.files.files.set(
			SHOP_FILE,
			SEEDED_YAML.replace("db/seed.sql", "../outside.sql"),
		);
		const events = await collect(seedService(world, MAIN_DB));
		expect(events.at(-1)?.error?.code).toBe("INVALID_STACK");
		world.files.files.set(SHOP_FILE, SEEDED_YAML.replace("db/seed.sql", "."));
		const folder = await collect(seedService(world, MAIN_DB));
		expect(folder.at(-1)?.error).toMatchObject({
			code: "INVALID_STACK",
			message:
				'Seed file "." of "main-db" is not a file inside the project folder',
		});
		expect(world.exec.calls).toEqual([]);
	});
});
