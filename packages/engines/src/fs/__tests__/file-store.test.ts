import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileStore } from "../file-store";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ls-files-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("BunFileStore", () => {
	const files = new BunFileStore();

	test("readText returns null for missing files", async () => {
		expect(await files.readText(join(dir, "nope.txt"))).toBeNull();
	});

	test("writeText creates parents and round-trips", async () => {
		const path = join(dir, "a/b/c.yml");
		await files.writeText(path, "hello: ✓\n");
		expect(await files.readText(path)).toBe("hello: ✓\n");
	});

	test("exists sees files and directories; mkdirp is idempotent", async () => {
		const sub = join(dir, "x/y");
		expect(await files.exists(sub)).toBe(false);
		await files.mkdirp(sub);
		await files.mkdirp(sub);
		expect(await files.exists(sub)).toBe(true);
		expect(await files.exists(dir)).toBe(true);
	});

	test("writeText with a mode sets permissions, also on an existing file", async () => {
		const path = join(dir, "s/.env");
		await files.writeText(path, "A=1\n");
		expect(statSync(path).mode & 0o777).not.toBe(0o600);
		await files.writeText(path, "SECRET=x\n", { mode: 0o600 });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(await files.readText(path)).toBe("SECRET=x\n");
		const fresh = join(dir, "s/fresh.env");
		await files.writeText(fresh, "B=2\n", { mode: 0o600 });
		expect(statSync(fresh).mode & 0o777).toBe(0o600);
	});

	test("writeText replaces atomically: a concurrent reader never sees an empty or partial file", async () => {
		const path = join(dir, "stack/.env");
		const first = `A=${"1".repeat(64 * 1024)}\n`;
		const second = `B=${"2".repeat(64 * 1024)}\n`;
		await files.writeText(path, first, { mode: 0o600 });
		let writing = true;
		const seen = new Set<string>();
		const reader = (async () => {
			while (writing) {
				const text = (await files.readText(path)) ?? "<missing>";
				seen.add(
					text === first || text === second ? "whole" : text.slice(0, 20),
				);
			}
		})();
		for (let i = 0; i < 40; i++) {
			await files.writeText(path, i % 2 === 0 ? second : first, {
				mode: 0o600,
			});
		}
		writing = false;
		await reader;
		expect([...seen]).toEqual(["whole"]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(dir, "stack"))).toEqual([".env"]);
	});

	test("writeText without a mode keeps an existing file's bits and writes through a symlink", async () => {
		const real = join(dir, "real.yaml");
		writeFileSync(real, "a: 1\n");
		chmodSync(real, 0o640);
		const link = join(dir, "link.yaml");
		symlinkSync(real, link);
		await files.writeText(link, "a: 2\n");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(await files.readText(real)).toBe("a: 2\n");
		expect(statSync(real).mode & 0o777).toBe(0o640);
		await files.writeText(join(dir, "new.yaml"), "b: 1\n");
		expect(statSync(join(dir, "new.yaml")).mode & 0o777).toBe(0o644);
	});

	test("fileInfo follows symlinks and reports kind and size", async () => {
		const real = realpathSync(dir);
		writeFileSync(join(dir, "seed.sql"), "SELECT 1;\n");
		symlinkSync(join(dir, "seed.sql"), join(dir, "alias.sql"));
		symlinkSync("/dev/null", join(dir, "null.sql"));
		symlinkSync(join(dir, "nowhere"), join(dir, "dangling.sql"));
		mkdirSync(join(dir, "db"));
		expect(await files.fileInfo(join(dir, "alias.sql"))).toEqual({
			realPath: join(real, "seed.sql"),
			kind: "file",
			sizeBytes: 10,
		});
		expect(await files.fileInfo(join(dir, "null.sql"))).toMatchObject({
			realPath: "/dev/null",
			kind: "other",
		});
		expect(await files.fileInfo(join(dir, "db"))).toMatchObject({
			realPath: join(real, "db"),
			kind: "directory",
		});
		expect(await files.fileInfo(join(dir, "dangling.sql"))).toBeNull();
		expect(await files.fileInfo(join(dir, "missing.sql"))).toBeNull();
	});

	test("list returns regular files only", async () => {
		writeFileSync(join(dir, "a.yaml"), "x");
		mkdirSync(join(dir, "sub"));
		expect(await files.list(dir)).toEqual(["a.yaml"]);
	});

	test("list returns [] for a missing directory or a file", async () => {
		expect(await files.list(join(dir, "nope"))).toEqual([]);
		writeFileSync(join(dir, "f"), "x");
		expect(await files.list(join(dir, "f"))).toEqual([]);
	});
});
