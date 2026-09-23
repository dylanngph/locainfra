import type { StopService } from "./ops.contract";
import { runComposeServiceCommand } from "./support/compose-service-op";

/**
 * `docker compose stop <name>` on the project's rendered compose file. A
 * project that was never started ends with `done` right away.
 * `SERVICE_NOT_FOUND` (as an `error` event) when the service is absent.
 */
export const stopService: StopService = (deps, input) =>
	runComposeServiceCommand(deps, input, {
		run: (target) => deps.lifecycle.stop(target),
		stepMessage: `Stopping ${input.name}`,
		doneMessage: `Stopped ${input.name}`,
		whenNeverStarted: `${input.name} is not running`,
	});
