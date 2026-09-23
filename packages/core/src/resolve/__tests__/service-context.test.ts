import { describe, expect, test } from "bun:test";
import {
	builtinTestDefinitions,
	createProjectStack,
} from "../../testing/catalog-fixtures";
import { resolveStack } from "../resolver";
import { serviceTemplateContext } from "../service-context";

describe("serviceTemplateContext", () => {
	test("rebuilds the resolver's context with dependencies by type and instance", () => {
		const stack = createProjectStack("shop", {
			cache: { type: "redis" },
			rest: { type: "upstash-redis" },
		});
		const resolved = resolveStack({
			stack,
			definitions: builtinTestDefinitions,
			state: {
				projects: [],
				stacks: {
					shop: {
						ports: { cache: 6380, rest: 8080 },
						createdAt: "2026-01-01T00:00:00Z",
					},
				},
			},
			secrets: {
				CACHE__REDIS_PASSWORD: "redis-pw-0123456789",
				REST__SRH_TOKEN: "token-0123456789",
			},
		});
		if (!resolved.ok) throw resolved.error;
		const rest = resolved.value.services.find((s) => s.name === "rest");
		if (rest === undefined) throw new Error("fixture");
		const context = serviceTemplateContext(resolved.value, rest);
		const dependency = {
			host: "cache",
			port: 6380,
			secrets: { REDIS_PASSWORD: "redis-pw-0123456789" },
			config: {},
		};
		expect(context).toEqual({
			name: "rest",
			version: "latest",
			port: 8080,
			stack: { name: "shop" },
			config: {},
			secrets: { SRH_TOKEN: "token-0123456789" },
			services: { cache: dependency, redis: dependency },
			byType: { redis: dependency },
		});
		const orphan = serviceTemplateContext(
			{ ...resolved.value, services: [rest] },
			rest,
		);
		expect(orphan.services).toEqual({});
	});
});
