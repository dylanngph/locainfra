import type { ProjectSummary, ServiceStatus } from "@locastack/server";
import { describe, expect, it } from "vitest";
import { MOCK_CATALOG } from "@/test/msw/catalog.fixture";
import { buildPaletteGroups } from "../palette-items";

const project = (name: string, serviceCount = 1): ProjectSummary => ({
	name,
	root: `/Users/dev/${name}`,
	serviceCount,
	running: 0,
	errors: 0,
	types: [],
});

const service = (name: string, type: string, hostPort: number) =>
	({ name, type, hostPort }) as ServiceStatus;

describe("buildPaletteGroups", () => {
	const projects = [project("shop"), project("blog", 2)];
	const input = {
		projects,
		definitions: MOCK_CATALOG,
		services: {
			shop: [service("main-db", "postgres", 5433)],
			blog: [service("db", "postgres", 5436), service("cache", "redis", 6380)],
		},
	};

	it("targets the current project and adds Actions", () => {
		const groups = buildPaletteGroups({ ...input, project: "blog" });
		expect(groups.map((g) => g.heading)).toEqual([
			"Add to blog",
			"Services",
			"Projects",
			"Actions",
		]);
		expect(groups[0]?.items[0]?.to).toMatch(/^\/p\/blog\/add\//);
		expect(groups[0]?.items.every((i) => i.cli === undefined)).toBe(true);
		expect(groups[1]?.items.map((i) => [i.label, i.sub, i.to])).toEqual([
			["main-db", "shop, port 5433", "/p/shop/s/main-db"],
			["db", "blog, port 5436", "/p/blog/s/db"],
			["cache", "blog, port 6380", "/p/blog/s/cache"],
		]);
		expect(groups[1]?.items.every((i) => i.cli === undefined)).toBe(true);
		expect(groups[2]?.items.map((i) => [i.sub, i.cli])).toEqual([
			["1 service", { command: "locastack up", cwd: "/Users/dev/shop" }],
			["2 services", { command: "locastack up", cwd: "/Users/dev/blog" }],
		]);
		expect(groups[3]?.items).toEqual([
			expect.objectContaining({
				label: "Export .env for blog",
				to: "/p/blog/env",
				cli: { command: "locastack env", cwd: "/Users/dev/blog" },
			}),
		]);
	});

	it("falls back to the first project outside a project, without Actions", () => {
		const groups = buildPaletteGroups({ ...input, project: undefined });
		expect(groups.map((g) => g.heading)).toEqual([
			"Add to shop",
			"Services",
			"Projects",
		]);
	});

	it("is empty without projects", () => {
		expect(
			buildPaletteGroups({
				project: undefined,
				projects: [],
				definitions: MOCK_CATALOG,
				services: {},
			}),
		).toEqual([]);
	});
});
