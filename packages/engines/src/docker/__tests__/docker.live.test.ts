import { describe, expect, test } from "bun:test";
import { ContainerDetails, LogLine, StatsSample } from "@locastack/core";
import { Value } from "@sinclair/typebox/value";
import { DockerContainerStreams } from "../container-streams";
import { DockerClient } from "../docker-client";
import { DockerSocketLocator } from "../socket-locator";
import { UnixSocketTransport } from "../unix-socket-transport";

// READ ONLY: these tests only issue GET requests (version, list, inspect, one
// stats frame, a 5-line log tail, an events subscription that is aborted).
// They never start, stop or otherwise touch containers.
const socket = await new DockerSocketLocator().locate();
const dockerAvailable =
	socket !== null &&
	(await fetch("http://localhost/_ping", { unix: socket })
		.then((r) => r.ok)
		.catch(() => false));

describe.skipIf(!dockerAvailable)("DockerClient (live, read-only)", () => {
	const client = new DockerClient(
		new UnixSocketTransport({ socketPath: socket ?? "" }),
	);

	test("info() reports the daemon", async () => {
		const info = await client.info();
		expect(info.serverVersion).toMatch(/^\d+\.\d+/);
		expect(info.apiVersion).toMatch(/^\d+\.\d+$/);
		expect(info.os).toBe("linux");
	});

	test("list() filters by compose project label", async () => {
		const containers = await client.list({
			labels: { "com.docker.compose.project": "local-infra" },
		});
		for (const container of containers) {
			expect(container.labels["com.docker.compose.project"]).toBe(
				"local-infra",
			);
			expect(container.name.startsWith("/")).toBe(false);
			expect(["healthy", "unhealthy", "starting", "none"]).toContain(
				container.health ?? "none",
			);
		}
		const none = await client.list({
			labels: { "com.docker.compose.project": "ls-no-such-project-xyz" },
		});
		expect(none).toEqual([]);
	});
});

describe.skipIf(!dockerAvailable)(
	"DockerContainerStreams (live, read-only)",
	() => {
		const transport = new UnixSocketTransport({ socketPath: socket ?? "" });
		const client = new DockerClient(transport);
		const streams = new DockerContainerStreams(transport);

		async function runningTarget(): Promise<string | undefined> {
			const containers = await client.list({
				labels: { "com.docker.compose.project": "local-infra" },
			});
			return containers.find((c) => c.state === "running")?.name;
		}

		test("inspect() maps a running container; unknown ids are null", async () => {
			const name = await runningTarget();
			if (name === undefined) return;
			const details = await client.inspect(name);
			expect(Value.Check(ContainerDetails, details)).toBe(true);
			expect(details?.state).toBe("running");
			expect(details?.startedAt).toBeDefined();
			expect(await client.inspect("ls-no-such-container-xyz")).toBeNull();
		});

		test("stats() yields a sample and closes on abort", async () => {
			const name = await runningTarget();
			if (name === undefined) return;
			const controller = new AbortController();
			const samples: StatsSample[] = [];
			for await (const sample of streams.stats(name, controller.signal)) {
				samples.push(sample);
				controller.abort();
			}
			expect(samples).toHaveLength(1);
			expect(Value.Check(StatsSample, samples[0])).toBe(true);
			expect(samples[0]?.memLimitBytes).toBeGreaterThan(0);
		});

		test("logs() tails 5 timestamped lines without following", async () => {
			const name = await runningTarget();
			if (name === undefined) return;
			const lines: LogLine[] = [];
			for await (const line of streams.logs(name, { follow: false, tail: 5 })) {
				lines.push(line);
			}
			expect(lines.length).toBeLessThanOrEqual(5);
			for (const line of lines) {
				expect(Value.Check(LogLine, line)).toBe(true);
				expect(line.at).toMatch(/Z$/);
			}
		});

		test("events() opens and ends quietly on abort", async () => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 150);
			const events: unknown[] = [];
			for await (const event of streams.events(
				{ labels: { "ls-no-such-label-xyz": "" } },
				controller.signal,
			)) {
				events.push(event);
			}
			expect(events).toEqual([]);
		});
	},
);
