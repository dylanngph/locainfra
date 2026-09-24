import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOpError } from "@locastack/core";
import type { Socket } from "bun";
import { DockerContainerExec } from "../container-exec";
import { decodeChunked, parseHttpHead, UnixSocketHijacker } from "../hijack";
import { demuxLogChunks, encodeLogFrame } from "../log-demuxer";
import { FakeTransport } from "./fake-transport";

let dir: string;
let socketPath: string;
const stops: (() => void)[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ls-hj-"));
	socketPath = join(dir, "d.sock");
});
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	rmSync(dir, { recursive: true, force: true });
});

interface Received {
	head: string;
	body: string;
	stdin: string;
	halfClosed: boolean;
}

/**
 * A fake daemon on a unix socket. `reply` gets the parsed request and
 * returns the bytes to answer with; `upgrade` servers answer `101`, collect
 * stdin until the client half-closes, then send `output(stdin)` and close.
 */
function fakeDaemon(
	mode:
		| { kind: "upgrade"; output: (stdin: string) => Uint8Array }
		| { kind: "raw"; response: string },
): Received {
	const received: Received = {
		head: "",
		body: "",
		stdin: "",
		halfClosed: false,
	};
	let buffer = "";
	let upgraded = false;
	const server = Bun.listen({
		unix: socketPath,
		allowHalfOpen: true,
		socket: {
			data(socket: Socket<undefined>, data) {
				const text = Buffer.from(data).toString("latin1");
				if (upgraded) {
					received.stdin += text;
					return;
				}
				buffer += text;
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				received.head = buffer.slice(0, end);
				const length = Number(
					/Content-Length: (\d+)/i.exec(received.head)?.[1],
				);
				const rest = buffer.slice(end + 4);
				if (rest.length < length) return;
				received.body = rest.slice(0, length);
				if (mode.kind === "raw") {
					socket.write(mode.response);
					return;
				}
				upgraded = true;
				received.stdin += rest.slice(length);
				socket.write(
					"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
				);
			},
			end(socket) {
				received.halfClosed = true;
				if (mode.kind === "upgrade") {
					socket.write(mode.output(received.stdin));
				}
				socket.end();
			},
		},
	});
	stops.push(() => server.stop(true));
	return received;
}

const target = () => ({
	socketPath: async () => socketPath,
	apiVersion: async () => "1.44",
});

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
	const out: Uint8Array[] = [];
	for await (const chunk of chunks) out.push(chunk);
	return out;
}

describe("parseHttpHead / decodeChunked", () => {
	test("parses the status line and lower-cases header names", () => {
		const head = parseHttpHead(
			"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/x\r\nUpgrade: tcp",
		);
		expect(head?.status).toBe(101);
		expect(head?.headers.get("content-type")).toBe("application/x");
		expect(parseHttpHead("garbage")).toBeNull();
	});

	test("decodes a chunked body and reports completeness", () => {
		const raw = new TextEncoder().encode(
			"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n",
		);
		const done = decodeChunked(raw);
		expect(new TextDecoder().decode(done.body)).toBe("Wikipedia");
		expect(done.complete).toBe(true);
		const partial = decodeChunked(raw.subarray(0, 12));
		expect(new TextDecoder().decode(partial.body)).toBe("Wiki");
		expect(partial.complete).toBe(false);
	});
});

describe("UnixSocketHijacker", () => {
	test("upgrades, writes stdin, half-closes and streams the output", async () => {
		const received = fakeDaemon({
			kind: "upgrade",
			output: (stdin) =>
				new Uint8Array([
					...encodeLogFrame("stdout", `read ${stdin.length} bytes`),
					...encodeLogFrame("stderr", "warn"),
				]),
		});
		const stdin = "x".repeat(200_000);
		const stream = await new UnixSocketHijacker(target()).open({
			path: "/exec/e1/start",
			body: '{"Detach":false,"Tty":false}',
			stdin: new TextEncoder().encode(stdin),
			signal: new AbortController().signal,
		});
		expect(stream.contentType).toBe(
			"application/vnd.docker.multiplexed-stream",
		);
		const frames = demuxLogChunks(await drain(stream.chunks));
		expect(frames).toEqual([
			{ stream: "stdout", text: "read 200000 bytes" },
			{ stream: "stderr", text: "warn" },
		]);
		expect(received.head.split("\r\n")[0]).toBe(
			"POST /v1.44/exec/e1/start HTTP/1.1",
		);
		expect(received.head).toContain("Upgrade: tcp");
		expect(received.head).toContain("Connection: Upgrade");
		expect(received.body).toBe('{"Detach":false,"Tty":false}');
		expect(received.halfClosed).toBe(true);
	});

	test("maps an error response with a JSON body", async () => {
		const message = '{"message":"No such exec instance: e9"}';
		fakeDaemon({
			kind: "raw",
			response: `HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${message.length}\r\n\r\n${message}`,
		});
		const error = await new UnixSocketHijacker(target())
			.open({
				path: "/exec/e9/start",
				body: "{}",
				stdin: new Uint8Array(0),
				signal: new AbortController().signal,
			})
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		expect(isOpError(error) && error.code).toBe("UNKNOWN");
		expect(isOpError(error) && error.message).toContain(
			"No such exec instance",
		);
		expect(isOpError(error) && error.details.status).toBe(404);
	});

	test("a 409 through DockerContainerExec becomes SERVICE_NOT_RUNNING", async () => {
		const message = '{"message":"container is paused"}';
		fakeDaemon({
			kind: "raw",
			response: `HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${message.length.toString(16)}\r\n${message}\r\n0\r\n\r\n`,
		});
		const transport = new FakeTransport([
			["/containers/", () => Response.json({ Id: "e1" }, { status: 201 })],
		]);
		const exec = new DockerContainerExec(transport, {
			hijacker: new UnixSocketHijacker(target()),
		});
		const error = await exec
			.run("db", ["psql"], {
				timeoutMs: 5000,
				maxBytes: 100,
				stdin: "select 1",
			})
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		expect(isOpError(error) && error.code).toBe("SERVICE_NOT_RUNNING");
	});

	test("a missing socket is DOCKER_UNREACHABLE", async () => {
		const error = await new UnixSocketHijacker(target())
			.open({
				path: "/exec/e1/start",
				body: "{}",
				stdin: new Uint8Array(0),
				signal: new AbortController().signal,
			})
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		expect(isOpError(error) && error.code).toBe("DOCKER_UNREACHABLE");
	});

	test("aborting after the upgrade ends the output quietly", async () => {
		// A daemon that upgrades but never answers.
		fakeDaemon({ kind: "upgrade", output: () => new Uint8Array(0) });
		const controller = new AbortController();
		const stream = await new UnixSocketHijacker(target()).open({
			path: "/exec/e1/start",
			body: "{}",
			stdin: new Uint8Array(0),
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 20);
		expect(await drain(stream.chunks)).toEqual([]);
	});
});
