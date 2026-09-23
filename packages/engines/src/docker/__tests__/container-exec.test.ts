import { describe, expect, test } from "bun:test";
import { isOpError } from "@locainfra/core";
import {
	DockerContainerExec,
	EXEC_KILL_SCRIPT,
	EXEC_TAG_ENV,
} from "../container-exec";
import type { DockerHijacker, HijackRequest } from "../hijack";
import { encodeLogFrame } from "../log-demuxer";
import type { DockerRequestInit } from "../transport";
import { FakeTransport, streamingResponse } from "./fake-transport";

const MUX = { "content-type": "application/vnd.docker.raw-stream" };
const LIMITS = { timeoutMs: 5000, maxBytes: 1024 } as const;

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function bodyOf(init: DockerRequestInit | undefined): Record<string, unknown> {
	return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

/**
 * A transport scripted like the daemon: `POST /containers/{c}/exec` hands out
 * `e1`, `e2`, … in order; `start` of `e1` replays `frames` (or stays open);
 * `GET /exec/{id}/json` reports `exitCode` after `runningPolls` polls.
 */
function daemon(
	options: {
		frames?: readonly Uint8Array[];
		keepOpen?: boolean;
		exitCode?: number;
		runningPolls?: number;
		createStatus?: number;
		createMessage?: string;
	} = {},
) {
	let created = 0;
	let polls = 0;
	const transport = new FakeTransport([
		[
			"/containers/",
			() => {
				if (options.createStatus !== undefined) {
					return Response.json(
						{ message: options.createMessage ?? "boom" },
						{ status: options.createStatus },
					);
				}
				created += 1;
				return Response.json({ Id: `e${created}` }, { status: 201 });
			},
		],
		[
			"/exec/e1/start",
			(init) =>
				streamingResponse(options.frames ?? [], {
					keepOpen: options.keepOpen ?? false,
					headers: MUX,
					signal: init?.signal,
				}).response,
		],
		["/exec/e2/start", () => new Response(new Uint8Array(0), { headers: MUX })],
		[
			"/exec/e1/json",
			() => {
				polls += 1;
				const running = polls <= (options.runningPolls ?? 0);
				return Response.json({
					Running: running,
					ExitCode: running ? null : (options.exitCode ?? 0),
				});
			},
		],
	]);
	return {
		transport,
		creates: () =>
			transport.calls
				.map((path, i) => ({ path, init: transport.inits[i] }))
				.filter((c) => c.path.endsWith("/exec")),
	};
}

describe("DockerContainerExec", () => {
	test("creates, starts, demuxes frames split across chunks and reads the exit code", async () => {
		const bytes = concat(
			encodeLogFrame("stdout", "id,name\n"),
			encodeLogFrame("stderr", "NOTICE: hi\n"),
			encodeLogFrame("stdout", "1,café\n"),
		);
		const { transport, creates } = daemon({
			frames: [bytes.subarray(0, 5), bytes.subarray(5, 21), bytes.subarray(21)],
			exitCode: 0,
		});
		const exec = new DockerContainerExec(transport, { newTag: () => "tag1" });
		const result = await exec.run(
			"li-shop-db",
			["psql", "-c", "select 1; -- $(rm -rf /)"],
			LIMITS,
		);
		expect(result).toEqual({
			exitCode: 0,
			stdout: "id,name\n1,café\n",
			stderr: "NOTICE: hi\n",
			truncated: false,
			timedOut: false,
		});
		expect(transport.calls).toEqual([
			"/containers/li-shop-db/exec",
			"/exec/e1/start",
			"/exec/e1/json",
		]);
		const create = creates()[0];
		expect(create?.init?.method).toBe("POST");
		expect(bodyOf(create?.init)).toEqual({
			AttachStdin: false,
			AttachStdout: true,
			AttachStderr: true,
			Tty: false,
			Cmd: ["psql", "-c", "select 1; -- $(rm -rf /)"],
			Env: [`${EXEC_TAG_ENV}=tag1`],
		});
		expect(bodyOf(transport.inits[1])).toEqual({ Detach: false, Tty: false });
	});

	test("encodes the container id and reports a failing command's exit code", async () => {
		const { transport } = daemon({
			frames: [encodeLogFrame("stderr", "ERROR: syntax\n")],
			exitCode: 1,
			runningPolls: 2,
		});
		const exec = new DockerContainerExec(transport);
		const result = await exec.run("a/b", ["false"], LIMITS);
		expect(transport.calls[0]).toBe("/containers/a%2Fb/exec");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("ERROR: syntax\n");
		expect(transport.calls.filter((c) => c === "/exec/e1/json")).toHaveLength(
			3,
		);
	});

	test("caps stdout at maxBytes on a character boundary, then kills the process", async () => {
		const { transport, creates } = daemon({
			frames: [
				encodeLogFrame("stdout", "abcé"),
				encodeLogFrame("stdout", "more"),
			],
			keepOpen: true,
		});
		const exec = new DockerContainerExec(transport, { newTag: () => "t-cap" });
		// "abcé" is 5 bytes; a 4-byte cap must not split "é".
		const result = await exec.run("db", ["cat", "big"], {
			timeoutMs: 5000,
			maxBytes: 4,
		});
		expect(result).toEqual({
			exitCode: -1,
			stdout: "abc",
			stderr: "",
			truncated: true,
			timedOut: false,
		});
		const kill = creates()[1];
		expect(bodyOf(kill?.init)).toMatchObject({
			Cmd: ["sh", "-c", EXEC_KILL_SCRIPT, "sh", "t-cap"],
		});
		expect(bodyOf(kill?.init).Env).toBeUndefined();
		expect(transport.calls).toContain("/exec/e2/start");
	});

	test("caps stderr separately without ending the run", async () => {
		const { transport } = daemon({
			frames: [
				encodeLogFrame("stderr", "x".repeat(10)),
				encodeLogFrame("stdout", "ok"),
			],
		});
		const exec = new DockerContainerExec(transport, { stderrMaxBytes: 4 });
		const result = await exec.run("db", ["x"], LIMITS);
		expect(result.stderr).toBe("xxxx");
		expect(result.stdout).toBe("ok");
		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(false);
	});

	test("kills on timeout and resolves with timedOut", async () => {
		const { transport, creates } = daemon({
			frames: [encodeLogFrame("stdout", "partial")],
			keepOpen: true,
		});
		const exec = new DockerContainerExec(transport, { newTag: () => "t-slow" });
		const started = Date.now();
		const result = await exec.run("db", ["sleep", "60"], {
			timeoutMs: 50,
			maxBytes: 1024,
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(result).toEqual({
			exitCode: -1,
			stdout: "partial",
			stderr: "",
			truncated: false,
			timedOut: true,
		});
		expect(transport.inits[1]?.signal?.aborted).toBe(true);
		expect(bodyOf(creates()[1]?.init).Cmd).toEqual([
			"sh",
			"-c",
			EXEC_KILL_SCRIPT,
			"sh",
			"t-slow",
		]);
		expect(transport.calls).not.toContain("/exec/e1/json");
	});

	test("the caller's signal aborts like a timeout", async () => {
		const { transport } = daemon({ keepOpen: true });
		const exec = new DockerContainerExec(transport);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const result = await exec.run("db", ["sleep", "60"], {
			...LIMITS,
			signal: controller.signal,
		});
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBe(-1);
	});

	test("an already aborted signal never reaches the daemon", async () => {
		const { transport } = daemon();
		const controller = new AbortController();
		controller.abort();
		const result = await new DockerContainerExec(transport).run("db", ["x"], {
			...LIMITS,
			signal: controller.signal,
		});
		expect(result.timedOut).toBe(true);
		expect(transport.calls).toEqual([]);
	});

	test("maps 404 to SERVICE_NOT_FOUND and 409 to SERVICE_NOT_RUNNING", async () => {
		const missing = daemon({ createStatus: 404, createMessage: "No such" });
		const notFound = await rejection(
			new DockerContainerExec(missing.transport).run("db", ["x"], LIMITS),
		);
		expect(isOpError(notFound) && notFound.code).toBe("SERVICE_NOT_FOUND");

		const stopped = daemon({
			createStatus: 409,
			createMessage: "Container db is not running",
		});
		const notRunning = await rejection(
			new DockerContainerExec(stopped.transport).run("db", ["x"], LIMITS),
		);
		expect(isOpError(notRunning) && notRunning.code).toBe(
			"SERVICE_NOT_RUNNING",
		);
	});

	test("rejects an empty argv and stdin without a hijacker", async () => {
		const { transport } = daemon();
		const exec = new DockerContainerExec(transport);
		const empty = await rejection(exec.run("db", [], LIMITS));
		expect(isOpError(empty) && empty.code).toBe("INVALID_INPUT");
		const stdin = await rejection(
			exec.run("db", ["cat"], { ...LIMITS, stdin: "x" }),
		);
		expect(isOpError(stdin) && stdin.code).toBe("INVALID_INPUT");
		expect(transport.calls).toEqual([]);
	});

	test("sends stdin through the hijacker", async () => {
		const { transport, creates } = daemon({ exitCode: 0 });
		const requests: HijackRequest[] = [];
		const hijacker: DockerHijacker = {
			async open(request) {
				requests.push(request);
				const echoed = new TextDecoder().decode(request.stdin);
				return {
					contentType: "application/vnd.docker.multiplexed-stream",
					chunks: (async function* () {
						yield encodeLogFrame("stdout", `got:${echoed}`);
					})(),
				};
			},
		};
		const exec = new DockerContainerExec(transport, { hijacker });
		const result = await exec.run("db", ["psql", "-f", "-"], {
			...LIMITS,
			stdin: "insert into t values (1);",
		});
		expect(result.stdout).toBe("got:insert into t values (1);");
		expect(result.exitCode).toBe(0);
		expect(requests[0]?.path).toBe("/exec/e1/start");
		expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
			Detach: false,
			Tty: false,
		});
		expect(bodyOf(creates()[0]?.init).AttachStdin).toBe(true);
		expect(transport.calls).not.toContain("/exec/e1/start");
	});
});
