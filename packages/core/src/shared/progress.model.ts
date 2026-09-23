import { type Static, Type } from "@sinclair/typebox";
import type { OpError } from "./op-error";

/** Kind of a {@link Progress} event. */
export const ProgressKind = Type.Union([
	Type.Literal("step"),
	Type.Literal("log"),
	Type.Literal("done"),
	Type.Literal("error"),
]);
/** Kind of a {@link Progress} event: a named step, a raw log line, completion, or failure. */
export type ProgressKind = Static<typeof ProgressKind>;

/** Serializable, secret-free form of an {@link OpError} carried by an `error` {@link Progress} event. */
export const ProgressError = Type.Object({
	code: Type.String({ description: "An OpErrorCode, e.g. PORT_CONFLICT" }),
	message: Type.String(),
	details: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Structured context, e.g. `port` and a `fix` hint",
		}),
	),
});
/** Serializable, secret-free form of an {@link OpError}. */
export type ProgressError = Static<typeof ProgressError>;

/**
 * One progress event streamed by a long-running operation (e.g. `upStack`).
 *
 * The dashboard forwards these over the `op:<id>` WebSocket channel; the CLI
 * renders them with a spinner. Messages must never contain secrets.
 */
export const Progress = Type.Object({
	kind: ProgressKind,
	message: Type.String(),
	service: Type.Optional(
		Type.String({ description: "Service id the event concerns, if any" }),
	),
	at: Type.Optional(
		Type.String({ description: "ISO-8601 timestamp of the event" }),
	),
	error: Type.Optional(ProgressError),
});
/** One progress event streamed by a long-running operation. */
export type Progress = Static<typeof Progress>;

/**
 * Converts an {@link OpError} into the plain object carried by `error`
 * progress events (an `Error` instance does not survive `JSON.stringify`).
 *
 * @param error - Op error.
 * @returns Code, message and details; never the cause.
 */
export function toProgressError(error: OpError): ProgressError {
	return Object.keys(error.details).length === 0
		? { code: error.code, message: error.message }
		: {
				code: error.code,
				message: error.message,
				details: { ...error.details },
			};
}
