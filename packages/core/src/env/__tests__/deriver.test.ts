import { describe, expect, test } from "bun:test";
import type { StateFile } from "../../ports/state.port";
import type { ResolvedStack } from "../../resolve/resolved.model";
import { resolveStack } from "../../resolve/resolver";
import type { StackLink } from "../../stack/stack.model";
import {
	builtinTestDefinitions,
	createProjectStack,
	postgresDefinition,
} from "../../testing/catalog-fixtures";
import { deriveEnv, isReservedEnvName, primaryExportName } from "../deriver";

const secrets = {
	POSTGRES_PASSWORD: "pg-pass",
	REDIS_PASSWORD: "redis-pass",
	SRH_TOKEN: "srh-token",
};
const state: StateFile = {
	projects: [],
	stacks: {
		sovr: {
			ports: { postgres: 5433, redis: 6380, "upstash-redis": 8080 },
			createdAt: "2026-01-01T00:00:00Z",
		},
	},
};

function resolved(
	services: Parameters<typeof createProjectStack>[1],
	definitions = builtinTestDefinitions,
): ResolvedStack {
	const result = resolveStack({
		stack: createProjectStack("sovr", services),
		definitions,
		state,
		secrets,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

describe("deriveEnv", () => {
	const stack = resolved({ postgres: {}, redis: {}, "upstash-redis": {} });

	test("merges exports of every service in stack order", () => {
		const env = deriveEnv(stack);
		expect(env).toEqual({
			ok: true,
			value: {
				DATABASE_URL: "postgres://postgres:pg-pass@127.0.0.1:5433/sovr",
				PGHOST: "127.0.0.1",
				PGPORT: "5433",
				REDIS_URL: "redis://:redis-pass@127.0.0.1:6380",
				UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8080",
				UPSTASH_REDIS_REST_TOKEN: "srh-token",
			},
		});
	});

	test("renames each service's primary export via link.names", () => {
		const link: StackLink = {
			names: { postgres: "PRIMARY_DB_URL", redis: "CACHE_URL", gone: "X" },
		};
		const env = deriveEnv(stack, link);
		if (!env.ok) throw env.error;
		expect(env.value.PRIMARY_DB_URL).toBe(
			"postgres://postgres:pg-pass@127.0.0.1:5433/sovr",
		);
		expect(env.value.CACHE_URL).toBe("redis://:redis-pass@127.0.0.1:6380");
		expect(env.value.DATABASE_URL).toBeUndefined();
		expect(env.value.REDIS_URL).toBeUndefined();
		expect(env.value.PGPORT).toBe("5433");
	});

	test("primaryExportName is the first export", () => {
		expect(stack.services.map(primaryExportName)).toEqual([
			"DATABASE_URL",
			"REDIS_URL",
			"UPSTASH_REDIS_REST_URL",
		]);
	});

	test("conflicting names are INVALID_STACK without leaking values", () => {
		const clash = {
			...postgresDefinition,
			id: "pg-two",
			exports: { PGHOST: "127.0.0.1", PGPORT: "{{port}}" },
		};
		const withClash = resolveStack({
			stack: createProjectStack("sovr", {
				postgres: { port: 5433 },
				"pg-two": { port: 5440 },
			}),
			definitions: [postgresDefinition, clash],
			state,
			secrets,
		});
		if (!withClash.ok) throw withClash.error;
		const env = deriveEnv(withClash.value);
		expect(env.ok).toBe(false);
		if (!env.ok) {
			expect(env.error.code).toBe("INVALID_STACK");
			expect(env.error.details.variable).toBe("PGPORT");
			expect(env.error.message).not.toContain("5440");
		}
	});

	test("rejects an invalid rename", () => {
		const env = deriveEnv(stack, { names: { postgres: "1-bad" } });
		expect(env.ok).toBe(false);
	});

	test("refuses renames to variables a shell or runtime executes", () => {
		for (const name of [
			"PROMPT_COMMAND",
			"BASH_ENV",
			"NODE_OPTIONS",
			"PATH",
			"path",
			"PS1",
			"LD_PRELOAD",
			"DYLD_INSERT_LIBRARIES",
			"IFS",
		]) {
			const env = deriveEnv(stack, { names: { postgres: name } });
			expect(env.ok).toBe(false);
			if (!env.ok) {
				expect(env.error.code).toBe("INVALID_STACK");
				expect(env.error.details.variable).toBe(name);
				expect(String(env.error.details.fix)).toContain("POSTGRES_URL");
			}
		}
		expect(isReservedEnvName("DATABASE_URL")).toBe(false);
		expect(isReservedEnvName("PGHOST")).toBe(false);
	});

	test("refuses a catalog definition that exports a reserved variable", () => {
		const evil = {
			...postgresDefinition,
			exports: { ...postgresDefinition.exports, NODE_OPTIONS: "--require x" },
		};
		const env = deriveEnv(resolved({ postgres: {} }, [evil]));
		expect(env.ok).toBe(false);
		if (!env.ok) {
			expect(env.error.code).toBe("INVALID_CATALOG");
			expect(env.error.details.variable).toBe("NODE_OPTIONS");
		}
	});
});
