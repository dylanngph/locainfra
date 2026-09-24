import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DockerInfo,
	type DockerInfoPort,
	OpError,
	type SocketLocator,
} from "@locastack/core";
import { PollingDaemonWaiter } from "../daemon-waiter";

const INFO: DockerInfo = {
	serverVersion: "27.0.0",
	apiVersion: "1.46",
	os: "linux",
	arch: "arm64",
};

/** Socket locator answering from a script, one value per call (last one repeats). */
class ScriptedLocator implements SocketLocator {
	calls = 0;
	constructor(private readonly answers: (string | null)[]) {}
	async locate(): Promise<string | null> {
		const answer =
			this.answers[Math.min(this.calls, this.answers.length - 1)] ?? null;
		this.calls += 1;
		return answer;
	}
}

/** Fake Engine API client: unreachable until `readyAfter` info() calls. */
class FakeClient implements DockerInfoPort {
	calls = 0;
	constructor(private readonly readyAfter: number) {}
	async info(): Promise<DockerInfo> {
		this.calls += 1;
		if (this.calls <= this.readyAfter) {
			throw new OpError("DOCKER_UNREACHABLE", "not yet");
		}
		return INFO;
	}
}

describe("PollingDaemonWaiter", () => {
	test("resolves true once the daemon answers, re-locating every attempt", async () => {
		const locator = new ScriptedLocator([null, "/a.sock", "/b.sock"]);
		const client = new FakeClient(1);
		const sockets: string[] = [];
		const waiter = new PollingDaemonWaiter({
			locator,
			intervalMs: 5,
			connect: (socket) => {
				sockets.push(socket);
				return client;
			},
		});
		expect(await waiter.waitForDocker(2_000)).toBe(true);
		expect(locator.calls).toBe(3);
		expect(sockets).toEqual(["/a.sock", "/b.sock"]);
	});

	test("resolves false after the deadline", async () => {
		const waiter = new PollingDaemonWaiter({
			locator: new ScriptedLocator(["/a.sock"]),
			intervalMs: 10,
			connect: () => new FakeClient(Number.POSITIVE_INFINITY),
		});
		const started = performance.now();
		expect(await waiter.waitForDocker(80)).toBe(false);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("always makes one attempt, even with no time left", async () => {
		const client = new FakeClient(0);
		const waiter = new PollingDaemonWaiter({
			locator: new ScriptedLocator(["/a.sock"]),
			connect: () => client,
		});
		expect(await waiter.waitForDocker(0)).toBe(true);
		expect(client.calls).toBe(1);
	});

	test("abort resolves false promptly", async () => {
		const controller = new AbortController();
		const waiter = new PollingDaemonWaiter({
			locator: new ScriptedLocator([null]),
			intervalMs: 10_000,
		});
		setTimeout(() => controller.abort(), 30);
		const started = performance.now();
		expect(await waiter.waitForDocker(60_000, controller.signal)).toBe(false);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(await waiter.waitForDocker(60_000, AbortSignal.abort())).toBe(false);
	});

	test("a hung attempt is bounded by attemptTimeoutMs", async () => {
		const hung: DockerInfoPort = { info: () => new Promise(() => {}) };
		const waiter = new PollingDaemonWaiter({
			locator: new ScriptedLocator(["/a.sock"]),
			intervalMs: 5,
			attemptTimeoutMs: 20,
			connect: () => hung,
		});
		expect(await waiter.waitForDocker(100)).toBe(false);
	});

	test("never rejects when the locator throws", async () => {
		const waiter = new PollingDaemonWaiter({
			locator: {
				locate: () => Promise.reject(new Error("docker context broke")),
			},
			intervalMs: 5,
		});
		expect(await waiter.waitForDocker(30)).toBe(false);
	});

	test("default client: talks to a real unix socket", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ls-waiter-"));
		const socket = join(dir, "d.sock");
		const server = Bun.serve({
			unix: socket,
			fetch: () =>
				Response.json({
					Version: "27.0.0",
					ApiVersion: "1.46",
					MinAPIVersion: "1.24",
					Os: "linux",
					Arch: "arm64",
				}),
		});
		try {
			const waiter = new PollingDaemonWaiter({
				locator: new ScriptedLocator([socket]),
				intervalMs: 5,
			});
			expect(await waiter.waitForDocker(2_000)).toBe(true);
		} finally {
			server.stop(true);
			await rm(dir, { recursive: true, force: true });
		}
	});
});
