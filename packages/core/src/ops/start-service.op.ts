import { loadProject } from "./load-project.op";
import type { StartService } from "./ops.contract";
import { loadDefinitions } from "./support/catalog";
import { checkComposeVersion } from "./support/compose";
import { provisionAndRender } from "./support/provision";
import { findService } from "./support/service-input";
import {
	serviceError,
	serviceStep,
	upService,
} from "./support/service-lifecycle";

/**
 * Starts one service: resolves and renders the project (pinning ports and
 * generating secrets when needed), then `compose up -d --wait <name>`, which
 * creates the container when missing (so it also recovers after a port fix)
 * and starts its dependencies. Every event names the service; ends with one
 * `done` or `error` (`SERVICE_NOT_FOUND` when absent).
 */
export const startService: StartService = async function* (deps, input) {
	const { name } = input;
	const clock = deps.clock;
	yield serviceStep(`Starting ${name}`, name, clock);

	const stack = await loadProject(deps, input);
	if (!stack.ok) {
		yield serviceError(stack.error, name, clock);
		return;
	}
	const found = findService(stack.value, name);
	if (!found.ok) {
		yield serviceError(found.error, name, clock);
		return;
	}
	const compose = await checkComposeVersion(deps.compose);
	if (!compose.ok) {
		yield serviceError(compose.error, name, clock);
		return;
	}
	const definitions = await loadDefinitions(deps.catalog);
	if (!definitions.ok) {
		yield serviceError(definitions.error, name, clock);
		return;
	}
	const rendered = await provisionAndRender(
		deps,
		stack.value,
		definitions.value,
	);
	if (!rendered.ok) {
		yield serviceError(rendered.error, name, clock);
		return;
	}
	yield* upService(deps, stack.value, name, `${name} is up`);
};
