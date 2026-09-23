import { describe, expect, test } from "bun:test";
import {
	postgresDefinition,
	redisDefinition,
	upstashRedisDefinition,
} from "../../testing/catalog-fixtures";
import type { ServiceDefinition } from "../catalog.model";
import { checkDefinitionConsistency } from "../validator";

function issues(definition: ServiceDefinition) {
	return checkDefinitionConsistency(definition);
}

function withData(data: ServiceDefinition["data"]): ServiceDefinition {
	return { ...postgresDefinition, data };
}

describe("checkDefinitionConsistency: data, seed, secretOptions, import", () => {
	test("the built-in fixtures are consistent", () => {
		for (const definition of [
			postgresDefinition,
			redisDefinition,
			upstashRedisDefinition,
		]) {
			expect(issues(definition)).toEqual([]);
		}
	});

	test("kind none has no other field", () => {
		expect(
			issues(withData({ kind: "none", label: "Tables", objects: ["*"] })),
		).toEqual([
			{
				path: "/data/label",
				message: "must be omitted when data.kind is none",
			},
			{
				path: "/data/objects",
				message: "must be omitted when data.kind is none",
			},
		]);
	});

	test("sql/redis need label, runQuery, defaultQuery and exactly one object source", () => {
		expect(issues(withData({ kind: "sql" }))).toEqual([
			{ path: "/data/label", message: "is required when data.kind is sql" },
			{ path: "/data/runQuery", message: "is required when data.kind is sql" },
			{
				path: "/data/defaultQuery",
				message: "is required when data.kind is sql",
			},
			{ path: "/data", message: "set exactly one of listObjects and objects" },
		]);
		const both = withData({
			kind: "redis",
			label: "Keys",
			objects: ["*"],
			listObjects: ["redis-cli", "KEYS", "*"],
			runQuery: ["redis-cli", "{{query}}"],
			defaultQuery: "GET {{object}}",
		});
		expect(issues(both)).toEqual([
			{ path: "/data", message: "set exactly one of listObjects and objects" },
		]);
	});

	test("{{query}} is exactly one whole runQuery item and nowhere else", () => {
		const base = postgresDefinition.data;
		if (base === undefined) throw new Error("fixture");
		const twice = withData({
			...base,
			runQuery: ["psql", "{{query}}", "{{query}}"],
		});
		expect(issues(twice)).toContainEqual({
			path: "/data/runQuery",
			message:
				"must contain exactly one item that is exactly {{query}} (found 2)",
		});
		const embedded = withData({ ...base, runQuery: ["psql", "-c {{query}}"] });
		expect(issues(embedded).map((i) => i.path)).toEqual([
			"/data/runQuery",
			"/data/runQuery/1",
		]);
		const elsewhere = {
			...postgresDefinition,
			seed: { mountPath: "/x", fileName: "s.sql", run: ["psql", "{{query}}"] },
		};
		expect(issues(elsewhere)).toEqual([
			{
				path: "/seed/run/1",
				message: expect.stringContaining(
					'template "query" is not a known path',
				),
			},
		]);
		const inList = withData({ ...base, listObjects: ["psql", "{{object}}"] });
		expect(issues(inList).map((i) => i.path)).toEqual(["/data/listObjects/1"]);
	});

	test("data and seed argv templates are checked like other templates", () => {
		const base = postgresDefinition.data;
		if (base === undefined) throw new Error("fixture");
		const bad = withData({
			...base,
			runQuery: ["psql", "-U", "{{config.NOPE}}", "{{query}}"],
			defaultQuery: "SELECT * FROM {{object}} -- {{secrets.NOPE}}",
		});
		expect(issues(bad).map((i) => i.path)).toEqual([
			"/data/runQuery/2",
			"/data/defaultQuery",
		]);
		const seed = {
			...postgresDefinition,
			seed: {
				mountPath: "/x",
				fileName: "s.sql",
				run: ["psql", "{{stack.nope}}"],
			},
		};
		expect(issues(seed).map((i) => i.path)).toEqual(["/seed/run/1"]);
	});

	test("secretOptions keys are secrets; import.env targets exist", () => {
		const definition: ServiceDefinition = {
			...postgresDefinition,
			secretOptions: { POSTGRES_PASSWORD: { bakedIntoVolume: true }, NOPE: {} },
			import: {
				images: ["postgres"],
				env: {
					DB: "config.POSTGRES_DB",
					PASS: "secrets.POSTGRES_PASSWORD",
					X: "config.NOPE",
					Y: "secrets.NOPE",
				},
			},
		};
		expect(issues(definition)).toEqual([
			{
				path: "/secretOptions/NOPE",
				message: "must name an entry of `secrets`",
			},
			{
				path: "/import/env/X",
				message: '"config.NOPE" does not name a key of `config`',
			},
			{
				path: "/import/env/Y",
				message: '"secrets.NOPE" does not name an entry of `secrets`',
			},
		]);
	});
});
