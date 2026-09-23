import { describe, expect, test } from "bun:test";
import { type Clock, Progress } from "@locainfra/core";
import { Value } from "@sinclair/typebox/value";
import type {
	CommandRunner,
	RunningCommand,
} from "../../process/command-runner";
import {
	ComposeRunner,
	networkRemoveArgv,
	removeArgs,
	serviceActionArgs,
	volumeRemoveArgv,
} from "../compose-runner";

const target = {
	projectName: "li-shop",
	composeFile: "/tmp/li/stacks/shop/docker-compose.yml",
};
const clock: Clock = { now: () => new Date("2026-09-23T00:00:00.000Z") };
const PREFIX = [
	"docker",
	"compose",
	"--ansi",
	"never",
	"--progress",
	"plain",
	"-p",
	"li-shop",
	"-f",
	"/tmp/li/stacks/shop/docker-compose.yml",
];

interface Script {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode?: number;
}

/** Runner replaying one script per spawn, in order (the last one repeats). */
function scripted(...scripts: Script[]): CommandRunner & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		spawn(argv): RunningCommand {
			const script = scripts[Math.min(calls.length, scripts.length - 1)] ?? {};
			calls.push([...argv]);
			return {
				stdout: new Response(script.stdout ?? "").body ?? new ReadableStream(),
				stderr: new Response(script.stderr ?? "").body ?? new ReadableStream(),
				exited: Promise.resolve(script.exitCode ?? 0),
			};
		},
	};
}

async function collect(iterable: AsyncIterable<Progress>): Promise<Progress[]> {
	const events: Progress[] = [];
	for await (const event of iterable) events.push(event);
	for (const event of events) expect(Value.Check(Progress, event)).toBe(true);
	return events;
}

describe("argv builders", () => {
	test("service actions, rm and volume rm", () => {
		expect(serviceActionArgs("restart", ["main-db", "cache"])).toEqual([
			"restart",
			"--",
			"main-db",
			"cache",
		]);
		expect(removeArgs(["cache"])).toEqual([
			"rm",
			"--stop",
			"--force",
			"-v",
			"--",
			"cache",
		]);
		expect(volumeRemoveArgv("docker", ["li-shop-cache-data"])).toEqual([
			"docker",
			"volume",
			"rm",
			"--force",
			"li-shop-cache-data",
		]);
	});
});

describe("ComposeRunner start / stop / restart", () => {
	for (const action of ["start", "stop", "restart"] as const) {
		test(`${action} runs compose ${action} for the named services and streams progress`, async () => {
			const runner = scripted({
				stderr: ` Container li-shop-main-db  ${action === "stop" ? "Stopping" : "Starting"}\n Container li-shop-main-db  Done\n`,
			});
			const compose = new ComposeRunner({ runner, clock });
			const events = await collect(
				compose[action]({ ...target, services: ["main-db"] }),
			);
			expect(runner.calls).toEqual([[...PREFIX, action, "--", "main-db"]]);
			expect(events.map((e) => e.kind)).toEqual(["log", "log", "done"]);
			expect(events.at(-1)?.message).toBe(`docker compose ${action} finished`);
		});
	}

	test("an empty service list is refused without spawning anything", async () => {
		const runner = scripted({});
		const events = await collect(
			new ComposeRunner({ runner, clock }).stop({ ...target, services: [] }),
		);
		expect(runner.calls).toEqual([]);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("error");
		expect(events[0]?.error?.code).toBe("INVALID_INPUT");
	});

	test("a port conflict on start is classified", async () => {
		const runner = scripted({
			stderr:
				"Error response from daemon: driver failed programming external connectivity on endpoint li-shop-main-db: Bind for 127.0.0.1:5432 failed: port is already allocated\n",
			exitCode: 1,
		});
		const events = await collect(
			new ComposeRunner({ runner, clock }).start({
				...target,
				services: ["main-db"],
			}),
		);
		expect(events.at(-1)?.error).toEqual({
			code: "PORT_CONFLICT",
			message: "Host port 5432 is already in use",
			details: { port: 5432, exitCode: 1 },
		});
	});
});

describe("ComposeRunner.remove", () => {
	test("removes containers only when no volumes are listed", async () => {
		const runner = scripted({ stderr: " Container li-shop-cache  Removed\n" });
		const events = await collect(
			new ComposeRunner({ runner, clock }).remove({
				...target,
				services: ["cache"],
			}),
		);
		expect(runner.calls).toEqual([
			[...PREFIX, "rm", "--stop", "--force", "-v", "--", "cache"],
		]);
		expect(events.map((e) => e.kind)).toEqual(["log", "done"]);
	});

	test("then deletes the listed volumes, ending with exactly one done", async () => {
		const runner = scripted(
			{ stderr: " Container li-shop-cache  Removed\n" },
			{ stdout: "li-shop-cache-data\n" },
		);
		const events = await collect(
			new ComposeRunner({ runner, clock }).remove({
				...target,
				services: ["cache"],
				volumes: ["li-shop-cache-data"],
			}),
		);
		expect(runner.calls[1]).toEqual([
			"docker",
			"volume",
			"rm",
			"--force",
			"li-shop-cache-data",
		]);
		expect(events.map((e) => e.kind)).toEqual(["log", "step", "log", "done"]);
		expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
	});

	test("then deletes the network after the volumes, ending with one done", async () => {
		const runner = scripted({}, { stdout: "li-shop-cache-data\n" }, {});
		const events = await collect(
			new ComposeRunner({ runner, clock }).remove({
				...target,
				services: ["cache"],
				volumes: ["li-shop-cache-data"],
				networks: ["li-shop"],
			}),
		);
		expect(runner.calls[2]).toEqual(networkRemoveArgv("docker", ["li-shop"]));
		expect(runner.calls[2]).toEqual([
			"docker",
			"network",
			"rm",
			"--force",
			"li-shop",
		]);
		expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
		expect(events.at(-1)?.kind).toBe("done");
	});

	test("deletes only the network when no volumes are listed", async () => {
		const runner = scripted({}, {});
		await collect(
			new ComposeRunner({ runner, clock }).remove({
				...target,
				services: ["cache"],
				networks: ["li-shop"],
			}),
		);
		expect(runner.calls).toHaveLength(2);
		expect(runner.calls[1]?.slice(0, 3)).toEqual(["docker", "network", "rm"]);
	});

	test("deletes anonymous volumes with the container (ephemeral data)", async () => {
		const runner = scripted({});
		await collect(
			new ComposeRunner({ runner, clock }).remove({
				...target,
				services: ["tmp"],
			}),
		);
		expect(runner.calls[0]).toContain("-v");
		expect(runner.calls[0]?.indexOf("-v")).toBeLessThan(
			runner.calls[0]?.indexOf("--") ?? -1,
		);
	});

	test("a busy network is logged, not fatal: the run still ends with done", async () => {
		const runner = scripted(
			{ stderr: " Container li-shop-redis  Removed\n" },
			{
				stderr:
					"Error response from daemon: error while removing network: network li-shop id 1234 has active endpoints\n",
				exitCode: 1,
			},
		);
		const events = await collect(
			new ComposeRunner({ runner, clock }).remove({
				...target,
				services: ["redis"],
				networks: ["li-shop"],
			}),
		);
		expect(runner.calls).toHaveLength(2);
		expect(events.some((e) => e.kind === "error")).toBe(false);
		expect(events.filter((e) => e.kind === "done")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			kind: "done",
			message: "docker compose rm finished; network li-shop kept",
		});
		expect(
			events.some(
				(e) =>
					e.kind === "log" &&
					e.message.startsWith("Network li-shop was not deleted"),
			),
		).toBe(true);
	});

	test("keeps volumes when removing the containers failed", async () => {
		const runner = scripted({
			stderr:
				"Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
			exitCode: 1,
		});
		const events = await collect(
			new ComposeRunner({ runner, clock }).remove({
				...target,
				services: ["cache"],
				volumes: ["li-shop-cache-data"],
			}),
		);
		expect(runner.calls).toHaveLength(1);
		expect(events.at(-1)?.error?.code).toBe("DOCKER_UNREACHABLE");
	});

	test("a volume failure names the docker command, not compose", async () => {
		const runner = scripted(
			{},
			{
				stderr:
					"Error response from daemon: remove li-shop-cache-data: volume is in use\n",
				exitCode: 1,
			},
		);
		const events = await collect(
			new ComposeRunner({ runner, clock }).remove({
				...target,
				services: ["cache"],
				volumes: ["li-shop-cache-data"],
			}),
		);
		expect(events.at(-1)?.kind).toBe("error");
		expect(events.at(-1)?.message).toStartWith(
			"docker volume rm failed (exit 1)",
		);
	});

	test("docker missing yields a single COMPOSE_MISSING error", async () => {
		const runner: CommandRunner = {
			spawn() {
				throw new Error("ENOENT");
			},
		};
		const events = await collect(
			new ComposeRunner({ runner, clock }).restart({
				...target,
				services: ["x"],
			}),
		);
		expect(events.map((e) => e.error?.code)).toEqual(["COMPOSE_MISSING"]);
	});
});
