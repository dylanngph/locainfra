import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOpError, type Progress } from "@locainfra/core";
import { DockerContainerExec } from "../container-exec";
import { UnixSocketHijacker } from "../hijack";
import { DockerSocketLocator } from "../socket-locator";
import { UnixSocketTransport } from "../unix-socket-transport";
import {
	DockerVolumeArchiver,
	SNAPSHOT_HELPER_IMAGE,
	SNAPSHOT_HELPER_LABEL,
} from "../volume-archiver";

// SCRATCH ONLY: these tests create their own alpine container, network and
// volume (all named li-test-<random>), never bind host ports, never touch any
// other container, and remove everything they created in afterAll.
const socket = await new DockerSocketLocator().locate();
const dockerAvailable =
	socket !== null &&
	(await fetch("http://localhost/_ping", { unix: socket })
		.then((r) => r.ok)
		.catch(() => false));

const suffix = crypto.randomUUID().slice(0, 8);
const network = `li-test-net-${suffix}`;
const container = `li-test-exec-${suffix}`;
const volume = `li-test-vol-${suffix}`;
const IMAGE = SNAPSHOT_HELPER_IMAGE;

async function docker(
	...args: string[]
): Promise<{ code: number; out: string }> {
	const child = Bun.spawn(["docker", ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
	]);
	return { code, out };
}

async function ensureImage(): Promise<void> {
	if ((await docker("image", "inspect", IMAGE)).code !== 0) {
		await docker("pull", IMAGE);
	}
}

async function drain(events: AsyncIterable<Progress>): Promise<Progress[]> {
	const out: Progress[] = [];
	for await (const event of events) out.push(event);
	return out;
}

describe.skipIf(!dockerAvailable)(
	"DockerContainerExec (live, scratch container)",
	() => {
		const transport = new UnixSocketTransport({ socketPath: socket ?? "" });
		const exec = new DockerContainerExec(transport, {
			hijacker: new UnixSocketHijacker(transport),
		});
		const limits = { timeoutMs: 10_000, maxBytes: 64 * 1024 };

		beforeAll(async () => {
			await ensureImage();
			await docker("network", "create", "--internal", network);
			const run = await docker(
				"run",
				"-d",
				"--rm",
				"--name",
				container,
				"--network",
				network,
				IMAGE,
				"sleep",
				"600",
			);
			expect(run.code).toBe(0);
		}, 120_000);

		afterAll(async () => {
			await docker("rm", "-f", container);
			await docker("network", "rm", network);
		}, 60_000);

		test("runs argv without a shell and reads the exit code", async () => {
			const ok = await exec.run(container, ["echo", "ok", "$HOME"], limits);
			expect(ok).toEqual({
				exitCode: 0,
				stdout: "ok $HOME\n",
				stderr: "",
				truncated: false,
				timedOut: false,
			});
			const failed = await exec.run(
				container,
				["sh", "-c", "echo bad >&2; exit 7"],
				limits,
			);
			expect(failed.exitCode).toBe(7);
			expect(failed.stderr).toBe("bad\n");
		});

		test("pipes stdin and closes it", async () => {
			const payload = `${"line\n".repeat(50_000)}end`;
			const result = await exec.run(container, ["wc", "-c"], {
				...limits,
				stdin: payload,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(String(payload.length));
		});

		test("kills the process on timeout", async () => {
			const result = await exec.run(container, ["sleep", "137"], {
				timeoutMs: 300,
				maxBytes: 1024,
			});
			expect(result.timedOut).toBe(true);
			expect(result.exitCode).toBe(-1);
			const ps = await exec.run(container, ["ps", "-o", "args"], limits);
			expect(ps.stdout).not.toContain("sleep 137");
		});

		test("caps stdout", async () => {
			const result = await exec.run(
				container,
				["sh", "-c", "yes | head -c 100000"],
				{ timeoutMs: 10_000, maxBytes: 1000 },
			);
			expect(result.truncated).toBe(true);
			expect(result.stdout).toHaveLength(1000);
		});

		test("an unknown container is SERVICE_NOT_FOUND", async () => {
			const error = await exec
				.run(`li-test-missing-${suffix}`, ["true"], limits)
				.then(
					() => undefined,
					(e: unknown) => e,
				);
			expect(isOpError(error) && error.code).toBe("SERVICE_NOT_FOUND");
		});
	},
);

describe.skipIf(!dockerAvailable)(
	"DockerVolumeArchiver (live, scratch volume)",
	() => {
		const archiver = new DockerVolumeArchiver();
		let home: string;

		beforeAll(async () => {
			home = mkdtempSync(join(tmpdir(), "li-test-home-"));
			await ensureImage();
			expect((await docker("volume", "create", volume)).code).toBe(0);
			const seed = await docker(
				"run",
				"--rm",
				"--network",
				"none",
				"--mount",
				`type=volume,src=${volume},dst=/d`,
				IMAGE,
				"sh",
				"-c",
				"echo hi > /d/a && echo h > /d/.hidden && mkdir /d/sub && echo s > /d/sub/f && chown 999:999 /d/a",
			);
			expect(seed.code).toBe(0);
		}, 120_000);

		afterAll(async () => {
			await docker("volume", "rm", "-f", volume);
			rmSync(home, { recursive: true, force: true });
		}, 60_000);

		test("archives, then restores over changed contents", async () => {
			const dest = join(home, "snapshots", "p", "s", "snap1.tgz");
			const archived = await drain(
				archiver.archive(volume, dest, new AbortController().signal),
			);
			expect(archived.at(-1)?.kind).toBe("done");
			expect(await archiver.sizeOf(dest)).toBeGreaterThan(0);

			await docker(
				"run",
				"--rm",
				"--network",
				"none",
				"--mount",
				`type=volume,src=${volume},dst=/d`,
				IMAGE,
				"sh",
				"-c",
				"rm /d/a && echo x > /d/extra && echo y > /d/.extra",
			);

			const restored = await drain(
				archiver.restore(volume, dest, new AbortController().signal),
			);
			expect(restored.at(-1)?.kind).toBe("done");

			const check = await docker(
				"run",
				"--rm",
				"--network",
				"none",
				"--mount",
				`type=volume,src=${volume},dst=/d,readonly`,
				IMAGE,
				"sh",
				"-c",
				"ls -A /d | sort | tr '\\n' ' '; cat /d/a; stat -c %u /d/a",
			);
			expect(check.out).toBe(".hidden a sub hi\n999\n");

			// A truncated archive (or one deleted mid-restore) fails the staged
			// extraction and leaves the volume exactly as it was.
			const bytes = await Bun.file(dest).arrayBuffer();
			const truncated = join(home, "snapshots", "p", "s", "cut.tgz");
			await Bun.write(
				truncated,
				bytes.slice(0, Math.floor(bytes.byteLength / 2)),
			);
			const garbage = join(home, "snapshots", "p", "s", "junk.tgz");
			await Bun.write(garbage, "not a gzip file");
			for (const bad of [truncated, garbage]) {
				const failed = await drain(
					archiver.restore(volume, bad, new AbortController().signal),
				);
				expect(failed.at(-1)?.kind).toBe("error");
				const intact = await docker(
					"run",
					"--rm",
					"--network",
					"none",
					"--mount",
					`type=volume,src=${volume},dst=/d,readonly`,
					IMAGE,
					"sh",
					"-c",
					"ls -A /d | sort | tr '\\n' ' '; cat /d/a",
				);
				expect(intact.out).toBe(".hidden a sub hi\n");
			}

			await archiver.removeArchive(dest);
			const helpers = await docker(
				"ps",
				"-aq",
				"--filter",
				`label=${SNAPSHOT_HELPER_LABEL}`,
			);
			expect(helpers.out.trim()).toBe("");
		}, 120_000);
	},
);
