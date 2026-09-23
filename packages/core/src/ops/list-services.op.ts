import { loadProject } from "./load-project.op";
import type { ListServices } from "./ops.contract";
import { collectServiceDetails } from "./support/service-detail";

/**
 * Detail of every service of a registered project, in stack file order
 * (`GET …/services`). Read-only.
 *
 * @returns The details, or the errors of `statusForProject`.
 */
export const listServices: ListServices = async (deps, input) => {
	const stack = await loadProject(deps, input);
	if (!stack.ok) return stack;
	return collectServiceDetails(deps, stack.value);
};
