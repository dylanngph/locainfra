import { isAbsolute, resolve } from "node:path";
import { OpError } from "../../shared/op-error";
import { err, ok, type Result } from "../../shared/result";
import { claimProjectName } from "../../stack/project-registry";
import type { Stack } from "../../stack/stack.model";
import type { ProjectWriteDeps } from "../ops.contract";
import { checkName } from "./service-input";

/**
 * @param name - Project name.
 * @param root - Project folder.
 * @returns The normalised absolute root, or `INVALID_INPUT`.
 */
export function checkProjectInput(name: string, root: string): Result<string> {
	const named = checkName(name, "project");
	if (!named.ok) return named;
	if (!isAbsolute(root)) {
		return err(
			new OpError("INVALID_INPUT", `Project folder must be absolute: ${root}`, {
				details: {
					root,
					fix: "Pass an absolute path, e.g. /Users/me/Developer/shop.",
				},
			}),
		);
	}
	return ok(resolve(root));
}

/**
 * Claims the project's name for its folder in the registry, reporting a
 * taken name or container-name clash as `PROJECT_EXISTS`.
 *
 * @param deps - State and files.
 * @param stack - The project stack.
 * @returns `ok`, `PROJECT_EXISTS` or `IO`.
 */
export async function registerStack(
	deps: ProjectWriteDeps,
	stack: Stack,
): Promise<Result<void>> {
	const claimed = await claimProjectName(deps, stack);
	if (claimed.ok || claimed.error.code !== "INVALID_STACK") return claimed;
	return err(
		new OpError("PROJECT_EXISTS", claimed.error.message, {
			cause: claimed.error,
			details: claimed.error.details,
		}),
	);
}
