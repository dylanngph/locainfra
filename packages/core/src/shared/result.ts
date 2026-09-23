import type { OpError } from "./op-error";

/**
 * Explicit success/failure return used at every operation boundary.
 *
 * Ops never throw for expected failures; they return `{ ok: false, error }`.
 *
 * @typeParam T - Success value type.
 * @typeParam E - Error type (usually {@link OpError}).
 */
export type Result<T, E = OpError> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };

/**
 * Builds a successful {@link Result}.
 *
 * @param value - The success value.
 * @returns `{ ok: true, value }`.
 */
export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

/**
 * Builds a failed {@link Result}.
 *
 * @param error - The failure value.
 * @returns `{ ok: false, error }`.
 */
export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}
