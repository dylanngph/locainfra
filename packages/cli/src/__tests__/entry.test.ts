import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { version } from "../../package.json";

const entry = join(import.meta.dir, "..", "index.ts");

async function runEntry(
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", entry, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

describe("locainfra entry (spawned)", () => {
	test("--version prints the package version and exits 0", async () => {
		const { code, stdout } = await runEntry(["--version"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toBe(version);
	});

	test("--help lists the commands and exits 0", async () => {
		const { code, stdout } = await runEntry(["--help"]);
		expect(code).toBe(0);
		expect(stdout).toContain("Usage: locainfra");
		for (const name of ["up", "down", "env", "doctor", "--json"]) {
			expect(stdout).toContain(name);
		}
	});

	test("an unknown command exits 2", async () => {
		const { code, stderr } = await runEntry(["frobnicate"]);
		expect(code).toBe(2);
		expect(stderr).toContain("frobnicate");
	});

	test("down --volumes without --yes exits 2 when not a TTY", async () => {
		const { code, stderr } = await runEntry(["down", "--volumes"]);
		expect(code).toBe(2);
		expect(stderr).toContain("--yes");
	});
});
