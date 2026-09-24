import { useQuery } from "@tanstack/react-query";
import type { SystemSetup } from "../api/system.api";
import { systemQuery, systemSetupQuery } from "../api/system.queries";

/** Whether the app can be used, as far as Docker is concerned. */
export type DockerAvailability =
	| {
			/** `GET /api/system` not answered yet, or the server is unreachable. */
			readonly status: "unknown";
	  }
	| {
			/** Docker and compose answer (or doctor found nothing failing). */
			readonly status: "available";
	  }
	| {
			/** Doctor has a failing check: show the Docker-unavailable screen. */
			readonly status: "unavailable";
			/** The report and the remedy plan. */
			readonly setup: SystemSetup;
	  };

/**
 * Reads `GET /api/system` (cheap, cached, refetched by Refresh) and, only
 * when it reports Docker or compose missing, `GET /api/system/setup`.
 * Unavailable once doctor confirms a failing check. Never polls: both
 * queries refetch on Re-check, Start Docker and Refresh only.
 *
 * @returns The availability.
 */
export function useDockerAvailability(): DockerAvailability {
	const system = useQuery(systemQuery());
	const suspect =
		system.data !== undefined &&
		(system.data.docker === null || system.data.compose === null);
	const setup = useQuery({ ...systemSetupQuery(), enabled: suspect });
	if (system.data === undefined) return { status: "unknown" };
	if (suspect && setup.data !== undefined && !setup.data.doctor.ok)
		return { status: "unavailable", setup: setup.data };
	return { status: "available" };
}
