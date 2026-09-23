/** Output stream of a demultiplexed log frame. */
export type LogStreamName = "stdout" | "stderr";

/** One decoded frame of a multiplexed Docker log/attach stream. */
export interface LogFrame {
	/** Which stream produced the text. */
	readonly stream: LogStreamName;
	/** UTF-8 decoded payload (may contain several lines or a partial line). */
	readonly text: string;
}

/** Size of the multiplexed stream frame header. */
export const LOG_FRAME_HEADER_BYTES = 8;

/**
 * Stream type byte → name. `0` (stdin) is reported as stdout; `3` (systemerr) as stderr.
 *
 * @param type - First header byte.
 * @returns The stream name, or `null` for an unknown type.
 */
function streamName(type: number): LogStreamName | null {
	if (type === 0 || type === 1) return "stdout";
	if (type === 2 || type === 3) return "stderr";
	return null;
}

/**
 * Incremental demultiplexer for Docker's 8-byte-header stream format
 * (`[type, 0, 0, 0, size(uint32 BE)]` + payload), used by `/logs` and `/attach`
 * for containers without a TTY. Frames and multi-byte characters may span chunks.
 */
export class LogDemuxer {
	#buffer: Uint8Array = new Uint8Array(0);
	readonly #decoders: Record<LogStreamName, TextDecoder> = {
		stdout: new TextDecoder(),
		stderr: new TextDecoder(),
	};

	/** Bytes received but not yet forming a complete frame. */
	get pendingBytes(): number {
		return this.#buffer.byteLength;
	}

	/**
	 * Feeds one chunk.
	 *
	 * @param chunk - Raw bytes from the response body.
	 * @returns Frames completed by this chunk (empty payloads are skipped).
	 * @throws Error when a header carries an unknown stream type (the stream is not multiplexed).
	 */
	push(chunk: Uint8Array): LogFrame[] {
		this.#buffer =
			this.#buffer.byteLength === 0 ? chunk : concat(this.#buffer, chunk);
		const frames: LogFrame[] = [];
		let offset = 0;
		while (this.#buffer.byteLength - offset >= LOG_FRAME_HEADER_BYTES) {
			const type = this.#buffer[offset] ?? -1;
			const stream = streamName(type);
			if (stream === null) {
				throw new Error(`Invalid log frame header: stream type ${type}`);
			}
			const view = new DataView(
				this.#buffer.buffer,
				this.#buffer.byteOffset + offset + 4,
				4,
			);
			const size = view.getUint32(0, false);
			const end = offset + LOG_FRAME_HEADER_BYTES + size;
			if (end > this.#buffer.byteLength) break;
			const payload = this.#buffer.subarray(
				offset + LOG_FRAME_HEADER_BYTES,
				end,
			);
			const text = this.#decoders[stream].decode(payload, { stream: true });
			if (text !== "") frames.push({ stream, text });
			offset = end;
		}
		this.#buffer = this.#buffer.slice(offset);
		return frames;
	}

	/**
	 * Ends the stream: flushes partially decoded characters and discards an incomplete frame.
	 *
	 * @returns Frames for any buffered partial characters.
	 */
	end(): LogFrame[] {
		this.#buffer = new Uint8Array(0);
		const frames: LogFrame[] = [];
		for (const stream of ["stdout", "stderr"] as const) {
			const text = this.#decoders[stream].decode();
			if (text !== "") frames.push({ stream, text });
		}
		return frames;
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
}

/**
 * Demultiplexes a complete sequence of chunks (pure; no state kept between calls).
 *
 * @param chunks - Raw body chunks in arrival order.
 * @returns Decoded frames in order.
 * @throws Error when a header carries an unknown stream type.
 */
export function demuxLogChunks(chunks: Iterable<Uint8Array>): LogFrame[] {
	const demuxer = new LogDemuxer();
	const frames: LogFrame[] = [];
	for (const chunk of chunks) frames.push(...demuxer.push(chunk));
	frames.push(...demuxer.end());
	return frames;
}

/**
 * Builds one multiplexed frame (header + payload). Useful for tests and fakes.
 *
 * @param stream - Stream the payload belongs to.
 * @param text - Payload text (UTF-8 encoded).
 * @returns The encoded frame.
 */
export function encodeLogFrame(
	stream: LogStreamName,
	text: string,
): Uint8Array {
	const payload = new TextEncoder().encode(text);
	const frame = new Uint8Array(LOG_FRAME_HEADER_BYTES + payload.byteLength);
	frame[0] = stream === "stdout" ? 1 : 2;
	new DataView(frame.buffer).setUint32(4, payload.byteLength, false);
	frame.set(payload, LOG_FRAME_HEADER_BYTES);
	return frame;
}
