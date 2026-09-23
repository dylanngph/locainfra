import { compareVersions } from "@locainfra/core";

/** Engine API version LocaInfra targets by default (Docker 25+). */
export const PREFERRED_DOCKER_API_VERSION = "1.44";

/**
 * Picks the API version to speak: the preferred one, or the daemon's when it is older.
 *
 * @param preferred - Version the client wants (e.g. `1.44`).
 * @param daemon - `ApiVersion` reported by `GET /version`, if known.
 * @returns The negotiated version.
 */
export function negotiateApiVersion(
	preferred: string,
	daemon: string | undefined,
): string {
	if (daemon === undefined || !/^\d+\.\d+$/.test(daemon)) return preferred;
	return (compareVersions(daemon, preferred) ?? 0) < 0 ? daemon : preferred;
}
