import { describe, expect, test } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { Stack, StackError, StackFile } from "../stack.model";

/** A stack with named instances (two postgres, one redis, an Upstash proxy). */
const shopExample = {
	version: 1,
	name: "shop",
	services: {
		"main-db": {
			type: "postgres",
			version: "17",
			port: 5433,
			persist: "volume",
			config: { POSTGRES_DB: "shop" },
		},
		events: { type: "postgres", persist: "ephemeral" },
		cache: { type: "redis", version: "7", port: 6380 },
		rest: { type: "upstash-redis", port: "auto", uses: { redis: "cache" } },
	},
	link: {
		file: ".env.local",
		names: { "main-db": "DATABASE_URL", cache: "REDIS_URL" },
	},
};

describe("StackFile schema", () => {
	test("compiles and accepts named instances", () => {
		const checker = TypeCompiler.Compile(StackFile);
		expect([...checker.Errors(shopExample)]).toEqual([]);
	});

	test("accepts port: auto and defaults services", () => {
		expect(
			Value.Check(StackFile, {
				version: 1,
				name: "x",
				services: { cache: { type: "redis", port: "auto" } },
			}),
		).toBe(true);
		expect(Value.Parse(StackFile, { version: 1, name: "x" }).services).toEqual(
			{},
		);
	});

	test("rejects wrong version, bad names, missing type, bad port or persist", () => {
		expect(Value.Check(StackFile, { ...shopExample, version: 2 })).toBe(false);
		expect(Value.Check(StackFile, { ...shopExample, name: "Has Space" })).toBe(
			false,
		);
		expect(Value.Check(StackFile, { ...shopExample, name: "1shop" })).toBe(
			false,
		);
		for (const services of [
			{ cache: { port: 6380 } },
			{ cache: { type: "redis", port: "5432" } },
			{ cache: { type: "redis", persist: "forever" } },
			{ Cache: { type: "redis" } },
			{ "-cache": { type: "redis" } },
		]) {
			expect(Value.Check(StackFile, { ...shopExample, services })).toBe(false);
		}
	});

	test("Stack wraps a stack file with its origin", () => {
		expect(
			Value.Check(Stack, {
				name: "shop",
				root: "/work/shop",
				filePath: "/work/shop/locastack.yaml",
				file: shopExample,
			}),
		).toBe(true);
		expect(
			Value.Check(Stack, { name: "x", filePath: "/x", file: shopExample }),
		).toBe(false);
	});
});

describe("StackError", () => {
	test("carries file path and issues", () => {
		const error = new StackError("bad", {
			filePath: "/x/locastack.yaml",
			issues: ["/name"],
		});
		expect(error.name).toBe("StackError");
		expect(error.filePath).toBe("/x/locastack.yaml");
		expect(error.issues).toEqual(["/name"]);
	});
});
