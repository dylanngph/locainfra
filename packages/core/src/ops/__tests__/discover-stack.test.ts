import { describe, expect, test } from "bun:test";
import { InMemoryFileStore } from "../../testing/fakes";
import { discoverStack } from "../discover-stack.op";

const projectYaml = `version: 1
name: shop
services:
  db: { type: postgres, version: "17", port: 5433 }
`;

describe("discoverStack", () => {
	test("walks up from cwd to the nearest locastack.yaml", async () => {
		const files = new InMemoryFileStore({
			"/work/shop/locastack.yaml": projectYaml,
		});
		const result = await discoverStack(
			{ files },
			{ cwd: "/work/shop/apps/web/src" },
		);
		if (!result.ok) throw result.error;
		expect(result.value).toMatchObject({
			name: "shop",
			root: "/work/shop",
			filePath: "/work/shop/locastack.yaml",
		});
		expect(result.value.file.services.db?.port).toBe(5433);
	});

	test("no stack file anywhere is STACK_NOT_FOUND", async () => {
		const result = await discoverStack(
			{ files: new InMemoryFileStore() },
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
			"/work/bad/locastack.yaml": "version: 2\nname: Bad Name\n",
		});
		const result = await discoverStack({ files }, { cwd: "/work/bad" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_STACK");
	});

	test("filesystem failures during the walk become IO", async () => {
		const files = new InMemoryFileStore();
		files.exists = async () => {
			throw new Error("EACCES");
		};
		const result = await discoverStack({ files }, { cwd: "/work" });
		expect(!result.ok && result.error.code).toBe("IO");
	});
});
