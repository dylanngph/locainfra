import { join } from "node:path";
import type { Paths } from "../ports/paths.port";

/** Prefix of every compose project and network created by LocaInfra. */
export const COMPOSE_PREFIX = "li-";

/**
 * @param stackName - Stack name.
 * @returns Compose project (and network) name, `li-<stackName>`.
 */
export function composeProjectName(stackName: string): string {
	return `${COMPOSE_PREFIX}${stackName}`;
}

/**
 * Docker container name of a service instance. Registration must reject a
 * project/instance pair whose name equals one in another registered project
 * (`li-shop` + `api-db` and `li-shop-api` + `db` both give `li-shop-api-db`).
 *
 * @param stackName - Project name.
 * @param instanceName - Service instance name.
 * @returns `li-<stack>-<instance>`.
 */
export function serviceContainerName(
	stackName: string,
	instanceName: string,
): string {
	return `${COMPOSE_PREFIX}${stackName}-${instanceName}`;
}

/**
 * Docker volume name of one catalog volume of a service instance.
 *
 * @param stackName - Project name.
 * @param instanceName - Service instance name.
 * @param volume - Catalog volume name (e.g. `data`).
 * @returns `li-<stack>-<instance>-<volume>`.
 */
export function serviceVolumeName(
	stackName: string,
	instanceName: string,
	volume: string,
): string {
	return `${COMPOSE_PREFIX}${stackName}-${instanceName}-${volume}`;
}

/**
 * @param paths - Resolved paths.
 * @returns `~/.locainfra/state.json`, the legacy (M1/M2) state file that the SQLite store imports once.
 */
export function stateFilePath(paths: Paths): string {
	return join(paths.stateDir, "state.json");
}

/**
 * @param paths - Resolved paths.
 * @returns `~/.locainfra/dashboard.json` (running dashboard pidfile).
 */
export function dashboardFilePath(paths: Paths): string {
	return join(paths.stateDir, "dashboard.json");
}

/**
 * @param paths - Resolved paths.
 * @param stackName - Stack name.
 * @returns `~/.locainfra/stacks/<stack>` (rendered compose dir).
 */
export function stackDir(paths: Paths, stackName: string): string {
	return join(paths.stacksDir, stackName);
}

/**
 * @param paths - Resolved paths.
 * @param stackName - Stack name.
 * @returns `~/.locainfra/stacks/<stack>/docker-compose.yml`.
 */
export function composeFilePath(paths: Paths, stackName: string): string {
	return join(stackDir(paths, stackName), "docker-compose.yml");
}

/**
 * @param paths - Resolved paths.
 * @param stackName - Stack name.
 * @returns `~/.locainfra/secrets/<stack>.env`.
 */
export function secretsFilePath(paths: Paths, stackName: string): string {
	return join(paths.secretsDir, `${stackName}.env`);
}
