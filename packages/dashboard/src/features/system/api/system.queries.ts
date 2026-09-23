import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/shared/lib/api";

/** Query key of {@link systemQuery} (the Refresh button refetches it). */
export const SYSTEM_KEY = ["system"] as const;

/**
 * `GET /api/system`: Docker/compose versions for the header status dot.
 * Fetched once; the project bar's Refresh button refetches it (no polling).
 */
export const systemQuery = () =>
	queryOptions({
		queryKey: SYSTEM_KEY,
		queryFn: () => unwrap(api.api.system.get()),
		staleTime: Number.POSITIVE_INFINITY,
	});
