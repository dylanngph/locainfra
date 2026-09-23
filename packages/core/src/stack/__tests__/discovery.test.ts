import { describe, expect, test } from "bun:test";
import { MemoryFiles } from "../../catalog/__tests__/memory-files";
import { emptyStackFile, findProjectStackFile } from "../discovery";
import { GLOBAL_STACK_NAME } from "../stack.model";

const project = (name: string) =>
	`version: 1\nname: ${name}\nservices:\n  postgres: { version: "17" }\n`;

describe("findProjectStackFile", () => {
	test("walks up to the nearest locainfra.yaml", async () => {
		const files = new MemoryFiles({
			"/work/app/locainfra.yaml": project("app"),
			"/work/locainfra.yaml": project("outer"),
		});
		expect(await findProjectStackFile(files, "/work/app/src/deep")).toBe(
			"/work/app/locainfra.yaml",
		);
		expect(await findProjectStackFile(files, "/work/app")).toBe(
			"/work/app/locainfra.yaml",
		);
		expect(await findProjectStackFile(files, "/work/other")).toBe(
			"/work/locainfra.yaml",
		);
		expect(await findProjectStackFile(files, "/elsewhere")).toBeNull();
	});

	test("normalises the start directory", async () => {
		const files = new MemoryFiles({
			"/work/app/locainfra.yaml": project("app"),
		});
		expect(await findProjectStackFile(files, "/work/app/src/../lib/")).toBe(
			"/work/app/locainfra.yaml",
		);
	});
});

describe("emptyStackFile", () => {
	test("defaults to an empty global stack", () => {
		expect(emptyStackFile()).toEqual({
			version: 1,
			name: GLOBAL_STACK_NAME,
			services: {},
		});
		expect(emptyStackFile("app").name).toBe("app");
	});
});
