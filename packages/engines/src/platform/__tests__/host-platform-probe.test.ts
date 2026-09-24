import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPlatformProbe } from "../platform-inspector";

// Uses a throwaway unix socket in a temp folder (no Docker involved).
const dir = await mkdtemp(join(tmpdir(), "locastack-probe-"));
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("HostPlatformProbe", () => {
	test("ping: a socket this user may not open is `denied`, a missing one `down`", async () => {
		const path = join(dir, "docker.sock");
		const server = Bun.listen({
			unix: path,
			socket: { data() {} },
		});
		try {
			await chmod(path, 0o000);
			const probe = new HostPlatformProbe({ pingTimeoutMs: 1_000 });
			const expected = process.getuid?.() === 0 ? "down" : "denied";
			expect(await probe.ping(path)).toBe(expected);
			expect(await probe.ping(join(dir, "missing.sock"))).toBe("down");
		} finally {
			server.stop(true);
		}
	});

	test("which reads the live PATH (a prefix prepended after start is found)", async () => {
		const bin = join(dir, "bin");
		await Bun.write(join(bin, "zz-locastack-probe"), "#!/bin/sh\n");
		await chmod(join(bin, "zz-locastack-probe"), 0o755);
		const probe = new HostPlatformProbe();
		const before = process.env.PATH;
		try {
			expect(await probe.which("zz-locastack-probe")).toBeUndefined();
			process.env.PATH = `${bin}:${before ?? ""}`;
			expect(await probe.which("zz-locastack-probe")).toBe(
				join(bin, "zz-locastack-probe"),
			);
		} finally {
			process.env.PATH = before;
		}
	});
});
