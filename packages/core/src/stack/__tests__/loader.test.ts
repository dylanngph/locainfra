import { describe, expect, test } from "bun:test";
import { MemoryFiles } from "../../catalog/__tests__/memory-files";
import { loadStack, parseStackFile } from "../loader";

const PLAN_EXAMPLE = `# yaml-language-server: $schema=https://locainfra.dev/schema/v1.json
version: 1
name: sovr
services:
  postgres: { version: "17", port: 5433, config: { POSTGRES_DB: sovr } }
  redis:    { version: "7", port: 6380 }
  upstash-redis: { port: 8080 }
link:
  file: .env.local
  names: { postgres: DATABASE_URL, redis: REDIS_URL }
`;

describe("parseStackFile", () => {
	test("parses the plan's example", () => {
		const result = parseStackFile(PLAN_EXAMPLE, "/p/locainfra.yaml");
		if (!result.ok) throw result.error;
		expect(result.value).toEqual({
			version: 1,
			name: "sovr",
			services: {
				postgres: {
					version: "17",
					port: 5433,
					config: { POSTGRES_DB: "sovr" },
				},
				redis: { version: "7", port: 6380 },
				"upstash-redis": { port: 8080 },
			},
			link: {
				file: ".env.local",
				names: { postgres: "DATABASE_URL", redis: "REDIS_URL" },
			},
		});
	});

	test("defaults and converts: missing or empty services, numeric versions, auto port", () => {
		expect(parseStackFile("version: 1\nname: x\n", "f").ok).toBe(true);
		const empty = parseStackFile("version: 1\nname: x\nservices:\n", "f");
		expect(empty.ok && empty.value.services).toEqual({});
		const converted = parseStackFile(
			"version: 1\nname: x\nservices:\n  redis: { version: 7, port: auto }\n",
			"f",
		);
		expect(converted.ok && converted.value.services.redis).toEqual({
			version: "7",
			port: "auto",
		});
	});

	test("reports every issue with file:line:col and pointer", () => {
		const result = parseStackFile(
			"version: 2\nname: Bad Name\nservices:\n  Pg: {}\n  redis: { port: 70000 }\n",
			"/p/locainfra.yaml",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.filePath).toBe("/p/locainfra.yaml");
		expect(result.error.issues).toEqual([
			"/p/locainfra.yaml:1:1: /version: must be 1",
			"/p/locainfra.yaml:2:1: /name: must match ^[a-z0-9][a-z0-9_-]*$",
			'/p/locainfra.yaml:5:12: /services/redis/port: must be one of: integer, "auto"',
			"/p/locainfra.yaml:4:3: /services/Pg: invalid key; keys must match ^[a-z0-9][a-z0-9-]*$",
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
		const files = new MemoryFiles({ "/p/locainfra.yaml": PLAN_EXAMPLE });
		const result = await loadStack(files, {
			filePath: "/p/locainfra.yaml",
			kind: "project",
			root: "/p",
		});
		if (!result.ok) throw result.error;
		expect(result.value).toMatchObject({
			kind: "project",
			name: "sovr",
			root: "/p",
			filePath: "/p/locainfra.yaml",
		});
	});

	test("missing → STACK_NOT_FOUND, unreadable → IO, invalid → INVALID_STACK", async () => {
		const files = new MemoryFiles({ "/p/bad.yaml": "version: 3\nname: x\n" });
		const missing = await loadStack(files, {
			filePath: "/p/nope.yaml",
			kind: "project",
		});
		expect(!missing.ok && missing.error.code).toBe("STACK_NOT_FOUND");
		const invalid = await loadStack(files, {
			filePath: "/p/bad.yaml",
			kind: "project",
		});
		expect(!invalid.ok && invalid.error.code).toBe("INVALID_STACK");
		expect(!invalid.ok && invalid.error.details.issues).toEqual([
			"/p/bad.yaml:1:1: /version: must be 1",
		]);
		files.readText = async () => {
			throw new Error("EACCES");
		};
		const io = await loadStack(files, {
			filePath: "/p/bad.yaml",
			kind: "project",
		});
		expect(!io.ok && io.error.code).toBe("IO");
	});

	test("the global stack must be named global, and projects may not be", async () => {
		const files = new MemoryFiles({
			"/s/global.yaml": "version: 1\nname: other\n",
			"/p/locainfra.yaml": "version: 1\nname: global\n",
		});
		const global = await loadStack(files, {
			filePath: "/s/global.yaml",
			kind: "global",
		});
		expect(!global.ok && global.error.code).toBe("INVALID_STACK");
		const project = await loadStack(files, {
			filePath: "/p/locainfra.yaml",
			kind: "project",
		});
		expect(!project.ok && project.error.message).toContain("reserved");
	});
});
