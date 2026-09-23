import { join } from "node:path";
import type { StateFile } from "../ports/state.port";
import { ioErrorFrom, OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { loadStack } from "../stack/loader";
import { findProjectEntry } from "../stack/project-registry";
import { PROJECT_STACK_FILE_NAME } from "../stack/stack.model";
import type { LoadProject } from "./ops.contract";

/**
 * Loads and validates a registered project's `<root>/locainfra.yaml`.
 *
 * @returns The stack; `PROJECT_NOT_FOUND` when the name is not registered,
 *   `STACK_NOT_FOUND` when the file is gone, `INVALID_STACK` when it is
 *   invalid or now declares another `name`, `IO` when state or the file
 *   cannot be read.
 */
export const loadProject: LoadProject = async (deps, input) => {
	let state: StateFile;
	try {
		state = await deps.state.read();
	} catch (cause) {
		return err(
			ioErrorFrom("Could not read the LocaInfra project registry", cause),
		);
	}
	const entry = findProjectEntry(state, input.project);
	if (entry === undefined) {
		return err(
			new OpError(
				"PROJECT_NOT_FOUND",
				`No project named "${input.project}" is registered`,
				{
					details: {
						project: input.project,
						fix: "Create the project from the dashboard, or run `locainfra up` in its folder.",
					},
				},
			),
		);
	}
	const filePath = join(entry.root, PROJECT_STACK_FILE_NAME);
	const loaded = await loadStack(deps.files, { filePath, root: entry.root });
	if (!loaded.ok) return loaded;
	if (loaded.value.name !== entry.name) {
		return err(
			new OpError(
				"INVALID_STACK",
				`${filePath} now declares name "${loaded.value.name}", but it is registered as "${entry.name}"`,
				{
					details: {
						project: entry.name,
						filePath,
						fix: `Set "name: ${entry.name}" in ${filePath} again, or register the folder under its new name.`,
					},
				},
			),
		);
	}
	return ok(loaded.value);
};
