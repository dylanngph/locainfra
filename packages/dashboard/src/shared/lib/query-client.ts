import { QueryClient } from "@tanstack/react-query";

/**
 * Default freshness of loaded data. The dashboard is load-once: nothing
 * polls, and data is refetched only after a mutation (scoped invalidation),
 * on the Refresh button, or when a page mounts with data older than this.
 * Live mode (opt-in per project) streams status over the WebSocket instead.
 */
export const DEFAULT_STALE_MS = 5 * 60_000;

/**
 * Creates the TanStack Query client: no interval refetching, no refetch on
 * window focus or reconnect.
 *
 * @returns A new client.
 */
export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: DEFAULT_STALE_MS,
				refetchInterval: false,
				refetchOnWindowFocus: false,
				refetchOnReconnect: false,
				retry: (count, error) =>
					count < 2 &&
					!(
						typeof error === "object" &&
						error !== null &&
						"status" in error &&
						typeof error.status === "number" &&
						error.status >= 400 &&
						error.status < 500
					),
			},
		},
	});
}
