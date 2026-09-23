import { describe, expect, it } from "bun:test";
import {
	type LogLine,
	ok,
	type ProjectStatus,
	type StatsSample,
} from "@locainfra/core";
import { FakeContainerStreams } from "@locainfra/core/testing";
import {
	CONTAINER,
	status as fixtureStatus,
	PROJECT,
} from "../../../__tests__/support/fixtures";
import { sleep, waitFor } from "../../../__tests__/support/wait";
import type { ObserverSink } from "../backpressure";
import type { ServerMessage } from "../observer.model";
import { ObserverService } from "../observer.service";
import { OpRegistry } from "../op-registry";

class RecordingSink implements ObserverSink {
	readonly messages: ServerMessage[] = [];
	status = 100;
	buffered = 0;
	constructor(readonly id: string) {}
	send(message: ServerMessage): number {
		if (this.status !== 0) this.messages.push(message);
		return this.status;
	}
	bufferedAmount(): number {
		return this.buffered;
	}
	of<T extends ServerMessage["type"]>(type: T, channel?: string) {
		return this.messages.filter(
			(m): m is Extract<ServerMessage, { type: T }> =>
				m.type === type && (channel === undefined || m.channel === channel),
		);
	}
}

const line = (text: string): LogLine => ({ stream: "stdout", text });
const sample = (cpu: number, at = new Date().toISOString()): StatsSample => ({
	cpuPercent: cpu,
	memBytes: 1000 + Math.round(cpu),
	memLimitBytes: 8000,
	netRx: 0,
	netTx: 0,
	at,
});

function setup(current: { status: ProjectStatus } = { status: fixtureStatus }) {
	const streams = new FakeContainerStreams();
	const ops = new OpRegistry();
	let loads = 0;
	const observer = new ObserverService(
		{
			status: async (project) => {
				loads++;
				return project === PROJECT
					? ok(structuredClone(current.status))
					: {
							ok: false as const,
							error: Object.assign(new Error(`No project ${project}`), {
								code: "PROJECT_NOT_FOUND" as const,
								details: {},
								name: "OpError",
							}),
						};
			},
			streams,
			ops,
		},
		{
			logs: { batchMs: 10 },
			stats: { flushMs: 30, retryMs: 10_000 },
			status: { intervalMs: 40, debounceMs: 5 },
		},
	);
	const connect = (id: string) => {
		const sink = new RecordingSink(id);
		observer.connect(sink);
		return sink;
	};
	return { streams, ops, observer, connect, loads: () => loads, current };
}

describe("ObserverService logs", () => {
	it("shares one upstream per container and closes it with the last subscriber", async () => {
		const { streams, observer, connect } = setup();
		streams.logLines.set(
			"c1",
			Array.from({ length: 300 }, (_, i) => line(`old${i}`)),
		);
		const a = connect("a");
		const b = connect("b");
		observer.message("a", { type: "subscribe", channel: "logs:c1" });
		await waitFor(() => a.of("log").length > 0);
		expect(a.of("log")[0]?.payload.lines).toHaveLength(200);
		expect(a.of("log")[0]?.payload.lines[0]?.text).toBe("old100");

		observer.message("b", { type: "subscribe", channel: "logs:c1", tail: 5 });
		expect(b.of("log")[0]?.payload.lines.map((l) => l.text)).toEqual([
			"old295",
			"old296",
			"old297",
			"old298",
			"old299",
		]);
		expect(streams.logsCalls).toHaveLength(1);
		expect(streams.logsCalls[0]?.options).toMatchObject({
			follow: true,
			tail: 200,
		});
		expect(streams.open).toBe(1);

		streams.pushLog("c1", line("new1"));
		streams.pushLog("c1", line("new2"));
		await waitFor(() => b.of("log").length === 2);
		expect(b.of("log")[1]?.payload.lines.map((l) => l.text)).toEqual([
			"new1",
			"new2",
		]);
		await waitFor(() => a.of("log").length === 2);

		observer.message("a", { type: "unsubscribe", channel: "logs:c1" });
		await sleep(5);
		expect(streams.open).toBe(1);
		observer.disconnect("b");
		await waitFor(() => streams.open === 0);
		expect(observer.logs.openUpstreams).toBe(0);
	});

	it("tells subscribers when the container's log stream ends", async () => {
		const ended = {
			logs: async function* () {
				yield line("bye");
			},
			stats: async function* () {},
			events: async function* () {},
		};
		const custom = new ObserverService(
			{
				status: async () => ok(fixtureStatus),
				streams: ended,
				ops: new OpRegistry(),
			},
			{ logs: { batchMs: 5 } },
		);
		const sink = new RecordingSink("s");
		custom.connect(sink);
		custom.message("s", { type: "subscribe", channel: "logs:c9" });
		await waitFor(() => sink.of("log").some((m) => m.payload.ended === true));
		expect(
			sink.of("log").flatMap((m) => m.payload.lines.map((l) => l.text)),
		).toEqual(["bye"]);
		expect(custom.logs.openUpstreams).toBe(0);
		custom.close();
	});

	it("pauses a congested socket's logs and reports skipped lines on drain", async () => {
		const { streams, observer, connect } = setup();
		const slow = connect("slow");
		const fast = connect("fast");
		observer.message("slow", {
			type: "subscribe",
			channel: "logs:c1",
			tail: 0,
		});
		observer.message("fast", {
			type: "subscribe",
			channel: "logs:c1",
			tail: 0,
		});
		await waitFor(() => streams.open === 1);

		slow.status = -1;
		streams.pushLog("c1", line("1"));
		await waitFor(() => slow.of("log").length === 1);
		slow.status = 100;
		slow.buffered = 2 * 1024 * 1024;
		streams.pushLog("c1", line("2"));
		streams.pushLog("c1", line("3"));
		await waitFor(
			() => fast.of("log").flatMap((m) => m.payload.lines).length === 3,
		);
		await sleep(15);
		expect(slow.of("log")).toHaveLength(1);

		slow.buffered = 0;
		observer.drain("slow");
		expect(slow.of("log").at(-1)?.payload).toEqual({ lines: [], skipped: 2 });
		streams.pushLog("c1", line("4"));
		await waitFor(() => slow.of("log").length === 3);
		expect(
			slow
				.of("log")
				.at(-1)
				?.payload.lines.map((l) => l.text),
		).toEqual(["4"]);
		expect(fast.of("log").some((m) => m.payload.skipped !== undefined)).toBe(
			false,
		);
		observer.close();
	});
});

describe("ObserverService stats", () => {
	it("sends the last 24 samples of history, then throttled latest values", async () => {
		const { streams, observer, connect } = setup();
		const first = connect("first");
		observer.message("first", { type: "subscribe", channel: "stats:c1" });
		expect(first.of("stats")[0]?.payload.samples).toEqual([]);
		await waitFor(() => streams.open === 1);
		for (let i = 0; i < 30; i++) streams.pushStats("c1", sample(i));
		await waitFor(() => first.of("stats").length >= 2);
		// Leading sample right away; the burst coalesces into one trailing send.
		await sleep(45);
		const live = first
			.of("stats")
			.slice(1)
			.map((m) => m.payload.samples);
		expect(live[0]?.map((s) => s.cpuPercent)).toEqual([0]);
		expect(live.at(-1)?.map((s) => s.cpuPercent)).toEqual([29]);
		expect(live.length).toBeLessThanOrEqual(3);

		const second = connect("second");
		observer.message("second", { type: "subscribe", channel: "stats:c1" });
		const history = second.of("stats")[0]?.payload.samples ?? [];
		expect(history).toHaveLength(24);
		expect(history[0]?.cpuPercent).toBe(6);
		expect(history.at(-1)?.cpuPercent).toBe(29);
		expect(streams.statsCalls).toEqual(["c1"]);

		observer.disconnect("first");
		await sleep(5);
		expect(streams.open).toBe(1);
		observer.message("second", { type: "unsubscribe", channel: "stats:c1" });
		await waitFor(() => streams.open === 0);

		// History outlives the subscription.
		const third = connect("third");
		observer.message("third", { type: "subscribe", channel: "stats:c1" });
		expect(third.of("stats")[0]?.payload.samples).toHaveLength(24);
		observer.close();
		await waitFor(() => streams.open === 0);
	});
});

describe("ObserverService status", () => {
	it("sends a snapshot, then only changed rows, and stops everything with the last subscriber", async () => {
		const current = { status: structuredClone(fixtureStatus) };
		const { streams, observer, connect } = setup(current);
		const sink = connect("s");
		observer.message("s", { type: "subscribe", channel: `status:${PROJECT}` });
		await waitFor(() => sink.of("snapshot").length === 1);
		expect(sink.of("snapshot")[0]?.payload.services[0]?.state).toBe("running");
		expect(streams.eventsCalls).toEqual([{}]);
		// Running containers are kept on the stats channel for CPU/MEM.
		await waitFor(() => streams.statsCalls.includes(CONTAINER));

		await sleep(100); // a few polls with nothing new
		expect(sink.of("delta")).toHaveLength(0);
		// No sample yet: no usage rather than a made-up 0.
		expect(observer.usageOf(PROJECT)).toBeUndefined();

		streams.pushStats(CONTAINER, sample(12.34));
		await waitFor(() => sink.of("delta").length === 1);
		expect(sink.of("delta")[0]?.payload.services[0]).toMatchObject({
			name: "main-db",
			cpuPercent: 12.3,
			memBytes: 1012,
		});
		expect(observer.usageOf(PROJECT)).toEqual({
			cpuPercent: 12.3,
			memBytes: 1012,
		});

		const row = current.status.services[0];
		if (row) row.state = "stopped";
		streams.pushEvent({
			action: "die",
			id: CONTAINER,
			at: new Date().toISOString(),
			attributes: { "locainfra.stack": PROJECT },
		});
		await waitFor(() => sink.of("delta").length === 2);
		expect(sink.of("delta")[1]?.payload).toMatchObject({
			services: [{ name: "main-db", state: "stopped" }],
			removed: [],
		});
		// Stopped container: its stats upstream closes.
		await waitFor(() => observer.stats.openUpstreams === 0);

		current.status.services = [];
		observer.status.poke(PROJECT);
		await waitFor(() => sink.of("delta").length === 3);
		expect(sink.of("delta")[2]?.payload).toEqual({
			services: [],
			removed: ["main-db"],
		});

		observer.message("s", {
			type: "unsubscribe",
			channel: `status:${PROJECT}`,
		});
		await waitFor(() => streams.open === 0);
		expect(observer.status.eventsOpen).toBe(false);
		observer.close();
	});

	it("gives a later subscriber the cached snapshot and refreshes when an op settles", async () => {
		const { observer, connect, ops, loads } = setup();
		const a = connect("a");
		observer.message("a", { type: "subscribe", channel: `status:${PROJECT}` });
		await waitFor(() => a.of("snapshot").length === 1);
		const b = connect("b");
		observer.message("b", { type: "subscribe", channel: `status:${PROJECT}` });
		expect(b.of("snapshot")).toHaveLength(1);
		const before = loads();
		const id = ops.start({
			kind: "x",
			project: PROJECT,
			run: async function* () {},
		});
		await ops.settled(id);
		expect(loads()).toBe(before + 1);
		observer.close();
	});

	it("reports an unknown project once, not on every poll", async () => {
		const { observer, connect } = setup();
		const sink = connect("s");
		observer.message("s", { type: "subscribe", channel: "status:ghost" });
		await sleep(120);
		expect(sink.of("error")).toEqual([
			{
				channel: "status:ghost",
				type: "error",
				payload: { code: "PROJECT_NOT_FOUND", message: "No project ghost" },
			},
		]);
		observer.close();
	});
});

describe("ObserverService op channel", () => {
	it("replays a finished op and rejects unknown ids", async () => {
		const { observer, connect, ops } = setup();
		const id = ops.start({
			kind: "x",
			run: async function* () {
				yield { kind: "step", message: "Pulling" };
				yield { kind: "done", message: "Done" };
			},
		});
		await ops.settled(id);
		const sink = connect("s");
		observer.message("s", { type: "subscribe", channel: `op:${id}` });
		expect(sink.of("progress").map((m) => m.payload.kind)).toEqual([
			"step",
			"done",
		]);
		observer.message("s", { type: "subscribe", channel: "op:nope" });
		expect(sink.of("error", "op:nope")[0]?.payload.code).toBe("BAD_CHANNEL");
		expect(observer.channelsOf("s")).toEqual([`op:${id}`]);
		observer.close();
	});
});
