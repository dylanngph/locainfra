import { describe, expect, test } from "bun:test";
import { InMemoryFileStore } from "../../testing/fakes";
import { LINKED_ENV_FILE_MODE, writeLinkedEnvFile } from "../link/link-file";

describe("writeLinkedEnvFile", () => {
	test("creates the file with only the block, mode 0600", async () => {
		const files = new InMemoryFileStore();
		const result = await writeLinkedEnvFile(files, "/p/.env", "A=1\n");
		expect(result.ok).toBe(true);
		expect(files.files.get("/p/.env")).toBe(
			"# locastack:start\nA=1\n# locastack:end\n",
		);
		expect(files.modes.get("/p/.env")).toBe(LINKED_ENV_FILE_MODE);
	});

	test("rewrites only the marker block", async () => {
		const files = new InMemoryFileStore({
			"/p/.env": "MINE=1\n# locastack:start\nOLD=1\n# locastack:end\nAFTER=2\n",
		});
		await writeLinkedEnvFile(files, "/p/.env", "NEW=1\n");
		expect(files.files.get("/p/.env")).toBe(
			"MINE=1\n# locastack:start\nNEW=1\n# locastack:end\nAFTER=2\n",
		);
	});

	test("unbalanced markers and I/O failures are IO errors naming the file", async () => {
		const files = new InMemoryFileStore({
			"/p/.env": "# locastack:start\nA=1\n",
		});
		const bad = await writeLinkedEnvFile(files, "/p/.env", "B=1\n");
		expect(!bad.ok && bad.error.code).toBe("IO");
		expect(!bad.ok && bad.error.details.path).toBe("/p/.env");

		files.writeText = async () => {
			throw new Error("EROFS");
		};
		const write = await writeLinkedEnvFile(files, "/p/other.env", "B=1\n");
		expect(!write.ok && write.error.code).toBe("IO");

		files.readText = async () => {
			throw new Error("EACCES");
		};
		const read = await writeLinkedEnvFile(files, "/p/other.env", "B=1\n");
		expect(!read.ok && read.error.message).toContain("could not be read");
	});
});
