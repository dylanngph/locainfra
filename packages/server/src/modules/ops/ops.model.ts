import { t } from "elysia";

/** Content type of `GET /api/ops/:opId/events`: one JSON `Progress` per line. */
export const OP_EVENTS_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/** `GET /api/ops/:opId/events` params. */
export const OpParams = t.Object({
	opId: t.String({
		pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$",
		maxLength: 128,
		description: "Operation id from a `202 { opId }` response",
	}),
});
/** `GET /api/ops/:opId/events` params. */
export type OpParams = typeof OpParams.static;

/** Error body when the operation is unknown or expired (60 s after it settled). */
export const OpNotFound = t.Object({
	code: t.Literal("OP_NOT_FOUND"),
	message: t.String(),
});
/** Unknown-operation error body. */
export type OpNotFound = typeof OpNotFound.static;

/**
 * Builds the {@link OpNotFound} body.
 *
 * @param opId - Requested operation id.
 * @returns The error body.
 */
export const opNotFound = (opId: string): OpNotFound => ({
	code: "OP_NOT_FOUND",
	message: `No operation ${opId} (unknown, or it finished more than a minute ago)`,
});

/** Reference models of the ops controller, registered under `Ops.`. */
export const OpsModel = {
	params: OpParams,
	notFound: OpNotFound,
};
