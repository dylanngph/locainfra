import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/shared/lib/api";

/** `GET /api/catalog`: definitions and category chips (static for a session). */
export const catalogQuery = () =>
	queryOptions({
		queryKey: ["catalog"],
		queryFn: () => unwrap(api.api.catalog.get()),
		staleTime: Number.POSITIVE_INFINITY,
	});

/**
 * `GET /api/catalog/:type/free-port`: the host port the Config screen
 * proposes (same rule as `port: auto`; skips every project's pinned ports and
 * the canonical default). The Config route's loader refetches it on every
 * visit; the page reads that value.
 *
 * @param type - Catalog id.
 * @returns Query options resolving to the port, or `null` when none is free.
 */
export const freePortQuery = (type: string) =>
	queryOptions({
		queryKey: ["catalog", type, "free-port"],
		queryFn: async () =>
			(await unwrap(api.api.catalog({ type })["free-port"].get())).port,
		staleTime: 30_000,
	});
