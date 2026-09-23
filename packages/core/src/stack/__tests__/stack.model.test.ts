import { describe, expect, test } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { Stack, StackError, StackFile } from "../stack.model";

/** The stack file example from plan §1. */
const sovrExample = {
	version: 1,
	name: "sovr",
	services: {
		postgres: { version: "17", port: 5433, config: { POSTGRES_DB: "sovr" } },
		redis: { version: "7", port: 6380 },
		"upstash-redis": { port: 8080 },
	},
	link: {
		file: ".env.local",
		names: { postgres: "DATABASE_URL", redis: "REDIS_URL" },
	},
};

describe("StackFile schema", () => {
	test("compiles and accepts the plan's example", () => {
		const checker = TypeCompiler.Compile(StackFile);
		expect([...checker.Errors(sovrExample)]).toEqual([]);
	});

	test("accepts port: auto and defaults services", () => {
		expect(
			Value.Check(StackFile, {
				version: 1,
				name: "x",
				services: { redis: { port: "auto" } },
			}),
		).toBe(true);
		expect(Value.Parse(StackFile, { version: 1, name: "x" }).services).toEqual(
			{},
		);
	});

	test("rejects wrong version, bad name and bad port", () => {
		expect(Value.Check(StackFile, { ...sovrExample, version: 2 })).toBe(false);
		expect(Value.Check(StackFile, { ...sovrExample, name: "Has Space" })).toBe(
			false,
		);
		expect(
			Value.Check(StackFile, {
				...sovrExample,
				services: { redis: { port: "5432" } },
			}),
		).toBe(false);
	});

	test("Stack wraps a stack file with its origin", () => {
		expect(
			Value.Check(Stack, {
				kind: "project",
				name: "sovr",
				root: "/work/sovr",
				filePath: "/work/sovr/locainfra.yaml",
				file: sovrExample,
			}),
		).toBe(true);
		expect(
			Value.Check(Stack, {
				kind: "other",
				name: "x",
				filePath: "/x",
				file: sovrExample,
			}),
		).toBe(false);
	});
});

describe("StackError", () => {
	test("carries file path and issues", () => {
		const error = new StackError("bad", {
			filePath: "/x/locainfra.yaml",
			issues: ["/name"],
		});
		expect(error.name).toBe("StackError");
		expect(error.filePath).toBe("/x/locainfra.yaml");
		expect(error.issues).toEqual(["/name"]);
	});
});
