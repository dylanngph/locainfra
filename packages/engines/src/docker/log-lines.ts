import { type LogLine, type LogOptions, OpError } from "@locainfra/core";
import {
	LOG_FRAME_HEADER_BYTES,
	type LogFrame,
	type LogStreamName,
} from "./log-demuxer";

/** RFC 3339 timestamp Docker prefixes to each line when `timestamps=1`, followed by one space. */
const TIMESTAMP_PREFIX =
	/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) /;

/** RFC 3339 instant with an optional fraction of any precision. */
const RFC3339 =
	/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/;

/**
 * Splits Docker's `timestamps=1` prefix off a log line.
 *
 * @param line - Line as received, e.g. `2026-09-23T10:00:00.123456789Z Ready`.
 * @returns The text without the prefix, and the instant as an ISO-8601
 *   string with millisecond precision (absent when the line has no prefix).
 */
export function splitLogTimestamp(line: string): {
	text: string;
	at?: string;
} {
	const match = TIMESTAMP_PREFIX.exec(line);
	const stamp = match?.[1];
	if (match === null || stamp === undefined) return { text: line };
	const ms = Date.parse(stamp);
	if (Number.isNaN(ms)) return { text: line };
	return {
		text: line.slice(match[0].length),
		at: new Date(ms).toISOString(),
	};
}

/**
 * Converts a `since` option into the Engine API's `seconds[.nanoseconds]` form.
 *
 * @param since - Unix seconds (`1790157600` or `1790157600.5`) or an RFC 3339 instant.
 * @returns The Engine API value, e.g. `1790157600.123456789`.
 * @throws {OpError} `INVALID_INPUT` when `since` is neither.
 */
export function toDockerSince(since: string): string {
	const trimmed = since.trim();
	if (/^\d+(?:\.\d{1,9})?$/.test(trimmed)) return trimmed;
	const match = RFC3339.exec(trimmed);
	const base = match?.[1];
	const zone = match?.[3];
	const ms =
		base === undefined || zone === undefined
			? Number.NaN
			: Date.parse(`${base}${zone}`);
	if (Number.isNaN(ms)) {
		throw new OpError("INVALID_INPUT", `Invalid log "since" value: ${since}`, {
			details: { since },
		});
	}
	const fraction = (match?.[2] ?? "").slice(0, 9).padEnd(9, "0");
	return `${Math.floor(ms / 1000)}.${fraction}`;
}

/**
 * Query string for `GET /containers/{id}/logs` (both streams, timestamps on).
 *
 * @param options - Follow, tail and since.
 * @returns Query without the leading `?`.
 * @throws {OpError} `INVALID_INPUT` for a bad `since` or a negative `tail`.
 */
export function buildLogsQuery(
	options: Pick<LogOptions, "follow" | "tail" | "since">,
): string {
	const tail = options.tail;
	if (tail !== undefined && (!Number.isInteger(tail) || tail < 0)) {
		throw new OpError("INVALID_INPUT", `Invalid log tail: ${tail}`, {
			details: { tail },
		});
	}
	const params = new URLSearchParams({
		follow: options.follow ? "1" : "0",
		stdout: "1",
		stderr: "1",
		timestamps: "1",
		tail: tail === undefined ? "all" : String(tail),
	});
	if (options.since !== undefined) {
		params.set("since", toDockerSince(options.since));
	}
	return params.toString();
}

/**
 * Whether a logs response uses the 8-byte-header multiplexed format (no TTY)
 * rather than the raw stream of a TTY container.
 *
 * @param contentType - Response `Content-Type` (API ≥ 1.42 names the format).
 * @param firstChunk - First body chunk, inspected when the header is not conclusive.
 * @returns `true` for a multiplexed stream.
 */
export function isMultiplexedLogStream(
	contentType: string,
	firstChunk: Uint8Array,
): boolean {
	if (contentType.includes("multiplexed-stream")) return true;
	if (contentType.includes("raw-stream")) return false;
	if (firstChunk.byteLength < LOG_FRAME_HEADER_BYTES) return false;
	const type = firstChunk[0] ?? -1;
	return (
		type >= 0 &&
		type <= 3 &&
		firstChunk[1] === 0 &&
		firstChunk[2] === 0 &&
		firstChunk[3] === 0
	);
}

/**
 * Reassembles demultiplexed frames into complete {@link LogLine}s, one
 * buffer per stream (a frame may hold several lines or part of one).
 * Timestamps are split off with {@link splitLogTimestamp}; a trailing `\r` is dropped.
 */
export class LogLineAssembler {
	readonly #partial: Record<LogStreamName, string> = { stdout: "", stderr: "" };

	/**
	 * @param frames - Frames in arrival order.
	 * @returns Lines completed by these frames.
	 */
	push(frames: readonly LogFrame[]): LogLine[] {
		const lines: LogLine[] = [];
		for (const frame of frames) {
			const parts = (this.#partial[frame.stream] + frame.text).split("\n");
			this.#partial[frame.stream] = parts.pop() ?? "";
			for (const part of parts) lines.push(toLogLine(frame.stream, part));
		}
		return lines;
	}

	/** @returns Lines for any unterminated trailing text (stdout first). */
	end(): LogLine[] {
		const lines: LogLine[] = [];
		for (const stream of ["stdout", "stderr"] as const) {
			const rest = this.#partial[stream];
			this.#partial[stream] = "";
			if (rest !== "") lines.push(toLogLine(stream, rest));
		}
		return lines;
	}
}

function toLogLine(stream: LogStreamName, raw: string): LogLine {
	const { text, at } = splitLogTimestamp(raw.replace(/\r$/, ""));
	return at === undefined ? { stream, text } : { stream, text, at };
}
