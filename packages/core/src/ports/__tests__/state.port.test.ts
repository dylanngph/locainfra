import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { ComposeServiceStatus } from "../compose.port";
import { ContainerSummary } from "../docker.port";
import { createEmptyState, StateFile } from "../state.port";

describe("port data schemas", () => {
	test("empty state is valid and a bare object parses to it", () => {
		expect(Value.Check(StateFile, createEmptyState())).toBe(true);
		expect(Value.Parse(StateFile, {})).toEqual(createEmptyState());
	});

	test("state with a pinned stack validates", () => {
		expect(
			Value.Check(StateFile, {
				projects: [{ name: "shop", root: "/work/shop", envFile: ".env.local" }],
				stacks: {
					shop: {
						ports: { postgres: 5433 },
						createdAt: "2026-09-23T00:00:00Z",
					},
				},
				registry: { etag: "W/1", updatedAt: "2026-09-23T00:00:00Z" },
			}),
		).toBe(true);
	});

	test("container and compose rows validate", () => {
		expect(
			Value.Check(ContainerSummary, {
				id: "abc",
				name: "ls-shop-postgres-1",
				image: "postgres:17-alpine",
				state: "running",
				health: "healthy",
				labels: { "locastack.stack": "shop" },
				ports: [{ host: 5433, container: 5432 }],
			}),
		).toBe(true);
		expect(
			Value.Check(ComposeServiceStatus, {
				service: "postgres",
				name: "ls-shop-postgres-1",
				state: "running",
				image: "postgres:17-alpine",
				publishers: [{ publishedPort: 5433, targetPort: 5432 }],
			}),
		).toBe(true);
	});
});
