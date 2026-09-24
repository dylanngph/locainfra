import { describe, expect, test } from "bun:test";
import { MemoryFiles } from "../../catalog/__tests__/memory-files";
import { emptyStackFile, findProjectStackFile } from "../discovery";

const project = (name: string) =>
	`version: 1\nname: ${name}\nservices:\n  db: { type: postgres, version: "17" }\n`;

describe("findProjectStackFile", () => {
	test("walks up to the nearest locastack.yaml", async () => {
		const files = new MemoryFiles({
			"/work/app/locastack.yaml": project("app"),
			"/work/locastack.yaml": project("outer"),
		});
		expect(await findProjectStackFile(files, "/work/app/src/deep")).toBe(
			"/work/app/locastack.yaml",
		);
		expect(await findProjectStackFile(files, "/work/app")).toBe(
			"/work/app/locastack.yaml",
		);
		expect(await findProjectStackFile(files, "/work/other")).toBe(
			"/work/locastack.yaml",
		);
		expect(await findProjectStackFile(files, "/elsewhere")).toBeNull();
	});

	test("normalises the start directory", async () => {
		const files = new MemoryFiles({
			"/work/app/locastack.yaml": project("app"),
		});
		expect(await findProjectStackFile(files, "/work/app/src/../lib/")).toBe(
			"/work/app/locastack.yaml",
		);
	});
});

describe("emptyStackFile", () => {
	test("is an empty stack named after the project", () => {
		expect(emptyStackFile("app")).toEqual({
			version: 1,
			name: "app",
			services: {},
		});
	});
});
