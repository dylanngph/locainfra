import { describe, expect, test } from "bun:test";
import { envPreview } from "../env-preview.op";
import { connectionLabel, getConnection } from "../get-connection.op";
import { linkEnv } from "../link-env.op";
import { MASKED_SECRET } from "../ops.model";
import { createWorld, SHOP_ROOT, SHOP_SECRETS, SHOP_YAML } from "./world";

describe("envPreview", () => {
	test("masks secrets, prefixes colliding keys and groups by service", async () => {
		const world = createWorld({ provisioned: true });
		const result = await envPreview(world, {
			project: "shop",
			format: "dotenv",
			reveal: false,
		});
		if (!result.ok) throw result.error;
		expect(result.value.serviceCount).toBe(4);
		expect(result.value.file).toBe(".env");
		expect(result.value.lines.map((l) => [l.key, l.service, l.type])).toEqual([
			["DATABASE_URL", "main-db", "postgres"],
			["PGHOST", "main-db", "postgres"],
			["PGPORT", "main-db", "postgres"],
			["EVENTS_DATABASE_URL", "events", "postgres"],
			["EVENTS_PGHOST", "events", "postgres"],
			["EVENTS_PGPORT", "events", "postgres"],
			["REDIS_URL", "cache", "redis"],
			["UPSTASH_REDIS_REST_URL", "rest", "upstash-redis"],
			["UPSTASH_REDIS_REST_TOKEN", "rest", "upstash-redis"],
		]);
		expect(result.value.lines[0]?.value).toBe(
			`postgres://postgres:${MASKED_SECRET}@127.0.0.1:5433/shop`,
		);
		expect(result.value.lines.at(-1)?.value).toBe(MASKED_SECRET);
		for (const secret of Object.values(SHOP_SECRETS)) {
			expect(JSON.stringify(result.value)).not.toContain(secret);
		}
		expect(result.value.text).toStartWith(
			`# main-db (postgres)\nDATABASE_URL='postgres://postgres:${MASKED_SECRET}@127.0.0.1:5433/shop'\n`,
		);
		expect(result.value.text).toContain("\n\n# events (postgres)\n");
	});

	test("reveal shows values; json and link.file / registry envFile", async () => {
		const world = createWorld({
			provisioned: true,
			yaml: `${SHOP_YAML}  file: .env.local\n`,
		});
		const result = await envPreview(world, {
			project: "shop",
			format: "json",
			reveal: true,
		});
		if (!result.ok) throw result.error;
		expect(result.value.file).toBe(".env.local");
		expect(JSON.parse(result.value.text).DATABASE_URL).toBe(
			`postgres://postgres:${SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD}@127.0.0.1:5433/shop`,
		);

		const registry = createWorld({ provisioned: true });
		registry.state.state.projects[0] = {
			name: "shop",
			root: SHOP_ROOT,
			envFile: ".env.development",
		};
		const fromRegistry = await envPreview(registry, {
			project: "shop",
			format: "shell",
			reveal: false,
		});
		expect(fromRegistry.ok && fromRegistry.value.file).toBe(".env.development");
		expect(fromRegistry.ok && fromRegistry.value.text).toContain(
			"export PGPORT='5433'\n",
		);
	});

	test("works before the first start (port 0, masked) and reports errors", async () => {
		const fresh = await envPreview(createWorld(), {
			project: "shop",
			format: "dotenv",
			reveal: true,
		});
		expect(fresh.ok && fresh.value.lines[2]).toMatchObject({
			key: "PGPORT",
			value: "0",
		});
		const missing = await envPreview(createWorld(), {
			project: "nope",
			format: "dotenv",
			reveal: false,
		});
		expect(!missing.ok && missing.error.code).toBe("PROJECT_NOT_FOUND");
		const clash = createWorld({
			provisioned: true,
			yaml: SHOP_YAML.replace(
				"names: { cache: REDIS_URL }",
				"names: { cache: DATABASE_URL }",
			),
		});
		const invalid = await envPreview(clash, {
			project: "shop",
			format: "dotenv",
			reveal: false,
		});
		expect(!invalid.ok && invalid.error.code).toBe("INVALID_STACK");
	});

	test("state failures are IO", async () => {
		const world = createWorld({ provisioned: true });
		world.secrets.read = async () => {
			throw new Error("EACCES");
		};
		const result = await envPreview(world, {
			project: "shop",
			format: "dotenv",
			reveal: false,
		});
		expect(!result.ok && result.error.code).toBe("IO");
	});
});

describe("linkEnv", () => {
	test("writes revealed values into the marker block with mode 0600", async () => {
		const world = createWorld({ provisioned: true });
		world.files.files.set(`${SHOP_ROOT}/.env`, "MINE=1\n");
		const result = await linkEnv(world, { project: "shop" });
		expect(result).toEqual({
			ok: true,
			value: { path: `${SHOP_ROOT}/.env`, count: 9 },
		});
		const text = world.files.files.get(`${SHOP_ROOT}/.env`) ?? "";
		expect(text).toStartWith(
			"MINE=1\n\n# locastack:start\n# main-db (postgres)\n",
		);
		expect(text).toContain(SHOP_SECRETS.MAIN_DB__POSTGRES_PASSWORD);
		expect(text).toContain("EVENTS_DATABASE_URL=");
		expect(text).toEndWith("# locastack:end\n");
		expect(world.files.modes.get(`${SHOP_ROOT}/.env`)).toBe(0o600);
	});

	test("an explicit file inside the root; escaping paths are refused", async () => {
		const world = createWorld({ provisioned: true });
		const nested = await linkEnv(world, {
			project: "shop",
			file: "apps/web/.env.local",
		});
		expect(nested.ok && nested.value.path).toBe(
			`${SHOP_ROOT}/apps/web/.env.local`,
		);
		for (const file of ["../other/.env", "/etc/profile", "", "."]) {
			const result = await linkEnv(world, { project: "shop", file });
			expect(!result.ok && result.error.code).toBe("INVALID_INPUT");
		}
	});

	test("an unstarted project is INVALID_STACK (no placeholders written)", async () => {
		const world = createWorld();
		const result = await linkEnv(world, { project: "shop" });
		expect(!result.ok && result.error.code).toBe("INVALID_STACK");
		expect(world.files.files.has(`${SHOP_ROOT}/.env`)).toBe(false);
	});

	test("unbalanced markers are IO; unknown project is PROJECT_NOT_FOUND", async () => {
		const world = createWorld({ provisioned: true });
		world.files.files.set(`${SHOP_ROOT}/.env`, "# locastack:start\n");
		const result = await linkEnv(world, { project: "shop" });
		expect(!result.ok && result.error.code).toBe("IO");
		const missing = await linkEnv(world, { project: "nope" });
		expect(!missing.ok && missing.error.code).toBe("PROJECT_NOT_FOUND");
		const clash = createWorld({
			provisioned: true,
			yaml: SHOP_YAML.replace(
				"names: { cache: REDIS_URL }",
				"names: { cache: DATABASE_URL }",
			),
		});
		const invalid = await linkEnv(clash, { project: "shop" });
		expect(!invalid.ok && invalid.error.code).toBe("INVALID_STACK");
	});
});

describe("getConnection", () => {
	test("masked: primary under its final name, exports, details and snippets", async () => {
		const world = createWorld({ provisioned: true });
		const result = await getConnection(world, {
			project: "shop",
			name: "events",
			reveal: false,
		});
		if (!result.ok) throw result.error;
		expect(result.value.primary).toEqual({
			key: "EVENTS_DATABASE_URL",
			value: `postgres://postgres:${MASKED_SECRET}@127.0.0.1:5434/shop`,
		});
		expect(result.value.exports.map((e) => e.key)).toEqual([
			"EVENTS_DATABASE_URL",
			"EVENTS_PGHOST",
			"EVENTS_PGPORT",
		]);
		expect(result.value.details).toEqual([
			{ k: "Host", v: "127.0.0.1" },
			{ k: "Port", v: "5434" },
			{ k: "User", v: "postgres" },
			{ k: "Database", v: "shop" },
			{ k: "Password", v: MASKED_SECRET },
			{ k: "Container", v: "ls-shop-events" },
		]);
		expect(result.value.snippets.node).toContain(
			"process.env.EVENTS_DATABASE_URL",
		);
		expect(result.value.snippets.python).toContain(
			'os.environ["EVENTS_DATABASE_URL"]',
		);
		expect(result.value.snippets.go).toContain(
			'os.Getenv("EVENTS_DATABASE_URL")',
		);
		expect(result.value.snippets.env).toBe(
			`EVENTS_DATABASE_URL=postgres://postgres:${MASKED_SECRET}@127.0.0.1:5434/shop\nEVENTS_PGHOST=127.0.0.1\nEVENTS_PGPORT=5434`,
		);
		expect(JSON.stringify(result.value)).not.toContain(
			SHOP_SECRETS.EVENTS__POSTGRES_PASSWORD,
		);
	});

	test("reveal shows the secret; renamed primary; no snippets when the definition has none", async () => {
		const world = createWorld({ provisioned: true });
		const cache = await getConnection(world, {
			project: "shop",
			name: "cache",
			reveal: true,
		});
		if (!cache.ok) throw cache.error;
		expect(cache.value.primary).toEqual({
			key: "REDIS_URL",
			value: `redis://:${SHOP_SECRETS.CACHE__REDIS_PASSWORD}@127.0.0.1:6380`,
		});
		expect(cache.value.details).toContainEqual({
			k: "Password",
			v: SHOP_SECRETS.CACHE__REDIS_PASSWORD,
		});
		expect(cache.value.snippets.node).toBeUndefined();
		const rest = await getConnection(world, {
			project: "shop",
			name: "rest",
			reveal: false,
		});
		expect(rest.ok && rest.value.details).toContainEqual({
			k: "Token",
			v: MASKED_SECRET,
		});
	});

	test("SERVICE_NOT_FOUND, PROJECT_NOT_FOUND and deriver errors", async () => {
		const world = createWorld({ provisioned: true });
		const missing = await getConnection(world, {
			project: "shop",
			name: "nope",
			reveal: false,
		});
		expect(!missing.ok && missing.error.code).toBe("SERVICE_NOT_FOUND");
		const project = await getConnection(world, {
			project: "nope",
			name: "x",
			reveal: false,
		});
		expect(!project.ok && project.error.code).toBe("PROJECT_NOT_FOUND");
		const clash = createWorld({
			provisioned: true,
			yaml: SHOP_YAML.replace(
				"names: { cache: REDIS_URL }",
				"names: { cache: DATABASE_URL }",
			),
		});
		const invalid = await getConnection(clash, {
			project: "shop",
			name: "cache",
			reveal: false,
		});
		expect(!invalid.ok && invalid.error.code).toBe("INVALID_STACK");
		const catalog = createWorld({ provisioned: true });
		catalog.catalog.definitions = async () => {
			throw new Error("bad");
		};
		const broken = await getConnection(catalog, {
			project: "shop",
			name: "cache",
			reveal: false,
		});
		expect(!broken.ok && broken.error.code).toBe("INVALID_CATALOG");
	});

	test("connectionLabel", () => {
		expect(connectionLabel("POSTGRES_USER")).toBe("User");
		expect(connectionLabel("MONGO_USERNAME")).toBe("User");
		expect(connectionLabel("POSTGRES_DB")).toBe("Database");
		expect(connectionLabel("MYSQL_DATABASE")).toBe("Database");
		expect(connectionLabel("S3_BUCKETS")).toBe("Buckets");
		expect(connectionLabel("REDIS_PASSWORD")).toBe("Password");
		expect(connectionLabel("SRH_TOKEN")).toBe("Token");
		expect(connectionLabel("REGION")).toBe("REGION");
	});
});
