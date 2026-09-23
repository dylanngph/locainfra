import type { ProjectEntry } from "../ports/state.port";
import { OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import type { UnregisterProject } from "./ops.contract";

/**
 * Removes a project from the registry in `state.json`. Containers, volumes,
 * secrets, pinned ports and the folder are left alone, so registering the
 * folder again picks everything up.
 *
 * @returns The removed entry, `PROJECT_NOT_FOUND`, or `IO`.
 */
export const unregisterProject: UnregisterProject = async (deps, input) => {
	let removed: ProjectEntry | undefined;
	try {
		await deps.state.update((state) => {
			removed = state.projects.find((p) => p.name === input.project);
			if (removed === undefined) return state;
			return {
				...state,
				projects: state.projects.filter((p) => p.name !== input.project),
			};
		});
	} catch (cause) {
		return err(
			new OpError("IO", "Could not update the LocaInfra project registry", {
				cause,
			}),
		);
	}
	if (removed === undefined) {
		return err(
			new OpError(
				"PROJECT_NOT_FOUND",
				`No project named "${input.project}" is registered`,
				{ details: { project: input.project } },
			),
		);
	}
	return ok(removed);
};
