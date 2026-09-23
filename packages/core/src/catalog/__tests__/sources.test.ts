import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BuiltinCatalogSource } from "../builtin";
import type { CatalogError, ServiceDefinition } from "../catalog.model";
import type { CatalogSource } from "../catalog.source";
import {
	CompositeCatalogSource,
	createCatalogSource,
	mergeDefinitions,
} from "../composite.source";
import { DirectoryCatalogSource } from "../directory.source";
import { diskFiles, MemoryFiles } from "./memory-files";

const CATALOG_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"..",
	"catalog",
);

function definition(id: string, name = id): string {
	return `id: ${id}
name: ${name}
category: other
image: demo/${id}:{{version}}
versions: ["1"]
defaultVersion: "1"
port: { container: 80, default: 8080, range: [8080, 8090] }
healthcheck: { test: ["CMD", "true"] }
exports: { DEMO_URL: "http://127.0.0.1:{{port}}" }
primaryExport: DEMO_URL
`;
}

function fixed(
	defs: Array<Pick<ServiceDefinition, "id" | "name">>,
): CatalogSource {
	return { definitions: async () => defs as ServiceDefinition[] };
}

describe("BuiltinCatalogSource", () => {
	test("loads the repo catalog through a FileStore", async () => {
		const source = new BuiltinCatalogSource(diskFiles, CATALOG_DIR);
		const ids = (await source.definitions()).map((d) => d.id);
		expect(ids).toEqual(["postgres", "redis", "upstash-redis"]);
	});

	test("caches, and returns a fresh array each call", async () => {
		const files = new MemoryFiles({ "/cat/a.yaml": definition("a") });
		let reads = 0;
		const read = files.readText.bind(files);
		files.readText = async (path) => {
			reads++;
			return read(path);
		};
		const source = new BuiltinCatalogSource(files, "/cat", ["a.yaml"]);
		const first = await source.definitions();
		first.pop();
		expect((await source.definitions()).length).toBe(1);
		expect(reads).toBe(1);
	});

	test("a missing or invalid built-in rejects with CatalogError", async () => {
		const source = new BuiltinCatalogSource(new MemoryFiles(), "/cat", [
			"a.yaml",
		]);
		await expect(source.definitions()).rejects.toMatchObject({
			name: "CatalogError",
		});
		const wrongId = new BuiltinCatalogSource(
			new MemoryFiles({ "/cat/a.yaml": definition("b") }),
			"/cat",
			["a.yaml"],
		);
		await expect(wrongId.definitions()).rejects.toMatchObject({
			name: "CatalogError",
			catalogId: "b",
		});
	});
});

describe("DirectoryCatalogSource", () => {
	test("loads *.yaml / *.yml in name order, ignoring other files", async () => {
		const files = new MemoryFiles({
			"/o/b.yml": definition("b"),
			"/o/a.yaml": definition("a"),
			"/o/readme.md": "# hi",
			"/o/.hidden.yaml": "x: [",
			"/o/nested/c.yaml": definition("c"),
		});
		const source = new DirectoryCatalogSource({
			files,
			lister: files,
			dir: "/o",
		});
		expect((await source.definitions()).map((d) => d.id)).toEqual(["a", "b"]);
	});

	test("missing directory yields nothing", async () => {
		const files = new MemoryFiles();
		const source = new DirectoryCatalogSource({
			files,
			lister: files,
			dir: "/none",
		});
		expect(await source.definitions()).toEqual([]);
	});

	test("invalid files throw by default, or are reported and skipped", async () => {
		const files = new MemoryFiles({
			"/o/a.yaml": definition("a"),
			"/o/bad.yaml": `${definition("bad")}privileged: true\n`,
		});
		await expect(
			new DirectoryCatalogSource({
				files,
				lister: files,
				dir: "/o",
			}).definitions(),
		).rejects.toMatchObject({
			catalogId: "bad",
		});
		const reported: CatalogError[] = [];
		const lenient = new DirectoryCatalogSource({
			files,
			lister: files,
			dir: "/o",
			onInvalid: (error) => reported.push(error),
		});
		expect((await lenient.definitions()).map((d) => d.id)).toEqual(["a"]);
		expect(reported.map((error) => error.source)).toEqual(["/o/bad.yaml"]);
	});

	test("applies the registry allow-list", async () => {
		const files = new MemoryFiles({ "/o/a.yaml": definition("a") });
		const source = new DirectoryCatalogSource({
			files,
			lister: files,
			dir: "/o",
			allowedRegistries: ["ghcr.io"],
		});
		await expect(source.definitions()).rejects.toMatchObject({
			name: "CatalogError",
		});
	});
});

describe("merging", () => {
	test("mergeDefinitions: later wins by id, first-seen order kept", () => {
		const merged = mergeDefinitions([
			[
				{ id: "a", name: "A1" },
				{ id: "b", name: "B1" },
			] as ServiceDefinition[],
			[
				{ id: "b", name: "B2" },
				{ id: "c", name: "C2" },
			] as ServiceDefinition[],
		]);
		expect(merged.map((d) => [d.id, d.name])).toEqual([
			["a", "A1"],
			["b", "B2"],
			["c", "C2"],
		]);
	});

	test("CompositeCatalogSource stacks sources", async () => {
		const composite = new CompositeCatalogSource([
			fixed([{ id: "a", name: "A1" }]),
			fixed([{ id: "a", name: "A2" }]),
		]);
		expect((await composite.definitions()).map((d) => d.name)).toEqual(["A2"]);
	});

	test("createCatalogSource: built-ins overridden by the overrides dir", async () => {
		const files = new MemoryFiles({
			"/cat/postgres.yaml": definition("postgres", "Builtin PG"),
			"/cat/redis.yaml": definition("redis"),
			"/cat/upstash-redis.yaml": definition("upstash-redis"),
			"/home/.locainfra/catalog/postgres.yaml": definition("postgres", "My PG"),
			"/home/.locainfra/catalog/extra.yaml": definition("extra"),
		});
		const source = createCatalogSource({
			files,
			lister: files,
			catalogDir: "/cat",
			overrideDirs: ["/home/.locainfra/registry", "/home/.locainfra/catalog"],
		});
		const defs = await source.definitions();
		expect(defs.map((d) => [d.id, d.name])).toEqual([
			["postgres", "My PG"],
			["redis", "redis"],
			["upstash-redis", "upstash-redis"],
			["extra", "extra"],
		]);
	});

	test("createCatalogSource without a lister uses built-ins only", async () => {
		const source = createCatalogSource({
			files: diskFiles,
			catalogDir: CATALOG_DIR,
			overrideDirs: ["/x"],
		});
		expect((await source.definitions()).length).toBe(3);
	});
});
