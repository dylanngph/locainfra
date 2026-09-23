import type { OpError, Result } from "@locainfra/core";

/**
 * Returns an op result's value or throws its `OpError`, which the
 * error-handler plugin turns into an HTTP status (`OP_ERROR_STATUS`).
 *
 * @param result - An op result.
 * @returns The success value.
 * @throws OpError when the result failed.
 */
export function unwrap<T>(result: Result<T, OpError>): T {
	if (result.ok) return result.value;
	throw result.error;
}
