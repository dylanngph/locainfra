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

const COMMENTED = `# yaml-language-server: $schema=https://locastack.dev/schema/v1.json
# Stack for the shop app.
version: 1 # schema version
name: shop
services:
  # main database
  main-db: { type: postgres, version: "17", port: 5433, config: { POSTGRES_DB: shop } } # pinned
  # cache
  cache: { type: redis, version: "7", port: 6380 }
  events:
    type: postgres # second postgres
    persist: ephemeral
link:
  file: .env.local # linked env file
  names: { main-db: DATABASE_URL, cache: REDIS_URL }
# trailing comment
`;

const COMMENTS = [
	"# yaml-language-server: $schema=https://locastack.dev/schema/v1.json",
	"# Stack for the shop app.",
	"# schema version",
	"# main database",
	"# pinned",
	"# second postgres",
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
			addStackService(COMMENTED, "rest", {
				type: "upstash-redis",
				port: 8080,
				uses: { redis: "cache" },
			}),
		);
		for (const comment of COMMENTS) expect(next).toContain(comment);
		expect(next).toContain(
			'  main-db: { type: postgres, version: "17", port: 5433, config: { POSTGRES_DB: shop } } # pinned\n',
		);
		expect(next).toContain(
			"  rest: { type: upstash-redis, port: 8080, uses: { redis: cache } }\n",
		);
		const parsed = parseStackFile(next, "f");
		expect(parsed.ok && Object.keys(parsed.value.services)).toEqual([
			"main-db",
			"cache",
			"events",
			"rest",
		]);
	});

	test("writes fields in canonical order: type, version, port, persist, config, uses", () => {
		const next = value(
			addStackService(COMMENTED, "search-db", {
				config: { POSTGRES_DB: "search" },
				persist: "volume",
				port: "auto",
				version: "16",
				type: "postgres",
			}),
		);
		expect(next).toContain(
			'  search-db: { type: postgres, version: "16", port: auto, persist: volume, config: { POSTGRES_DB: search } }\n',
		);
	});

	test("add then remove round-trips to the original text", () => {
		// yaml always puts a blank line before a document-trailing comment, so
		// the byte-exact check uses the fixture without one.
		const original = COMMENTED.replace("# trailing comment\n", "");
		const added = value(
			addStackService(original, "mailpit", { type: "mailpit", version: "1" }),
		);
		expect(value(removeStackService(added, "mailpit"))).toBe(original);
	});

	test("remove drops the entry and its own comment only", () => {
		const next = value(removeStackService(COMMENTED, "cache"));
		expect(next).not.toContain("cache: {");
		expect(next).not.toContain("# cache");
		for (const comment of COMMENTS) expect(next).toContain(comment);
		expect(next).toContain(
			"names: { main-db: DATABASE_URL, cache: REDIS_URL }",
		);
	});

	test("set updates an existing flow entry in place, keeping its comments", () => {
		const next = value(
			setStackService(COMMENTED, "main-db", {
				type: "postgres",
				version: "16",
				port: 5433,
			}),
		);
		expect(next).toContain(
			'  # main database\n  main-db: { type: postgres, version: "16", port: 5433 } # pinned\n',
		);
		const reordered = value(
			setStackService(COMMENTED, "cache", {
				type: "redis",
				version: "7",
				port: 6380,
				persist: "ephemeral",
				uses: {},
			}),
		);
		expect(reordered).toContain(
			'  # cache\n  cache: { type: redis, version: "7", port: 6380, persist: ephemeral, uses: {} }\n',
		);
		const inserted = value(
			setStackService(COMMENTED, "files", { type: "minio", port: "auto" }),
		);
		expect(inserted).toContain("  files: { type: minio, port: auto }\n");
	});

	test("set updates a block entry field by field, keeping inner comments", () => {
		const next = value(
			setStackService(COMMENTED, "events", {
				type: "postgres",
				persist: "volume",
				port: 5440,
			}),
		);
		expect(next).toContain(
			"  events:\n    type: postgres # second postgres\n    persist: volume\n    port: 5440\n",
		);
	});

	test("add refuses duplicates; remove refuses unknown names", () => {
		const dup = addStackService(COMMENTED, "cache", { type: "redis" });
		expect(!dup.ok && dup.error.message).toContain("already exists");
		const missing = removeStackService(COMMENTED, "nope");
		expect(!missing.ok && missing.error.message).toContain("not in the stack");
	});

	test("rejects invalid names and entries without touching the text", () => {
		const badId = addStackService(COMMENTED, "Bad_Id", { type: "redis" });
		expect(!badId.ok && badId.error.issues[0]).toContain(
			"service name must match",
		);
		const digit = addStackService(COMMENTED, "1db", { type: "redis" });
		expect(digit.ok).toBe(false);
		const badPort = addStackService(COMMENTED, "x", {
			type: "redis",
			port: 70000,
		});
		expect(!badPort.ok && badPort.error.issues[0]).toContain(
			"/services/x/port",
		);
		const badPersist = addStackService(COMMENTED, "x", {
			type: "redis",
			persist: "forever" as "volume",
		});
		expect(badPersist.ok).toBe(false);
	});

	test("refuses to edit an invalid file", () => {
		expect(
			addStackService("version: 2\nname: x\n", "cache", { type: "redis" }).ok,
		).toBe(false);
	});

	test("works when services is missing, empty or an empty flow map", () => {
		for (const text of [
			"version: 1\nname: x\n",
			"version: 1\nname: x\nservices:\n",
			"version: 1\nname: x\nservices: {}\n",
		]) {
			const next = value(
				addStackService(text, "cache", { type: "redis", version: "7" }),
			);
			expect(next).toContain(
				'services:\n  cache: { type: redis, version: "7" }\n',
			);
		}
	});

	test("removing the last service leaves a valid file", () => {
		const next = value(
			removeStackService(
				'version: 1\nname: x\nservices:\n  cache: { type: redis, version: "7" }\n',
				"cache",
			),
		);
		const parsed = parseStackFile(next, "f");
		expect(parsed.ok && parsed.value.services).toEqual({});
	});

	test("never re-folds long user lines", () => {
		const long = `version: 1\nname: x\nlink:\n  file: ${"a".repeat(120)}\nservices: {}\n`;
		expect(value(addStackService(long, "cache", { type: "redis" }))).toContain(
			`file: ${"a".repeat(120)}\n`,
		);
	});

	test("renderStackFile writes a new file with the schema hint", () => {
		const text = renderStackFile({
			version: 1,
			name: "shop",
			services: {
				"main-db": { type: "postgres", version: "17", port: 5433 },
				events: { type: "postgres", persist: "ephemeral" },
			},
			link: { file: ".env.local" },
		});
		expect(text.startsWith(`${STACK_SCHEMA_COMMENT}\n`)).toBe(true);
		expect(text).toContain(
			'  main-db: { type: postgres, version: "17", port: 5433 }\n',
		);
		expect(text).toContain(
			"  events: { type: postgres, persist: ephemeral }\n",
		);
		const parsed = parseStackFile(text, "f");
		expect(parsed.ok && parsed.value.link).toEqual({ file: ".env.local" });
		expect(parsed.ok && parsed.value.services.events?.persist).toBe(
			"ephemeral",
		);
	});
});

describe("updateStackFile", () => {
	test("reads, edits, validates and writes through the FileStore", async () => {
		const files = new MemoryFiles({ "/p/locastack.yaml": COMMENTED });
		const result = await updateStackFile(files, "/p/locastack.yaml", (text) =>
			addStackService(text, "files", { type: "minio" }),
		);
		expect(result.ok && Object.keys(result.value.services)).toEqual([
			"main-db",
			"cache",
			"events",
			"files",
		]);
		expect(await files.readText("/p/locastack.yaml")).toContain(
			"# main database",
		);
	});

	test("missing file: STACK_NOT_FOUND unless initial contents are given", async () => {
		const files = new MemoryFiles();
		const missing = await updateStackFile(files, "/p/locastack.yaml", (text) =>
			addStackService(text, "cache", { type: "redis" }),
		);
		expect(!missing.ok && missing.error.code).toBe("STACK_NOT_FOUND");
		const created = await updateStackFile(
			files,
			"/p/locastack.yaml",
			(text) => addStackService(text, "cache", { type: "redis" }),
			renderStackFile({ version: 1, name: "p", services: {} }),
		);
		expect(created.ok).toBe(true);
		expect(await files.readText("/p/locastack.yaml")).toContain(
			"cache: { type: redis }",
		);
	});

	test("edit failures become INVALID_STACK and nothing is written", async () => {
		const files = new MemoryFiles({ "/p/locastack.yaml": COMMENTED });
		const result = await updateStackFile(files, "/p/locastack.yaml", (text) =>
			removeStackService(text, "nope"),
		);
		expect(!result.ok && result.error.code).toBe("INVALID_STACK");
		expect(await files.readText("/p/locastack.yaml")).toBe(COMMENTED);
	});

	test("read and write failures become IO", async () => {
		const files = new MemoryFiles({ "/p/locastack.yaml": COMMENTED });
		files.writeText = async () => {
			throw new Error("EROFS");
		};
		const result = await updateStackFile(files, "/p/locastack.yaml", (text) =>
			addStackService(text, "files", { type: "minio" }),
		);
		expect(!result.ok && result.error.code).toBe("IO");
		files.readText = async () => {
			throw new Error("EACCES");
		};
		const read = await updateStackFile(files, "/p/locastack.yaml", (text) =>
			addStackService(text, "files", { type: "minio" }),
		);
		expect(!read.ok && read.error.code).toBe("IO");
	});
});
