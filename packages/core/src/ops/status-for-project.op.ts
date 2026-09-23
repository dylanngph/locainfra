import { loadProject } from "./load-project.op";
import type { StatusForProject } from "./ops.contract";
import { readProjectView } from "./support/project-view";
import { collectProjectStatus } from "./support/service-status";

/**
 * Live status of every service of a registered project, in stack file order:
 * the resolved stack (pinned ports; never-started services show port 0)
 * joined with its containers (label `locainfra.stack=<project>`) and their
 * inspect details. A service without a running container whose pinned port
 * is busy, or whose container failed to bind, is `port-conflict` with
 * `problem.suggestedPort` set. Read-only.
 *
 * @returns The status; `PROJECT_NOT_FOUND`, `STACK_NOT_FOUND`,
 *   `INVALID_STACK`, `INVALID_CATALOG`, `IO` or `DOCKER_UNREACHABLE`.
 */
export const statusForProject: StatusForProject = async (deps, input) => {
	const stack = await loadProject(deps, input);
	if (!stack.ok) return stack;
	const view = await readProjectView(deps, stack.value, "placeholder");
	if (!view.ok) return view;
	return collectProjectStatus(
		deps,
		view.value,
		Object.keys(stack.value.file.services),
	);
};
