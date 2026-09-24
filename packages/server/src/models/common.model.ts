import {
	type OpError,
	type OpErrorCode,
	SNAPSHOT_ID_PATTERN,
} from "@locastack/core";
import { Elysia, t } from "elysia";

/**
 * JSON body of every expected API failure (404/409/422/503…): an op's
 * `OpError` without its cause. `details` may carry a `fix` hint or a
 * suggested `port`; never a secret.
 */
export const ApiError = t.Object({
	code: t.String({ description: "An OpErrorCode, e.g. SERVICE_NOT_FOUND" }),
	message: t.String(),
	details: t.Optional(t.Record(t.String(), t.Unknown())),
});
/** JSON body of an expected API failure. */
export type ApiError = typeof ApiError.static;

/**
 * `202` body of every long-running action. Progress streams on the
 * `op:<opId>` WebSocket channel (events are buffered and replayed to late
 * subscribers until 60 s after the terminal `done`/`error`).
 */
export const OpAccepted = t.Object({
	opId: t.String({ description: "Subscribe to op:<opId> for progress" }),
});
/** `202` body of a long-running action. */
export type OpAccepted = typeof OpAccepted.static;

/** Path params of every `/api/projects/:project…` route. */
export const ProjectParams = t.Object({
	project: t.String({ pattern: "^[a-z][a-z0-9-]*$" }),
});
/** Path params naming a project. */
export type ProjectParams = typeof ProjectParams.static;

/** Path params of every `/api/projects/:project/services/:name…` route. */
export const ServiceParams = t.Object({
	project: t.String({ pattern: "^[a-z][a-z0-9-]*$" }),
	name: t.String({ pattern: "^[a-z][a-z0-9-]*$" }),
});
/** Path params naming a service instance. */
export type ServiceParams = typeof ServiceParams.static;

/** Path params of every `/api/projects/:project/services/:name/snapshots/:id…` route. */
export const SnapshotParams = t.Object({
	project: t.String({ pattern: "^[a-z][a-z0-9-]*$" }),
	name: t.String({ pattern: "^[a-z][a-z0-9-]*$" }),
	id: t.String({ pattern: SNAPSHOT_ID_PATTERN }),
});
/** Path params naming a snapshot of a service instance. */
export type SnapshotParams = typeof SnapshotParams.static;

/** Shared reference models, registered under the `Common.` prefix. */
export const CommonModel = {
	error: ApiError,
	opAccepted: OpAccepted,
	projectParams: ProjectParams,
	serviceParams: ServiceParams,
	snapshotParams: SnapshotParams,
};

/**
 * Plugin registering {@link CommonModel} as `Common.Error`,
 * `Common.OpAccepted`, `Common.ProjectParams`,
 * `Common.ServiceParams`, `Common.SnapshotParams`. Controllers `.use()` it to reference them by name.
 */
export const commonModels = new Elysia({ name: "Models.Common" })
	.model(CommonModel)
	.prefix("model", "Common.");

/**
 * HTTP status for each op error code; controllers map a failed `Result` to
 * `status(OP_ERROR_STATUS[code], toApiError(error))`.
 */
export const OP_ERROR_STATUS = {
	DOCKER_UNREACHABLE: 503,
	COMPOSE_MISSING: 503,
	COMPOSE_TOO_OLD: 503,
	DOCKER_NOT_INSTALLED: 409,
	DOCKER_START_TIMEOUT: 503,
	SETUP_UNSUPPORTED: 409,
	SETUP_NEEDS_TERMINAL: 409,
	SETUP_STEP_FAILED: 500,
	SETUP_CANCELLED: 409,
	STACK_NOT_FOUND: 404,
	PROJECT_NOT_FOUND: 404,
	PROJECT_EXISTS: 409,
	SERVICE_NOT_FOUND: 404,
	SERVICE_EXISTS: 409,
	SERVICE_NOT_RUNNING: 409,
	SNAPSHOT_NOT_FOUND: 404,
	INVALID_INPUT: 422,
	INVALID_STACK: 422,
	INVALID_CATALOG: 422,
	PORT_CONFLICT: 409,
	IO: 500,
	UNKNOWN: 500,
} as const satisfies Record<OpErrorCode, number>;

/**
 * `code` of a `504` body: an op gave up after its hard deadline (e.g. a Data
 * tab query over `DATA_QUERY_TIMEOUT_MS`). The op's own code and details
 * (`timedOut: true`, `exitCode`…) stay in `details`.
 */
export const TIMEOUT_CODE = "TIMEOUT";

/**
 * @param error - Op error.
 * @returns Whether the op failed because it hit its deadline (`details.timedOut === true`).
 */
export function isTimeoutError(error: OpError): boolean {
	return error.details.timedOut === true;
}

/**
 * Converts a timed-out op failure into the `504` body:
 * `{ code: "TIMEOUT", message, details: { ...details, opCode } }`.
 *
 * @param error - Op error with `details.timedOut === true`.
 * @returns The API error body.
 */
export function toTimeoutError(error: OpError): ApiError {
	return {
		code: TIMEOUT_CODE,
		message: error.message,
		details: { ...error.details, opCode: error.code },
	};
}

/**
 * Converts an op failure into the API error body (never the cause, which may
 * hold low-level details).
 *
 * @param error - Op error.
 * @returns `{ code, message, details? }`.
 */
export function toApiError(error: OpError): ApiError {
	return Object.keys(error.details).length === 0
		? { code: error.code, message: error.message }
		: {
				code: error.code,
				message: error.message,
				details: { ...error.details },
			};
}
