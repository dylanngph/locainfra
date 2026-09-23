import type { DockerRequestInit, DockerTransport } from "../transport";

/** Builds a scripted response; receives the request so streams can honour its signal. */
export type FakeResponder = (
	init: DockerRequestInit | undefined,
	path: string,
) => Response;

/** Scripted {@link DockerTransport} for tests: maps path prefixes to responses. */
export class FakeTransport implements DockerTransport {
	/** Paths requested, in order. */
	readonly calls: string[] = [];
	/** Request options, in order (parallel to {@link FakeTransport.calls}). */
	readonly inits: (DockerRequestInit | undefined)[] = [];
	readonly #routes: ReadonlyArray<readonly [string, FakeResponder]>;

	/** @param routes - `[pathPrefix, responder]` pairs, first match wins. */
	constructor(routes: ReadonlyArray<readonly [string, FakeResponder]>) {
		this.#routes = routes;
	}

	/** Returns the first matching scripted response, or 404. */
	async request(path: string, init?: DockerRequestInit): Promise<Response> {
		this.calls.push(path);
		this.inits.push(init);
		const route = this.#routes.find(([prefix]) => path.startsWith(prefix));
		return route
			? route[1](init, path)
			: Response.json({ message: "not found" }, { status: 404 });
	}
}

/** Observable state of a {@link streamingResponse} body. */
export interface StreamProbe {
	/** Whether the consumer cancelled the body (connection released). */
	cancelled: boolean;
	/** Whether the request signal aborted. */
	aborted: boolean;
	/** Pushes another chunk into an open body. */
	push(chunk: Uint8Array | string): void;
	/** Ends the body. */
	close(): void;
}

/**
 * A response whose body emits `chunks` and then, when `keepOpen`, stays open
 * (like a `follow`/`stream=1` Engine API response) until cancelled or aborted.
 *
 * @param chunks - Initial chunks (strings are UTF-8 encoded).
 * @param options - Keep the body open, headers, and the request signal to honour.
 * @returns The response and a probe to observe/drive it.
 */
export function streamingResponse(
	chunks: ReadonlyArray<Uint8Array | string>,
	options: {
		keepOpen?: boolean;
		headers?: Record<string, string>;
		signal?: AbortSignal;
	} = {},
): { response: Response; probe: StreamProbe } {
	const encode = (c: Uint8Array | string) =>
		typeof c === "string" ? new TextEncoder().encode(c) : c;
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	const probe: StreamProbe = {
		cancelled: false,
		aborted: false,
		push(chunk) {
			if (!closed) controller?.enqueue(encode(chunk));
		},
		close() {
			if (closed) return;
			closed = true;
			controller?.close();
		},
	};
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			for (const chunk of chunks) c.enqueue(encode(chunk));
			if (!options.keepOpen) {
				closed = true;
				c.close();
			}
		},
		cancel() {
			probe.cancelled = true;
			closed = true;
		},
	});
	options.signal?.addEventListener("abort", () => {
		probe.aborted = true;
		if (!closed) {
			closed = true;
			controller?.error(new DOMException("aborted", "AbortError"));
		}
	});
	return {
		response: new Response(body, { headers: options.headers }),
		probe,
	};
}
