import { OpError } from "@locainfra/core";
import type { Socket } from "bun";
import { dockerApiError } from "./docker-errors";

/** One upgraded (hijacked) Engine API request, e.g. `POST /exec/{id}/start` with stdin. */
export interface HijackRequest {
	/** Unversioned API path, e.g. `/exec/abc/start`. */
	readonly path: string;
	/** JSON request body. */
	readonly body: string;
	/** Bytes written to the connection once upgraded; the write side is then closed (stdin EOF). */
	readonly stdin: Uint8Array;
	/** Aborting closes the connection and ends the output quietly. */
	readonly signal: AbortSignal;
}

/** Output side of a hijacked connection. */
export interface HijackedStream {
	/** `Content-Type` of the upgrade response (lower-cased, may be empty). */
	readonly contentType: string;
	/** Raw output bytes (multiplexed frames for a non-TTY exec) until the daemon closes the connection. */
	readonly chunks: AsyncIterable<Uint8Array>;
}

/**
 * Sends an Engine API request that upgrades the connection to a raw
 * bidirectional stream (`Connection: Upgrade`, `Upgrade: tcp`), as
 * `docker exec -i` does. `fetch` cannot write after the request body, so
 * stdin needs this.
 */
export interface DockerHijacker {
	/**
	 * @param request - Path, body, stdin bytes and abort signal.
	 * @returns The output stream once the daemon answered `101` (or `200`).
	 * @throws {OpError} `DOCKER_UNREACHABLE` when the socket refuses the
	 *   connection; the mapped Engine API error for any other status.
	 */
	open(request: HijackRequest): Promise<HijackedStream>;
}

/** Where a {@link UnixSocketHijacker} connects ({@link UnixSocketTransport} satisfies it). */
export interface HijackTarget {
	/** @returns Absolute path of the daemon socket. */
	socketPath(): Promise<string>;
	/** @returns Negotiated Engine API version (e.g. `1.44`). */
	apiVersion(): Promise<string>;
}

/** Parsed status line and headers of an HTTP/1.1 response head. */
export interface HttpHead {
	/** Status code. */
	readonly status: number;
	/** Header names lower-cased. */
	readonly headers: ReadonlyMap<string, string>;
}

const HEAD_END = "\r\n\r\n";
/** Largest response head accepted before the connection is dropped. */
const MAX_HEAD_BYTES = 64 * 1024;
/** Largest error body read before giving up on the rest. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Parses an HTTP/1.x response head (without the terminating blank line).
 *
 * @param head - Status line and header lines joined by CRLF.
 * @returns Status and headers, or `null` when the status line is malformed.
 */
export function parseHttpHead(head: string): HttpHead | null {
	const lines = head.split("\r\n");
	const match = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "");
	if (match === null) return null;
	const headers = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		headers.set(
			line.slice(0, colon).trim().toLowerCase(),
			line.slice(colon + 1).trim(),
		);
	}
	return { status: Number(match[1]), headers };
}

/**
 * Decodes a complete `Transfer-Encoding: chunked` body.
 *
 * @param raw - Chunked bytes (possibly incomplete).
 * @returns The payload decoded so far and whether the final chunk was seen.
 */
export function decodeChunked(raw: Uint8Array): {
	readonly body: Uint8Array;
	readonly complete: boolean;
} {
	const parts: Uint8Array[] = [];
	let offset = 0;
	const text = new TextDecoder("latin1");
	for (;;) {
		const lineEnd = indexOfCrlf(raw, offset);
		if (lineEnd < 0) break;
		const size = Number.parseInt(
			text.decode(raw.subarray(offset, lineEnd)).split(";")[0] ?? "",
			16,
		);
		if (!Number.isFinite(size)) break;
		if (size === 0) return { body: join(parts), complete: true };
		const start = lineEnd + 2;
		if (start + size + 2 > raw.byteLength) break;
		parts.push(raw.subarray(start, start + size));
		offset = start + size + 2;
	}
	return { body: join(parts), complete: false };
}

function indexOfCrlf(bytes: Uint8Array, from: number): number {
	for (let i = from; i + 1 < bytes.byteLength; i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
	}
	return -1;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/** Unbounded single-consumer byte queue bridging socket callbacks to an async iterator. */
class ChunkQueue {
	readonly #items: Uint8Array[] = [];
	#ended = false;
	#error: unknown;
	#wake: (() => void) | undefined;

	push(chunk: Uint8Array): void {
		if (this.#ended || chunk.byteLength === 0) return;
		this.#items.push(chunk);
		this.#notify();
	}

	end(error?: unknown): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#error = error;
		this.#notify();
	}

	async *iterate(onExit: () => void): AsyncGenerator<Uint8Array> {
		try {
			for (;;) {
				const next = this.#items.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (this.#ended) {
					if (this.#error !== undefined) throw this.#error;
					return;
				}
				await new Promise<void>((resolve) => {
					this.#wake = resolve;
				});
			}
		} finally {
			onExit();
		}
	}

	#notify(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}
}

/** Writes a buffer fully, honouring socket backpressure (`drain`). */
class SocketWriter {
	#pending: Uint8Array = new Uint8Array(0);
	#flushed: (() => void) | undefined;

	write(socket: Socket<undefined>, data: Uint8Array): Promise<void> {
		this.#pending =
			this.#pending.byteLength === 0 ? data : join([this.#pending, data]);
		return new Promise<void>((resolve) => {
			this.#flushed = resolve;
			this.drain(socket);
		});
	}

	drain(socket: Socket<undefined>): void {
		while (this.#pending.byteLength > 0) {
			const written = socket.write(this.#pending);
			if (written <= 0) return;
			this.#pending = this.#pending.subarray(written);
		}
		const flushed = this.#flushed;
		this.#flushed = undefined;
		flushed?.();
	}
}

/**
 * {@link DockerHijacker} over the daemon's unix socket (`Bun.connect`). It
 * speaks just enough HTTP/1.1: writes the request, waits for the `101`
 * head, writes stdin, half-closes the write side (the daemon then closes the
 * process's stdin) and streams everything that follows.
 */
export class UnixSocketHijacker implements DockerHijacker {
	readonly #target: HijackTarget;

	/** @param target - Socket path and API version source. */
	constructor(target: HijackTarget) {
		this.#target = target;
	}

	/**
	 * @param request - Path, body, stdin and signal.
	 * @returns The upgraded output stream.
	 * @throws {OpError} `DOCKER_UNREACHABLE` on connect failure; mapped API errors otherwise.
	 */
	async open(request: HijackRequest): Promise<HijackedStream> {
		const [socketPath, version] = await Promise.all([
			this.#target.socketPath(),
			this.#target.apiVersion(),
		]);
		const body = new TextEncoder().encode(request.body);
		const head = new TextEncoder().encode(
			[
				`POST /v${version}${request.path} HTTP/1.1`,
				"Host: docker",
				"Content-Type: application/json",
				`Content-Length: ${body.byteLength}`,
				"Connection: Upgrade",
				"Upgrade: tcp",
				"",
				"",
			].join("\r\n"),
		);
		const queue = new ChunkQueue();
		const writer = new SocketWriter();
		let headBuffer: Uint8Array = new Uint8Array(0);
		let parsed: HttpHead | undefined;
		let errorBody: Uint8Array = new Uint8Array(0);
		let settle:
			| { resolve: (s: HijackedStream) => void; reject: (e: unknown) => void }
			| undefined;
		const opened = new Promise<HijackedStream>((resolve, reject) => {
			settle = { resolve, reject };
		});
		let socket: Socket<undefined> | undefined;
		const close = (): void => {
			socket?.terminate();
		};
		const fail = (error: unknown): void => {
			const s = settle;
			settle = undefined;
			s?.reject(error);
			queue.end(error);
			close();
		};
		let errorReported = false;
		const finishError = async (status: number, bytes: Uint8Array) => {
			if (errorReported) return;
			errorReported = true;
			const response = new Response(bytes.slice(), { status });
			fail(await dockerApiError(response, request.path));
		};
		const onErrorBody = (chunk: Uint8Array, ended: boolean): void => {
			const status = parsed?.status ?? 500;
			errorBody = join([errorBody, chunk]);
			const length = Number(
				parsed?.headers.get("content-length") ?? Number.NaN,
			);
			const chunked = parsed?.headers.get("transfer-encoding") === "chunked";
			if (chunked) {
				const decoded = decodeChunked(errorBody);
				if (decoded.complete || ended) void finishError(status, decoded.body);
				return;
			}
			if (
				ended ||
				(Number.isFinite(length) && errorBody.byteLength >= length) ||
				errorBody.byteLength >= MAX_ERROR_BODY_BYTES
			) {
				void finishError(
					status,
					Number.isFinite(length) ? errorBody.subarray(0, length) : errorBody,
				);
			}
		};
		const onUpgraded = (rest: Uint8Array): void => {
			const s = settle;
			settle = undefined;
			queue.push(rest);
			s?.resolve({
				contentType: (parsed?.headers.get("content-type") ?? "").toLowerCase(),
				chunks: queue.iterate(close),
			});
			const sock = socket;
			if (sock === undefined) return;
			void writer
				.write(sock, request.stdin)
				.then(() => sock.shutdown())
				.catch(() => undefined);
		};
		const onAbort = (): void => {
			const s = settle;
			settle = undefined;
			s?.reject(
				new OpError("UNKNOWN", "The Docker request was aborted", {
					details: { aborted: true },
				}),
			);
			queue.end();
			close();
		};
		if (request.signal.aborted) {
			onAbort();
			return opened;
		}
		request.signal.addEventListener("abort", onAbort, { once: true });
		try {
			socket = await Bun.connect({
				unix: socketPath,
				allowHalfOpen: true,
				socket: {
					data(_s, data) {
						const chunk = new Uint8Array(data);
						if (parsed === undefined) {
							headBuffer = join([headBuffer, chunk]);
							const text = new TextDecoder("latin1").decode(headBuffer);
							const end = text.indexOf(HEAD_END);
							if (end < 0) {
								if (headBuffer.byteLength > MAX_HEAD_BYTES) {
									fail(
										new OpError(
											"UNKNOWN",
											"Docker sent an oversized response head",
										),
									);
								}
								return;
							}
							const head = parseHttpHead(text.slice(0, end));
							if (head === null) {
								fail(new OpError("UNKNOWN", "Docker sent an invalid response"));
								return;
							}
							parsed = head;
							const rest = headBuffer.subarray(end + HEAD_END.length);
							headBuffer = new Uint8Array(0);
							if (head.status === 101 || head.status === 200) {
								onUpgraded(rest);
							} else {
								onErrorBody(rest, false);
							}
							return;
						}
						if (parsed.status === 101 || parsed.status === 200) {
							queue.push(chunk);
						} else {
							onErrorBody(chunk, false);
						}
					},
					drain(s) {
						writer.drain(s);
					},
					end(s) {
						if (
							parsed !== undefined &&
							parsed.status !== 101 &&
							parsed.status !== 200
						) {
							onErrorBody(new Uint8Array(0), true);
						}
						s.end();
					},
					close() {
						if (settle !== undefined) {
							if (
								parsed !== undefined &&
								parsed.status !== 101 &&
								parsed.status !== 200
							) {
								onErrorBody(new Uint8Array(0), true);
								return;
							}
							fail(
								new OpError(
									"DOCKER_UNREACHABLE",
									"The Docker connection closed before the exec started",
								),
							);
							return;
						}
						request.signal.removeEventListener("abort", onAbort);
						queue.end();
					},
					error(_s, error) {
						fail(
							new OpError(
								"DOCKER_UNREACHABLE",
								"The Docker connection failed",
								{
									cause: error,
								},
							),
						);
					},
				},
			});
		} catch (cause) {
			request.signal.removeEventListener("abort", onAbort);
			throw new OpError(
				"DOCKER_UNREACHABLE",
				`Cannot reach the Docker daemon at ${socketPath}`,
				{ details: { socket: socketPath }, cause },
			);
		}
		void writer.write(socket, join([head, body])).catch(() => undefined);
		return opened;
	}
}
