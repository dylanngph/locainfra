import type { RestartService } from "./ops.contract";
import { runComposeServiceCommand } from "./support/compose-service-op";

/**
 * `docker compose restart <name>` on the project's rendered compose file.
 * `SERVICE_NOT_FOUND` when the service is absent, `INVALID_INPUT` when the
 * project was never started (use `startService`).
 */
export const restartService: RestartService = (deps, input) =>
	runComposeServiceCommand(deps, input, {
		run: (target) => deps.lifecycle.restart(target),
		stepMessage: `Restarting ${input.name}`,
		doneMessage: `Restarted ${input.name}`,
	});
