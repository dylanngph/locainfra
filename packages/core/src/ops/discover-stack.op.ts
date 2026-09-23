import { dirname, resolve } from "node:path";
import { OpError } from "../shared/op-error";
import { err } from "../shared/result";
import { findProjectStackFile } from "../stack/discovery";
import { loadStack } from "../stack/loader";
import { PROJECT_STACK_FILE_NAME } from "../stack/stack.model";
import type { DiscoverStack } from "./ops.contract";

/**
 * Finds and validates the nearest `locainfra.yaml` walking up from `cwd` to
 * the filesystem root.
 *
 * @returns The stack; `STACK_NOT_FOUND` (with a fix hint) when there is none,
 *   `INVALID_STACK` when the file is invalid, `IO` when it cannot be read.
 */
export const discoverStack: DiscoverStack = async (deps, input) => {
	let filePath: string | null;
	try {
		filePath = await findProjectStackFile(deps.files, input.cwd);
	} catch (cause) {
		return err(
			new OpError("IO", `could not search for ${PROJECT_STACK_FILE_NAME}`, {
				cause,
				details: { cwd: resolve(input.cwd) },
			}),
		);
	}
	if (filePath !== null) {
		return loadStack(deps.files, { filePath, root: dirname(filePath) });
	}

	return err(
		new OpError(
			"STACK_NOT_FOUND",
			`No ${PROJECT_STACK_FILE_NAME} in ${resolve(input.cwd)} or any parent folder`,
			{
				details: {
					cwd: resolve(input.cwd),
					fix: "Run `locainfra` to create a project from the dashboard, or cd into a project folder.",
				},
			},
		),
	);
};
