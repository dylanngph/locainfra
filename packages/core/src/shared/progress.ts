import type { Clock } from "../ports/files.port";
import { isOpError, type OpError } from "./op-error";
import { type Progress, toProgressError } from "./progress.model";

/**
 * Adds an `at` timestamp to an event that has none.
 *
 * @param event - Progress event.
 * @param clock - Time source (wall clock when omitted).
 * @returns The event with `at` set.
 */
export function withTimestamp(event: Progress, clock?: Clock): Progress {
	if (event.at !== undefined) return event;
	return { ...event, at: (clock?.now() ?? new Date()).toISOString() };
}

/**
 * @param error - Op error.
 * @param clock - Time source.
 * @returns An `error` progress event carrying the error's (secret-free) message, code and details.
 */
export function errorProgress(error: OpError, clock?: Clock): Progress {
	return withTimestamp(
		{ kind: "error", message: error.message, error: toProgressError(error) },
		clock,
	);
}

/**
 * Forwards a lifecycle stream so that it ends with exactly one terminal event:
 * stops after the first `done`/`error`, appends `done` when the stream ends
 * without one, and turns a thrown error into an `error` event. Events are
 * forwarded as is: `LifecycleRunner` adapters must already yield the
 * serializable {@link Progress} shape.
 *
 * @param start - Starts the underlying stream.
 * @param doneMessage - Message of the synthesized `done` event.
 * @param clock - Time source for synthesized events.
 * @returns The forwarded events.
 */
export async function* terminalProgress(
	start: () => AsyncIterable<Progress>,
	doneMessage: string,
	clock?: Clock,
): AsyncIterable<Progress> {
	try {
		for await (const event of start()) {
			yield event;
			if (event.kind === "done" || event.kind === "error") return;
		}
	} catch (cause) {
		if (isOpError(cause)) {
			yield errorProgress(cause, clock);
			return;
		}
		const message =
			cause instanceof Error ? cause.message : "docker compose failed";
		yield withTimestamp({ kind: "error", message }, clock);
		return;
	}
	yield withTimestamp({ kind: "done", message: doneMessage }, clock);
}
