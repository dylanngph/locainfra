import { composeProjectName } from "../paths/layout";
import { OpError } from "../shared/op-error";
import {
	errorProgress,
	terminalProgress,
	withTimestamp,
} from "../shared/progress";
import { err, ok, type Result } from "../shared/result";
import { claimProjectName } from "../stack/project-registry";
import type { UpStack, UpStackDeps, UpStackInput } from "./ops.contract";
import { loadDefinitions } from "./support/catalog";
import { checkComposeVersion, UP_WAIT_TIMEOUT_SEC } from "./support/compose";
import { provisionAndRender } from "./support/provision";

/**
 * Checks the compose version (`COMPOSE_MISSING` / `COMPOSE_TOO_OLD`), binds
 * the project's name to its folder (`INVALID_STACK` when another folder owns
 * it or a container name would clash), resolves the stack (pinning ports,
 * generating missing secrets), writes `docker-compose.yml` and `.env` to
 * `~/.locainfra/stacks/<name>/`, then runs `docker compose up -d --wait`,
 * forwarding its progress. Ends with exactly one `done` or `error` event; no
 * event carries a secret value.
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

	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) return definitions;

	const rendered = await provisionAndRender(deps, stack, definitions.value);
	if (!rendered.ok) return rendered;
	return ok(rendered.value.composeFile);
}
