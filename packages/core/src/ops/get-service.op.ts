import { OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { loadProject } from "./load-project.op";
import type { GetService } from "./ops.contract";
import { collectServiceDetails } from "./support/service-detail";

/**
 * Status, effective non-secret config, secret names and volumes of one
 * service (the service detail page). Read-only.
 *
 * @returns The detail; `SERVICE_NOT_FOUND` when the project has no such
 *   service, plus the errors of `statusForProject`.
 */
export const getService: GetService = async (deps, input) => {
	const stack = await loadProject(deps, input);
	if (!stack.ok) return stack;
	const details = await collectServiceDetails(deps, stack.value, input.name);
	if (!details.ok) return details;
	const [detail] = details.value;
	if (detail === undefined) {
		return err(
			new OpError(
				"SERVICE_NOT_FOUND",
				`Project "${input.project}" has no service "${input.name}"`,
				{ details: { project: input.project, service: input.name } },
			),
		);
	}
	return ok(detail);
};
