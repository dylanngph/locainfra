import { describe, expect, test } from "bun:test";
import type { TemplateContext } from "../../template/template.model";
import {
	buildQueryArgv,
	renderArgv,
	renderDefaultQuery,
	splitRedisWords,
} from "../query-argv";

const context: TemplateContext = {
	name: "main-db",
	version: "17",
	port: 5433,
	stack: { name: "shop" },
	config: { POSTGRES_USER: "postgres", POSTGRES_DB: "shop" },
	secrets: { POSTGRES_PASSWORD: "pw-0123456789abcdef" },
	services: {},
	byType: {},
};

const PSQL = [
	"psql",
	"-U",
	"{{config.POSTGRES_USER}}",
	"--csv",
	"-c",
	"{{query}}",
];

describe("splitRedisWords", () => {
	test("splits like redis-cli: whitespace, double and single quotes, escapes", () => {
		expect(splitRedisWords('SET  "my key" \'it\\\'s\'  "a\\x41\\n"')).toEqual({
			ok: true,
			value: ["SET", "my key", "it's", "aA\n"],
		});
		expect(splitRedisWords("  ")).toEqual({ ok: true, value: [] });
		expect(splitRedisWords('GET a"b c"')).toEqual({
			ok: true,
			value: ["GET", "ab c"],
		});
		expect(splitRedisWords('GET "\\q"')).toEqual({
			ok: true,
			value: ["GET", "q"],
		});
	});

	test("rejects unbalanced quotes and text glued to a closing quote", () => {
		for (const line of [
			'GET "abc',
			"GET 'abc",
			'GET "a"b',
			"GET 'a'b",
			'GET "a\\',
		]) {
			const result = splitRedisWords(line);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
		}
	});
});

describe("buildQueryArgv", () => {
	test("sql: the query is ONE verbatim argv item; templates never touch it", () => {
		const query =
			"SELECT '{{secrets.POSTGRES_PASSWORD}}'; $(rm -rf /) `x` \"y\"";
		expect(buildQueryArgv(PSQL, "sql", query, context)).toEqual({
			ok: true,
			value: ["psql", "-U", "postgres", "--csv", "-c", query],
		});
	});

	test("redis: the query becomes its words", () => {
		expect(
			buildQueryArgv(
				["redis-cli", "--csv", "{{query}}"],
				"redis",
				'SET k "a b"',
				context,
			),
		).toEqual({ ok: true, value: ["redis-cli", "--csv", "SET", "k", "a b"] });
	});

	test("redis: refuses option-looking commands, blank lines and bad quotes", () => {
		for (const query of [
			"-h evil.example 6379 PING",
			"--rdb /tmp/x",
			"   ",
			"GET 'x",
		]) {
			const result = buildQueryArgv(
				["redis-cli", "{{query}}"],
				"redis",
				query,
				context,
			);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
		}
	});

	test("INVALID_CATALOG without exactly one {{query}} item or with a bad template", () => {
		for (const template of [
			["psql", "-c"],
			["psql", "{{query}}", "{{query}}"],
			["psql", "-c {{query}}"],
			["psql", "-U", "{{config.NOPE}}", "{{query}}"],
			["psql", "{{query}}", "{{secrets.NOPE}}"],
		]) {
			const result = buildQueryArgv(template, "sql", "SELECT 1", context);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("INVALID_CATALOG");
				expect(result.error.message).not.toContain("pw-0123456789abcdef");
			}
		}
	});
});

describe("renderArgv and renderDefaultQuery", () => {
	test("renders argv templates", () => {
		expect(
			renderArgv(["psql", "-d", "{{config.POSTGRES_DB}}"], context),
		).toEqual({
			ok: true,
			value: ["psql", "-d", "shop"],
		});
	});

	test("fills {{object}} literally and renders other paths", () => {
		expect(
			renderDefaultQuery(
				'SELECT * FROM "{{object}}" -- {{stack.name}}',
				"{{x}}",
				context,
			),
		).toEqual({ ok: true, value: 'SELECT * FROM "{{x}}" -- shop' });
		const bad = renderDefaultQuery("{{nope}} {{object}}", "t", context);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error.code).toBe("INVALID_CATALOG");
	});
});
