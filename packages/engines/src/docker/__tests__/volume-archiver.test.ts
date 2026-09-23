import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, isOpError, Progress } from "@locainfra/core";
import { Value } from "@sinclair/typebox/value";
import type {
	CommandRunner,
	RunningCommand,
	SpawnOptions,
} from "../../process/command-runner";
import {
	ARCHIVE_SCRIPT,
	classifyHelperFailure,
	DockerVolumeArchiver,
	RESTORE_SCRIPT,
	SNAPSHOT_HELPER_IMAGE,
} from "../volume-archiver";

const clock: Clock = { now: () => new Date("2026-09-23T00:00:00.000Z") };

interface Script {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode?: number;
	/** Runs when spawned (e.g. the helper writing its archive). */
	readonly effect?: (argv: readonly string[]) => void;
	/** Never exits on its own; exits 143 when the spawn signal aborts. */
	readonly hang?: boolean;
}

/** Runner answering by the first argv word after `docker` (`volume`, `image`, `pull`, `run`, `rm`). */
function scripted(scripts: Partial<Record<string, Script>>) {
	const calls: string[][] = [];
	const runner: CommandRunner = {
		spawn(argv, options?: SpawnOptions): RunningCommand {
			calls.push([...argv]);
			const script = scripts[argv[1] ?? ""] ?? {};
			script.effect?.(argv);
			if (script.hang) {
				let closeOut: (() => void) | undefined;
				const stdout = new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new TextEncoder().encode("working\n"));
						closeOut = () => c.close();
					},
				});
				const exited = new Promise<number>((resolve) => {
					options?.signal?.addEventListener("abort", () => {
						closeOut?.();
						resolve(143);
					});
				});
				return {
					stdout,
					stderr: new Response("").body ?? new ReadableStream(),
					exited,
				};
			}
			return {
				stdout: new Response(script.stdout ?? "").body ?? new ReadableStream(),
				stderr: new Response(script.stderr ?? "").body ?? new ReadableStream(),
				exited: Promise.resolve(script.exitCode ?? 0),
			};
		},
	};
	return { runner, calls };
}

async function collect(
	iterable: AsyncIterable<Progress>,
	onEvent?: (event: Progress) => void,
): Promise<Progress[]> {
	const events: Progress[] = [];
	for await (const event of iterable) {
		events.push(event);
		onEvent?.(event);
	}
	for (const event of events) expect(Value.Check(Progress, event)).toBe(true);
	const terminal = events.filter(
		(e) => e.kind === "done" || e.kind === "error",
	);
	expect(terminal).toHaveLength(1);
	expect(events.at(-1)).toBe(terminal[0]);
	return events;
}

/** The helper's `/to/<file>` argument mapped back to the host folder. */
function writeTemp(dir: string, content: string) {
	return (argv: readonly string[]) => {
		const target = argv.find((a) => a.startsWith("/to/"));
		if (target) writeFileSync(join(dir, target.slice(4)), content);
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "li-arch-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

describe("DockerVolumeArchiver.archive", () => {
	test("runs a --rm helper with safe mounts and renames the archive into place", async () => {
		const snapDir = join(dir, "snapshots", "shop", "db");
		const dest = join(snapDir, "abc.tgz");
		const { runner, calls } = scripted({
			run: { effect: writeTemp(snapDir, "tgz-bytes") },
		});
		const archiver = new DockerVolumeArchiver({
			runner,
			clock,
			newSuffix: () => "s1",
			owner: "501:20",
		});
		const events = await collect(
			archiver.archive("li-shop-db-data", dest, signal()),
		);
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["log", "Archiving volume li-shop-db-data"],
			["done", "Archived volume li-shop-db-data"],
		]);
		expect(readFileSync(dest, "utf8")).toBe("tgz-bytes");
		expect(readdirSync(snapDir)).toEqual(["abc.tgz"]);
		expect((statSync(snapDir).mode & 0o777).toString(8)).toBe("700");
		expect(calls).toEqual([
			[
				"docker",
				"volume",
				"inspect",
				"--format",
				"{{.Name}}",
				"li-shop-db-data",
			],
			[
				"docker",
				"image",
				"inspect",
				"--format",
				"{{.Id}}",
				SNAPSHOT_HELPER_IMAGE,
			],
			[
				"docker",
				"run",
				"--rm",
				"--name",
				"li-snapshot-helper-s1",
				"--label",
				"io.locainfra.helper=snapshot",
				"--network",
				"none",
				"--mount",
				"type=volume,src=li-shop-db-data,dst=/from,readonly",
				"--mount",
				`type=bind,src=${snapDir},dst=/to`,
				SNAPSHOT_HELPER_IMAGE,
				"sh",
				"-c",
				ARCHIVE_SCRIPT,
				"sh",
				"/to/.abc.tgz.partial-s1",
				"501:20",
			],
		]);
	});

	test("pulls a missing helper image, forwarding its output as log lines", async () => {
		const dest = join(dir, "a.tgz");
		const { runner, calls } = scripted({
			image: { exitCode: 1, stderr: "Error: No such image" },
			pull: { stdout: "3.20: Pulling from library/alpine\nDigest: sha256:x\n" },
			run: { effect: writeTemp(dir, "x") },
		});
		const archiver = new DockerVolumeArchiver({ runner, clock, owner: null });
		const events = await collect(archiver.archive("vol", dest, signal()));
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["step", `Pulling ${SNAPSHOT_HELPER_IMAGE}`],
			["log", "3.20: Pulling from library/alpine"],
			["log", "Digest: sha256:x"],
			["log", "Archiving volume vol"],
			["done", "Archived volume vol"],
		]);
		expect(calls[2]).toEqual(["docker", "pull", SNAPSHOT_HELPER_IMAGE]);
		expect(calls[3]?.at(-1)).toBe("");
	});

	test("a failed pull ends with an error and never runs the helper", async () => {
		const { runner, calls } = scripted({
			image: { exitCode: 1 },
			pull: { exitCode: 1, stderr: "network unreachable" },
		});
		const events = await collect(
			new DockerVolumeArchiver({ runner, clock }).archive(
				"vol",
				join(dir, "a.tgz"),
				signal(),
			),
		);
		expect(events.at(-1)?.error?.message).toContain("network unreachable");
		expect(calls.some((c) => c[1] === "run")).toBe(false);
	});

	test("a missing volume is SERVICE_NOT_FOUND and is never created", async () => {
		const { runner, calls } = scripted({
			volume: {
				exitCode: 1,
				stderr: "Error response from daemon: get vol: no such volume",
			},
		});
		const events = await collect(
			new DockerVolumeArchiver({ runner, clock }).archive(
				"vol",
				join(dir, "a.tgz"),
				signal(),
			),
		);
		expect(events.at(-1)?.error?.code).toBe("SERVICE_NOT_FOUND");
		expect(calls).toHaveLength(1);
	});

	test("a stopped daemon is DOCKER_UNREACHABLE", async () => {
		const { runner } = scripted({
			volume: {
				exitCode: 1,
				stderr:
					"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
			},
		});
		const events = await collect(
			new DockerVolumeArchiver({ runner, clock }).archive(
				"vol",
				join(dir, "a.tgz"),
				signal(),
			),
		);
		expect(events.at(-1)?.error?.code).toBe("DOCKER_UNREACHABLE");
	});

	test("rejects host paths as volumes and unsafe archive paths", async () => {
		const { runner, calls } = scripted({});
		const archiver = new DockerVolumeArchiver({ runner, clock });
		for (const [volume, path] of [
			["/etc", join(dir, "a.tgz")],
			["../x", join(dir, "a.tgz")],
			["vol", "relative/a.tgz"],
			["vol", join(dir, "a,dst=/etc.tgz")],
			["vol", join(dir, 'a"b.tgz')],
		] as const) {
			const events = await collect(archiver.archive(volume, path, signal()));
			expect(events.at(-1)?.error?.code).toBe("INVALID_INPUT");
		}
		expect(calls).toEqual([]);
	});

	test("a failing helper leaves no partial file and is force-removed", async () => {
		const { runner, calls } = scripted({
			run: {
				effect: writeTemp(dir, "half"),
				exitCode: 1,
				stderr: "tar: short write",
			},
		});
		const archiver = new DockerVolumeArchiver({
			runner,
			clock,
			newSuffix: () => "s2",
		});
		const dest = join(dir, "a.tgz");
		const events = await collect(archiver.archive("vol", dest, signal()));
		expect(events.at(-1)?.error).toEqual({
			code: "UNKNOWN",
			message: "Archiving volume vol failed (exit 1): tar: short write",
			details: { exitCode: 1 },
		});
		expect(readdirSync(dir)).toEqual([]);
		expect(calls.at(-1)).toEqual([
			"docker",
			"rm",
			"-f",
			"li-snapshot-helper-s2",
		]);
	});

	test("aborting kills the CLI, force-removes the helper and ends with an error", async () => {
		const { runner, calls } = scripted({
			run: { effect: writeTemp(dir, "half"), hang: true },
		});
		const archiver = new DockerVolumeArchiver({
			runner,
			clock,
			newSuffix: () => "s3",
		});
		const controller = new AbortController();
		const events = await collect(
			archiver.archive("vol", join(dir, "a.tgz"), controller.signal),
			(event) => {
				if (event.kind === "log") controller.abort();
			},
		);
		expect(events.at(-1)?.error?.details).toEqual({ cancelled: true });
		expect(existsSync(join(dir, "a.tgz"))).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
		expect(calls.at(-1)).toEqual([
			"docker",
			"rm",
			"-f",
			"li-snapshot-helper-s3",
		]);
	});

	test("breaking out of the stream still removes the helper", async () => {
		const { runner, calls } = scripted({ run: { hang: true } });
		const archiver = new DockerVolumeArchiver({
			runner,
			clock,
			newSuffix: () => "s4",
		});
		const controller = new AbortController();
		for await (const event of archiver.archive(
			"vol",
			join(dir, "a.tgz"),
			controller.signal,
		)) {
			// The first log is the "Archiving volume" line, before the helper runs.
			if (event.kind === "log" && event.message !== "Archiving volume vol") {
				controller.abort();
				break;
			}
		}
		expect(calls.at(-1)).toEqual([
			"docker",
			"rm",
			"-f",
			"li-snapshot-helper-s4",
		]);
	});

	test("a missing docker CLI is COMPOSE_MISSING", async () => {
		const runner: CommandRunner = {
			spawn() {
				throw new Error("ENOENT");
			},
		};
		const events = await collect(
			new DockerVolumeArchiver({ runner, clock }).archive(
				"vol",
				join(dir, "a.tgz"),
				signal(),
			),
		);
		expect(events.at(-1)?.error?.code).toBe("COMPOSE_MISSING");
	});
});

describe("DockerVolumeArchiver.restore", () => {
	test("mounts the volume read-write and the archive folder read-only", async () => {
		const src = join(dir, "abc.tgz");
		writeFileSync(src, "tgz");
		const { runner, calls } = scripted({});
		const archiver = new DockerVolumeArchiver({
			runner,
			clock,
			newSuffix: () => "r1",
		});
		const events = await collect(
			archiver.restore("li-shop-db-data", src, signal()),
		);
		expect(events.map((e) => [e.kind, e.message])).toEqual([
			["log", "Restoring volume li-shop-db-data"],
			["done", "Restored volume li-shop-db-data"],
		]);
		expect(calls.at(-1)).toEqual([
			"docker",
			"run",
			"--rm",
			"--name",
			"li-snapshot-helper-r1",
			"--label",
			"io.locainfra.helper=snapshot",
			"--network",
			"none",
			"--mount",
			"type=volume,src=li-shop-db-data,dst=/from",
			"--mount",
			`type=bind,src=${dir},dst=/to,readonly`,
			SNAPSHOT_HELPER_IMAGE,
			"sh",
			"-c",
			RESTORE_SCRIPT,
			"sh",
			"/to/abc.tgz",
		]);
		expect(calls.some((c) => c[1] === "volume")).toBe(false);
	});

	test("a missing archive is SNAPSHOT_NOT_FOUND", async () => {
		const { runner, calls } = scripted({});
		const events = await collect(
			new DockerVolumeArchiver({ runner, clock }).restore(
				"vol",
				join(dir, "gone.tgz"),
				signal(),
			),
		);
		expect(events.at(-1)?.error?.code).toBe("SNAPSHOT_NOT_FOUND");
		expect(calls).toEqual([]);
	});

	test("a failed restore force-removes the helper", async () => {
		const src = join(dir, "abc.tgz");
		writeFileSync(src, "tgz");
		const { runner, calls } = scripted({ run: { exitCode: 3 } });
		const events = await collect(
			new DockerVolumeArchiver({
				runner,
				clock,
				newSuffix: () => "r2",
			}).restore("vol", src, signal()),
		);
		expect(events.at(-1)?.error?.details).toEqual({ exitCode: 3 });
		expect(calls.at(-1)).toEqual([
			"docker",
			"rm",
			"-f",
			"li-snapshot-helper-r2",
		]);
	});
});

describe("DockerVolumeArchiver files", () => {
	test("sizeOf reports bytes; a missing file is SNAPSHOT_NOT_FOUND", async () => {
		const archiver = new DockerVolumeArchiver({ runner: scripted({}).runner });
		const path = join(dir, "a.tgz");
		writeFileSync(path, "12345");
		expect(await archiver.sizeOf(path)).toBe(5);
		const error = await archiver.sizeOf(join(dir, "none")).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(isOpError(error) && error.code).toBe("SNAPSHOT_NOT_FOUND");
	});

	test("removeArchive deletes and tolerates a missing file", async () => {
		const archiver = new DockerVolumeArchiver({ runner: scripted({}).runner });
		const path = join(dir, "a.tgz");
		writeFileSync(path, "x");
		await archiver.removeArchive(path);
		expect(existsSync(path)).toBe(false);
		await archiver.removeArchive(path);
	});

	test("classifyHelperFailure skips docker run's usage hint; a missing bind source is IO with a fix", () => {
		const usage = classifyHelperFailure(
			[
				'docker: Error response from daemon: invalid mount config for type "bind": boom',
				"",
				"Run 'docker run --help' for more information",
			],
			125,
			"Archiving volume v",
		);
		expect(usage.message).toBe(
			'Archiving volume v failed (exit 125): docker: Error response from daemon: invalid mount config for type "bind": boom',
		);
		const hidden = classifyHelperFailure(
			[
				'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /host_mnt/x',
				"Run 'docker run --help' for more information",
			],
			125,
			"Archiving volume v",
		);
		expect(hidden.code).toBe("IO");
		expect(hidden.details?.fix).toContain("File sharing");
	});

	test("classifyHelperFailure truncates the last line", () => {
		const error = classifyHelperFailure(["a", "b".repeat(500)], 2, "run");
		expect(error.message).toBe(`run failed (exit 2): ${"b".repeat(200)}`);
		expect(classifyHelperFailure([], 1, "run").message).toBe(
			"run failed (exit 1)",
		);
	});
});
