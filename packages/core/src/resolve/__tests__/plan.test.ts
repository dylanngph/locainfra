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
			"upstash-redis": {},
			postgres: {},
			redis: {},
		});
		const plan = planStack(stack, builtinTestDefinitions);
		if (!plan.ok) throw plan.error;
		expect(plan.value.map((s) => s.id)).toEqual([
			"postgres",
			"redis",
			"upstash-redis",
		]);
	});

	test("rejects unknown services", () => {
		const plan = planStack(
			createProjectStack("app", { nope: {} }),
			builtinTestDefinitions,
		);
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.error.code).toBe("INVALID_STACK");
	});

	test("rejects a dependency missing from the stack", () => {
		const plan = planStack(
			createProjectStack("app", { "upstash-redis": {} }),
			builtinTestDefinitions,
		);
		expect(plan.ok).toBe(false);
		if (!plan.ok) {
			expect(plan.error.code).toBe("INVALID_STACK");
			expect(plan.error.details.dependency).toBe("redis");
		}
	});

	test("reports a dependency cycle as INVALID_STACK", () => {
		const a = { ...postgresDefinition, id: "a", dependsOn: ["b"] };
		const b = { ...redisDefinition, id: "b", dependsOn: ["a"] };
		const plan = planStack(createProjectStack("app", { a: {}, b: {} }), [a, b]);
		expect(plan.ok).toBe(false);
		if (!plan.ok) {
			expect(plan.error.code).toBe("INVALID_STACK");
			expect(plan.error.message).toContain("cycle");
			expect(plan.error.details.services).toEqual(["a", "b"]);
		}
	});
});
