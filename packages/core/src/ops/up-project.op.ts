import { errorProgress, withTimestamp } from "../shared/progress";
import { loadProject } from "./load-project.op";
import type { UpProject } from "./ops.contract";
import { upStack } from "./up-stack.op";

/**
 * Loads a registered project ({@link loadProject}) and starts it
 * ({@link upStack}): resolve, render, `compose up --wait`, optionally
 * limited to some services. Ends with exactly one `done` or `error` event.
 */
export const upProject: UpProject = async function* (deps, input) {
	const stack = await loadProject(deps, input);
	if (!stack.ok) {
		yield withTimestamp(
			{ kind: "step", message: `Starting ${input.project}` },
			deps.clock,
		);
		yield errorProgress(stack.error, deps.clock);
		return;
	}
	yield* upStack(deps, {
		stack: stack.value,
		...(input.services !== undefined && { services: input.services }),
	});
};
