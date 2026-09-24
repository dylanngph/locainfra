import { treaty } from "@elysiajs/eden";
import type { App } from "@locastack/server";
import { toApiError } from "./api-error";
import { getSessionToken } from "./session-token";

/** Typed Eden Treaty client of the dashboard API. */
export type ApiClient = ReturnType<typeof treaty<App>>;

/**
 * Creates an Eden client that sends the session token on every request.
 *
 * @param baseUrl - Origin of the dashboard server, e.g. `http://127.0.0.1:4488`.
 * @param getToken - Returns the current session token.
 * @returns The typed client.
 */
export function createApiClient(
	baseUrl: string,
	getToken: () => string | null,
): ApiClient {
	return treaty<App>(baseUrl, {
		// Resolve fetch per call so test/mocking layers that patch it are honoured.
		fetcher: ((input, init) => fetch(input, init)) as typeof fetch,
		headers() {
			const token = getToken();
			return token ? { "x-locastack-token": token } : undefined;
		},
	});
}

/** The app-wide API client (same origin as the page). */
export const api: ApiClient = createApiClient(
	window.location.origin,
	getSessionToken,
);

/**
 * Shape shared by every Eden Treaty response. The error side is `unknown`
 * because Eden types it that way for routes whose error bodies it cannot
 * name; at runtime it is `{ status, value }`.
 */
type EdenResult<T> = { data: T; error: null } | { data: null; error: unknown };

const isEdenError = (
	error: unknown,
): error is { readonly status: number; readonly value: unknown } =>
	typeof error === "object" &&
	error !== null &&
	"status" in error &&
	typeof error.status === "number";

/**
 * Awaits an Eden call and returns its data, throwing an `ApiRequestError`
 * for any error status.
 *
 * @param request - Pending Eden call.
 * @returns The response data.
 */
export async function unwrap<T>(
	request: Promise<EdenResult<T>>,
): Promise<NonNullable<T>> {
	const result = await request;
	if (result.error) {
		const { error } = result;
		throw isEdenError(error)
			? toApiError(error.status, error.value)
			: toApiError(0, error);
	}
	if (result.data === null || result.data === undefined) {
		throw toApiError(0, "Empty response");
	}
	return result.data;
}
