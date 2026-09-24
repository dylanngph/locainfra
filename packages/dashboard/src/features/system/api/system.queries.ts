import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/shared/lib/api";
import { fetchSystemSetup } from "./system.api";

/** Query key of {@link systemQuery} (the Refresh button refetches it and everything under it). */
export const SYSTEM_KEY = ["system"] as const;

/** Query key of {@link systemSetupQuery} (under {@link SYSTEM_KEY}). */
export const SYSTEM_SETUP_KEY = [...SYSTEM_KEY, "setup"] as const;

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

/**
 * `GET /api/system/setup`: doctor report + setup plan, fetched only while
 * `GET /api/system` says Docker or compose is missing. Re-fetched by the
 * Docker-unavailable screen's Re-check and after Start Docker (no polling).
 */
export const systemSetupQuery = () =>
	queryOptions({
		queryKey: SYSTEM_SETUP_KEY,
		queryFn: fetchSystemSetup,
		staleTime: Number.POSITIVE_INFINITY,
	});
