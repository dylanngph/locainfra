import { type Static, Type } from "@sinclair/typebox";
import { ProgressError } from "../shared/progress.model";

/** Outcome of a journaled operation (`ops.status` in SQLite). */
export const OpStatus = Type.Union([
	Type.Literal("running"),
	Type.Literal("succeeded"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
]);
/** Outcome of a journaled operation. */
export type OpStatus = Static<typeof OpStatus>;

/** Start of a journaled operation (one row of the SQLite `ops` table). */
export const OpStart = Type.Object({
	id: Type.String({ description: "Operation id (the server's opId)" }),
	project: Type.String({ description: "Project (stack) name" }),
	service: Type.Optional(
		Type.String({ description: "Service instance, when the op targets one" }),
	),
	kind: Type.String({
		description:
			"Operation kind, e.g. snapshot.create, snapshot.restore, seed, secret.rotate, import, data.query",
	}),
	startedAt: Type.String({ description: "ISO-8601 start time" }),
});
/** Start of a journaled operation. */
export type OpStart = Static<typeof OpStart>;

/** End of a journaled operation. */
export const OpFinish = Type.Object({
	status: OpStatus,
	finishedAt: Type.String({ description: "ISO-8601 end time" }),
	error: Type.Optional(ProgressError),
});
/** End of a journaled operation. */
export type OpFinish = Static<typeof OpFinish>;

/**
 * Operation history (engines: the SQLite `ops` table, pruned per project).
 * Records carry no secret: `error` is the secret-free `ProgressError` of the
 * op's terminal event. Callers never let a journal failure fail the op.
 */
export interface OpJournal {
	/**
	 * Records a started operation (`status: running`).
	 *
	 * @param start - Id, project, service, kind and start time.
	 */
	start(start: OpStart): Promise<void>;
	/**
	 * Records how an operation ended.
	 *
	 * @param id - Operation id given to {@link OpJournal.start}.
	 * @param finish - Status, end time and error.
	 */
	finish(id: string, finish: OpFinish): Promise<void>;
}
