import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type Clock,
	isOpError,
	LogLine,
	OpError,
	StatsSample,
} from "@locastack/core";
import { Value } from "@sinclair/typebox/value";
import { DockerContainerStreams } from "../container-streams";
import { encodeLogFrame } from "../log-demuxer";
import {
	FakeTransport,
	type StreamProbe,
	streamingResponse,
} from "./fake-transport";

const clock: Clock = { now: () => new Date("2026-09-23T00:00:00.000Z") };
const MUX = { "content-type": "application/vnd.docker.multiplexed-stream" };

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) items.push(item);
	return items;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe("DockerContainerStreams.logs", () => {
	test("demultiplexes frames split across chunks into timestamped lines", async () => {
		const bytes = concat(
			encodeLogFrame(
				"stdout",
				"2026-09-23T03:39:58.100464347Z Ready to accept\n",
			),
			encodeLogFrame(
				"stderr",
				"2026-09-23T03:39:59Z \u001b[33mwarn\u001b[0m\n",
			),
			encodeLogFrame("stdout", "2026-09-23T03:40:00Z café\n"),
		);
		const transport = new FakeTransport([
			[
				"/containers/ls-shop-db/logs",
				() =>
					streamingResponse(
						[
							bytes.subarray(0, 5),
							bytes.subarray(5, 70),
							bytes.subarray(70, bytes.byteLength - 2),
							bytes.subarray(bytes.byteLength - 2),
						],
						{ headers: MUX },
					).response,
			],
		]);
		const lines = await drain(
			new DockerContainerStreams(transport, { clock }).logs("ls-shop-db", {
				follow: false,
				tail: 5,
			}),
		);
		expect(lines).toEqual([
			{
				stream: "stdout",
				text: "Ready to accept",
				at: "2026-09-23T03:39:58.100Z",
			},
			{
				stream: "stderr",
				text: "\u001b[33mwarn\u001b[0m",
				at: "2026-09-23T03:39:59.000Z",
			},
			{ stream: "stdout", text: "café", at: "2026-09-23T03:40:00.000Z" },
		]);
		for (const line of lines) expect(Value.Check(LogLine, line)).toBe(true);
		const query = new URLSearchParams(transport.calls[0]?.split("?")[1]);
		expect(Object.fromEntries(query)).toEqual({
			follow: "0",
			stdout: "1",
			stderr: "1",
			timestamps: "1",
			tail: "5",
		});
	});

	test("reads a TTY container's raw stream as stdout", async () => {
		const transport = new FakeTransport([
			[
				"/containers/",
				() =>
					streamingResponse(
						[
							"2026-09-23T00:00:00Z first\n2026-09-23T00:00:01Z sec",
							"ond\nno-newline",
						],
						{
							headers: { "content-type": "application/vnd.docker.raw-stream" },
						},
					).response,
			],
		]);
		expect(
			await drain(
				new DockerContainerStreams(transport).logs("tty", { follow: false }),
			),
		).toEqual([
			{ stream: "stdout", text: "first", at: "2026-09-23T00:00:00.000Z" },
			{ stream: "stdout", text: "second", at: "2026-09-23T00:00:01.000Z" },
			{ stream: "stdout", text: "no-newline" },
		]);
	});

	test("follow: abort ends the iterator quietly and closes the connection", async () => {
		let probe: StreamProbe | undefined;
		const transport = new FakeTransport([
			[
				"/containers/",
				(init) => {
					const opened = streamingResponse(
						[encodeLogFrame("stdout", "2026-09-23T00:00:00Z one\n")],
						{ keepOpen: true, headers: MUX, signal: init?.signal },
					);
					probe = opened.probe;
					return opened.response;
				},
			],
		]);
		const controller = new AbortController();
		const seen: string[] = [];
		const done = (async () => {
			for await (const line of new DockerContainerStreams(transport).logs(
				"db",
				{ follow: true, signal: controller.signal },
			)) {
				seen.push(line.text);
				if (seen.length === 1) {
					probe?.push(encodeLogFrame("stderr", "2026-09-23T00:00:01Z two\n"));
				}
				if (seen.length === 2) controller.abort();
			}
		})();
		await done;
		expect(seen).toEqual(["one", "two"]);
		expect(probe?.aborted || probe?.cancelled).toBe(true);
		expect(transport.inits[0]?.signal?.aborted).toBe(true);
		expect(
			new URLSearchParams(transport.calls[0]?.split("?")[1]).get("follow"),
		).toBe("1");
	});

	test("breaking out of the loop also closes the connection", async () => {
		const transport = new FakeTransport([
			[
				"/containers/",
				(init) =>
					streamingResponse([encodeLogFrame("stdout", "a\nb\n")], {
						keepOpen: true,
						headers: MUX,
						signal: init?.signal,
					}).response,
			],
		]);
		for await (const line of new DockerContainerStreams(transport).logs("db", {
			follow: true,
		})) {
			expect(line.text).toBe("a");
			break;
		}
		expect(transport.inits[0]?.signal?.aborted).toBe(true);
	});

	test("an already-aborted signal makes no request", async () => {
		const transport = new FakeTransport([]);
		const lines = await drain(
			new DockerContainerStreams(transport).logs("db", {
				follow: true,
				signal: AbortSignal.abort(),
			}),
		);
		expect(lines).toEqual([]);
		expect(transport.calls).toEqual([]);
	});

	test("missing container rejects with SERVICE_NOT_FOUND; bad since with INVALID_INPUT", async () => {
		const streams = new DockerContainerStreams(
			new FakeTransport([
				[
					"/containers/",
					() =>
						Response.json(
							{ message: "No such container: ghost" },
							{ status: 404 },
						),
				],
			]),
		);
		const missing = await rejection(
			drain(streams.logs("ghost", { follow: false })),
		);
		expect(isOpError(missing) && missing.code).toBe("SERVICE_NOT_FOUND");
		const invalid = await rejection(
			drain(streams.logs("ghost", { follow: false, since: "soon" })),
		);
		expect(isOpError(invalid) && invalid.code).toBe("INVALID_INPUT");
	});

	test("unreachable daemon rejects with DOCKER_UNREACHABLE", async () => {
		const streams = new DockerContainerStreams({
			request: () =>
				Promise.reject(
					new OpError("DOCKER_UNREACHABLE", "Docker socket not found"),
				),
		});
		const error = await rejection(
			drain(streams.stats("db", new AbortController().signal)),
		);
		expect(isOpError(error) && error.code).toBe("DOCKER_UNREACHABLE");
	});

	test("a stream cut mid-way (not by us) rejects with DOCKER_UNREACHABLE", async () => {
		const streams = new DockerContainerStreams(
			new FakeTransport([
				[
					"/events",
					() =>
						new Response(
							new ReadableStream({
								start(c) {
									c.error(new Error("socket hang up"));
								},
							}),
						),
				],
			]),
		);
		const error = await rejection(
			drain(streams.events({}, new AbortController().signal)),
		);
		expect(isOpError(error) && error.code).toBe("DOCKER_UNREACHABLE");
	});
});

describe("DockerContainerStreams.stats", () => {
	test("parses recorded NDJSON frames split mid-line", async () => {
		const ndjson = await Bun.file(
			join(import.meta.dir, "fixtures/redis-stats.ndjson"),
		).text();
		const cut = Math.floor(ndjson.length / 3);
		const transport = new FakeTransport([
			[
				"/containers/local-infra-redis-1/stats",
				(init) =>
					streamingResponse([ndjson.slice(0, cut), ndjson.slice(cut)], {
						signal: init?.signal,
					}).response,
			],
		]);
		const samples = await drain(
			new DockerContainerStreams(transport, { clock }).stats(
				"local-infra-redis-1",
				new AbortController().signal,
			),
		);
		expect(transport.calls).toEqual([
			"/containers/local-infra-redis-1/stats?stream=1",
		]);
		expect(samples.map((s) => s.cpuPercent)).toEqual([0, 0.96]);
		expect(samples[1]?.memBytes).toBe(10383360);
		for (const s of samples) expect(Value.Check(StatsSample, s)).toBe(true);
	});

	test("abort ends a live stats stream without throwing", async () => {
		const transport = new FakeTransport([
			[
				"/containers/",
				(init) =>
					streamingResponse(['{"read":"2026-09-23T00:00:01Z"}\n'], {
						keepOpen: true,
						signal: init?.signal,
					}).response,
			],
		]);
		const controller = new AbortController();
		const samples: string[] = [];
		for await (const sample of new DockerContainerStreams(transport, {
			clock,
		}).stats("db", controller.signal)) {
			samples.push(sample.at);
			setTimeout(() => controller.abort(), 5);
		}
		expect(samples).toEqual(["2026-09-23T00:00:01.000Z"]);
	});
});

describe("DockerContainerStreams.events", () => {
	test("filters container events by label and maps JSON lines", async () => {
		const transport = new FakeTransport([
			[
				"/events",
				(init) =>
					streamingResponse(
						[
							'{"Type":"container","Action":"start","Actor":{"ID":"c1","Attributes":{"locastack.stack":"shop"}},"timeNano":1790143200000000000}\n{"Type":"network","Action":"connect","Actor":{"ID":"n"}}\nnot json\n',
							'{"Type":"container","Action":"die","Actor":{"ID":"c1","Attributes":{"exitCode":"1"}},"time":1790143201}\n',
						],
						{ signal: init?.signal },
					).response,
			],
		]);
		const events = await drain(
			new DockerContainerStreams(transport, { clock }).events(
				{ labels: { "locastack.stack": "shop" } },
				new AbortController().signal,
			),
		);
		expect(events).toEqual([
			{
				action: "start",
				id: "c1",
				at: "2026-09-23T06:00:00.000Z",
				attributes: { "locastack.stack": "shop" },
			},
			{
				action: "die",
				id: "c1",
				at: "2026-09-23T06:00:01.000Z",
				attributes: { exitCode: "1" },
			},
		]);
		const query = new URLSearchParams(transport.calls[0]?.split("?")[1]);
		expect(JSON.parse(query.get("filters") ?? "")).toEqual({
			type: ["container"],
			label: ["locastack.stack=shop"],
		});
	});
});
