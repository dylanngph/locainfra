import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { BUILTIN_CATALOG_FILES } from "../../catalog/builtin";
import type { ServiceDefinition } from "../../catalog/catalog.model";
import { parseServiceDefinition } from "../../catalog/loader";
import type { StateFile } from "../../ports/state.port";
import type { ResolvedStack } from "../../resolve/resolved.model";
import { resolveStack } from "../../resolve/resolver";
import type { Stack } from "../../stack/stack.model";
import {
	builtinTestDefinitions,
	createProjectStack,
	postgresDefinition,
} from "../../testing/catalog-fixtures";
import {
	renderCompose,
	renderComposeEnvFile,
	toComposeDocument,
} from "../compose-renderer";
import {
	LABEL_CATALOG_ID,
	LABEL_INSTANCE,
	LABEL_SERVICE,
	LABEL_STACK,
	LABEL_TYPE,
	LABEL_VERSION,
} from "../labels";
import { createComposeEscaper, secretVarName } from "../secret-refs";

/** Compose interpolation reference to a secret, e.g. `${LI_SECRET_X}`. */
function ref(name: string): string {
	return `$\{${secretVarName(name)}}`;
}

/** Secrets keyed per instance (`<INSTANCE>__<SECRET>`), as the secret store holds them. */
const secrets = {
	POSTGRES__POSTGRES_PASSWORD: "pgSecret_0123456789abcdefghijklmnopqrstuvw",
	REDIS__REDIS_PASSWORD: "redisSecret_0123456789abcdefghijklmnopqrst",
	UPSTASH_REDIS__SRH_TOKEN: "srhToken_0123456789abcdefghijklmnopqrstuvwx",
	MAIN_DB__POSTGRES_PASSWORD: "mainDbSecret_0123456789abcdefghijklmnopq",
	EVENTS__POSTGRES_PASSWORD: "eventsSecret_0123456789abcdefghijklmnopq",
	CACHE__REDIS_PASSWORD: "cacheSecret_0123456789abcdefghijklmnopqr",
	REST__SRH_TOKEN: "restToken_0123456789abcdefghijklmnopqrstu",
};

function resolve(
	stack: Stack,
	state: StateFile,
	definitions: readonly ServiceDefinition[] = builtinTestDefinitions,
): ResolvedStack {
	const result = resolveStack({ stack, definitions, state, secrets });
	if (!result.ok) throw result.error;
	return result.value;
}

const projectState: StateFile = {
	projects: [],
	stacks: {
		shop: {
			ports: { postgres: 5433, redis: 6380, "upstash-redis": 8080 },
			createdAt: "2026-01-01T00:00:00Z",
		},
	},
};

/** A project with named instances. */
function createShop(): Stack {
	return createProjectStack("shop", {
		"main-db": { type: "postgres", config: { POSTGRES_DB: "shop" } },
		events: { type: "postgres", persist: "ephemeral" },
		cache: { type: "redis" },
		rest: { type: "upstash-redis", uses: { redis: "cache" } },
	});
}

const shopState: StateFile = {
	projects: [],
	stacks: {
		shop: {
			ports: { "main-db": 5433, events: 5434, cache: 6380, rest: 8080 },
			createdAt: "2026-01-01T00:00:00Z",
		},
	},
};

/** The real built-in definitions from the repo-root `catalog/` folder. */
function loadBuiltins(): ServiceDefinition[] {
	return BUILTIN_CATALOG_FILES.map((file) => {
		const path = join(REPO_CATALOG_DIR, file);
		const parsed = parseServiceDefinition(readFileSync(path, "utf8"), path);
		if (!parsed.ok) throw parsed.error;
		return parsed.value;
	});
}

const REPO_CATALOG_DIR = fileURLToPath(
	new URL("../../../../../catalog", import.meta.url),
);

describe("renderCompose golden snapshots (built-in catalog)", () => {
	const builtins = loadBuiltins();

	test.each(builtins.map((d) => [d.id, d] as const))("%s", (id, definition) => {
		const services: Stack["file"]["services"] = { [id]: { type: id } };
		for (const dep of definition.dependsOn ?? []) {
			services[dep] = { type: dep };
		}
		const stack = createProjectStack("shop", services);
		expect(
			renderCompose(resolve(stack, projectState, builtins)),
		).toMatchSnapshot();
	});

	test("named instances: two postgres (one ephemeral), redis, upstash via uses", () => {
		const resolved = resolve(createShop(), shopState, builtins);
		expect(renderCompose(resolved)).toMatchSnapshot();
		expect(renderComposeEnvFile(resolved)).toMatchSnapshot();
	});

	test("seed file: read-only bind mount after the data volume ($ escaped)", () => {
		const base = createProjectStack("shop", {
			"main-db": { type: "postgres", seed: "db/seed.sql" },
			events: { type: "postgres", persist: "ephemeral", seed: "db/events.sql" },
			// redis has no catalog seed block: the entry's seed is ignored.
			cache: { type: "redis", seed: "db/ignored.txt" },
		});
		const stack: Stack = {
			...base,
			root: "/work/shop$app",
			filePath: "/work/shop$app/locastack.yaml",
		};
		const text = renderCompose(resolve(stack, shopState, builtins));
		expect(text).toMatchSnapshot();
		const doc = parse(text) as {
			services: Record<string, { volumes?: unknown[] }>;
		};
		expect(doc.services["main-db"]?.volumes).toEqual([
			"ls-shop-main-db-data:/var/lib/postgresql/data",
			{
				type: "bind",
				source: "/work/shop$$app/db/seed.sql",
				target: "/docker-entrypoint-initdb.d/seed.sql",
				read_only: true,
				bind: { create_host_path: false },
			},
		]);
		expect(doc.services.events?.volumes).toEqual([
			{
				type: "bind",
				source: "/work/shop$$app/db/events.sql",
				target: "/docker-entrypoint-initdb.d/seed.sql",
				read_only: true,
				bind: { create_host_path: false },
			},
		]);
		expect(doc.services.cache?.volumes).toEqual(["ls-shop-cache-data:/data"]);
	});
});

describe("toComposeDocument", () => {
	const resolved = resolve(
		createProjectStack("shop", {
			postgres: { type: "postgres" },
			redis: { type: "redis" },
			"upstash-redis": { type: "upstash-redis" },
		}),
		projectState,
	);
	const doc = toComposeDocument(resolved);

	test("binds ports to 127.0.0.1 and names containers ls-<stack>-<svc>", () => {
		expect(doc.name).toBe("ls-shop");
		expect(doc.services.postgres?.ports).toEqual(["127.0.0.1:5433:5432"]);
		expect(doc.services.postgres?.container_name).toBe("ls-shop-postgres");
		expect(doc.services.postgres?.restart).toBe("unless-stopped");
		expect(doc.services.postgres?.networks).toEqual(["ls-shop"]);
	});

	test("labels every container with project, instance, type and version", () => {
		expect(doc.services.redis?.labels).toEqual({
			[LABEL_STACK]: "shop",
			[LABEL_SERVICE]: "redis",
			[LABEL_INSTANCE]: "redis",
			[LABEL_TYPE]: "redis",
			[LABEL_CATALOG_ID]: "redis",
			[LABEL_VERSION]: "7",
		});
	});

	test("depends_on waits for healthy dependencies", () => {
		expect(doc.services["upstash-redis"]?.depends_on).toEqual({
			redis: { condition: "service_healthy" },
		});
		expect(doc.services.postgres?.depends_on).toBeUndefined();
	});

	test("declares named volumes and the stack network", () => {
		expect(doc.services.postgres?.volumes).toEqual([
			"ls-shop-postgres-data:/var/lib/postgresql/data",
		]);
		expect(Object.keys(doc.volumes ?? {})).toEqual([
			"ls-shop-postgres-data",
			"ls-shop-redis-data",
		]);
		expect(doc.volumes?.["ls-shop-postgres-data"]?.name).toBe(
			"ls-shop-postgres-data",
		);
		expect(doc.networks).toEqual({
			"ls-shop": { name: "ls-shop", labels: { [LABEL_STACK]: "shop" } },
		});
	});

	test("rendered YAML contains no secret values and round-trips", () => {
		const yaml = renderCompose(resolved);
		for (const value of Object.values(secrets)) {
			expect(yaml).not.toContain(value);
		}
		expect(parse(yaml)).toEqual(JSON.parse(JSON.stringify(doc)));
		expect(doc.services.postgres?.environment?.POSTGRES_PASSWORD).toBe(
			ref("POSTGRES__POSTGRES_PASSWORD"),
		);
		expect(
			doc.services["upstash-redis"]?.environment?.SRH_CONNECTION_STRING,
		).toBe(`redis://:${ref("REDIS__REDIS_PASSWORD")}@redis:6379`);
	});

	test(".env carries every secret for interpolation", () => {
		const env = renderComposeEnvFile(resolved);
		expect(env).toContain(
			`LI_SECRET_POSTGRES__POSTGRES_PASSWORD=${secrets.POSTGRES__POSTGRES_PASSWORD}\n`,
		);
		expect(env).toContain(
			`LI_SECRET_REDIS__REDIS_PASSWORD=${secrets.REDIS__REDIS_PASSWORD}\n`,
		);
		expect(env).toContain(
			`LI_SECRET_UPSTASH_REDIS__SRH_TOKEN=${secrets.UPSTASH_REDIS__SRH_TOKEN}\n`,
		);
	});

	test("literal $ is escaped so compose interpolates only secrets", () => {
		const def: ServiceDefinition = {
			...postgresDefinition,
			env: { ...postgresDefinition.env, GREETING: `cost $5 and $\{HOME}` },
		};
		const stack = createProjectStack("shop", {
			postgres: { type: "postgres" },
		});
		const out = toComposeDocument(resolve(stack, projectState, [def]));
		expect(out.services.postgres?.environment?.GREETING).toBe(
			`cost $$5 and $$\{HOME}`,
		);
	});
});

describe("toComposeDocument with named instances", () => {
	const doc = toComposeDocument(resolve(createShop(), shopState));

	test("one compose service and container per instance", () => {
		expect(Object.keys(doc.services)).toEqual([
			"main-db",
			"events",
			"cache",
			"rest",
		]);
		expect(doc.services["main-db"]?.container_name).toBe("ls-shop-main-db");
		expect(doc.services.events?.container_name).toBe("ls-shop-events");
		expect(doc.services["main-db"]?.ports).toEqual(["127.0.0.1:5433:5432"]);
		expect(doc.services.events?.ports).toEqual(["127.0.0.1:5434:5432"]);
		expect(doc.services.events?.labels).toMatchObject({
			[LABEL_INSTANCE]: "events",
			[LABEL_TYPE]: "postgres",
		});
	});

	test("ephemeral instances get no named volume", () => {
		expect(doc.services.events?.volumes).toBeUndefined();
		expect(Object.keys(doc.volumes ?? {})).toEqual([
			"ls-shop-main-db-data",
			"ls-shop-cache-data",
		]);
		expect(doc.volumes?.["ls-shop-main-db-data"]?.labels).toEqual({
			[LABEL_STACK]: "shop",
			[LABEL_SERVICE]: "main-db",
			[LABEL_INSTANCE]: "main-db",
			[LABEL_TYPE]: "postgres",
		});
	});

	test("secrets are referenced per instance and dependencies by instance name", () => {
		expect(doc.services["main-db"]?.environment?.POSTGRES_PASSWORD).toBe(
			ref("MAIN_DB__POSTGRES_PASSWORD"),
		);
		expect(doc.services.events?.environment?.POSTGRES_PASSWORD).toBe(
			ref("EVENTS__POSTGRES_PASSWORD"),
		);
		expect(doc.services.rest?.depends_on).toEqual({
			cache: { condition: "service_healthy" },
		});
		expect(doc.services.rest?.environment?.SRH_CONNECTION_STRING).toBe(
			`redis://:${ref("CACHE__REDIS_PASSWORD")}@cache:6379`,
		);
	});

	test("every port binds 127.0.0.1 only", () => {
		for (const service of Object.values(doc.services)) {
			for (const port of service.ports) expect(port).toStartWith("127.0.0.1:");
		}
	});
});

describe("createComposeEscaper", () => {
	test("keeps short secrets inline and escapes $ inside secret values", () => {
		const escaper = createComposeEscaper({
			SHORT: "abc",
			LONG: "pa$$word-long-1",
		});
		expect(escaper.escape("abc:pa$$word-long-1")).toBe(`abc:${ref("LONG")}`);
	});

	test("prefers the longest secret when values overlap", () => {
		const escaper = createComposeEscaper({
			A: "overlap-value",
			B: "overlap-value-extended",
		});
		expect(escaper.escape("x overlap-value-extended y")).toBe(
			`x ${ref("B")} y`,
		);
	});
});
