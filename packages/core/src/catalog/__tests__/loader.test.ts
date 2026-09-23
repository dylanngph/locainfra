import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BUILTIN_CATALOG_FILES } from "../builtin";
import { loadServiceDefinition, parseServiceDefinition } from "../loader";
import { checkCatalogReferences } from "../validator";
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

const MINIMAL = `id: demo
name: Demo
category: other
image: demo/app:{{version}}
versions: [1, "2"]
defaultVersion: 1
port: { container: 80, default: 8080, range: [8080, 8090] }
healthcheck: { test: ["CMD", "true"] }
`;

async function builtins() {
	return Promise.all(
		BUILTIN_CATALOG_FILES.map(async (name) => {
			const result = await loadServiceDefinition(
				diskFiles,
				join(CATALOG_DIR, name),
				{
					expectedId: name.replace(/\.yaml$/, ""),
				},
			);
			if (!result.ok) throw new Error(result.error.issues.join("\n"));
			return result.value;
		}),
	);
}

describe("built-in catalog", () => {
	test("all three built-ins load and validate", async () => {
		const definitions = await builtins();
		expect(definitions.map((definition) => definition.id)).toEqual([
			"postgres",
			"redis",
			"upstash-redis",
		]);
		expect(checkCatalogReferences(definitions)).toEqual([]);
	});

	test("postgres matches the plan's example", async () => {
		const [postgres] = await builtins();
		expect(postgres?.image).toBe("postgres:{{version}}-alpine");
		expect(postgres?.versions).toEqual(["17", "16", "15"]);
		expect(postgres?.port).toEqual({
			container: 5432,
			default: 5432,
			range: [5432, 5499],
		});
		expect(postgres?.config.POSTGRES_DB).toMatchObject({
			default: "{{stack.name}}",
		});
		expect(postgres?.exports.DATABASE_URL).toBe(
			"postgres://{{config.POSTGRES_USER}}:{{secrets.POSTGRES_PASSWORD}}@127.0.0.1:{{port}}/{{config.POSTGRES_DB}}",
		);
		expect(postgres?.studio).toEqual({ panel: "sql" });
	});

	test("no healthcheck or command passes a config value through a shell", async () => {
		for (const definition of await builtins()) {
			const [form, ...args] = definition.healthcheck.test;
			if (form === "CMD-SHELL") {
				for (const item of args) expect(item).not.toContain("{{config.");
			}
			for (const [key, value] of Object.entries(definition.config)) {
				const used = [
					...definition.healthcheck.test,
					...Object.values(definition.exports),
				].some((item) => item.includes(`{{config.${key}}}`));
				if (used)
					expect(value.pattern, `${definition.id}.${key}`).toBeDefined();
			}
		}
		const [postgres] = await builtins();
		expect(postgres?.healthcheck.test).toEqual([
			"CMD",
			"pg_isready",
			"-U",
			"{{config.POSTGRES_USER}}",
			"-d",
			"{{config.POSTGRES_DB}}",
		]);
	});

	test("redis runs with a password and append-only persistence", async () => {
		const [, redis] = await builtins();
		expect(redis?.command).toEqual([
			"redis-server",
			"--requirepass",
			"{{secrets.REDIS_PASSWORD}}",
			"--appendonly",
			"yes",
		]);
		expect(redis?.secrets).toEqual(["REDIS_PASSWORD"]);
		expect(redis?.port.default).toBe(6379);
		expect(redis?.config).toEqual({});
	});

	test("upstash-redis proxies the stack's redis", async () => {
		const [, , upstash] = await builtins();
		expect(upstash?.image).toBe("hiett/serverless-redis-http:{{version}}");
		expect(upstash?.versions).toEqual(["latest"]);
		expect(upstash?.port).toMatchObject({ container: 80, default: 8079 });
		expect(upstash?.dependsOn).toEqual(["redis"]);
		expect(upstash?.env).toEqual({
			SRH_MODE: "env",
			SRH_TOKEN: "{{secrets.SRH_TOKEN}}",
			SRH_CONNECTION_STRING:
				"redis://:{{services.redis.secrets.REDIS_PASSWORD}}@redis:6379",
		});
		expect(upstash?.exports).toEqual({
			UPSTASH_REDIS_REST_URL: "http://127.0.0.1:{{port}}",
			UPSTASH_REDIS_REST_TOKEN: "{{secrets.SRH_TOKEN}}",
		});
		expect(upstash?.volumes).toEqual([]);
	});
});

describe("parseServiceDefinition", () => {
	test("applies defaults and converts YAML numbers to strings", () => {
		const result = parseServiceDefinition(MINIMAL, "demo.yaml");
		if (!result.ok) throw result.error;
		expect(result.value.versions).toEqual(["1", "2"]);
		expect(result.value.defaultVersion).toBe("1");
		expect(result.value.env).toEqual({});
		expect(result.value.tags).toEqual([]);
	});

	test("strips unknown harmless keys after validation", () => {
		const result = parseServiceDefinition(
			`${MINIMAL}restart: always\n`,
			"demo.yaml",
		);
		if (!result.ok) throw result.error;
		expect("restart" in result.value).toBe(false);
	});

	test("reports invalid record keys instead of silently dropping them", () => {
		const result = parseServiceDefinition(
			`${MINIMAL}env: { bad-name: x }\n`,
			"demo.yaml",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.issues).toEqual([
			"demo.yaml:9:8: /env/bad-name: invalid key; keys must match ^[A-Za-z_][A-Za-z0-9_]*$",
		]);
	});

	test("messages carry file, line, column and JSON pointer", () => {
		const text = MINIMAL.replace("container: 80", "container: 70000").replace(
			"category: other",
			"category: nope",
		);
		const result = parseServiceDefinition(text, "catalog/demo.yaml");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.catalogId).toBe("demo");
		expect(result.error.source).toBe("catalog/demo.yaml");
		expect(result.error.issues).toContain(
			"catalog/demo.yaml:7:9: /port/container: expected integer to be less or equal to 65535",
		);
		expect(
			result.error.issues.some((line) =>
				line.startsWith("catalog/demo.yaml:3:1: /category: must be one of:"),
			),
		).toBe(true);
	});

	test("reports missing required properties at their parent", () => {
		const result = parseServiceDefinition(
			MINIMAL.replace(/^healthcheck.*$/m, ""),
			"d.yaml",
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.issues).toEqual([
				"d.yaml:1:1: /healthcheck: is required",
			]);
	});

	test("reports YAML syntax errors with position", () => {
		const result = parseServiceDefinition("id: [unclosed\n", "broken.yaml");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("broken.yaml: invalid YAML");
			expect(result.error.issues[0]).toMatch(/^broken\.yaml:\d+:\d+: /);
		}
	});

	test("rejects duplicate keys and empty documents", () => {
		expect(parseServiceDefinition("id: a\nid: b\n", "dup.yaml").ok).toBe(false);
		const empty = parseServiceDefinition("", "empty.yaml");
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error.issues[0]).toContain("document is empty");
	});

	test("runs consistency rules once the schema passes", () => {
		const result = parseServiceDefinition(
			MINIMAL.replace("defaultVersion: 1", "defaultVersion: 3"),
			"demo.yaml",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.issues).toEqual([
				"demo.yaml:6:1: /defaultVersion: must be one of `versions`",
			]);
		}
	});

	test("checks the id against the file name when asked", () => {
		const result = parseServiceDefinition(MINIMAL, "other.yaml", {
			expectedId: "other",
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.issues[0]).toContain('/id: must be "other"');
	});
});

describe("loadServiceDefinition", () => {
	test("reads through the FileStore", async () => {
		const files = new MemoryFiles({ "/c/demo.yaml": MINIMAL });
		const result = await loadServiceDefinition(files, "/c/demo.yaml");
		expect(result.ok).toBe(true);
	});

	test("missing file is a CatalogError", async () => {
		const result = await loadServiceDefinition(
			new MemoryFiles(),
			"/c/nope.yaml",
			{
				expectedId: "nope",
			},
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("/c/nope.yaml: not found");
			expect(result.error.catalogId).toBe("nope");
		}
	});

	test("read failures become a CatalogError with cause", async () => {
		const files = new MemoryFiles();
		const boom = new Error("EACCES");
		files.readText = async () => {
			throw boom;
		};
		const result = await loadServiceDefinition(files, "/c/x.yaml");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.cause).toBe(boom);
	});
});
