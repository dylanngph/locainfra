import type { ComposeServicesInput } from "../../ports/compose.port";
import { OpError } from "../../shared/op-error";
import { terminalProgress, withService } from "../../shared/progress";
import type { Progress } from "../../shared/progress.model";
import { loadProject } from "../load-project.op";
import type { ServiceLifecycleDeps, ServiceRef } from "../ops.contract";
import { composeTarget } from "./compose";
import { findService } from "./service-input";
import { serviceError, serviceStep } from "./service-lifecycle";

/** What {@link runComposeServiceCommand} runs and says. */
export interface ComposeServiceCommand {
	/** Lifecycle method to call. */
	readonly run: (input: ComposeServicesInput) => AsyncIterable<Progress>;
	/** First step message, e.g. `Stopping main-db`. */
	readonly stepMessage: string;
	/** Message of a synthesized `done`. */
	readonly doneMessage: string;
	/**
	 * Outcome when the project was never rendered (no compose file): `done`
	 * with this message, or an `INVALID_INPUT` error when `undefined`.
	 */
	readonly whenNeverStarted?: string;
}

/**
 * Loads the project, checks the service exists, then runs one compose
 * command on it (`stop`, `restart`) against the rendered compose file.
 *
 * @param deps - Project read, lifecycle and paths.
 * @param input - Project and service.
 * @param command - Command and messages.
 * @returns Events tagged with the service, ending with one `done` or `error`.
 */
export async function* runComposeServiceCommand(
	deps: ServiceLifecycleDeps,
	input: ServiceRef,
	command: ComposeServiceCommand,
): AsyncIterable<Progress> {
	const { name } = input;
	yield serviceStep(command.stepMessage, name);
	const stack = await loadProject(deps, input);
	if (!stack.ok) {
		yield serviceError(stack.error, name);
		return;
	}
	const found = findService(stack.value, name);
	if (!found.ok) {
		yield serviceError(found.error, name);
		return;
	}
	const target = composeTarget(deps.paths, stack.value.name);
	let rendered: boolean;
	try {
		rendered = await deps.files.exists(target.composeFile);
	} catch {
		rendered = true;
	}
	if (!rendered) {
		if (command.whenNeverStarted !== undefined) {
			yield { ...serviceStep(command.whenNeverStarted, name), kind: "done" };
			return;
		}
		yield serviceError(
			new OpError(
				"INVALID_INPUT",
				`"${name}" has never been started; start it first`,
				{ details: { project: stack.value.name, service: name } },
			),
			name,
		);
		return;
	}
	yield* withService(
		terminalProgress(
			() => command.run({ ...target, services: [name] }),
			command.doneMessage,
		),
		name,
	);
}
