import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "../../process/command-runner";
import {
	DockerSocketLocator,
	defaultSocketCandidates,
	unixSocketPathFromHost,
} from "../socket-locator";

function fakeRunner(
	stdout: string,
	exitCode = 0,
): CommandRunner & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		spawn(argv) {
			calls.push([...argv]);
			return {
				stdout: new Response(stdout).body ?? new ReadableStream(),
				stderr: new Response("").body ?? new ReadableStream(),
				exited: Promise.resolve(exitCode),
			};
		},
	};
}

const throwingRunner: CommandRunner = {
	spawn() {
		throw new Error("ENOENT: docker");
	},
};

describe("unixSocketPathFromHost", () => {
	test.each([
		["unix:///var/run/docker.sock", "/var/run/docker.sock"],
		["/tmp/docker.sock", "/tmp/docker.sock"],
		["tcp://127.0.0.1:2375", null],
		["npipe:////./pipe/docker_engine", null],
		["", null],
		["unix://", null],
	] as const)("%s → %s", (host, expected) => {
		expect(unixSocketPathFromHost(host)).toBe(expected);
	});
});

describe("defaultSocketCandidates", () => {
	test("macOS prefers the per-user Docker Desktop socket", () => {
		expect(defaultSocketCandidates("darwin", "/Users/me")[0]).toBe(
			"/Users/me/.docker/run/docker.sock",
		);
	});
	test("Linux prefers /var/run/docker.sock", () => {
		expect(defaultSocketCandidates("linux", "/home/me")[0]).toBe(
			"/var/run/docker.sock",
		);
	});
	test("macOS ends with Colima's and OrbStack's sockets (docker CLI not on PATH yet)", () => {
		expect(defaultSocketCandidates("darwin", "/Users/me")).toEqual([
			"/Users/me/.docker/run/docker.sock",
			"/var/run/docker.sock",
			"/Users/me/.colima/default/docker.sock",
			"/Users/me/.orbstack/run/docker.sock",
		]);
	});
	test("other platforms have no unix default", () => {
		expect(defaultSocketCandidates("win32", "C:\\Users\\me")).toEqual([]);
	});
});

describe("DockerSocketLocator", () => {
	const existing = (paths: string[]) => async (p: string) => paths.includes(p);

	test("fresh Colima while `docker` is not runnable: finds ~/.colima/default/docker.sock", async () => {
		const locator = new DockerSocketLocator({
			env: {},
			platform: "darwin",
			home: "/Users/me",
			runner: throwingRunner,
			exists: existing(["/Users/me/.colima/default/docker.sock"]),
		});
		expect(await locator.locate()).toBe(
			"/Users/me/.colima/default/docker.sock",
		);
	});

	test("DOCKER_HOST wins and skips docker context", async () => {
		const runner = fakeRunner("unix:///ctx.sock");
		const locator = new DockerSocketLocator({
			env: { DOCKER_HOST: "unix:///env.sock" },
			runner,
			exists: existing(["/env.sock", "/ctx.sock"]),
		});
		expect(await locator.locate()).toBe("/env.sock");
		expect(runner.calls).toEqual([]);
	});

	test("a non-unix DOCKER_HOST yields null instead of another daemon", async () => {
		const locator = new DockerSocketLocator({
			env: { DOCKER_HOST: "tcp://10.0.0.1:2375" },
			platform: "linux",
			runner: fakeRunner(""),
			exists: existing(["/var/run/docker.sock"]),
		});
		expect(await locator.locate()).toBeNull();
	});

	test("falls back to docker context inspect", async () => {
		const runner = fakeRunner("unix:///Users/me/.colima/docker.sock\n");
		const locator = new DockerSocketLocator({
			env: {},
			platform: "darwin",
			home: "/Users/me",
			runner,
			exists: existing([
				"/Users/me/.colima/docker.sock",
				"/Users/me/.docker/run/docker.sock",
			]),
		});
		expect(await locator.locate()).toBe("/Users/me/.colima/docker.sock");
		expect(runner.calls[0]).toEqual([
			"docker",
			"context",
			"inspect",
			"--format",
			"{{.Endpoints.docker.Host}}",
		]);
	});

	test("falls back to the platform default when docker is missing", async () => {
		const locator = new DockerSocketLocator({
			env: {},
			platform: "darwin",
			home: "/Users/me",
			runner: throwingRunner,
			exists: existing(["/Users/me/.docker/run/docker.sock"]),
		});
		expect(await locator.locate()).toBe("/Users/me/.docker/run/docker.sock");
	});

	test("returns null when nothing exists", async () => {
		const locator = new DockerSocketLocator({
			env: {},
			platform: "linux",
			home: "/home/me",
			runner: fakeRunner("", 1),
			exists: existing([]),
		});
		expect(await locator.locate()).toBeNull();
	});
});
