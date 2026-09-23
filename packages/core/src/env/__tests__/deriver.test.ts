import { describe, expect, test } from "bun:test";
import type { StateFile } from "../../ports/state.port";
import type { ResolvedStack } from "../../resolve/resolved.model";
import { resolveStack } from "../../resolve/resolver";
import type { StackFile, StackLink } from "../../stack/stack.model";
import {
	builtinTestDefinitions,
	createProjectStack,
	postgresDefinition,
} from "../../testing/catalog-fixtures";
import {
	deriveEnv,
	deriveEnvLines,
	envKeyPrefix,
	isReservedEnvName,
	maskSecrets,
	primaryExportName,
} from "../deriver";

const secrets = {
	POSTGRES__POSTGRES_PASSWORD: "pg-pass",
	REDIS__REDIS_PASSWORD: "redis-pass",
	UPSTASH_REDIS__SRH_TOKEN: "srh-token",
	MAIN_DB__POSTGRES_PASSWORD: "main-pass",
	EVENTS__POSTGRES_PASSWORD: "events-pass",
	AUDIT__POSTGRES_PASSWORD: "audit-pass",
	LD__POSTGRES_PASSWORD: "ld-pass",
};
const state: StateFile = {
	projects: [],
	stacks: {
		shop: {
			ports: {
				postgres: 5433,
				redis: 6380,
				"upstash-redis": 8080,
				"main-db": 5434,
				events: 5435,
				audit: 5436,
				ld: 5437,
			},
			createdAt: "2026-01-01T00:00:00Z",
		},
	},
};

function resolved(
	services: StackFile["services"],
	definitions = builtinTestDefinitions,
): ResolvedStack {
	const result = resolveStack({
		stack: createProjectStack("shop", services),
		definitions,
		state,
		secrets,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

describe("deriveEnv", () => {
	const stack = resolved({
		postgres: { type: "postgres" },
		redis: { type: "redis" },
		"upstash-redis": { type: "upstash-redis" },
	});

	test("merges exports of every service in stack order", () => {
		const env = deriveEnv(stack);
		expect(env).toEqual({
			ok: true,
			value: {
				DATABASE_URL: "postgres://postgres:pg-pass@127.0.0.1:5433/shop",
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
			"postgres://postgres:pg-pass@127.0.0.1:5433/shop",
		);
		expect(env.value.CACHE_URL).toBe("redis://:redis-pass@127.0.0.1:6380");
		expect(env.value.DATABASE_URL).toBeUndefined();
		expect(env.value.REDIS_URL).toBeUndefined();
		expect(env.value.PGPORT).toBe("5433");
	});

	test("primaryExportName is the definition's primaryExport", () => {
		expect(stack.services.map(primaryExportName)).toEqual([
			"DATABASE_URL",
			"REDIS_URL",
			"UPSTASH_REDIS_REST_URL",
		]);
		const [pg] = resolved({ postgres: { type: "postgres" } }, [
			{ ...postgresDefinition, primaryExport: "GONE" },
		]).services;
		expect(pg && primaryExportName(pg)).toBeUndefined();
	});

	test("rejects an invalid rename", () => {
		const env = deriveEnv(stack, { names: { postgres: "1-bad" } });
		expect(env.ok).toBe(false);
		if (!env.ok) expect(env.error.details.variable).toBe("1-bad");
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
		const env = deriveEnv(resolved({ postgres: { type: "postgres" } }, [evil]));
		expect(env.ok).toBe(false);
		if (!env.ok) {
			expect(env.error.code).toBe("INVALID_CATALOG");
			expect(env.error.details.variable).toBe("NODE_OPTIONS");
		}
	});
});

describe("deriveEnvLines collision prefixing", () => {
	const twoDbs = resolved({
		"main-db": { type: "postgres" },
		events: { type: "postgres" },
		redis: { type: "redis" },
	});

	test("prefixes every key of a service only when one of its keys collides", () => {
		const lines = deriveEnvLines(twoDbs);
		if (!lines.ok) throw lines.error;
		expect(lines.value.map((l) => [l.key, l.service, l.type])).toEqual([
			["DATABASE_URL", "main-db", "postgres"],
			["PGHOST", "main-db", "postgres"],
			["PGPORT", "main-db", "postgres"],
			["EVENTS_DATABASE_URL", "events", "postgres"],
			["EVENTS_PGHOST", "events", "postgres"],
			["EVENTS_PGPORT", "events", "postgres"],
			["REDIS_URL", "redis", "redis"],
		]);
		expect(lines.value[3]).toMatchObject({
			sourceKey: "DATABASE_URL",
			primary: true,
			value: "postgres://postgres:events-pass@127.0.0.1:5435/shop",
		});
		expect(lines.value[4]?.primary).toBe(false);
	});

	test("'earlier' follows the given stack file order", () => {
		const lines = deriveEnvLines(twoDbs, undefined, [
			"redis",
			"events",
			"main-db",
		]);
		if (!lines.ok) throw lines.error;
		expect(lines.value.map((l) => l.key)).toEqual([
			"REDIS_URL",
			"DATABASE_URL",
			"PGHOST",
			"PGPORT",
			"MAIN_DB_DATABASE_URL",
			"MAIN_DB_PGHOST",
			"MAIN_DB_PGPORT",
		]);
	});

	test("a link.names rename is never prefixed and avoids the collision", () => {
		const lines = deriveEnvLines(twoDbs, {
			names: { events: "EVENTS_URL" },
		});
		if (!lines.ok) throw lines.error;
		// PGHOST/PGPORT still collide, so the other keys are prefixed.
		expect(
			lines.value.filter((l) => l.service === "events").map((l) => l.key),
		).toEqual(["EVENTS_URL", "EVENTS_PGHOST", "EVENTS_PGPORT"]);
	});

	test("a prefixed key that still collides is INVALID_STACK", () => {
		const stack = resolved({
			"main-db": { type: "postgres" },
			events: { type: "postgres" },
			audit: { type: "postgres" },
		});
		const clash = deriveEnvLines(stack, {
			names: { audit: "EVENTS_DATABASE_URL" },
		});
		expect(clash.ok).toBe(false);
		if (!clash.ok) {
			expect(clash.error.code).toBe("INVALID_STACK");
			expect(clash.error.details.variable).toBe("EVENTS_DATABASE_URL");
			expect(clash.error.details.services).toEqual(["events", "audit"]);
			expect(clash.error.message).not.toContain("audit-pass");
		}
	});

	test("a prefix that makes a reserved name is INVALID_STACK", () => {
		const stack = resolved({
			postgres: { type: "postgres" },
			ld: { type: "postgres" },
		});
		const lines = deriveEnvLines(stack);
		expect(lines.ok).toBe(false);
		if (!lines.ok) {
			expect(lines.error.code).toBe("INVALID_STACK");
			expect(lines.error.details.variable).toBe("LD_DATABASE_URL");
		}
	});

	test("envKeyPrefix upper-cases and replaces non-alphanumerics", () => {
		expect(envKeyPrefix("main-db")).toBe("MAIN_DB_");
		expect(envKeyPrefix("cache2")).toBe("CACHE2_");
	});
});

describe("maskSecrets", () => {
	test("replaces every secret, longest first, ignoring empty values", () => {
		expect(
			maskSecrets("a:pass-long@h/pass", ["pass", "pass-long", ""], "***"),
		).toBe("a:***@h/***");
		expect(maskSecrets("plain", [], "***")).toBe("plain");
	});
});
