import type { Clock } from "../ports/files.port";
import type { OpFinish, OpJournal, OpStart } from "../ports/op-journal.port";
import { isOpError, type OpError } from "./op-error";
import type { Progress } from "./progress.model";
import { toProgressError } from "./progress.model";
import type { Result } from "./result";

/** What {@link journalProgress} and {@link journalResult} record. */
export type JournalEntry = Omit<OpStart, "startedAt">;

async function safely(write: () => Promise<void>): Promise<void> {
	try {
		await write();
	} catch {
		// The journal is history only: it never fails the op it records.
	}
}

/**
 * Records a streamed op in the journal: `start` before the first event,
 * `finish` on its terminal event (`done` → succeeded, `error` → failed with
 * the event's secret-free error), or `cancelled` when the consumer stops
 * early or the stream ends without a terminal event. Events are forwarded
 * unchanged; journal failures are ignored.
 *
 * @param events - The op's progress stream.
 * @param journal - Operation history.
 * @param entry - Id, project, service and kind.
 * @param clock - Time source.
 * @returns The same events.
 */
export async function* journalProgress(
	events: AsyncIterable<Progress>,
	journal: OpJournal,
	entry: JournalEntry,
	clock: Clock,
): AsyncIterable<Progress> {
	await safely(() =>
		journal.start({ ...entry, startedAt: clock.now().toISOString() }),
	);
	let finish: Omit<OpFinish, "finishedAt"> = { status: "cancelled" };
	try {
		for await (const event of events) {
			if (event.kind === "done") finish = { status: "succeeded" };
			if (event.kind === "error") {
				finish = {
					status: "failed",
					error: event.error ?? { code: "UNKNOWN", message: event.message },
				};
			}
			yield event;
			if (event.kind === "done" || event.kind === "error") return;
		}
	} catch (cause) {
		finish = {
			status: "failed",
			error: isOpError(cause)
				? toProgressError(cause)
				: { code: "UNKNOWN", message: "The operation failed" },
		};
		throw cause;
	} finally {
		await safely(() =>
			journal.finish(entry.id, {
				...finish,
				finishedAt: clock.now().toISOString(),
			}),
		);
	}
}

/**
 * Records a `Result` op in the journal (`start`, run, `finish`). Journal
 * failures are ignored.
 *
 * @param run - Runs the op.
 * @param journal - Operation history.
 * @param entry - Id, project, service and kind.
 * @param clock - Time source.
 * @returns The op's result.
 */
export async function journalResult<T>(
	run: () => Promise<Result<T, OpError>>,
	journal: OpJournal,
	entry: JournalEntry,
	clock: Clock,
): Promise<Result<T, OpError>> {
	await safely(() =>
		journal.start({ ...entry, startedAt: clock.now().toISOString() }),
	);
	let finish: Omit<OpFinish, "finishedAt"> = {
		status: "failed",
		error: { code: "UNKNOWN", message: "The operation failed" },
	};
	try {
		const result = await run();
		finish = result.ok
			? { status: "succeeded" }
			: { status: "failed", error: toProgressError(result.error) };
		return result;
	} finally {
		await safely(() =>
			journal.finish(entry.id, {
				...finish,
				finishedAt: clock.now().toISOString(),
			}),
		);
	}
}
