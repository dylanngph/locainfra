import { OpError } from "@locastack/core";
import { dockerApiError } from "./docker-errors";
import type { DockerTransport } from "./transport";

/** Options for {@link openDockerStream}. */
export interface OpenStreamOptions {
	/** Unversioned API path including query. */
	readonly path: string;
	/** Caller's signal: aborting ends the iteration quietly and closes the connection. */
	readonly signal?: AbortSignal;
	/** Container the stream concerns (a `404` then becomes `SERVICE_NOT_FOUND`). */
	readonly container?: string;
}

/** Response of an open stream: headers plus body chunks. */
export interface OpenedStream {
	/** `Content-Type` of the response (lower-cased, may be empty). */
	readonly contentType: string;
	/** Body chunks; ends when the daemon closes the stream or the signal aborts. */
	readonly chunks: AsyncIterable<Uint8Array>;
}

/**
 * Opens a long-lived Engine API stream and iterates its body.
 *
 * Contract (shared by logs, stats and events):
 * - Aborting `signal` ends the iteration without throwing and closes the
 *   HTTP connection.
 * - Breaking out of the `for await` (or calling `return()`) also closes it.
 * - An unreachable daemon rejects with `DOCKER_UNREACHABLE`; a non-2xx
 *   response rejects with a typed {@link OpError}.
 *
 * @param transport - How requests reach the daemon.
 * @param options - Path, signal and container.
 * @param consume - Receives the opened stream and yields parsed items.
 * @returns The items produced by `consume`.
 */
export async function* openDockerStream<T>(
	transport: DockerTransport,
	options: OpenStreamOptions,
	consume: (stream: OpenedStream) => AsyncIterable<T>,
): AsyncGenerator<T> {
	const outer = options.signal;
	if (outer?.aborted) return;
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(outer?.reason);
	outer?.addEventListener("abort", onAbort, { once: true });
	try {
		let response: Response;
		try {
			response = await transport.request(options.path, {
				signal: controller.signal,
			});
		} catch (error) {
			if (controller.signal.aborted) return;
			throw error;
		}
		if (!response.ok) {
			throw await dockerApiError(response, options.path, options.container);
		}
		const body = response.body;
		if (body === null) return;
		yield* consume({
			contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
			chunks: readBody(body, controller.signal),
		});
	} finally {
		outer?.removeEventListener("abort", onAbort);
		controller.abort();
	}
}

/**
 * Iterates a body stream until it ends or `signal` aborts (then quietly).
 * The reader is cancelled on exit so the connection is released.
 */
async function* readBody(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
	const reader = body.getReader();
	const onAbort = (): void => {
		reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		for (;;) {
			if (signal.aborted) return;
			let result: Awaited<ReturnType<typeof reader.read>>;
			try {
				result = await reader.read();
			} catch (cause) {
				if (signal.aborted) return;
				throw new OpError(
					"DOCKER_UNREACHABLE",
					"The Docker stream closed unexpectedly",
					{ cause },
				);
			}
			if (result.done) return;
			if (result.value.byteLength > 0) yield result.value;
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		reader.cancel().catch(() => undefined);
	}
}

/**
 * Splits byte chunks into UTF-8 lines (terminators removed, blank lines skipped).
 *
 * @param chunks - Body chunks.
 * @returns Non-empty lines; a trailing partial line is emitted at the end.
 */
export async function* splitLines(
	chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of chunks) {
		buffer += decoder.decode(chunk, { stream: true });
		const parts = buffer.split(/\r?\n/);
		buffer = parts.pop() ?? "";
		for (const part of parts) if (part.trim() !== "") yield part;
	}
	buffer += decoder.decode();
	if (buffer.trim() !== "") yield buffer;
}

/**
 * Parses newline-delimited JSON (the Engine API `stats` and `events` streams).
 * Unparseable lines are skipped.
 *
 * @param chunks - Body chunks.
 * @returns One parsed value per line.
 */
export async function* parseJsonLines(
	chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
	for await (const line of splitLines(chunks)) {
		try {
			yield JSON.parse(line);
		} catch {
			// Skip a malformed line rather than killing a long-lived stream.
		}
	}
}
