import { basename, join } from "node:path";
import {
	err,
	loadStack,
	type OpError,
	ok,
	PROJECT_STACK_FILE_NAME,
	type Result,
} from "@locastack/core";
import type { CliDeps } from "../../cli.types";

/**
 * A valid project name derived from a folder name: lower case, runs of other
 * characters become `-`, leading non-letters dropped (`My App 2` → `my-app-2`).
 *
 * @param root - Absolute folder.
 * @returns A name matching `^[a-z][a-z0-9-]*$` (`project` when nothing is left).
 */
export function projectNameFromDir(root: string): string {
	const slug = basename(root)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/-+$/, "");
	return slug || "project";
}

/**
 * `--project <dir>`: registers the folder so the dashboard can preselect it.
 * A folder with `locastack.yaml` is registered under the name in that file
 * (a no-op when it already is); otherwise a fresh `locastack.yaml` named
 * after the folder is created and registered.
 *
 * @param deps - Composition root.
 * @param root - Absolute project folder.
 * @returns The project name, or the op error.
 */
export async function registerProjectDir(
	deps: CliDeps,
	root: string,
): Promise<Result<string, OpError>> {
	const filePath = join(root, PROJECT_STACK_FILE_NAME);
	const files = deps.projects.files;
	if (await files.exists(filePath)) {
		const loaded = await loadStack(files, { filePath, root });
		if (!loaded.ok) return loaded;
		const registered = await deps.ops.registerProject(deps.projects, {
			name: loaded.value.name,
			root,
		});
		return registered.ok ? ok(registered.value.name) : err(registered.error);
	}
	const created = await deps.ops.createProject(deps.projects, {
		name: projectNameFromDir(root),
		root,
	});
	return created.ok ? ok(created.value.name) : err(created.error);
}
