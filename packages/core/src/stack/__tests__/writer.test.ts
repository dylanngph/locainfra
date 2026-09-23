import { describe, expect, test } from "bun:test";
import { MemoryFiles } from "../../catalog/__tests__/memory-files";
import { parseStackFile } from "../loader";
import {
	addStackService,
	removeStackService,
	renderStackFile,
	STACK_SCHEMA_COMMENT,
	setStackService,
	updateStackFile,
} from "../writer";

const COMMENTED = `# yaml-language-server: $schema=https://locainfra.dev/schema/v1.json
# Stack for the sovr app.
version: 1 # schema version
name: sovr
services:
  # main database
  postgres: { version: "17", port: 5433, config: { POSTGRES_DB: sovr } } # pinned
  # cache
  redis: { version: "7", port: 6380 }
link:
  file: .env.local # linked env file
  names: { postgres: DATABASE_URL, redis: REDIS_URL }
# trailing comment
`;

const COMMENTS = [
	"# yaml-language-server: $schema=https://locainfra.dev/schema/v1.json",
	"# Stack for the sovr app.",
	"# schema version",
	"# main database",
	"# pinned",
	"# linked env file",
	"# trailing comment",
];

function value(
	result: { ok: true; value: string } | { ok: false; error: Error },
): string {
	if (!result.ok) throw result.error;
	return result.value;
}

describe("stack writer", () => {
	test("add keeps every comment and existing formatting", () => {
		const next = value(
			addStackService(COMMENTED, "upstash-redis", { port: 8080 }),
		);
		for (const comment of COMMENTS) expect(next).toContain(comment);
		expect(next).toContain(
			'  postgres: { version: "17", port: 5433, config: { POSTGRES_DB: sovr } } # pinned\n',
		);
		expect(next).toContain("  upstash-redis: { port: 8080 }\n");
		const parsed = parseStackFile(next, "f");
		expect(parsed.ok && Object.keys(parsed.value.services)).toEqual([
			"postgres",
			"redis",
			"upstash-redis",
		]);
	});

	test("add then remove round-trips to the original text", () => {
		// yaml always puts a blank line before a document-trailing comment, so
		// the byte-exact check uses the fixture without one.
		const original = COMMENTED.replace("# trailing comment\n", "");
		const added = value(addStackService(original, "mailpit", { version: "1" }));
		expect(value(removeStackService(added, "mailpit"))).toBe(original);
	});

	test("remove drops the entry and its own comment only", () => {
		const next = value(removeStackService(COMMENTED, "redis"));
		expect(next).not.toContain("redis: {");
		expect(next).not.toContain("# cache");
		for (const comment of COMMENTS) expect(next).toContain(comment);
		expect(next).toContain(
			"names: { postgres: DATABASE_URL, redis: REDIS_URL }",
		);
	});

	test("set updates an existing entry in place, keeping its comments", () => {
		const next = value(
			setStackService(COMMENTED, "postgres", { version: "16", port: 5433 }),
		);
		expect(next).toContain(
			'  # main database\n  postgres: { version: "16", port: 5433 } # pinned\n',
		);
		const inserted = value(
			setStackService(COMMENTED, "minio", { port: "auto" }),
		);
		expect(inserted).toContain("  minio: { port: auto }\n");
	});

	test("add refuses duplicates; remove refuses unknown ids", () => {
		const dup = addStackService(COMMENTED, "redis", {});
		expect(!dup.ok && dup.error.message).toContain("already exists");
		const missing = removeStackService(COMMENTED, "nope");
		expect(!missing.ok && missing.error.message).toContain("not in the stack");
	});

	test("rejects invalid ids and entries without touching the text", () => {
		const badId = addStackService(COMMENTED, "Bad_Id", {});
		expect(!badId.ok && badId.error.issues[0]).toContain(
			"service id must match",
		);
		const badPort = addStackService(COMMENTED, "x", { port: 70000 });
		expect(!badPort.ok && badPort.error.issues[0]).toContain(
			"/services/x/port",
		);
	});

	test("refuses to edit an invalid file", () => {
		expect(addStackService("version: 2\nname: x\n", "redis", {}).ok).toBe(
			false,
		);
	});

	test("works when services is missing, empty or an empty flow map", () => {
		for (const text of [
			"version: 1\nname: x\n",
			"version: 1\nname: x\nservices:\n",
			"version: 1\nname: x\nservices: {}\n",
		]) {
			const next = value(addStackService(text, "redis", { version: "7" }));
			expect(next).toContain('services:\n  redis: { version: "7" }\n');
		}
	});

	test("removing the last service leaves a valid file", () => {
		const next = value(
			removeStackService(
				'version: 1\nname: x\nservices:\n  redis: { version: "7" }\n',
				"redis",
			),
		);
		const parsed = parseStackFile(next, "f");
		expect(parsed.ok && parsed.value.services).toEqual({});
	});

	test("never re-folds long user lines", () => {
		const long = `version: 1\nname: x\nlink:\n  file: ${"a".repeat(120)}\nservices: {}\n`;
		expect(value(addStackService(long, "redis", {}))).toContain(
			`file: ${"a".repeat(120)}\n`,
		);
	});

	test("renderStackFile writes a new file with the schema hint", () => {
		const text = renderStackFile({
			version: 1,
			name: "sovr",
			services: { postgres: { version: "17", port: 5433 } },
			link: { file: ".env.local" },
		});
		expect(text.startsWith(`${STACK_SCHEMA_COMMENT}\n`)).toBe(true);
		expect(text).toContain('  postgres: { version: "17", port: 5433 }\n');
		const parsed = parseStackFile(text, "f");
		expect(parsed.ok && parsed.value.link).toEqual({ file: ".env.local" });
	});
});

describe("updateStackFile", () => {
	test("reads, edits, validates and writes through the FileStore", async () => {
		const files = new MemoryFiles({ "/p/locainfra.yaml": COMMENTED });
		const result = await updateStackFile(files, "/p/locainfra.yaml", (text) =>
			addStackService(text, "minio", {}),
		);
		expect(result.ok && Object.keys(result.value.services)).toEqual([
			"postgres",
			"redis",
			"minio",
		]);
		expect(await files.readText("/p/locainfra.yaml")).toContain(
			"# main database",
		);
	});

	test("missing file: STACK_NOT_FOUND unless initial contents are given", async () => {
		const files = new MemoryFiles();
		const missing = await updateStackFile(files, "/s/global.yaml", (text) =>
			addStackService(text, "redis", {}),
		);
		expect(!missing.ok && missing.error.code).toBe("STACK_NOT_FOUND");
		const created = await updateStackFile(
			files,
			"/s/global.yaml",
			(text) => addStackService(text, "redis", {}),
			renderStackFile({ version: 1, name: "global", services: {} }),
		);
		expect(created.ok).toBe(true);
		expect(await files.readText("/s/global.yaml")).toContain("redis: {}");
	});

	test("edit failures become INVALID_STACK and nothing is written", async () => {
		const files = new MemoryFiles({ "/p/locainfra.yaml": COMMENTED });
		const result = await updateStackFile(files, "/p/locainfra.yaml", (text) =>
			removeStackService(text, "nope"),
		);
		expect(!result.ok && result.error.code).toBe("INVALID_STACK");
		expect(await files.readText("/p/locainfra.yaml")).toBe(COMMENTED);
	});

	test("write failures become IO", async () => {
		const files = new MemoryFiles({ "/p/locainfra.yaml": COMMENTED });
		files.writeText = async () => {
			throw new Error("EROFS");
		};
		const result = await updateStackFile(files, "/p/locainfra.yaml", (text) =>
			addStackService(text, "minio", {}),
		);
		expect(!result.ok && result.error.code).toBe("IO");
	});
});
