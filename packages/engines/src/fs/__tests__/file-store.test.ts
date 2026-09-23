import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileStore } from "../file-store";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "li-files-"));
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
