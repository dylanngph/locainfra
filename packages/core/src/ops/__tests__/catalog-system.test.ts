import { describe, expect, test } from "bun:test";
import {
	builtinTestDefinitions,
	postgresDefinition,
} from "../../testing/catalog-fixtures";
import {
	FakeComposeInfo,
	FakeDockerInfo,
	StaticCatalogSource,
} from "../../testing/fakes";
import { catalogList, categorySlug } from "../catalog-list.op";
import { getSystemInfo } from "../get-system-info.op";

describe("catalogList", () => {
	test("sorts definitions by name and counts categories by label", async () => {
		const storage = {
			...postgresDefinition,
			id: "minio",
			name: "MinIO",
			category: "storage" as const,
			categoryLabel: "Object storage",
		};
		const result = await catalogList({
			catalog: new StaticCatalogSource([...builtinTestDefinitions, storage]),
		});
		if (!result.ok) throw result.error;
		expect(result.value.definitions.map((d) => d.name)).toEqual([
			"MinIO",
			"PostgreSQL",
			"Redis",
			"Upstash Redis (REST)",
		]);
		expect(result.value.categories).toEqual([
			{
				id: "object-storage",
				label: "Object storage",
				category: "storage",
				count: 1,
			},
			{ id: "database", label: "Database", category: "database", count: 1 },
			{ id: "redis", label: "Redis", category: "cache", count: 2 },
		]);
	});

	test("a failing catalog is INVALID_CATALOG", async () => {
		const result = await catalogList({
			catalog: {
				definitions: async () => {
					throw new Error("bad yaml");
				},
			},
		});
		expect(!result.ok && result.error.code).toBe("INVALID_CATALOG");
		expect(!result.ok && result.error.details.reason).toBe("bad yaml");
	});

	test("categorySlug", () => {
		expect(categorySlug(" Object  Storage! ")).toBe("object-storage");
	});
});

describe("getSystemInfo", () => {
	test("reports docker and compose versions", async () => {
		expect(
			await getSystemInfo({
				docker: new FakeDockerInfo(),
				compose: new FakeComposeInfo("2.40.0"),
			}),
		).toEqual({
			docker: {
				version: "29.6.1",
				apiVersion: "1.55",
				platformName: "Docker Desktop 4.82.0",
			},
			compose: "2.40.0",
		});
	});

	test("never throws: unreachable daemon and failing compose become null", async () => {
		const docker = new FakeDockerInfo();
		docker.error = new Error("ECONNREFUSED");
		const compose = new FakeComposeInfo(null);
		compose.version = async () => {
			throw new Error("spawn failed");
		};
		expect(await getSystemInfo({ docker, compose })).toEqual({
			docker: null,
			compose: null,
		});
		const bare = new FakeDockerInfo();
		const { platformName: _omit, ...rest } = bare.value;
		bare.value = rest;
		const info = await getSystemInfo({
			docker: bare,
			compose: new FakeComposeInfo(null),
		});
		expect(info.docker).toEqual({ version: "29.6.1", apiVersion: "1.55" });
		expect(info.compose).toBeNull();
	});
});
