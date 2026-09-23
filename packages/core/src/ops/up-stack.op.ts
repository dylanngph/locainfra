import { join } from "node:path";
import { composeFilePath, composeProjectName, stackDir } from "../paths/layout";
import type { ComposeInfoPort } from "../ports/compose.port";
import {
	renderCompose,
	renderComposeEnvFile,
} from "../render/compose-renderer";
import { provisionStack } from "../resolve/provision";
import { OpError } from "../shared/op-error";
import {
	errorProgress,
	terminalProgress,
	withTimestamp,
} from "../shared/progress";
import { err, ok, type Result } from "../shared/result";
import { isAtLeast, MIN_COMPOSE_VERSION } from "../shared/version";
import { claimProjectName } from "../stack/project-registry";
import type { UpStack, UpStackDeps, UpStackInput } from "./ops.contract";

/** Seconds `docker compose up --wait` waits for services to become healthy. */
export const UP_WAIT_TIMEOUT_SEC = 120;

/** File name of the compose interpolation env file next to `docker-compose.yml`. */
export const COMPOSE_ENV_FILE_NAME = ".env";

/** Permission bits of the compose `.env`, which holds secret values (owner read/write only). */
export const SECRET_FILE_MODE = 0o600;

/**
 * Checks the compose version (`COMPOSE_MISSING` / `COMPOSE_TOO_OLD`), binds
 * a project stack's name to its folder (`INVALID_STACK` when another folder
 * owns it), resolves the stack (pinning ports, generating missing secrets), writes
 * `docker-compose.yml` and `.env` to `~/.locainfra/stacks/<name>/`, then runs
 * `docker compose up -d --wait`, forwarding its progress. Ends with exactly
 * one `done` or `error` event; no event carries a secret value.
 */
export const upStack: UpStack = async function* (deps, input) {
	const { stack } = input;
	yield withTimestamp(
		{ kind: "step", message: `Resolving ${stack.name}` },
		deps.clock,
	);

	const prepared = await prepare(deps, input);
	if (!prepared.ok) {
		yield errorProgress(prepared.error, deps.clock);
		return;
	}
	yield withTimestamp(
		{ kind: "step", message: `Wrote ${prepared.value}` },
		deps.clock,
	);

	yield* terminalProgress(
		() =>
			deps.lifecycle.up({
				projectName: composeProjectName(stack.name),
				composeFile: prepared.value,
				...(input.services && { services: [...input.services] }),
				wait: true,
				waitTimeoutSec: UP_WAIT_TIMEOUT_SEC,
			}),
		`${stack.name} is up`,
		deps.clock,
	);
};

async function prepare(
	deps: UpStackDeps,
	input: UpStackInput,
): Promise<Result<string>> {
	const { stack } = input;
	const unknown = (input.services ?? []).filter(
		(id) => !Object.hasOwn(stack.file.services, id),
	);
	if (unknown.length > 0) {
		return err(
			new OpError(
				"INVALID_STACK",
				`Not in stack "${stack.name}": ${unknown.join(", ")}`,
				{ details: { stack: stack.name, services: unknown } },
			),
		);
	}

	const compose = await checkComposeVersion(deps.compose);
	if (!compose.ok) return compose;

	const claimed = await claimProjectName(deps, stack);
	if (!claimed.ok) return claimed;

	let definitions: Awaited<ReturnType<UpStackDeps["catalog"]["definitions"]>>;
	try {
		definitions = await deps.catalog.definitions();
	} catch (cause) {
		return err(
			new OpError("INVALID_CATALOG", "Could not load the service catalog", {
				cause,
			}),
		);
	}

	const resolved = await provisionStack(deps, stack, definitions);
	if (!resolved.ok) return resolved;

	const dir = stackDir(deps.paths, stack.name);
	const composeFile = composeFilePath(deps.paths, stack.name);
	try {
		await deps.files.mkdirp(dir);
		await deps.files.writeText(composeFile, renderCompose(resolved.value));
		// The `.env` holds the secret values the compose file references.
		await deps.files.writeText(
			join(dir, COMPOSE_ENV_FILE_NAME),
			renderComposeEnvFile(resolved.value),
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

/**
 * Enforces {@link MIN_COMPOSE_VERSION} before any lifecycle call (`--wait` and
 * `--wait-timeout` need it). An unparsable version is let through; `doctor`
 * reports it.
 */
async function checkComposeVersion(
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
					fix: `Install Docker Desktop (or the docker compose plugin ${MIN_COMPOSE_VERSION}+) and run \`locainfra doctor\`.`,
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
