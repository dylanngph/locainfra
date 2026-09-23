import type { ChannelError } from "../observer.model";

/** Timer handle returned by `setTimeout`/`setInterval`. */
export type Timer = ReturnType<typeof setTimeout>;

/**
 * Maps a failure of an upstream Docker stream to a channel `error` payload.
 * Never includes the raw error text (it could echo request data).
 *
 * @param error - What the stream threw.
 * @returns A `DOCKER_UNREACHABLE` error payload.
 */
export function streamFailure(error: unknown): ChannelError {
	const code =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		/^[A-Z_]+$/.test(error.code)
			? error.code
			: "DOCKER_UNREACHABLE";
	return { code, message: "The Docker stream failed or is unreachable" };
}

/**
 * Starts a timer that does not keep the process alive.
 *
 * @param fn - Callback.
 * @param ms - Delay.
 * @returns The handle.
 */
export function later(fn: () => void, ms: number): Timer {
	const timer = setTimeout(fn, ms);
	(timer as { unref?: () => void }).unref?.();
	return timer;
}
