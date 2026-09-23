import { errorProgress, withTimestamp } from "../shared/progress";
import { downStack } from "./down-stack.op";
import { loadProject } from "./load-project.op";
import type { DownProject } from "./ops.contract";

/**
 * Loads a registered project ({@link loadProject}) and stops it
 * ({@link downStack}), optionally deleting its named volumes. Ends with
 * exactly one `done` or `error` event.
 */
export const downProject: DownProject = async function* (deps, input) {
	const stack = await loadProject(deps, input);
	if (!stack.ok) {
		yield withTimestamp({ kind: "step", message: `Stopping ${input.project}` });
		yield errorProgress(stack.error);
		return;
	}
	yield* downStack(deps, {
		stack: stack.value,
		...(input.volumes !== undefined && { volumes: input.volumes }),
	});
};
