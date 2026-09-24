import { join } from "node:path";
import {
	composeFilePath,
	composeProjectName,
	stackDir,
} from "../../paths/layout";
import type { ComposeInfoPort, ComposeTarget } from "../../ports/compose.port";
import type { FileStore } from "../../ports/files.port";
import type { Paths } from "../../ports/paths.port";
import {
	renderCompose,
	renderComposeEnvFile,
} from "../../render/compose-renderer";
import type { ResolvedStack } from "../../resolve/resolved.model";
import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import { isAtLeast, MIN_COMPOSE_VERSION } from "../../shared/version";
import { verifySeedMounts } from "./seed-file";

/** Seconds `docker compose up --wait` waits for services to become healthy. */
export const UP_WAIT_TIMEOUT_SEC = 120;

/** File name of the compose interpolation env file next to `docker-compose.yml`. */
export const COMPOSE_ENV_FILE_NAME = ".env";

/** Permission bits of the compose `.env`, which holds secret values (owner read/write only). */
export const SECRET_FILE_MODE = 0o600;

/**
 * @param paths - Filesystem layout.
 * @param stackName - Project name.
 * @returns The compose project and file of a project.
 */
export function composeTarget(paths: Paths, stackName: string): ComposeTarget {
	return {
		projectName: composeProjectName(stackName),
		composeFile: composeFilePath(paths, stackName),
	};
}

/**
 * Enforces {@link MIN_COMPOSE_VERSION} before any mutating lifecycle call
 * (`--wait` and `--wait-timeout` need it). An unparsable version is let
 * through; `doctor` reports it.
 *
 * @param compose - Compose version reader.
 * @returns `ok`, `COMPOSE_MISSING` or `COMPOSE_TOO_OLD` (with fix hints).
 */
export async function checkComposeVersion(
	compose: ComposeInfoPort,
): Promise<Result<void>> {
	let version: string | null;
	try {
		version = await compose.version();
	} catch {
		version = null;
	}
	if (version === null) {
		return err(
			new OpError("COMPOSE_MISSING", "docker compose is not installed", {
				details: {
					minimum: MIN_COMPOSE_VERSION,
					fix: `Install Docker Desktop (or the docker compose plugin ${MIN_COMPOSE_VERSION}+) and run \`locastack doctor\`.`,
				},
			}),
		);
	}
	if (isAtLeast(version, MIN_COMPOSE_VERSION) === false) {
		return err(
			new OpError(
				"COMPOSE_TOO_OLD",
				`docker compose ${version} is too old (need ${MIN_COMPOSE_VERSION} or newer)`,
				{
					details: {
						version,
						minimum: MIN_COMPOSE_VERSION,
						fix: `Update Docker Desktop (or the docker compose plugin) to ${MIN_COMPOSE_VERSION} or newer.`,
					},
				},
			),
		);
	}
	return ok(undefined);
}

/** Ports needed by {@link writeComposeProject}. */
export interface ComposeWriteDeps {
	/** File access. */
	readonly files: FileStore;
	/** Filesystem layout. */
	readonly paths: Paths;
}

/**
 * Writes `docker-compose.yml` and its secret `.env` (mode
 * {@link SECRET_FILE_MODE}) to `~/.locastack/stacks/<name>/`, both
 * atomically. Seed bind mounts are verified on disk first
 * (`verifySeedMounts`: no symlink out of the project, regular files only).
 *
 * @param deps - Files and paths.
 * @param resolved - The resolved stack.
 * @returns The compose file path, `INVALID_INPUT` for a refused seed file,
 *   or `IO`.
 */
export async function writeComposeProject(
	deps: ComposeWriteDeps,
	resolved: ResolvedStack,
): Promise<Result<string>> {
	const dir = stackDir(deps.paths, resolved.name);
	const composeFile = composeFilePath(deps.paths, resolved.name);
	const verified = await verifySeedMounts(deps.files, resolved);
	if (!verified.ok) return verified;
	try {
		await deps.files.mkdirp(dir);
		await deps.files.writeText(composeFile, renderCompose(verified.value));
		// The `.env` holds the secret values the compose file references.
		await deps.files.writeText(
			join(dir, COMPOSE_ENV_FILE_NAME),
			renderComposeEnvFile(verified.value),
			{ mode: SECRET_FILE_MODE },
		);
	} catch (cause) {
		return err(
			new OpError("IO", `Could not write the compose project to ${dir}`, {
				cause,
				details: { dir },
			}),
		);
	}
	return ok(composeFile);
}
