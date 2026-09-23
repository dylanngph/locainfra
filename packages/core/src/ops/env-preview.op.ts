import { formatGroupedEnv } from "../env/formats/grouped";
import { ok } from "../shared/result";
import { loadProject } from "./load-project.op";
import type { EnvPreviewOp } from "./ops.contract";
import { envFileOf, projectEnvLines } from "./support/env-lines";
import { readProjectView } from "./support/project-view";

/**
 * The project's exported variables for the Environment page: each service's
 * evaluated `exports` in stack file order, the primary one renamed by
 * `link.names`, and every key of a service prefixed with `<INSTANCE_NAME>_`
 * only when one of its keys collides with an earlier service's. Secret
 * values are masked unless `reveal`. `text` is the serialized preview
 * (dotenv/shell grouped under `# <service> (<type>)`). Services never started
 * show port 0 and masked secrets. Read-only.
 *
 * @returns The preview; `PROJECT_NOT_FOUND`, `STACK_NOT_FOUND`,
 *   `INVALID_STACK` (e.g. an unresolvable name collision), `INVALID_CATALOG`
 *   or `IO`.
 */
export const envPreview: EnvPreviewOp = async (deps, input) => {
	const stack = await loadProject(deps, input);
	if (!stack.ok) return stack;
	const view = await readProjectView(deps, stack.value, "placeholder");
	if (!view.ok) return view;
	const lines = projectEnvLines(view.value.resolved, stack.value, input.reveal);
	if (!lines.ok) return lines;
	return ok({
		format: input.format,
		lines: lines.value.map(({ key, value, service, type }) => ({
			key,
			value,
			service,
			type,
		})),
		text: formatGroupedEnv(input.format, lines.value),
		serviceCount: view.value.resolved.services.length,
		file: envFileOf(stack.value, view.value.state),
	});
};
