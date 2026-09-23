import { describe, expect, test } from "bun:test";
import { createTestPaths, InMemoryFileStore } from "../../testing/fakes";
import { discoverStack } from "../discover-stack.op";

const projectYaml = `version: 1
name: sovr
services:
  postgres: { version: "17", port: 5433 }
`;

describe("discoverStack", () => {
	test("walks up from cwd to the nearest locainfra.yaml", async () => {
		const files = new InMemoryFileStore({
			"/work/sovr/locainfra.yaml": projectYaml,
		});
		const result = await discoverStack(
			{ files, paths: createTestPaths() },
			{ cwd: "/work/sovr/apps/web/src" },
		);
		if (!result.ok) throw result.error;
		expect(result.value).toMatchObject({
			kind: "project",
			name: "sovr",
			root: "/work/sovr",
			filePath: "/work/sovr/locainfra.yaml",
		});
		expect(result.value.file.services.postgres?.port).toBe(5433);
	});

	test("no stack file anywhere is STACK_NOT_FOUND", async () => {
		const result = await discoverStack(
			{ files: new InMemoryFileStore(), paths: createTestPaths() },
			{ cwd: "/work/empty" },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("STACK_NOT_FOUND");
			expect(result.error.details.fix).toBeDefined();
		}
	});

	test("an invalid stack file is INVALID_STACK", async () => {
		const files = new InMemoryFileStore({
			"/work/bad/locainfra.yaml": "version: 2\nname: Bad Name\n",
		});
		const result = await discoverStack(
			{ files, paths: createTestPaths() },
			{ cwd: "/work/bad" },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_STACK");
	});

	test("--global loads ~/.locainfra/global.yaml", async () => {
		const files = new InMemoryFileStore({
			"/home/test/.locainfra/global.yaml":
				"version: 1\nname: global\nservices:\n  redis: {}\n",
		});
		const result = await discoverStack(
			{ files, paths: createTestPaths() },
			{ cwd: "/anywhere", global: true },
		);
		if (!result.ok) throw result.error;
		expect(result.value.kind).toBe("global");
		expect(result.value.name).toBe("global");
		expect(result.value.root).toBeUndefined();
	});

	test("missing global stack is STACK_NOT_FOUND with a fix", async () => {
		const result = await discoverStack(
			{ files: new InMemoryFileStore(), paths: createTestPaths() },
			{ cwd: "/", global: true },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("STACK_NOT_FOUND");
			expect(String(result.error.details.fix)).toContain("dashboard");
		}
	});

	test("--global wins even inside a project", async () => {
		const files = new InMemoryFileStore({
			"/work/sovr/locainfra.yaml": projectYaml,
			"/home/test/.locainfra/global.yaml":
				"version: 1\nname: global\nservices:\n  redis: {}\n",
		});
		const result = await discoverStack(
			{ files, paths: createTestPaths() },
			{ cwd: "/work/sovr", global: true },
		);
		expect(result.ok && result.value.kind).toBe("global");
	});

	test("filesystem failures during the walk become IO", async () => {
		const files = new InMemoryFileStore();
		files.exists = async () => {
			throw new Error("EACCES");
		};
		const result = await discoverStack(
			{ files, paths: createTestPaths() },
			{ cwd: "/work" },
		);
		expect(!result.ok && result.error.code).toBe("IO");
	});
});
