import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Clock, Progress } from "@locainfra/core";
import { Value } from "@sinclair/typebox/value";
import type {
	CommandRunner,
	RunningCommand,
} from "../../process/command-runner";
import { ComposeRunner, upArgs } from "../compose-runner";

const target = {
	projectName: "li-demo",
	composeFile: "/tmp/li/docker-compose.yml",
};
const clock: Clock = { now: () => new Date("2026-09-23T00:00:00.000Z") };

function stream(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body ?? new ReadableStream();
}

/** Scripted runner: every spawn returns the same output. */
function scripted(
	stdout: string,
	stderr: string,
	exitCode: number,
): CommandRunner & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		spawn(argv): RunningCommand {
			calls.push([...argv]);
			return {
				stdout: stream(stdout),
				stderr: stream(stderr),
				exited: Promise.resolve(exitCode),
			};
		},
	};
}

async function collect(iterable: AsyncIterable<Progress>) {
	const events: Progress[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("ComposeRunner.version", () => {
	test("returns the short version without a leading v", async () => {
		const runner = scripted("v2.30.3\n", "", 0);
		expect(await new ComposeRunner({ runner }).version()).toBe("2.30.3");
		expect(runner.calls[0]).toEqual([
			"docker",
			"compose",
			"version",
			"--short",
		]);
	});

	test("returns null when compose fails or docker is missing", async () => {
		expect(
			await new ComposeRunner({
				runner: scripted("", "unknown command", 1),
			}).version(),
		).toBeNull();
		const missing: CommandRunner = {
			spawn() {
				throw new Error("ENOENT");
			},
		};
		expect(await new ComposeRunner({ runner: missing }).version()).toBeNull();
	});
});

describe("ComposeRunner.up", () => {
	test("builds argv with project, file, wait flags and services", async () => {
		const runner = scripted("", "", 0);
		await collect(
			new ComposeRunner({ runner, clock }).up({
				...target,
				wait: true,
				waitTimeoutSec: 60,
				services: ["postgres"],
			}),
		);
		expect(runner.calls[0]).toEqual([
			"docker",
			"compose",
			"--ansi",
			"never",
			"--progress",
			"plain",
			"-p",
			"li-demo",
			"-f",
			"/tmp/li/docker-compose.yml",
			"up",
			"-d",
			"--remove-orphans",
			"--wait",
			"--wait-timeout",
			"60",
			"--",
			"postgres",
		]);
	});

	test("streams log lines then a single done event", async () => {
		const runner = scripted(
			"",
			" Network li-demo  Creating\n Network li-demo  Created\r\n\n Container li-demo-redis-1  Started",
			0,
		);
		const events = await collect(
			new ComposeRunner({ runner, clock }).up(target),
		);
		expect(events.map((e) => e.kind)).toEqual(["log", "log", "log", "done"]);
		expect(events[0]).toEqual({
			kind: "log",
			message: "Network li-demo  Creating",
			at: "2026-09-23T00:00:00.000Z",
		});
	});

	test("ends with a typed PORT_CONFLICT error", async () => {
		const runner = scripted(
			"",
			" Container li-demo-postgres-1  Starting\nError response from daemon: Bind for 127.0.0.1:5432 failed: port is already allocated\n",
			1,
		);
		const events = await collect(
			new ComposeRunner({ runner, clock }).up(target),
		);
		const last = events.at(-1);
		expect(last?.kind).toBe("error");
		expect(last?.error?.code).toBe("PORT_CONFLICT");
		expect(last?.error?.details?.port).toBe(5432);
		expect(
			events.filter((e) => e.kind === "error" || e.kind === "done"),
		).toHaveLength(1);
	});

	test("error events honour the Progress contract (JSON-safe, no Error instance)", async () => {
		const runner = scripted(
			"",
			"Error response from daemon: Bind for 127.0.0.1:5432 failed: port is already allocated\n",
			1,
		);
		const events = await collect(
			new ComposeRunner({ runner, clock }).up(target),
		);
		const last = events.at(-1);
		expect(last?.error).not.toBeInstanceOf(Error);
		expect(Value.Check(Progress, last)).toBe(true);
		const wire = JSON.parse(JSON.stringify(last)) as Progress;
		expect(wire).toEqual(last as Progress);
		expect(wire.error?.message).toBe(last?.error?.message ?? "missing");
		expect(wire.error?.message).not.toBe("");
		expect(JSON.stringify(last)).not.toContain("cause");
	});

	test("docker missing yields a single COMPOSE_MISSING error", async () => {
		const runner: CommandRunner = {
			spawn() {
				throw new Error("ENOENT");
			},
		};
		const events = await collect(
			new ComposeRunner({ runner, clock }).up(target),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.error?.code).toBe("COMPOSE_MISSING");
	});

	test("upArgs clamps the wait timeout", () => {
		expect(upArgs({ ...target, waitTimeoutSec: 0.2 })).toContain("1");
	});
});

describe("ComposeRunner.down", () => {
	test("passes --volumes only when asked", async () => {
		const runner = scripted("", "", 0);
		const compose = new ComposeRunner({ runner, clock });
		await collect(compose.down(target));
		await collect(compose.down({ ...target, volumes: true }));
		expect(runner.calls[0]?.slice(-2)).toEqual(["down", "--remove-orphans"]);
		expect(runner.calls[1]?.slice(-3)).toEqual([
			"down",
			"--remove-orphans",
			"--volumes",
		]);
	});
});

describe("ComposeRunner.ps", () => {
	test("parses the recorded fixture", async () => {
		const fixture = await Bun.file(
			join(import.meta.dir, "fixtures/local-infra-ps.ndjson"),
		).text();
		const runner = scripted(fixture, "", 0);
		const rows = await new ComposeRunner({ runner }).ps(target);
		expect(rows.map((r) => r.service)).toEqual([
			"postgres",
			"redis",
			"serverless-redis-http",
		]);
		expect(runner.calls[0]?.slice(-4)).toEqual([
			"ps",
			"--all",
			"--format",
			"json",
		]);
	});

	test("rejects with a classified error on failure", async () => {
		const runner = scripted(
			"",
			"Cannot connect to the Docker daemon at unix:///x.sock",
			1,
		);
		const error = await new ComposeRunner({ runner })
			.ps(target)
			.catch((e: unknown) => e);
		expect((error as { code?: string }).code).toBe("DOCKER_UNREACHABLE");
	});
});
