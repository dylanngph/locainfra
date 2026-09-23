import type { Clock } from "../ports/files.port";
import { terminalProgress, withService } from "./progress";
import type { Progress } from "./progress.model";

/**
 * Runs one step of a multi-step op (a lifecycle call, an archive…):
 * forwards its non-terminal events tagged with `service`, swallows its
 * `done`, and returns its `error` event instead of yielding it, so the
 * caller decides what happens next (e.g. restart the service, then
 * report the error). A thrown error becomes an `error` event.
 *
 * @param start - Starts the underlying stream.
 * @param service - Service instance the events concern.
 * @param clock - Time source for synthesized events.
 * @returns A generator whose return value is the step's `error` event, or
 *   `undefined` when it succeeded.
 */
export async function* subStep(
	start: () => AsyncIterable<Progress>,
	service: string,
	clock?: Clock,
): AsyncGenerator<Progress, Progress | undefined> {
	for await (const event of withService(
		terminalProgress(start, "ok", clock),
		service,
	)) {
		if (event.kind === "error") return event;
		if (event.kind === "done") return undefined;
		yield event;
	}
	return undefined;
}
