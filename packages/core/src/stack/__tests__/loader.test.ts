import { describe, expect, test } from "bun:test";
import { MemoryFiles } from "../../catalog/__tests__/memory-files";
import { loadStack, parseStackFile, stackErrorToOpError } from "../loader";
import { StackError } from "../stack.model";

const SHOP = `# yaml-language-server: $schema=https://locastack.dev/schema/v1.json
version: 1
name: shop
services:
  main-db: { type: postgres, version: "17", port: 5433, config: { POSTGRES_DB: shop } }
  events:  { type: postgres, persist: ephemeral }
  cache:   { type: redis, version: 7, port: 6380 }
  rest:    { type: upstash-redis, uses: { redis: cache } }
link:
  file: .env.local
  names: { main-db: DATABASE_URL, cache: REDIS_URL }
`;

describe("parseStackFile", () => {
	test("parses named instances", () => {
		const result = parseStackFile(SHOP, "/p/locastack.yaml");
		if (!result.ok) throw result.error;
		expect(result.value).toEqual({
			version: 1,
			name: "shop",
			services: {
				"main-db": {
					type: "postgres",
					version: "17",
					port: 5433,
					config: { POSTGRES_DB: "shop" },
				},
				events: { type: "postgres", persist: "ephemeral" },
				cache: { type: "redis", version: "7", port: 6380 },
				rest: { type: "upstash-redis", uses: { redis: "cache" } },
			},
			link: {
				file: ".env.local",
				names: { "main-db": "DATABASE_URL", cache: "REDIS_URL" },
			},
		});
	});

	test("defaults and converts: missing or empty services, numeric versions, auto port", () => {
		expect(parseStackFile("version: 1\nname: x\n", "f").ok).toBe(true);
		const empty = parseStackFile("version: 1\nname: x\nservices:\n", "f");
		expect(empty.ok && empty.value.services).toEqual({});
		const converted = parseStackFile(
			"version: 1\nname: x\nservices:\n  cache: { type: redis, version: 7, port: auto }\n",
			"f",
		);
		expect(converted.ok && converted.value.services.cache).toEqual({
			type: "redis",
			version: "7",
			port: "auto",
		});
	});

	test("reports every issue with file:line:col and pointer", () => {
		const result = parseStackFile(
			"version: 2\nname: Bad Name\nservices:\n  Pg: { type: postgres }\n  cache: { type: redis, port: 70000 }\n  nope: { port: 1 }\n",
			"/p/locastack.yaml",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.filePath).toBe("/p/locastack.yaml");
		expect(result.error.issues).toEqual([
			"/p/locastack.yaml:1:1: /version: must be 1",
			"/p/locastack.yaml:2:1: /name: must match ^[a-z][a-z0-9-]*$",
			'/p/locastack.yaml:5:25: /services/cache/port: must be one of: integer, "auto"',
			"/p/locastack.yaml:6:3: /services/nope/type: is required",
			"/p/locastack.yaml:4:3: /services/Pg: invalid key; keys must match ^[a-z][a-z0-9-]*$",
		]);
	});

	test("reports YAML syntax errors", () => {
		const result = parseStackFile("version: 1\nname: [x\n", "f.yaml");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toBe("f.yaml: invalid YAML");
	});
});

describe("loadStack", () => {
	test("wraps a project stack with its root", async () => {
		const files = new MemoryFiles({ "/p/locastack.yaml": SHOP });
		const result = await loadStack(files, {
			filePath: "/p/locastack.yaml",
			root: "/p",
		});
		if (!result.ok) throw result.error;
		expect(result.value).toMatchObject({
			name: "shop",
			root: "/p",
			filePath: "/p/locastack.yaml",
		});
		const defaulted = await loadStack(files, { filePath: "/p/locastack.yaml" });
		expect(defaulted.ok && defaulted.value.root).toBe("/p");
	});

	test("missing → STACK_NOT_FOUND, unreadable → IO, invalid → INVALID_STACK", async () => {
		const files = new MemoryFiles({ "/p/bad.yaml": "version: 3\nname: x\n" });
		const missing = await loadStack(files, { filePath: "/p/nope.yaml" });
		expect(!missing.ok && missing.error.code).toBe("STACK_NOT_FOUND");
		const invalid = await loadStack(files, { filePath: "/p/bad.yaml" });
		expect(!invalid.ok && invalid.error.code).toBe("INVALID_STACK");
		expect(!invalid.ok && invalid.error.details.issues).toEqual([
			"/p/bad.yaml:1:1: /version: must be 1",
		]);
		files.readText = async () => {
			throw new Error("EACCES");
		};
		const io = await loadStack(files, { filePath: "/p/bad.yaml" });
		expect(!io.ok && io.error.code).toBe("IO");
	});

	test("stackErrorToOpError keeps path and issues", () => {
		const error = stackErrorToOpError(
			new StackError("bad", { filePath: "/f", issues: ["x"] }),
		);
		expect(error.code).toBe("INVALID_STACK");
		expect(error.details).toEqual({ filePath: "/f", issues: ["x"] });
	});
});
