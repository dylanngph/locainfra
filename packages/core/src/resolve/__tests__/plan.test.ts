import { describe, expect, test } from "bun:test";
import {
	builtinTestDefinitions,
	createProjectStack,
	postgresDefinition,
	redisDefinition,
} from "../../testing/catalog-fixtures";
import { planStack } from "../plan";

describe("planStack", () => {
	test("orders dependencies first and keeps file order otherwise", () => {
		const stack = createProjectStack("app", {
			rest: { type: "upstash-redis" },
			db: { type: "postgres" },
			cache: { type: "redis" },
		});
		const plan = planStack(stack, builtinTestDefinitions);
		if (!plan.ok) throw plan.error;
		expect(plan.value.map((s) => s.name)).toEqual(["db", "cache", "rest"]);
		expect(plan.value[2]?.dependencies).toEqual({ redis: "cache" });
		expect(plan.value[2]?.definition.id).toBe("upstash-redis");
	});

	test("several instances of one type are planned independently", () => {
		const plan = planStack(
			createProjectStack("app", {
				"main-db": { type: "postgres" },
				events: { type: "postgres" },
			}),
			builtinTestDefinitions,
		);
		if (!plan.ok) throw plan.error;
		expect(plan.value.map((s) => [s.name, s.definition.id])).toEqual([
			["main-db", "postgres"],
			["events", "postgres"],
		]);
	});

	test("dependsOn binds to the first instance of the type, or to uses", () => {
		const services = {
			rest: { type: "upstash-redis" },
			sessions: { type: "redis" },
			cache: { type: "redis" },
		};
		const first = planStack(
			createProjectStack("app", services),
			builtinTestDefinitions,
		);
		if (!first.ok) throw first.error;
		const rest = first.value.find((s) => s.name === "rest");
		expect(rest?.dependencies).toEqual({ redis: "sessions" });
		expect(first.value.map((s) => s.name)).toEqual([
			"sessions",
			"rest",
			"cache",
		]);

		const chosen = planStack(
			createProjectStack("app", {
				...services,
				rest: { type: "upstash-redis", uses: { redis: "cache" } },
			}),
			builtinTestDefinitions,
		);
		if (!chosen.ok) throw chosen.error;
		expect(chosen.value.find((s) => s.name === "rest")?.dependencies).toEqual({
			redis: "cache",
		});
		expect(chosen.value.map((s) => s.name)).toEqual([
			"sessions",
			"cache",
			"rest",
		]);
	});

	test("uses must name an instance of the required type", () => {
		const plan = planStack(
			createProjectStack("app", {
				db: { type: "postgres" },
				cache: { type: "redis" },
				rest: { type: "upstash-redis", uses: { redis: "db" } },
			}),
			builtinTestDefinitions,
		);
		expect(plan.ok).toBe(false);
		if (!plan.ok) {
			expect(plan.error.code).toBe("INVALID_STACK");
			expect(plan.error.message).toContain('uses.redis names "db"');
			expect(String(plan.error.details.fix)).toContain("cache");
		}
	});

	test("rejects unknown types", () => {
		const plan = planStack(
			createProjectStack("app", { x: { type: "nope" } }),
			builtinTestDefinitions,
		);
		expect(plan.ok).toBe(false);
		if (!plan.ok) {
			expect(plan.error.code).toBe("INVALID_STACK");
			expect(plan.error.details.type).toBe("nope");
		}
	});

	test("rejects a dependency type missing from the stack", () => {
		const plan = planStack(
			createProjectStack("app", { rest: { type: "upstash-redis" } }),
			builtinTestDefinitions,
		);
		expect(plan.ok).toBe(false);
		if (!plan.ok) {
			expect(plan.error.code).toBe("INVALID_STACK");
			expect(plan.error.details.dependency).toBe("redis");
			expect(String(plan.error.details.fix)).toContain("Add a redis");
		}
	});

	test("reports a dependency cycle as INVALID_STACK", () => {
		const a = { ...postgresDefinition, id: "a", dependsOn: ["b"] };
		const b = { ...redisDefinition, id: "b", dependsOn: ["a"] };
		const plan = planStack(
			createProjectStack("app", { x: { type: "a" }, y: { type: "b" } }),
			[a, b],
		);
		expect(plan.ok).toBe(false);
		if (!plan.ok) {
			expect(plan.error.code).toBe("INVALID_STACK");
			expect(plan.error.message).toContain("cycle");
			expect(plan.error.details.services).toEqual(["x", "y"]);
		}
	});
});
