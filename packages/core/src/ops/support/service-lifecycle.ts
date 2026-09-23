import type { LifecycleRunner } from "../../ports/compose.port";
import type { Clock } from "../../ports/files.port";
import type { Paths } from "../../ports/paths.port";
import type { OpError } from "../../shared/op-error";
import {
	errorProgress,
	terminalProgress,
	withService,
	withTimestamp,
} from "../../shared/progress";
import type { Progress } from "../../shared/progress.model";
import type { Stack } from "../../stack/stack.model";
import { composeTarget, UP_WAIT_TIMEOUT_SEC } from "./compose";

/**
 * @param message - Step message.
 * @param service - Service instance name.
 * @param clock - Time source.
 * @returns A timestamped `step` event about `service`.
 */
export function serviceStep(
	message: string,
	service: string,
	clock?: Clock,
): Progress {
	return withTimestamp({ kind: "step", message, service }, clock);
}

/**
 * @param error - Failure.
 * @param service - Service instance name.
 * @param clock - Time source.
 * @returns A timestamped `error` event about `service`.
 */
export function serviceError(
	error: OpError,
	service: string,
	clock?: Clock,
): Progress {
	return { ...errorProgress(error, clock), service };
}

/** Ports needed by {@link upService}. */
export interface UpServiceDeps {
	/** Compose lifecycle. */
	readonly lifecycle: LifecycleRunner;
	/** Filesystem layout. */
	readonly paths: Paths;
	/** Time source. */
	readonly clock?: Clock;
}

/**
 * `docker compose up -d --wait <service>` (compose also starts the
 * service's dependencies), every event tagged with the service and ending
 * with exactly one `done` or `error`.
 *
 * @param deps - Lifecycle, paths and clock.
 * @param stack - The project stack.
 * @param service - Instance name.
 * @param doneMessage - Message of a synthesized `done`.
 * @returns The progress stream.
 */
export function upService(
	deps: UpServiceDeps,
	stack: Stack,
	service: string,
	doneMessage: string,
): AsyncIterable<Progress> {
	return withService(
		terminalProgress(
			() =>
				deps.lifecycle.up({
					...composeTarget(deps.paths, stack.name),
					services: [service],
					wait: true,
					waitTimeoutSec: UP_WAIT_TIMEOUT_SEC,
				}),
			doneMessage,
			deps.clock,
		),
		service,
	);
}
