import { join } from "node:path";
import { OpError } from "../shared/op-error";
import { err, ok } from "../shared/result";
import { parseStackFile, stackErrorToOpError } from "../stack/loader";
import { findProjectEntry } from "../stack/project-registry";
import { PROJECT_STACK_FILE_NAME, type Stack } from "../stack/stack.model";
import { renderStackFile } from "../stack/writer";
import type { CreateProject } from "./ops.contract";
import { checkProjectInput, registerStack } from "./support/registration";

/**
 * Creates the project folder (when missing) and a fresh
 * `<root>/locastack.yaml` (with the given services, nothing started), then
 * registers it.
 *
 * @returns The new stack; `INVALID_INPUT` (bad name, relative root),
 *   `PROJECT_EXISTS` (name registered to another folder, file already
 *   present, container name clash), `INVALID_STACK` (invalid services) or `IO`.
 */
export const createProject: CreateProject = async (deps, input) => {
	const root = checkProjectInput(input.name, input.root);
	if (!root.ok) return root;
	const filePath = join(root.value, PROJECT_STACK_FILE_NAME);

	try {
		const owner = findProjectEntry(await deps.state.read(), input.name);
		if (owner !== undefined) {
			return err(
				new OpError(
					"PROJECT_EXISTS",
					`A project named "${input.name}" is already registered at ${owner.root}`,
					{
						details: {
							reason: "name-taken",
							project: input.name,
							registeredRoot: owner.root,
							fix: "Pick another name, or remove the other project from the dashboard first.",
						},
					},
				),
			);
		}
		if (await deps.files.exists(filePath)) {
			return err(
				new OpError("PROJECT_EXISTS", `${filePath} already exists`, {
					details: {
						reason: "file-exists",
						filePath,
						fix: "Register the existing folder instead of creating a new project.",
					},
				}),
			);
		}
	} catch (cause) {
		return err(
			new OpError("IO", `Could not check ${filePath}`, {
				cause,
				details: { filePath },
			}),
		);
	}

	const text = renderStackFile({
		version: 1,
		name: input.name,
		services: { ...(input.services ?? {}) },
	});
	const parsed = parseStackFile(text, filePath);
	if (!parsed.ok) return err(stackErrorToOpError(parsed.error));
	const stack: Stack = {
		name: input.name,
		root: root.value,
		filePath,
		file: parsed.value,
	};

	const registered = await registerStack(deps, stack);
	if (!registered.ok) return registered;
	try {
		await deps.files.mkdirp(root.value);
		await deps.files.writeText(filePath, text);
	} catch (cause) {
		await deps.state
			.update((state) => ({
				...state,
				projects: state.projects.filter((p) => p.name !== input.name),
			}))
			.catch(() => undefined);
		return err(
			new OpError("IO", `Could not write ${filePath}`, {
				cause,
				details: { filePath },
			}),
		);
	}
	return ok(stack);
};
