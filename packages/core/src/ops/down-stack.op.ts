import { composeFilePath, composeProjectName } from "../paths/layout";
import {
	errorProgress,
	terminalProgress,
	withTimestamp,
} from "../shared/progress";
import { checkProjectOwner } from "../stack/project-registry";
import type { DownStack } from "./ops.contract";

/**
 * Runs `docker compose down` for a stack's rendered project, forwarding the
 * runner's progress. Ends with exactly one `done` or `error` event. A project
 * stack whose name is registered to another folder is refused before compose
 * runs, so `down --volumes` can never delete another project's data.
 */
export const downStack: DownStack = async function* (deps, input) {
	const { stack, volumes } = input;
	yield withTimestamp({
		kind: "step",
		message: volumes
			? `Stopping ${stack.name} and removing its volumes`
			: `Stopping ${stack.name}`,
	});
	const owner = await checkProjectOwner(deps, stack);
	if (!owner.ok) {
		yield errorProgress(owner.error);
		return;
	}
	yield* terminalProgress(
		() =>
			deps.lifecycle.down({
				projectName: composeProjectName(stack.name),
				composeFile: composeFilePath(deps.paths, stack.name),
				...(volumes !== undefined && { volumes }),
			}),
		`Stopped ${stack.name}`,
	);
};
