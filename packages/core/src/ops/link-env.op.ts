import { isAbsolute, relative, resolve, sep } from "node:path";
import { formatGroupedEnv } from "../env/formats/grouped";
import { writeLinkedEnvFile } from "../env/link/link-file";
import { OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { loadProject } from "./load-project.op";
import type { LinkEnv } from "./ops.contract";
import { envFileOf, projectEnvLines } from "./support/env-lines";
import { readProjectView } from "./support/project-view";

/**
 * @param root - Project folder.
 * @param file - Env file relative to it.
 * @returns Whether `file` stays inside `root`.
 */
function isInside(root: string, file: string): boolean {
	if (file === "" || isAbsolute(file)) return false;
	const rel = relative(root, resolve(root, file));
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${sep}`) &&
		!isAbsolute(rel)
	);
}

/**
 * Writes the project's revealed variables (dotenv, grouped by service)
 * between the `# locainfra:start` / `# locainfra:end` markers of
 * `<root>/<file>` (default `link.file`, else the registry's `envFile`, else
 * `.env`), leaving the rest of the file untouched; the file gets mode 0600.
 * Every service must have been started once (`INVALID_STACK` otherwise, so
 * no placeholder ever lands in the file).
 *
 * @returns The absolute path and the number of variables written;
 *   `INVALID_INPUT` when the file escapes the project root, `IO` for
 *   unbalanced markers or write failures, plus the errors of `loadProject`.
 */
export const linkEnv: LinkEnv = async (deps, input) => {
	const stack = await loadProject(deps, input);
	if (!stack.ok) return stack;
	const view = await readProjectView(deps, stack.value, "error");
	if (!view.ok) return view;
	const file = input.file ?? envFileOf(stack.value, view.value.state);
	if (!isInside(stack.value.root, file)) {
		return err(
			new OpError(
				"INVALID_INPUT",
				`Env file "${file}" is outside the project folder`,
				{
					details: {
						file,
						root: stack.value.root,
						fix: "Use a path relative to the project folder, e.g. .env.local.",
					},
				},
			),
		);
	}
	const lines = projectEnvLines(view.value.resolved, stack.value, true);
	if (!lines.ok) return lines;
	const path = resolve(stack.value.root, file);
	const written = await writeLinkedEnvFile(
		deps.files,
		path,
		formatGroupedEnv("dotenv", lines.value),
	);
	if (!written.ok) return written;
	return ok({ path, count: lines.value.length });
};
