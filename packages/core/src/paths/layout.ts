import { join } from "node:path";
import type { Paths } from "../ports/paths.port";
import { GLOBAL_STACK_FILE_NAME } from "../stack/stack.model";

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
 * @param paths - Resolved paths.
 * @returns `~/.locainfra/state.json`.
 */
export function stateFilePath(paths: Paths): string {
	return join(paths.stateDir, "state.json");
}

/**
 * @param paths - Resolved paths.
 * @returns `~/.locainfra/global.yaml`.
 */
export function globalStackFilePath(paths: Paths): string {
	return join(paths.stateDir, GLOBAL_STACK_FILE_NAME);
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
