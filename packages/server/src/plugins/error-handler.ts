import { isOpError } from "@locastack/core";
import { Elysia } from "elysia";
import {
	isTimeoutError,
	OP_ERROR_STATUS,
	toApiError,
	toTimeoutError,
} from "../models/common.model";

/**
 * Maps failures thrown by services to HTTP responses:
 * - an `OpError` whose `details.timedOut` is true (an op hit its hard
 *   deadline, e.g. a Data tab query) → `504 { code: "TIMEOUT", message, details }`;
 * - any other `OpError` → `OP_ERROR_STATUS[code]` with `{ code, message, details? }`;
 * - any other unexpected error → `500 { code: "UNKNOWN", message }` without
 *   the original message (it could leak paths or command output).
 * Elysia's own errors (validation `422`, `404` route not found, parse) keep
 * their default handling. Global, so it covers every module.
 */
export const errorHandler = new Elysia({ name: "Plugin.ErrorHandler" }).onError(
	{ as: "global" },
	({ code, error, status }) => {
		if (isOpError(error)) {
			if (isTimeoutError(error)) return status(504, toTimeoutError(error));
			return status(OP_ERROR_STATUS[error.code], toApiError(error));
		}
		if (code === "UNKNOWN" || code === "INTERNAL_SERVER_ERROR")
			return status(500, {
				code: "UNKNOWN",
				message: "Internal server error",
			});
	},
);
